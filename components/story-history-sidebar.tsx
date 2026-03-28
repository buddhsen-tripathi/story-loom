"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { deleteStory, listUserStories, type StorySummary, type Timestamp } from "@/lib/firebase-db"

interface StoryHistorySidebarProps {
  userId: string
  currentStoryId: string | null
  refreshKey?: string | null
  onLoadStory: (storyId: string) => void
  onNewStory: () => void
}

function formatDate(ts: Timestamp | undefined): string {
  if (!ts?.toMillis) return "—"
  const d = new Date(ts.toMillis())
  const now = new Date()
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  })
}

function getDayGroup(ts: Timestamp | undefined): string {
  if (!ts?.toMillis) return "Older"
  const diffDays = Math.floor((Date.now() - ts.toMillis()) / 86_400_000)
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays <= 7) return "Past 7 days"
  if (diffDays <= 30) return "Past 30 days"
  return "Older"
}

const GROUP_ORDER = ["Today", "Yesterday", "Past 7 days", "Past 30 days", "Older"]

function groupStories(stories: StorySummary[]) {
  const map = new Map<string, StorySummary[]>()
  for (const s of stories) {
    const key = getDayGroup(s.updatedAt)
    map.set(key, [...(map.get(key) ?? []), s])
  }
  return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ label: g, items: map.get(g)! }))
}

function displayTitle(s: StorySummary): string {
  if (s.title) return s.title
  const t = s.prompt?.slice(0, 48) ?? "Untitled"
  return t.length < (s.prompt?.length ?? 0) ? `${t}…` : t
}

export function StoryHistorySidebar({ userId, currentStoryId, refreshKey, onLoadStory, onNewStory }: StoryHistorySidebarProps) {
  const [stories, setStories] = useState<StorySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setStories(await listUserStories(userId)) }
    finally { setLoading(false) }
  }, [userId])

  useEffect(() => { if (userId) void refresh() }, [userId, refreshKey, refresh])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
      if (e.key === "Escape" && document.activeElement === searchRef.current) {
        setQuery("")
        searchRef.current?.blur()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleDelete = useCallback(async (e: React.MouseEvent, storyId: string) => {
    e.stopPropagation()
    if (deletingId) return
    setDeletingId(storyId)
    setDeleteError(null)
    try {
      await deleteStory(storyId)
      setStories((prev) => prev.filter((s) => s.id !== storyId))
    } catch {
      setDeleteError("Failed to delete story. Please try again.")
    } finally {
      setDeletingId(null)
    }
  }, [deletingId])

  const filtered = query.trim()
    ? stories.filter((s) => {
        const q = query.toLowerCase()
        return displayTitle(s).toLowerCase().includes(q) || s.prompt?.toLowerCase().includes(q)
      })
    : stories

  const groups = groupStories(filtered)

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="gap-3 px-3 py-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] text-primary">Story Loom</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Your stories</p>
        </div>

        <button
          type="button"
          onClick={onNewStory}
          className="flex w-full items-center gap-2 rounded-full bg-primary px-3 py-2 text-xs uppercase tracking-[0.16em] text-primary-foreground transition hover:brightness-110"
        >
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="shrink-0">
            <line x1="7" y1="1" x2="7" y2="13" /><line x1="1" y1="7" x2="13" y2="7" />
          </svg>
          New Story
        </button>

        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
            <circle cx="5.5" cy="5.5" r="4" /><line x1="9" y1="9" x2="12" y2="12" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="h-8 w-full rounded-full border border-border bg-muted/50 pl-8 pr-10 text-xs text-foreground placeholder-muted-foreground outline-none transition focus:border-primary"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border px-1 py-0.5 text-[9px] text-muted-foreground">⌘K</kbd>
        </div>
      </SidebarHeader>

      <SidebarSeparator />

      <SidebarContent>
        {loading && stories.length === 0 && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {Array.from({ length: 5 }).map((_, i) => (
                  <SidebarMenuItem key={i}><SidebarMenuSkeleton /></SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {deleteError && (
          <p className="px-4 pt-2 text-center text-xs text-destructive">{deleteError}</p>
        )}

        {!loading && filtered.length === 0 && (
          <p className="px-4 pt-6 text-center text-xs text-muted-foreground">
            {query ? `No results for "${query}"` : "No stories yet."}
          </p>
        )}

        {groups.map(({ label, items }) => (
          <SidebarGroup key={label}>
            <SidebarGroupLabel className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
              {label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((s) => (
                  <SidebarMenuItem key={s.id}>
                    <SidebarMenuButton
                      isActive={currentStoryId === s.id}
                      onClick={() => onLoadStory(s.id)}
                      className="h-auto flex-col items-start gap-0 py-2 data-[active=true]:bg-primary/10 data-[active=true]:text-primary data-[active=true]:hover:bg-primary/15"
                    >
                      <span className="w-full truncate text-[12px] leading-snug">
                        {displayTitle(s)}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60 data-[active=true]:text-primary/70">
                        {formatDate(s.updatedAt)}
                      </span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      onClick={(e) => void handleDelete(e, s.id)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      {deletingId === s.id ? (
                        <div className="h-3 w-3 animate-spin rounded-full border border-border border-t-destructive" />
                      ) : (
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <line x1="1" y1="1" x2="11" y2="11" /><line x1="11" y1="1" x2="1" y2="11" />
                        </svg>
                      )}
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  )
}
