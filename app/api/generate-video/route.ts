import { NextResponse } from "next/server"
import { getGeminiClient } from "@/lib/gemini"
import { uploadVideoClip } from "@/lib/r2"
import { logger } from "@/lib/logger"
import { readFile, unlink } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

interface GenerateVideoRequest {
  storyId: string
  panels: {
    panelId: string
    imageUrl: string
    caption: string
  }[]
}

interface GeneratedClip {
  panelIndex: number
  panelId: string
  videoUrl: string
}

const maxPollAttempts = 30

function getBackoffMs(attempt: number) {
  return Math.min(5000 * 2 ** Math.floor(attempt / 2), 30_000)
}

function tmpPath(label: string) {
  return `/tmp/story-loom-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Generate a single video clip from an image + caption via Veo.
 * Returns the local mp4 file path (caller is responsible for cleanup).
 */
async function generateClipToFile({
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
    model: "veo-3.0-generate-001",
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
    throw new Error(`Video generation timed out for panel ${panelIndex}`)
  }

  if (operation.error) {
    throw new Error(`Video generation failed for panel ${panelIndex}: ${JSON.stringify(operation.error)}`)
  }

  const generatedVideo = operation.response?.generatedVideos?.[0]
  if (!generatedVideo?.video?.uri) {
    throw new Error(`No video URI returned for panel ${panelIndex}`)
  }

  const mp4Path = tmpPath(`clip-${panelIndex}`) + ".mp4"
  logger.info("Downloading video bytes", { route: "/api/generate-video", panelIndex })
  await client.files.download({ file: generatedVideo, downloadPath: mp4Path })

  logger.info("Video clip downloaded", { route: "/api/generate-video", panelIndex, durationMs: Date.now() - start })
  return mp4Path
}

/**
 * Extract the last frame of an mp4 as a base64 JPEG using ffmpeg.
 */
async function extractLastFrame(mp4Path: string): Promise<{ base64: string; mimeType: string }> {
  const framePath = tmpPath("lastframe") + ".jpg"
  try {
    await execFileAsync("ffmpeg", [
      "-sseof", "-0.1",
      "-i", mp4Path,
      "-frames:v", "1",
      "-q:v", "2",
      "-y",
      framePath,
    ])
    const frameBytes = await readFile(framePath)
    return { base64: frameBytes.toString("base64"), mimeType: "image/jpeg" }
  } finally {
    await unlink(framePath).catch(() => {})
  }
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], base64: match[2] }
}

export async function POST(request: Request) {
  const start = Date.now()
  const route = "/api/generate-video"
  const tmpFiles: string[] = []

  try {
    const body = (await request.json()) as GenerateVideoRequest

    if (!body.panels || !Array.isArray(body.panels) || body.panels.length === 0) {
      logger.warn("Invalid request body", { route })
      return NextResponse.json({ error: "panels array is required" }, { status: 400 })
    }

    if (!body.storyId) {
      logger.warn("Missing storyId", { route })
      return NextResponse.json({ error: "storyId is required" }, { status: 400 })
    }

    logger.info("Request received — sequential chained generation", { route, storyId: body.storyId, panelCount: body.panels.length })

    const encoder = new TextEncoder()
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()

    const generate = async () => {
      const clips: GeneratedClip[] = []
      const failedIndices: number[] = []
      let writerOpen = true

      // Send keep-alive pings every 10s to prevent the connection from timing out
      const keepAlive = setInterval(async () => {
        if (!writerOpen) return
        try {
          await writer.write(encoder.encode(`${JSON.stringify({ type: "ping" })}\n`))
        } catch {
          writerOpen = false
        }
      }, 10_000)

      let nextImageBase64: string | null = null
      let nextImageMimeType: string | null = null

      for (let i = 0; i < body.panels.length; i++) {
        if (request.signal.aborted) break

        const panel = body.panels[i]!
        try {
          let imageBase64: string
          let mimeType: string

          if (nextImageBase64 && nextImageMimeType) {
            imageBase64 = nextImageBase64
            mimeType = nextImageMimeType
            logger.info("Using chained last-frame as input", { route, panelIndex: i })
          } else {
            const parsed = parseDataUrl(panel.imageUrl)
            if (!parsed) throw new Error(`Invalid image data URL for panel ${i}`)
            imageBase64 = parsed.base64
            mimeType = parsed.mimeType
          }

          const mp4Path = await generateClipToFile({
            imageBase64,
            mimeType,
            caption: panel.caption,
            panelIndex: i,
          })
          tmpFiles.push(mp4Path)

          // Extract last frame for chaining + read file for R2 upload in parallel
          const [lastFrame, videoBuffer] = await Promise.all([
            i < body.panels.length - 1
              ? extractLastFrame(mp4Path).catch((err) => {
                  logger.warn("Last frame extraction failed, breaking chain", { route, panelIndex: i, error: err instanceof Error ? err.message : String(err) })
                  return null
                })
              : Promise.resolve(null),
            readFile(mp4Path),
          ])

          if (lastFrame) {
            nextImageBase64 = lastFrame.base64
            nextImageMimeType = lastFrame.mimeType
            logger.info("Extracted last frame for chaining", { route, panelIndex: i })
          } else {
            nextImageBase64 = null
            nextImageMimeType = null
          }

          // Upload to R2 and get presigned URL
          const sizeKb = Math.round(videoBuffer.length / 1024)
          logger.info("Uploading clip to R2", { route, panelIndex: i, sizeKb })
          const { key: videoKey, url: videoUrl } = await uploadVideoClip({
            buffer: videoBuffer,
            storyId: body.storyId,
            panelId: panel.panelId,
          })
          logger.info("Clip uploaded to R2", { route, panelIndex: i, videoKey })

          const clip: GeneratedClip = { panelIndex: i, panelId: panel.panelId, videoUrl }
          clips.push(clip)

          try {
            await writer.write(
              encoder.encode(`${JSON.stringify({ type: "clip", panelIndex: i, panelId: panel.panelId, videoUrl, videoKey })}\n`)
            )
          } catch {
            writerOpen = false
            logger.warn("Writer closed, client likely disconnected", { route, panelIndex: i })
          }
          logger.info("Clip streamed to client", { route, panelIndex: i })
        } catch (err) {
          failedIndices.push(i)
          const reason = err instanceof Error ? `${err.message}\n${err.stack}` : JSON.stringify(err)
          logger.error("Clip generation failed", { route, panelIndex: i, error: reason })
          nextImageBase64 = null
          nextImageMimeType = null
        }
      }

      clearInterval(keepAlive)

      clips.sort((a, b) => a.panelIndex - b.panelIndex)
      if (writerOpen) {
        try {
          await writer.write(
            encoder.encode(`${JSON.stringify({ type: "done", clips, failedIndices })}\n`)
          )
          await writer.close()
        } catch {
          logger.warn("Writer closed before done message — client disconnected", { route })
        }
      }
      logger.info("Video stream completed", { route, clipCount: clips.length, failedCount: failedIndices.length, durationMs: Date.now() - start })

      for (const f of tmpFiles) {
        await unlink(f).catch(() => {})
      }
    }

    generate().catch(async (err) => {
      // ResponseAborted is expected when the client navigates away — not a real error
      const isAbort = err instanceof Error && (err.message.includes("ResponseAborted") || err.message.includes("aborted"))
      if (isAbort) {
        logger.info("Client disconnected, generation continues for R2 uploads", { route })
      } else {
        const errDetail = err instanceof Error ? `${err.message}\n${err.stack}` : JSON.stringify(err)
        logger.error("Generation pipeline error", { route, error: errDetail })
      }
      try {
        await writer.close()
      } catch { /* already closed */ }
    })

    return new Response(readable, {
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
    for (const f of tmpFiles) {
      await unlink(f).catch(() => {})
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
