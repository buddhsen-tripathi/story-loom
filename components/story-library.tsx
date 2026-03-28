"use client"

import { useCallback, useEffect, useState } from "react"
import {
  deleteStory,
  listUserStories,
  type StorySummary,
  type Timestamp,
} from "@/lib/firebase-db"

interface StoryLibraryProps {
  userId: string
  onLoadStory: (storyId: string) => void
  currentStoryId: string | null
}

function formatDate(ts: Timestamp | undefined): string {
  if (!ts?.toMillis) return "—"
  const d = new Date(ts.toMillis())
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined })
}

export function StoryLibrary({ userId, onLoadStory, currentStoryId }: StoryLibraryProps) {
  const [stories, setStories] = useState<StorySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listUserStories(userId)
      setStories(list)
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    if (!userId) return
    void refresh()
  }, [userId, refresh])

  const handleDelete = useCallback(
    async (storyId: string) => {
      if (deletingId) return
      setDeletingId(storyId)
      try {
        await deleteStory(storyId)
        setStories((prev) => prev.filter((s) => s.id !== storyId))
      } finally {
        setDeletingId(null)
      }
    },
    [deletingId]
  )

  if (loading && stories.length === 0) {
    return (
      <div className="rounded-2xl border border-stone-300 bg-white p-3">
        <p className="text-xs uppercase tracking-[0.16em] text-stone-600">Your stories</p>
        <p className="mt-3 text-sm text-stone-500">Loading…</p>
      </div>
    )
  }

  if (stories.length === 0) {
    return (
      <div className="rounded-2xl border border-stone-300 bg-white p-3">
        <p className="text-xs uppercase tracking-[0.16em] text-stone-600">Your stories</p>
        <p className="mt-3 text-sm text-stone-500">No saved stories yet. Generate one to save it here.</p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-stone-300 bg-white p-3">
      <p className="mb-2 text-xs uppercase tracking-[0.16em] text-stone-600">Your stories</p>
      <ul className="max-h-[200px] space-y-2 overflow-y-auto pr-1">
        {stories.map((s) => (
          <li
            key={s.id}
            className={`flex items-start justify-between gap-2 rounded-xl border p-2 transition ${
              currentStoryId === s.id
                ? "border-red-700 bg-red-50"
                : "border-stone-200 bg-stone-50/50 hover:border-stone-300"
            }`}
          >
            <button
              type="button"
              onClick={() => onLoadStory(s.id)}
              className="min-w-0 flex-1 text-left text-sm text-stone-800"
            >
              <span className="line-clamp-2">{s.prompt || "Untitled story"}</span>
              <span className="mt-1 block text-[10px] uppercase tracking-[0.08em] text-stone-500">
                {formatDate(s.updatedAt)}
              </span>
            </button>
            <button
              type="button"
              onClick={() => void handleDelete(s.id)}
              disabled={deletingId === s.id}
              className="shrink-0 rounded-full border border-stone-300 px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-stone-600 transition hover:border-red-400 hover:text-red-700 disabled:opacity-50"
            >
              {deletingId === s.id ? "…" : "Delete"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
