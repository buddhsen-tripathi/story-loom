import { NextResponse } from "next/server"
import { getGeminiClient } from "@/lib/gemini"
import { logger } from "@/lib/logger"

interface GenerateVideoRequest {
  panels: {
    imageUrl: string
    caption: string
  }[]
}

interface GeneratedClip {
  panelIndex: number
  videoUrl: string
}

const maxPollAttempts = 30

function getBackoffMs(attempt: number) {
  return Math.min(5000 * 2 ** Math.floor(attempt / 2), 30_000)
}

async function generateClip({
  imageBase64,
  mimeType,
  caption,
  panelIndex,
  signal,
}: {
  imageBase64: string
  mimeType: string
  caption: string
  panelIndex: number
  signal?: AbortSignal
}): Promise<string> {
  const start = Date.now()
  const client = getGeminiClient()
  logger.info("Starting Veo video generation", { route: "/api/generate-video", panelIndex, captionLength: caption.length })

  let operation = await client.models.generateVideos({
    model: "veo-3.1-fast-generate-preview",
    prompt: caption,
    image: {
      imageBytes: imageBase64,
      mimeType,
    },
    config: {
      numberOfVideos: 1,
      durationSeconds: 4,
      aspectRatio: "9:16",
      resolution: "720p",
      personGeneration: "allow_adult",
    },
  })

  let attempts = 0
  while (!operation.done && attempts < maxPollAttempts) {
    if (signal?.aborted) throw new Error(`Video generation aborted for panel ${panelIndex}`)
    attempts++
    const backoff = getBackoffMs(attempts)
    logger.debug("Polling video operation", { route: "/api/generate-video", panelIndex, attempt: attempts, backoffMs: backoff })
    await new Promise((resolve) => setTimeout(resolve, backoff))
    operation = await client.operations.getVideosOperation({ operation })
  }

  if (!operation.done) {
    logger.error("Video generation timed out", { route: "/api/generate-video", panelIndex, durationMs: Date.now() - start })
    throw new Error(`Video generation timed out for panel ${panelIndex}`)
  }

  if (operation.error) {
    logger.error("Video generation failed", { route: "/api/generate-video", panelIndex, error: operation.error })
    throw new Error(`Video generation failed for panel ${panelIndex}: ${JSON.stringify(operation.error)}`)
  }

  const generatedVideo = operation.response?.generatedVideos?.[0]
  if (!generatedVideo?.video?.uri) {
    logger.error("No video URI in response", { route: "/api/generate-video", panelIndex })
    throw new Error(`No video URI returned for panel ${panelIndex}`)
  }

  // Download video bytes via SDK (the URI is not directly fetchable)
  logger.info("Downloading video bytes", { route: "/api/generate-video", panelIndex })
  const tmpPath = `/tmp/story-loom-clip-${panelIndex}-${Date.now()}.mp4`
  await client.files.download({ file: generatedVideo, downloadPath: tmpPath })

  const { readFile, unlink } = await import("node:fs/promises")
  const videoBytes = await readFile(tmpPath)
  const videoBase64 = videoBytes.toString("base64")
  await unlink(tmpPath).catch(() => {})

  const dataUrl = `data:video/mp4;base64,${videoBase64}`
  const sizeKb = Math.round(videoBytes.length / 1024)
  logger.info("Video clip ready", { route: "/api/generate-video", panelIndex, sizeKb, durationMs: Date.now() - start })
  return dataUrl
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], base64: match[2] }
}

export async function POST(request: Request) {
  const start = Date.now()
  const route = "/api/generate-video"

  try {
    const body = (await request.json()) as GenerateVideoRequest

    if (!body.panels || !Array.isArray(body.panels) || body.panels.length === 0) {
      logger.warn("Invalid request body", { route })
      return NextResponse.json({ error: "panels array is required" }, { status: 400 })
    }

    logger.info("Request received", { route, panelCount: body.panels.length })

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const clips: GeneratedClip[] = []
        const failedIndices: number[] = []

        // Generate all video clips in parallel, tolerating individual failures
        const clipPromises = body.panels.map(async (panel, index) => {
          const parsed = parseDataUrl(panel.imageUrl)
          if (!parsed) {
            throw new Error(`Invalid image data URL for panel ${index}`)
          }

          const videoUrl = await generateClip({
            imageBase64: parsed.base64,
            mimeType: parsed.mimeType,
            caption: panel.caption,
            panelIndex: index,
            signal: request.signal,
          })

          const clip: GeneratedClip = { panelIndex: index, videoUrl }

          // Stream each clip as it completes
          controller.enqueue(
            encoder.encode(`${JSON.stringify({ type: "clip", ...clip })}\n`)
          )
          logger.info("Clip streamed to client", { route, panelIndex: index })

          return clip
        })

        const results = await Promise.allSettled(clipPromises)

        for (const [i, result] of results.entries()) {
          if (result.status === "fulfilled") {
            clips.push(result.value)
          } else {
            failedIndices.push(i)
            const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
            logger.error("Clip generation failed", { route, panelIndex: i, error: reason })
          }
        }

        // Send done with successful clips in order + any failed indices
        clips.sort((a, b) => a.panelIndex - b.panelIndex)
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ type: "done", clips, failedIndices })}\n`)
        )
        controller.close()
        logger.info("Video stream completed", { route, clipCount: clips.length, failedCount: failedIndices.length, durationMs: Date.now() - start })
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate video"
    const stack = error instanceof Error ? error.stack : undefined
    logger.error("Video generation failed", { route, error: message, stack, durationMs: Date.now() - start })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
