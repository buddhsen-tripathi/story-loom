export interface StoryPanelSeed {
  title: string
  caption: string
  imagePrompt: string
}

export interface BuildStoryPromptInput {
  prompt: string
  panelCount: number
  priorPanels?: StoryPanelSeed[]
}

const maxPriorPanels = 6

export function buildStorySystemPrompt() {
  return [
    "You are a senior visual story director.",
    "Write cinematic but concise panel content.",
    "Each panel must include: title, caption, imagePrompt.",
    "imagePrompt must be optimized for cinematic visual composition, dramatic lighting, and character continuity.",
    "CRITICAL: Every imagePrompt MUST re-describe each character's full appearance (hair color, style, clothing, build, distinguishing features) from scratch. The image generator has NO memory between panels — if you omit details, the character will look like a different person.",
    "ALWAYS ground every panel in the user's master prompt — their characters, setting, and premise must be central.",
    "When prior panels are provided, maintain narrative continuity and build directly on established events.",
  ].join("\n")
}

export interface BuildInspirationPromptInput {
  prompt: string
  priorPanels?: StoryPanelSeed[]
  message?: string
}

export function buildInspirationSystemPrompt() {
  return [
    "You are a veteran story director's creative partner.",
    "Your job is to help the director decide WHAT HAPPENS NEXT in their story.",
    "Analyze where the narrative currently stands — characters, tension, unresolved threads — and suggest concrete, actionable next beats the director can use immediately.",
    "Draw from real films, novels, and myths to back up your suggestions, but always frame them as moves the director can make RIGHT NOW.",
    "Be bold, specific, and cinematic. Avoid generic advice.",
  ].join("\n")
}

export function buildInspirationUserPrompt({ prompt, priorPanels = [], message }: BuildInspirationPromptInput) {
  const recentPanels = priorPanels.slice(-maxPriorPanels)

  return [
    `Story concept: ${prompt}`,
    recentPanels.length > 0
      ? `Current panels so far: ${JSON.stringify(recentPanels)}`
      : "(Story has not started yet — suggest strong opening beats.)",
    message ? `Director's request: ${message}` : "",
    "",
    "Respond with this JSON schema:",
    '{"nextBeats":["string"],"references":[{"title":"string","type":"string","lesson":"string"}],"wildcards":["string"]}',
    "",
    "Rules:",
    '- "nextBeats": 3 concrete, one-sentence suggestions for the very next scene or panel the director could create. Each should move the plot forward in a distinct direction.',
    '- "references": 2-3 real films, novels, or myths whose story structure is relevant HERE. "lesson" explains the specific technique or beat the director can borrow (not a plot summary).',
    '- "wildcards": 1-2 surprising left-field ideas — a tonal shift, an unexpected character entrance, a genre pivot — that could electrify the story.',
  ].filter(Boolean).join("\n")
}

export function buildStoryUserPrompt({ prompt, panelCount, priorPanels = [] }: BuildStoryPromptInput) {
  const isFresh = priorPanels.length === 0

  // Sliding window: keep only the most recent panels to avoid token overflow
  const truncated = priorPanels.length > maxPriorPanels
  const recentPanels = truncated ? priorPanels.slice(-maxPriorPanels) : priorPanels
  const priorPanelsJson = JSON.stringify(recentPanels)

  const modeInstruction = isFresh
    ? "This is the OPENING of the story. Establish the world, characters, and inciting incident described in the master prompt."
    : "Continue the story directly from the prior panels. Honor established characters and plot threads."

  return [
    `Master prompt (follow this exactly): ${prompt}`,
    modeInstruction,
    `Generate exactly ${panelCount} panels.`,
    "Output schema:",
    '{"panels":[{"title":"string","caption":"string","imagePrompt":"string"}]}',
    "Rules:",
    "- Titles are short (2-6 words).",
    "- Captions are 1-2 sentences and push story progression.",
    "- imagePrompt format: [full character appearance description], [action/pose], [setting], [camera angle], [lighting/mood], [art style]. Always repeat character looks — the image model is stateless.",
    "- Keep tone consistent with the master prompt and avoid repeating the same scene.",
    truncated ? `(Note: ${priorPanels.length - maxPriorPanels} earlier panels omitted for brevity. The most recent ${maxPriorPanels} panels follow.)` : "",
    recentPanels.length > 0 ? `Prior panels JSON: ${priorPanelsJson}` : "",
  ].filter(Boolean).join("\n")
}
