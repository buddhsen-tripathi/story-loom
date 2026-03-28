"use client"

import { useEffect, useRef, useState } from "react"

interface NewStoryModalProps {
  onConfirm: (idea: string, title: string | null, generateTitle: boolean) => void
  onClose: () => void
}

export function NewStoryModal({ onConfirm, onClose }: NewStoryModalProps) {
  const [idea, setIdea] = useState("")
  const [title, setTitle] = useState("")
  const [autoTitle, setAutoTitle] = useState(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  function handleSubmit() {
    const trimmedIdea = idea.trim()
    if (!trimmedIdea) return
    if (!autoTitle && !title.trim()) return
    onConfirm(trimmedIdea, autoTitle ? null : title.trim(), autoTitle)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative mx-4 w-full max-w-lg rounded-2xl border border-border bg-card p-8 shadow-xl dark:shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full border border-border p-1.5 text-muted-foreground transition hover:border-border hover:text-foreground"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="1" y1="1" x2="13" y2="13" />
            <line x1="13" y1="1" x2="1" y2="13" />
          </svg>
        </button>

        <p className="text-[10px] uppercase tracking-[0.22em] text-primary">New Story</p>
        <h2 className="mt-2 font-['Iowan_Old_Style','Baskerville','Palatino','serif'] text-2xl text-foreground">
          What&apos;s your story?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe your concept — a character, a world, a dramatic premise.
        </p>

        {/* Idea textarea */}
        <div className="mt-5">
          <label className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Story Idea</label>
          <textarea
            ref={textareaRef}
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={4}
            placeholder="e.g. A washed-up storyteller discovers repainting old memories changes the present…"
            className="mt-2 w-full resize-none rounded-2xl border border-border bg-muted/50 p-4 text-sm text-foreground placeholder-muted-foreground outline-none transition focus:border-primary"
          />
        </div>

        {/* Title section */}
        <div className="mt-4">
          <label
            className="flex cursor-pointer items-center gap-2.5"
            onClick={() => setAutoTitle((v) => !v)}
          >
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                autoTitle
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-muted/50"
              }`}
            >
              {autoTitle && (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="2 6 5 9 10 3" />
                </svg>
              )}
            </span>
            <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              Generate title with AI
            </span>
          </label>

          {!autoTitle && (
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter a title…"
              className="mt-2.5 w-full rounded-2xl border border-border bg-muted/50 px-4 py-3 text-base font-medium text-foreground outline-none transition focus:border-primary"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
            />
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border px-4 py-2 text-xs uppercase tracking-[0.14em] text-muted-foreground transition hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!idea.trim() || (!autoTitle && !title.trim())}
            className="flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-xs uppercase tracking-[0.14em] text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Start Story
          </button>
        </div>

        <p className="mt-3 text-center text-[10px] text-muted-foreground">
          &#8984;&#8629; to start
        </p>
      </div>
    </div>
  )
}
