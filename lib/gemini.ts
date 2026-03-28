import { GoogleGenAI } from "@google/genai"

let _client: GoogleGenAI | null = null

export function getGeminiClient(): GoogleGenAI {
  if (!_client) {
    const useVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === "true"

    if (useVertex) {
      const project = process.env.GOOGLE_CLOUD_PROJECT
      const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1"
      if (!project) throw new Error("Missing GOOGLE_CLOUD_PROJECT for Vertex AI")
      _client = new GoogleGenAI({ vertexai: true, project, location })
    } else {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
      if (!apiKey) throw new Error("Missing GOOGLE_GENERATIVE_AI_API_KEY")
      _client = new GoogleGenAI({ apiKey })
    }
  }
  return _client
}
