import { NextResponse } from "next/server"
import { getGeminiClient } from "@/lib/gemini"
import { logger } from "@/lib/logger"

interface GenerateTitleRequest {
  prompt?: string
}

export async function POST(request: Request) {
  const start = Date.now()
  const route = "/api/generate-title"

  try {
    const body = (await request.json()) as GenerateTitleRequest
    const prompt = body.prompt?.trim()

    logger.info("Request received", { route, promptLength: prompt?.length ?? 0 })

    if (!prompt) {
      logger.warn("Missing prompt in request body", { route })
      return NextResponse.json({ error: "`prompt` is required." }, { status: 400 })
    }

    const client = getGeminiClient()

    logger.info("Calling Gemini for title generation", { route, model: "gemini-3-flash-preview" })
    const response = await client.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `You are a story title generator. Create a single short, evocative story title (3–6 words) for the story concept below. Return ONLY the title — no quotes, no punctuation at the end, no explanation.\n\nStory concept: ${prompt}`,
      config: { temperature: 0.9 },
    })

    const raw = response.text ?? ""
    const title = raw.trim().replace(/^["']|["']$/g, "").trim()

    logger.info("Title generated successfully", { route, title, durationMs: Date.now() - start })
    return NextResponse.json({ title })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate title"
    const stack = error instanceof Error ? error.stack : undefined
    logger.error("Title generation failed", { route, error: message, stack, durationMs: Date.now() - start })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
