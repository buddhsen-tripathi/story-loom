import { GoogleGenAI } from "@google/genai"

let _client: GoogleGenAI | null = null

export function getGeminiClient(): GoogleGenAI {
  if (!_client) {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) throw new Error("Missing GOOGLE_GENERATIVE_AI_API_KEY")
    _client = new GoogleGenAI({ apiKey })
  }
  return _client
}
