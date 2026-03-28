# Story Loom

**AI-powered interactive visual storytelling with branching narratives and cinematic video generation.**

Story Loom lets you describe a story concept and watch it come to life -- AI generates cinematic panels with images, lets you fork timelines at any point, and animates your story into a continuous video with frame-by-frame visual continuity.

---

## What it does

1. **Describe your story** -- type a concept, character, or premise
2. **AI generates visual panels** -- Gemini creates narrative beats with cinematic images
3. **Branch the timeline** -- fork from any panel to explore alternate storylines
4. **Animate into video** -- Veo generates chained video clips where each clip's last frame feeds into the next, creating seamless visual continuity
5. **Watch your story** -- gapless dual-player playback stitches clips into a continuous movie

---

## Demo

```
[Story idea] --> AI Title + 3 cinematic panels --> Interactive canvas
                                                        |
                                          "Branch here" on any panel
                                                        |
                                               Fork the timeline
                                                        |
                                          "Animate" --> Chained video
```

---

## Tech stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Frontend | React 19, TypeScript, Tailwind CSS 4 |
| Story canvas | ReactFlow (node graph visualization) |
| UI | shadcn/ui + Radix primitives |
| AI text + images | Google Gemini 3 Flash |
| AI video | Google Veo 3.0 (image-to-video with frame chaining) |
| Auth | Firebase Authentication |
| Database | Cloud Firestore |
| Video storage | Cloudflare R2 |
| Video processing | ffmpeg (last-frame extraction for clip chaining) |

---

## How the video chaining works

Traditional approach: generate all clips in parallel from static images. Result: no visual continuity between clips.

**Story Loom's approach:**

```
Panel 1 image --> Veo --> Clip 1 (4s video)
                              |
                         ffmpeg: extract last frame
                              |
                              v
                    Last frame --> Veo --> Clip 2 (4s video)
                                              |
                                         ffmpeg: extract last frame
                                              |
                                              v
                                    Last frame --> Veo --> Clip 3 (4s video)
```

Each clip's ending pose, camera angle, and lighting naturally flow into the next clip's opening -- because the next clip literally starts from where the previous one ended.

**Playback:** Two `<video>` elements swap via opacity toggle. While one plays, the other preloads the next clip. Zero gap between clips.

---

## Architecture

```
User describes story
        |
        v
  [Gemini 3 Flash] --> panels with titles, captions, image prompts
        |
        v
  [Gemini Image Gen] --> cinematic images per panel (parallel)
        |
        v
  [ReactFlow Canvas] --> interactive node graph with branching
        |
        v
  [Veo 3.0] --> sequential chained video generation
        |         (last frame of clip N = first frame of clip N+1)
        v
  [ffmpeg] --> extract last frame for chaining
        |
        v
  [R2 Storage] --> persistent video clips with presigned URLs
        |
        v
  [Dual <video> player] --> gapless playback with preloading
```

### Key design decisions

- **Sequential chained video generation** -- clips generate one after another, each using the previous clip's last frame as its starting image. Visual continuity that parallel generation can't achieve.
- **Dual video element playback** -- two `<video>` elements swap via opacity toggle. While one plays, the other preloads the next clip. Zero gap between clips.
- **Keep-alive streaming** -- server sends pings every 10s during long Veo generations to prevent connection timeouts.
- **Branch-aware context** -- when generating panels for a branch, the full ancestor chain is sent to Gemini so the AI maintains narrative coherence across forks.
- **Progressive streaming** -- panels and video clips stream to the client as they complete. Chat shows live task progress with per-frame status updates.
- **Resilient to disconnection** -- if the user closes the overlay mid-generation, the server continues generating and uploading to R2. Next time they animate, cached clips load instantly.

---

## Getting started

### Prerequisites

- Node.js 18+ or Bun
- ffmpeg (`brew install ffmpeg` on macOS)
- Google AI Studio API key
- Firebase project (Auth + Firestore)
- Cloudflare R2 bucket

### Install

```bash
git clone <repo-url>
cd story-loom
bun install
```

### Environment

Create `.env.local`:

```env
# Google AI (AI Studio)
GOOGLE_GENERATIVE_AI_API_KEY=your_key

# Firebase
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...

# Cloudflare R2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
```

### Firestore rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /stories/{storyId} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.userId;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.userId;
      match /{subcollection}/{docId} {
        allow read, write: if request.auth != null;
      }
    }
  }
}
```

### Run

```bash
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Project structure

```
app/
  api/
    generate-panels/    # Gemini text + image generation (streaming)
    generate-title/     # AI title generation
    generate-video/     # Veo chained video pipeline (streaming)
    video-url/          # R2 presigned URL refresh
    get-inspiration/    # Story prompt suggestions
  page.tsx              # Entry point
  layout.tsx            # Root layout with providers

components/
  story-loom-workbench  # Main app -- state, canvas, chat, branching
  panel-node            # ReactFlow panel card with branch/animate
  story-transition-overlay  # Video gen + dual-player playback
  new-story-modal       # Story creation with optional AI title
  story-history-sidebar # Story library with search
  auth-modal            # Firebase auth (email + Google OAuth)
  ui/                   # shadcn/ui components

lib/
  firebase.ts           # Firebase init
  firebase-db.ts        # Firestore CRUD with logging + timeouts
  gemini.ts             # Gemini client (API key or Vertex AI)
  r2.ts                 # Cloudflare R2 upload + presigned URLs
  logger.ts             # Structured logging

prompts/
  storyPrompts.ts       # System + user prompts for panel generation
```

---

## Scripts

```bash
bun run dev          # Dev server with Turbopack
bun run build        # Production build
bun run start        # Production server
bun run lint         # ESLint
bun run format       # Prettier
bun run typecheck    # TypeScript check
```

---

Built in 24 hours. Powered by Gemini, Veo, and coffee.
