import { NextResponse } from "next/server"

import { getGeminiClient } from "@/lib/gemini"
import {
  buildInspirationSystemPrompt,
  buildInspirationUserPrompt,
  type StoryPanelSeed,
} from "@/prompts/storyPrompts"
import { logger } from "@/lib/logger"

interface GetInspirationRequest {
  prompt?: string
  priorPanels?: StoryPanelSeed[]
  message?: string
}

interface InspirationPayload {
  nextBeats?: string[]
  references?: { title: string; type: string; lesson: string }[]
  wildcards?: string[]
}

export async function POST(request: Request) {
  const route = "/api/get-inspiration"
  const start = Date.now()

  try {
    const body = (await request.json()) as GetInspirationRequest
    const prompt = body.prompt?.trim()
    const priorPanels = Array.isArray(body.priorPanels) ? body.priorPanels : []
    const message = body.message?.trim() || undefined

    if (!prompt) {
      logger.warn("Missing prompt in request body", { route })
      return NextResponse.json({ error: "`prompt` is required." }, { status: 400 })
    }

    logger.info("Generating inspiration", { route, promptLength: prompt.length, priorPanelCount: priorPanels.length, hasMessage: !!message })

    const client = getGeminiClient()
    const response = await client.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: buildInspirationUserPrompt({ prompt, priorPanels, message }),
      config: {
        temperature: 0.9,
        systemInstruction: buildInspirationSystemPrompt(),
        responseMimeType: "application/json",
        responseSchema: {
          type: "object" as const,
          properties: {
            nextBeats: {
              type: "array" as const,
              items: { type: "string" as const },
            },
            references: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  title: { type: "string" as const },
                  type: { type: "string" as const },
                  lesson: { type: "string" as const },
                },
                required: ["title", "type", "lesson"],
              },
            },
            wildcards: {
              type: "array" as const,
              items: { type: "string" as const },
            },
          },
          required: ["nextBeats", "references", "wildcards"],
        },
      },
    })

    const payload = JSON.parse(response.text ?? "{}") as InspirationPayload

    if (!payload.nextBeats || !Array.isArray(payload.nextBeats)) {
      logger.error("Invalid inspiration payload from model", { route })
      return NextResponse.json({ error: "Invalid response from model" }, { status: 500 })
    }

    logger.info("Inspiration generated", { route, beatCount: payload.nextBeats.length, durationMs: Date.now() - start })

    return NextResponse.json(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate inspiration"
    logger.error("Inspiration generation failed", { route, error: message, durationMs: Date.now() - start })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
