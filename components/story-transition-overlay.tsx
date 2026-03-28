"use client"

import { useCallback, useEffect, useRef, useState } from "react"

export interface AnimationState {
  open: boolean
  branchId: string
  storyId?: string
  images: { panelId: string; url: string; title: string; caption: string; videoUrl?: string }[]
  statusMessageId?: string
}

const PANEL_HOLD_MS = 3600

type VideoStatus = "idle" | "generating" | "ready" | "error"

interface VideoClip {
  panelIndex: number
  videoUrl: string
}

interface StoryTransitionOverlayProps {
  animation: AnimationState
  onClose: () => void
  onClipProgress?: (panelIndex: number, status: "running" | "done" | "error") => void
  onVideoSaved?: (panelId: string, videoUrl: string, videoKey?: string) => void
  onAllClipsDone?: (branchId: string) => void
}

export function StoryTransitionOverlay({ animation, onClose, onClipProgress, onVideoSaved, onAllClipsDone }: StoryTransitionOverlayProps) {
  const [index, setIndex] = useState(0)

  // Stable refs for callbacks — avoids re-creating generateVideo on every render
  const clipProgressRef = useRef(onClipProgress)
  clipProgressRef.current = onClipProgress
  const videoSavedRef = useRef(onVideoSaved)
  videoSavedRef.current = onVideoSaved
  const allClipsDoneRef = useRef(onAllClipsDone)
  allClipsDoneRef.current = onAllClipsDone

  // Video generation state
  const [videoStatus, setVideoStatus] = useState<VideoStatus>("idle")
  const [videoClips, setVideoClips] = useState<VideoClip[]>([])
  const [videoError, setVideoError] = useState<string | null>(null)
  const [clipsReady, setClipsReady] = useState(0)
  const [activeClipIndex, setActiveClipIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Dual video elements for gapless playback
  const videoARef = useRef<HTMLVideoElement>(null)
  const videoBRef = useRef<HTMLVideoElement>(null)
  const [activePlayer, setActivePlayer] = useState<"A" | "B">("A")

  // CSS morph auto-advance (while generating)
  useEffect(() => {
    if (videoStatus === "ready") return
    if (animation.images.length < 2) return
    const timer = setInterval(() => {
      setIndex((cur) => {
        const last = animation.images.length - 2
        if (cur >= last) return cur
        return cur + 1
      })
    }, PANEL_HOLD_MS)
    return () => clearInterval(timer)
  }, [animation.images.length, animation.branchId, videoStatus])

  const generateVideo = useCallback(async () => {
    // Check if all panels already have persisted video URLs (skip generation)
    const existingClips: VideoClip[] = []
    for (let i = 0; i < animation.images.length; i++) {
      const img = animation.images[i]
      if (img.videoUrl) {
        existingClips.push({ panelIndex: i, videoUrl: img.videoUrl })
      }
    }
    if (existingClips.length === animation.images.length) {
      setVideoClips(existingClips)
      setClipsReady(existingClips.length)
      setVideoStatus("ready")
      setActiveClipIndex(0)
      setActivePlayer("A")
      for (let i = 0; i < animation.images.length; i++) {
        clipProgressRef.current?.(i, "done")
      }
      return
    }

    setVideoStatus("generating")
    setVideoError(null)
    setVideoClips([])
    setClipsReady(0)

    const controller = new AbortController()
    abortRef.current = controller

    for (let i = 0; i < animation.images.length; i++) {
      clipProgressRef.current?.(i, "running")
    }

    try {
      const panels = animation.images.map((img) => ({
        panelId: img.panelId,
        imageUrl: img.url,
        caption: img.caption,
      }))

      const response = await fetch("/api/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyId: animation.storyId, panels }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        throw new Error(`Server error: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.trim()) continue
          const msg = JSON.parse(line)

          if (msg.type === "ping") continue
          if (msg.type === "clip") {
            setVideoClips((prev) => [...prev, { panelIndex: msg.panelIndex, videoUrl: msg.videoUrl }])
            setClipsReady((prev) => prev + 1)
            clipProgressRef.current?.(msg.panelIndex, "done")
            // Persist the R2 URL + key
            if (msg.panelId && msg.videoUrl) {
              videoSavedRef.current?.(msg.panelId, msg.videoUrl, msg.videoKey)
            }
          } else if (msg.type === "done") {
            if (msg.failedIndices) {
              for (const fi of msg.failedIndices) {
                clipProgressRef.current?.(fi, "error")
              }
            }
            setVideoStatus("ready")
            setActiveClipIndex(0)
            setActivePlayer("A")
            allClipsDoneRef.current?.(animation.branchId)
          } else if (msg.type === "error") {
            throw new Error(msg.error)
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return
      // If we already received some clips before the stream broke,
      // show them as ready instead of failing everything.
      setVideoClips((cur) => {
        if (cur.length > 0) {
          setVideoStatus("ready")
          setActiveClipIndex(0)
          setActivePlayer("A")
          allClipsDoneRef.current?.(animation.branchId)
        } else {
          const message = err instanceof Error ? err.message : "Video generation failed"
          setVideoError(message)
          setVideoStatus("error")
          for (let i = 0; i < animation.images.length; i++) {
            clipProgressRef.current?.(i, "error")
          }
        }
        return cur
      })
    }
  }, [animation.images, animation.storyId])

  // Auto-trigger video generation on mount
  const hasStartedVideo = useRef(false)
  useEffect(() => {
    if (!hasStartedVideo.current && animation.images.length >= 2) {
      hasStartedVideo.current = true
      void generateVideo()
    }
  }, [animation.images.length, generateVideo])

  // Do NOT abort on unmount — let the server finish generating and uploading to R2.
  // The server handles client disconnection gracefully and still persists clips.
  // Aborting would waste the Veo generation quota.

  // ---------- Dual-video gapless playback ----------

  const getActiveEl = useCallback(() => activePlayer === "A" ? videoARef.current : videoBRef.current, [activePlayer])
  const getNextEl = useCallback(() => activePlayer === "A" ? videoBRef.current : videoARef.current, [activePlayer])

  // Load & play the active clip, preload the next clip in the hidden player
  useEffect(() => {
    if (videoStatus !== "ready") return
    const sorted = [...videoClips].sort((a, b) => a.panelIndex - b.panelIndex)
    const activeClip = sorted[activeClipIndex]
    const nextClip = sorted[activeClipIndex + 1] ?? sorted[0] // loop

    const activeEl = getActiveEl()
    const nextEl = getNextEl()

    if (activeEl && activeClip) {
      activeEl.src = activeClip.videoUrl
      activeEl.load()
      activeEl.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false))
    }

    // Preload the next clip in the hidden player
    if (nextEl && nextClip) {
      nextEl.src = nextClip.videoUrl
      nextEl.load()
    }
  }, [activeClipIndex, videoStatus, videoClips, getActiveEl, getNextEl])

  // When active clip ends, swap players instantly
  const handleVideoEnded = useCallback(() => {
    const sorted = [...videoClips].sort((a, b) => a.panelIndex - b.panelIndex)
    const nextIdx = activeClipIndex + 1 < sorted.length ? activeClipIndex + 1 : 0

    // Swap: hidden player becomes visible and starts playing
    setActivePlayer((cur) => (cur === "A" ? "B" : "A"))
    setActiveClipIndex(nextIdx)

    // The new active player already has the clip preloaded — play it
    const nextEl = getNextEl()
    if (nextEl) {
      nextEl.play().then(() => setIsPlaying(true)).catch(() => {})
    }
  }, [videoClips, activeClipIndex, getNextEl])

  function handleClose() {
    // Don't abort — let the server finish and upload to R2.
    // Pausing the active video prevents audio bleed after close.
    videoARef.current?.pause()
    videoBRef.current?.pause()
    onClose()
  }

  if (animation.images.length < 2) return null

  const fromPanel = animation.images[index]
  const toPanel = animation.images[Math.min(index + 1, animation.images.length - 1)]
  const sortedClips = [...videoClips].sort((a, b) => a.panelIndex - b.panelIndex)
  const activeImage = videoStatus === "ready" ? animation.images[sortedClips[activeClipIndex]?.panelIndex ?? 0] : toPanel

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/95">
      {/* Top controls */}
      <div className="absolute top-5 right-5 z-20 flex items-center gap-3">
        {(videoStatus === "idle" || videoStatus === "generating") && (
          <div className="flex items-center gap-2 rounded-full border border-white/20 bg-black/60 px-4 py-2 text-sm text-white/70">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            Generating {clipsReady}/{animation.images.length} clips...
          </div>
        )}

        {videoStatus === "error" && (
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-red-500/40 bg-red-900/30 px-3 py-2 text-xs text-red-300">
              {videoError}
            </span>
            <button
              type="button"
              onClick={() => { hasStartedVideo.current = false; void generateVideo() }}
              className="rounded-full border border-white/40 bg-black/40 px-4 py-2 text-sm text-white transition hover:bg-white/20"
            >
              Retry
            </button>
          </div>
        )}

        {videoStatus === "ready" && (
          <span className="rounded-full border border-green-500/30 bg-green-900/20 px-3 py-2 text-xs text-green-300">
            {isPlaying ? `Playing clip ${activeClipIndex + 1}/${sortedClips.length}` : "Video ready"}
          </span>
        )}

        <button
          type="button"
          onClick={handleClose}
          className="rounded-full border border-white/40 bg-black/40 px-4 py-2 text-sm text-white transition hover:bg-white/20"
        >
          Close
        </button>
      </div>

      <div className="relative mx-auto h-[86vh] w-full max-w-[620px] overflow-hidden rounded-2xl border border-white/20 bg-black">
        {videoStatus === "ready" ? (
          /* Dual video players for gapless playback */
          <>
            <video
              ref={videoARef}
              className="absolute inset-0 h-full w-full object-cover transition-opacity duration-100"
              style={{ opacity: activePlayer === "A" ? 1 : 0 }}
              playsInline
              onEnded={activePlayer === "A" ? handleVideoEnded : undefined}
            />
            <video
              ref={videoBRef}
              className="absolute inset-0 h-full w-full object-cover transition-opacity duration-100"
              style={{ opacity: activePlayer === "B" ? 1 : 0 }}
              playsInline
              onEnded={activePlayer === "B" ? handleVideoEnded : undefined}
            />
          </>
        ) : (
          /* CSS morph mode (while generating) */
          <>
            <img
              key={`from-${animation.branchId}-${index}`}
              src={fromPanel.url}
              alt={fromPanel.title}
              className="story-morph-from absolute inset-0 h-full w-full object-cover grayscale contrast-125"
            />
            <img
              key={`to-${animation.branchId}-${index}`}
              src={toPanel.url}
              alt={toPanel.title}
              className="story-morph-to absolute inset-0 h-full w-full object-cover grayscale contrast-125"
            />
            <div key={`warp-${animation.branchId}-${index}`} className="story-morph-warp absolute inset-0" />
          </>
        )}

        {/* Panel info overlay */}
        <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 to-transparent p-5">
          {videoStatus === "ready" ? (
            <>
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/60">
                Clip {activeClipIndex + 1} of {sortedClips.length}
              </p>
              <h3 className="mt-1 font-['Iowan_Old_Style','Baskerville','Palatino','serif'] text-xl text-white">
                {activeImage.title}
              </h3>
              <p className="mt-1 text-sm text-white/70">{activeImage.caption}</p>
            </>
          ) : (
            <>
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/60">
                {index + 1} → {index + 2} of {animation.images.length}
              </p>
              <h3 className="mt-1 font-['Iowan_Old_Style','Baskerville','Palatino','serif'] text-xl text-white">
                {toPanel.title}
              </h3>
              <p className="mt-1 text-sm text-white/70">{toPanel.caption}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
