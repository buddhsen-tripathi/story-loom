import { NextResponse } from "next/server"
import { Modality } from "@google/genai"

import { getGeminiClient } from "@/lib/gemini"
import { buildStorySystemPrompt, buildStoryUserPrompt, type StoryPanelSeed } from "@/prompts/storyPrompts"
import { logger } from "@/lib/logger"

interface GeneratePanelsRequest {
  prompt?: string
  priorPanels?: StoryPanelSeed[]
  panelCount?: number
  generateTitle?: boolean
}

interface GeneratedPanel {
  title: string
  caption: string
  imagePrompt: string
}

interface PanelContent extends GeneratedPanel {
  imageUrl: string
}

const defaultPanelCount = 3
const maxPanelCount = 5
const maxRetries = 3

function normalizeGeneratedPanel(panel: Partial<GeneratedPanel>) {
  const title = panel.title?.trim() ?? ""
  const caption = panel.caption?.trim() ?? ""
  const imagePrompt = panel.imagePrompt?.trim() ?? ""
  return { title, caption, imagePrompt }
}

function isValidGeneratedPanel(panel: GeneratedPanel) {
  return Boolean(panel.title && panel.caption && panel.imagePrompt)
}

async function generateStoryTitle(prompt: string) {
  const client = getGeminiClient()
  const response = await client.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `You are a story title generator. Create a single short, evocative story title (3–6 words) for the story concept below. Return ONLY the title — no quotes, no punctuation at the end, no explanation.\n\nStory concept: ${prompt}`,
    config: { temperature: 0.9 },
  })
  const raw = response.text ?? ""
  return raw.trim().replace(/^["']|["']$/g, "").trim()
}

async function generateStoryPanels({
  prompt,
  priorPanels,
  panelCount,
}: {
  prompt: string
  priorPanels: StoryPanelSeed[]
  panelCount: number
}) {
  const start = Date.now()
  logger.info("Generating story panel text", { route: "/api/generate-panels", model: "gemini-3-flash-preview", panelCount, priorPanelCount: priorPanels.length })

  const client = getGeminiClient()
  const response = await client.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: buildStoryUserPrompt({ prompt, panelCount, priorPanels }),
    config: {
      temperature: 0.8,
      systemInstruction: buildStorySystemPrompt(),
      responseMimeType: "application/json",
      responseSchema: {
        type: "object" as const,
        properties: {
          panels: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                title: { type: "string" as const },
                caption: { type: "string" as const },
                imagePrompt: { type: "string" as const },
              },
              required: ["title", "caption", "imagePrompt"],
            },
          },
        },
        required: ["panels"],
      },
    },
  })

  const payload = JSON.parse(response.text ?? "{}") as { panels?: Partial<GeneratedPanel>[] }
  if (!payload?.panels || !Array.isArray(payload.panels)) {
    logger.error("Invalid story payload shape from model", { route: "/api/generate-panels" })
    throw new Error("Invalid story payload shape from model")
  }

  const normalizedPanels = payload.panels.map(normalizeGeneratedPanel).filter(isValidGeneratedPanel)
  if (normalizedPanels.length === 0) {
    logger.error("No valid panels generated", { route: "/api/generate-panels", rawPanelCount: payload.panels.length })
    throw new Error("Model returned no valid panels")
  }

  if (normalizedPanels.length !== panelCount) {
    logger.warn("Panel count mismatch, proceeding with partial results", { route: "/api/generate-panels", expected: panelCount, got: normalizedPanels.length })
  }

  logger.info("Story panel text generated", { route: "/api/generate-panels", panelCount: normalizedPanels.length, durationMs: Date.now() - start })
  return normalizedPanels
}

async function generateImageDataUrl({
  prompt,
  panelIndex,
}: {
  prompt: string
  panelIndex: number
}) {
  const start = Date.now()
  const client = getGeminiClient()
  logger.info("Generating image", { route: "/api/generate-panels", panelIndex, promptLength: prompt.length })

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.models.generateContent({
        model: "gemini-3.1-flash-image-preview",
        contents: prompt,
        config: {
          responseModalities: [Modality.IMAGE],
        },
      })

      const part = response.candidates?.[0]?.content?.parts?.find((item) => item.inlineData?.data)
      const imageBytes = part?.inlineData?.data
      const mimeType = part?.inlineData?.mimeType ?? "image/png"
      if (!imageBytes) {
        logger.error("Image model returned no image bytes", { route: "/api/generate-panels", panelIndex, attempt })
        throw new Error("Image model did not return image bytes")
      }

      logger.info("Image generated", { route: "/api/generate-panels", panelIndex, attempt, mimeType, sizeKb: Math.round(imageBytes.length * 0.75 / 1024), durationMs: Date.now() - start })
      return `data:${mimeType};base64,${imageBytes}`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const is429 = message.includes("429") || message.includes("RESOURCE_EXHAUSTED")
      const isTransient = is429 || message.includes("500") || message.includes("503") || message.includes("UNAVAILABLE")

      if (isTransient && attempt < maxRetries) {
        const backoffMs = is429 ? attempt * 10_000 : attempt * 2_000
        logger.warn("Transient error, retrying", { route: "/api/generate-panels", panelIndex, attempt, backoffMs, is429 })
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
        continue
      }
      throw error
    }
  }

  throw new Error("Unreachable")
}

export async function POST(request: Request) {
  const start = Date.now()
  const route = "/api/generate-panels"

  try {
    const body = (await request.json()) as GeneratePanelsRequest
    const prompt = body.prompt?.trim()
    const priorPanels = Array.isArray(body.priorPanels) ? body.priorPanels : []
    const panelCount = Number.isFinite(body.panelCount)
      ? Math.min(maxPanelCount, Math.max(1, Number(body.panelCount)))
      : defaultPanelCount
    const generateTitle = body.generateTitle === true

    logger.info("Request received", { route, promptLength: prompt?.length ?? 0, priorPanelCount: priorPanels.length, panelCount, generateTitle })

    if (!prompt) {
      logger.warn("Missing prompt in request body", { route })
      return NextResponse.json({ error: "`prompt` is required." }, { status: 400 })
    }

    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Fire title + panel text generation concurrently when requested
          const titlePromise = generateTitle
            ? generateStoryTitle(prompt).catch((err) => {
                logger.warn("Title generation failed, skipping", { route, error: err instanceof Error ? err.message : String(err) })
                return null
              })
            : Promise.resolve(null)

          const panelsPromise = generateStoryPanels({ prompt, priorPanels, panelCount })

          const [title, storyPanels] = await Promise.all([titlePromise, panelsPromise])

          // Stream title first if generated
          if (title) {
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: "title", title })}\n`))
            logger.info("Title streamed to client", { route, title })
          }

          logger.info("Starting parallel image generation", { route, panelCount: storyPanels.length })

          // Stream each panel individually as its image completes
          let completedCount = 0
          const imagePromises = storyPanels.map(async (panel, index) => {
            try {
              const imageUrl = await generateImageDataUrl({
                prompt: panel.imagePrompt,
                panelIndex: index,
              })

              const payload = {
                type: "panel",
                index,
                panel: { ...panel, imageUrl } satisfies PanelContent,
              }

              controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
              completedCount++
              logger.info("Panel streamed to client", { route, panelIndex: index, title: panel.title })
            } catch (error) {
              const message = error instanceof Error ? error.message : "Image generation failed"
              logger.error("Image generation failed for panel", { route, panelIndex: index, error: message })

              // Stream the panel with text but mark as failed
              const payload = {
                type: "panel",
                index,
                panel: { ...panel, imageUrl: "", hasFailed: true } as PanelContent & { hasFailed: boolean },
              }
              controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
            }
          })

          await Promise.allSettled(imagePromises)

          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done", panelCount: completedCount, expectedPanelCount: storyPanels.length })}\n`))
          controller.close()
          logger.info("Stream completed", { route, panelCount: completedCount, totalPanels: storyPanels.length, durationMs: Date.now() - start })
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed during panel stream"
          logger.error("Stream error", { route, error: message, durationMs: Date.now() - start })
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", error: message })}\n`))
          controller.close()
        }
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
    const message = error instanceof Error ? error.message : "Failed to generate panels"
    const stack = error instanceof Error ? error.stack : undefined
    logger.error("Panel generation failed", { route, error: message, stack, durationMs: Date.now() - start })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
