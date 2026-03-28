"use client"

import {
  Background,
  Controls,
  Edge,
  MarkerType,
  MiniMap,
  Node,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import "@xyflow/react/dist/style.css"

import { AuthModal } from "@/components/auth-modal"
import { StoryHistorySidebar } from "@/components/story-history-sidebar"
import { StoryTransitionOverlay, type AnimationState } from "@/components/story-transition-overlay"
import { NewStoryModal } from "@/components/new-story-modal"
import { PanelNode, type PanelData } from "@/components/panel-node"
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { useAuth } from "@/hooks/use-auth"
import {
  createStory,
  loadStory,
  saveBranch,
  saveEdges,
  savePanel,
  saveVideoUrl,
  updateStoryTitle,
  type EdgeDoc,
  type PanelDoc,
} from "@/lib/firebase-db"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoryPanelSeed {
  title: string
  caption: string
  imagePrompt: string
}

interface GeneratedPanel extends StoryPanelSeed {
  imageUrl: string
}

interface BranchEntry {
  id: string
  sourceNodeId: string
  label: string
  edgeColor: string
  nodeColor: string
}

interface StreamPanelEvent {
  type: "panel"
  index: number
  panel: GeneratedPanel
}

interface StreamTitleEvent {
  type: "title"
  title: string
}

interface StreamDoneEvent {
  type: "done"
  panelCount: number
  expectedPanelCount?: number
}

interface StreamErrorEvent {
  type: "error"
  error: string
}

interface TaskStep {
  label: string
  status: "pending" | "running" | "done" | "error"
}

interface ChatMessage {
  id: string
  role: "assistant" | "user"
  text: string
  tasks?: TaskStep[]
  action?: { type: "play-video"; branchId: string }
  suggestions?: string[]
}

type FlowNode = Node<PanelData>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const batchPanelCount = 3

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

interface SlashCommand {
  name: string
  description: string
  hasArg: boolean
  argHint?: string
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/get-inspiration",
    description: "Get ideas to progress your story",
    hasArg: true,
    argHint: "optional focus, e.g. 'raise the stakes'",
  },
]

function updateTaskInMessage(
  messages: ChatMessage[],
  messageId: string,
  taskIndex: number,
  update: Partial<TaskStep>,
): ChatMessage[] {
  return messages.map((m) => {
    if (m.id !== messageId || !m.tasks) return m
    const tasks = m.tasks.map((t, i) => (i === taskIndex ? { ...t, ...update } : t))
    return { ...m, tasks }
  })
}

const BRANCH_PALETTES = [
  { edgeColor: "#ef4444", nodeColor: "#ef4444", label: "Crimson route" },
  { edgeColor: "#14b8a6", nodeColor: "#14b8a6", label: "Jade route" },
  { edgeColor: "#f59e0b", nodeColor: "#f59e0b", label: "Amber route" },
  { edgeColor: "#60a5fa", nodeColor: "#60a5fa", label: "Sapphire route" },
]

const MAIN_BRANCH: BranchEntry = {
  id: "main",
  sourceNodeId: "",
  label: "Main story",
  edgeColor: "#a07830",
  nodeColor: "#a07830",
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function parsePanelNumber(nodeId: string) {
  return parseInt(nodeId.replace(/.*-p/, ""), 10)
}

function sortByPanelNumber(a: FlowNode, b: FlowNode) {
  return parsePanelNumber(a.id) - parsePanelNumber(b.id)
}

function nodeIdFor(branchId: string, panelIndex: number) {
  return `${branchId}-p${panelIndex}`
}

function branchIdOfNode(nodeId: string) {
  return nodeId.replace(/-p\d+$/, "")
}

/**
 * Trace the full story context from the root of the tree down to `targetNodeId`,
 * following branch ancestry so Gemini has the complete prior narrative.
 */
function collectFullContext({
  targetNodeId,
  branchMap,
  nodes,
}: {
  targetNodeId: string
  branchMap: Map<string, BranchEntry>
  nodes: FlowNode[]
}): StoryPanelSeed[] {
  const branchId = branchIdOfNode(targetNodeId)
  const upToPanel = parsePanelNumber(targetNodeId)
  const branch = branchMap.get(branchId)

  const ancestorContext: StoryPanelSeed[] = branch?.sourceNodeId
    ? collectFullContext({ targetNodeId: branch.sourceNodeId, branchMap, nodes })
    : []

  const ownPanels = nodes
    .filter((n) => {
      if (branchIdOfNode(n.id) !== branchId) return false
      if (n.data.isLoading || !n.data.imageUrl) return false
      return parsePanelNumber(n.id) <= upToPanel
    })
    .sort(sortByPanelNumber)
    .map((n) => ({
      title: n.data.title,
      caption: n.data.caption,
      imagePrompt: n.data.imagePrompt || n.data.caption,
    }))

  return [...ancestorContext, ...ownPanels]
}

/**
 * Like collectFullContext but returns full FlowNode references so callers
 * can access imageUrl and node ID directly (used by animation).
 */
function collectAncestorNodes({
  targetNodeId,
  branchMap,
  nodes,
}: {
  targetNodeId: string
  branchMap: Map<string, BranchEntry>
  nodes: FlowNode[]
}): FlowNode[] {
  const branchId = branchIdOfNode(targetNodeId)
  const upToPanel = parsePanelNumber(targetNodeId)
  const branch = branchMap.get(branchId)

  const ancestors: FlowNode[] = branch?.sourceNodeId
    ? collectAncestorNodes({ targetNodeId: branch.sourceNodeId, branchMap, nodes })
    : []

  const ownNodes = nodes
    .filter((n) => {
      if (branchIdOfNode(n.id) !== branchId) return false
      if (n.data.isLoading || !n.data.imageUrl) return false
      return parsePanelNumber(n.id) <= upToPanel
    })
    .sort(sortByPanelNumber)

  return [...ancestors, ...ownNodes]
}

function buildEdgesForNewNodes({
  nodeIds,
  entrySourceId,
  color,
}: {
  nodeIds: string[]
  entrySourceId?: string
  color: string
}): Edge[] {
  const edges: Edge[] = []
  if (!nodeIds.length) return edges

  const mkEdge = (source: string, target: string, width: number): Edge => ({
    id: `${source}->${target}`,
    source,
    target,
    animated: true,
    style: { stroke: color, strokeWidth: width },
    markerEnd: { type: MarkerType.ArrowClosed, color },
  })

  if (entrySourceId) edges.push(mkEdge(entrySourceId, nodeIds[0], 3))
  for (let i = 1; i < nodeIds.length; i += 1) {
    edges.push(mkEdge(nodeIds[i - 1], nodeIds[i], 2))
  }
  return edges
}

function makePlaceholderNode({
  id,
  x,
  y,
  branchId,
  styleLabel,
  branchColor,
  onBranch,
  onAnimate,
}: {
  id: string
  x: number
  y: number
  branchId: string
  styleLabel: string
  branchColor: string
  onBranch: (nodeId: string) => void
  onAnimate: (branchId: string) => void
}): FlowNode {
  return {
    id,
    type: "panelNode",
    position: { x, y },
    data: {
      branchId,
      title: "Rendering…",
      caption: "Generating panel.",
      imageUrl: "",
      imagePrompt: "",
      styleLabel,
      branchColor,
      isLoading: true,
      hasFailed: false,
      onBranch,
      onAnimate,
    },
  }
}

// ---------------------------------------------------------------------------
// Stream helper
// ---------------------------------------------------------------------------

async function streamPanels({
  prompt,
  priorPanels,
  panelCount,
  generateTitle,
  onPanel,
  onTitle,
  signal,
}: {
  prompt: string
  priorPanels: StoryPanelSeed[]
  panelCount: number
  generateTitle?: boolean
  onPanel: (input: { panel: GeneratedPanel; index: number }) => void
  onTitle?: (title: string) => void
  signal?: AbortSignal
}) {
  const response = await fetch("/api/generate-panels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, priorPanels, panelCount, generateTitle }),
    signal,
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error || "Failed to start panel stream")
  }
  if (!response.body) throw new Error("Panel stream body is missing")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  function handleLine(line: string) {
    if (!line.trim()) return
    const event = JSON.parse(line) as StreamPanelEvent | StreamTitleEvent | StreamDoneEvent | StreamErrorEvent
    if (event.type === "title" && onTitle) onTitle(event.title)
    if (event.type === "panel") onPanel({ panel: event.panel, index: event.index })
    if (event.type === "error") throw new Error(event.error)
  }

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    let nl = buffer.indexOf("\n")
    while (nl >= 0) {
      handleLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf("\n")
    }
    if (done) break
  }
  if (buffer.trim()) handleLine(buffer)
}

// ---------------------------------------------------------------------------
// withHandlers — inject fresh callbacks without mutating node state
// ---------------------------------------------------------------------------

function withHandlers({
  nodes,
  onBranch,
  onAnimate,
}: {
  nodes: FlowNode[]
  onBranch: (nodeId: string) => void
  onAnimate: (branchId: string, nodeId: string) => void
}) {
  return nodes.map((node) => ({
    ...node,
    data: { ...node.data, onBranch, onAnimate },
  }))
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const nodeTypes = { panelNode: PanelNode }

function sessionKey(userId: string) {
  return `story-loom:session:${userId}`
}

function saveSession(userId: string, storyId: string, activeBranchId: string) {
  localStorage.setItem(sessionKey(userId), JSON.stringify({ storyId, activeBranchId }))
}

function loadSession(userId: string): { storyId: string; activeBranchId: string } | null {
  try {
    const raw = localStorage.getItem(sessionKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.storyId) return parsed
  } catch { /* corrupted data */ }
  return null
}

function clearSession(userId: string) {
  localStorage.removeItem(sessionKey(userId))
}

export function StoryLoomWorkbench() {
  const auth = useAuth()
  const [storyId, setStoryId] = useState<string | null>(null)
  const [storyTitle, setStoryTitle] = useState<string | null>(null)
  const [showNewStoryModal, setShowNewStoryModal] = useState(false)

  const [promptInput, setPromptInput] = useState("")
  const [chatInput, setChatInput] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)

  const [branchMap, setBranchMap] = useState<Map<string, BranchEntry>>(() => new Map([["main", MAIN_BRANCH]]))
  const [activeBranchId, setActiveBranchId] = useState("main")
  const branchCounter = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const [animation, setAnimation] = useState<AnimationState>({ open: false, branchId: "main", images: [] })
  const [pendingBranch, setPendingBranch] = useState<{ sourceNodeId: string } | null>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  const [slashFilter, setSlashFilter] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "m1",
      role: "assistant",
      text: "Describe your story and press Generate. Chat to extend it. Branch from any panel to fork the timeline. Type / for commands.",
    },
  ])

  const filteredSlashCommands = useMemo(() => {
    if (!slashFilter) return SLASH_COMMANDS
    const q = slashFilter.toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
  }, [slashFilter])

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const fillPanel = useCallback(
    ({
      panelIds,
      panel,
      index,
      storyId: sid,
      position,
    }: {
      panelIds: string[]
      panel: GeneratedPanel
      index: number
      storyId?: string | null
      position?: { x: number; y: number }
    }) => {
      const nodeId = panelIds[index]
      if (!nodeId) return
      const branchId = branchIdOfNode(nodeId)
      const panelNum = parsePanelNumber(nodeId)
      setNodes((current) => {
        let resolvedPosition = position
        return current.map((n) => {
          if (n.id !== nodeId) return n
          if (!resolvedPosition) resolvedPosition = n.position
          const updated = {
            ...n,
            data: {
              ...n.data,
              title: panel.title,
              caption: panel.caption,
              imagePrompt: panel.imagePrompt,
              imageUrl: panel.imageUrl,
              isLoading: false,
              hasFailed: false,
            },
          }
          if (sid && resolvedPosition) {
            const doc: PanelDoc = {
              id: nodeId,
              branchId,
              panelNum,
              title: panel.title,
              caption: panel.caption,
              imageUrl: panel.imageUrl,
              imagePrompt: panel.imagePrompt,
              positionX: resolvedPosition.x,
              positionY: resolvedPosition.y,
            }
            void savePanel(sid, doc)
          }
          return updated
        })
      })
    },
    [setNodes],
  )

  // ------- mark a set of nodes as failed (keeps them visible, avoids empty src) -------
  const markFailed = useCallback(
    (panelIds: string[]) => {
      setNodes((current) =>
        current.map((n) =>
          panelIds.includes(n.id)
            ? { ...n, data: { ...n.data, isLoading: false, hasFailed: true } }
            : n,
        ),
      )
    },
    [setNodes],
  )

  // ------- extend any branch with the next batchPanelCount panels -------
  const extendBranch = useCallback(
    async ({
      branchId,
      directionPrompt,
      overrideStoryId,
      storyPrompt,
      generateTitle,
      onTitle,
      onPanelProgress,
      signal,
    }: {
      branchId: string
      directionPrompt: string
      overrideStoryId?: string | null
      storyPrompt?: string
      generateTitle?: boolean
      onTitle?: (title: string) => void
      onPanelProgress?: (index: number) => void
      signal?: AbortSignal
    }) => {
      const effectiveStoryId = overrideStoryId !== undefined ? overrideStoryId : storyId
      const branch = branchMap.get(branchId)
      if (!branch) return

      const existingNodes = nodes
        .filter((n) => branchIdOfNode(n.id) === branchId)
        .sort(sortByPanelNumber)
      const startPanel = existingNodes.length + 1

      const placeholders: FlowNode[] = Array.from({ length: batchPanelCount }, (_, i) => {
        const panelNum = startPanel + i
        const isMainBranch = branchId === "main"
        return makePlaceholderNode({
          id: nodeIdFor(branchId, panelNum),
          x: isMainBranch ? 80 + (panelNum - 1) * 235 : existingNodes.length > 0
            ? (existingNodes[0]?.position.x ?? 200) + (panelNum - 1) * 210
            : 200 + (panelNum - 1) * 210,
          y: isMainBranch ? 80 + ((panelNum - 1) % 2) * 150 : (existingNodes[0]?.position.y ?? 300),
          branchId,
          styleLabel: branch.label,
          branchColor: branch.nodeColor,
          onBranch: () => {},
          onAnimate: () => {},
        })
      })
      const panelIds = placeholders.map((n) => n.id)
      const entrySourceId =
        existingNodes.length > 0 ? existingNodes[existingNodes.length - 1]?.id : undefined

      const newEdges = buildEdgesForNewNodes({ nodeIds: panelIds, entrySourceId, color: branch.edgeColor })
      setNodes((cur) => [...cur, ...placeholders])
      setEdges((cur) => [...cur, ...newEdges])

      if (effectiveStoryId) {
        const edgeDocs: EdgeDoc[] = newEdges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          color: (e.style?.stroke as string) ?? branch.edgeColor,
          animated: e.animated ?? true,
          strokeWidth: (e.style?.strokeWidth as number) ?? 2,
        }))
        void saveEdges(effectiveStoryId, edgeDocs)
      }

      const lastExisting = existingNodes.filter((n) => !n.data.isLoading && n.data.imageUrl).at(-1)
      const priorPanels = lastExisting
        ? collectFullContext({ targetNodeId: lastExisting.id, branchMap, nodes })
        : []

      const resolvedPrompt = storyPrompt ?? promptInput
      try {
        await streamPanels({
          prompt: `${resolvedPrompt.trim()}\nDirection: ${directionPrompt}`,
          priorPanels,
          panelCount: batchPanelCount,
          generateTitle,
          onTitle,
          signal,
          onPanel: ({ panel, index }) => {
            fillPanel({
              panelIds,
              panel,
              index,
              storyId: effectiveStoryId,
              position: placeholders[index]?.position,
            })
            onPanelProgress?.(index)
          },
        })
      } catch {
        markFailed(panelIds)
      }
    },
    [branchMap, fillPanel, markFailed, nodes, promptInput, setEdges, setNodes, storyId],
  )

  // ------- branch from any panel — ask for direction first -------
  const spawnBranch = useCallback(
    (sourceNodeId: string) => {
      const sourceNode = nodes.find((n) => n.id === sourceNodeId)
      if (!sourceNode || sourceNode.data.isLoading) return

      setPendingBranch({ sourceNodeId })
      setMessages((cur) => [
        ...cur,
        {
          id: `m-${Date.now()}-branch-ask`,
          role: "assistant",
          text: `Where should this fork go? Describe the new direction for the branch from panel ${sourceNodeId}, then hit Send.`,
        },
      ])
    },
    [nodes],
  )

  // ------- actually create and stream the branch once direction is known -------
  const executeBranch = useCallback(
    async ({ sourceNodeId, directionPrompt, onPanelProgress }: { sourceNodeId: string; directionPrompt: string; onPanelProgress?: (index: number) => void }) => {
      const sourceNode = nodes.find((n) => n.id === sourceNodeId)
      if (!sourceNode) {
        setMessages((cur) => [
          ...cur,
          {
            id: `m-${Date.now()}-branch-err`,
            role: "assistant",
            text: `Cannot branch: source panel "${sourceNodeId}" no longer exists.`,
          },
        ])
        return
      }

      branchCounter.current += 1
      const newBranchId = `b${branchCounter.current}`
      const paletteIndex = (branchCounter.current - 1) % BRANCH_PALETTES.length
      const palette = BRANCH_PALETTES[paletteIndex]

      const newBranch: BranchEntry = {
        id: newBranchId,
        sourceNodeId,
        label: palette.label,
        edgeColor: palette.edgeColor,
        nodeColor: palette.nodeColor,
      }

      setBranchMap((cur) => new Map([...cur, [newBranchId, newBranch]]))
      setActiveBranchId(newBranchId)

      const placeholders: FlowNode[] = Array.from({ length: batchPanelCount }, (_, i) =>
        makePlaceholderNode({
          id: nodeIdFor(newBranchId, i + 1),
          x: sourceNode.position.x + 220 + i * 210,
          y: sourceNode.position.y + 240 + branchCounter.current * 100 + (i % 2) * 80,
          branchId: newBranchId,
          styleLabel: palette.label,
          branchColor: palette.nodeColor,
          onBranch: () => {},
          onAnimate: () => {},
        }),
      )
      const panelIds = placeholders.map((n) => n.id)
      const newEdges = buildEdgesForNewNodes({
        nodeIds: panelIds,
        entrySourceId: sourceNodeId,
        color: palette.edgeColor,
      })

      setNodes((cur) => [...cur, ...placeholders])
      setEdges((cur) => [...cur, ...newEdges])

      if (storyId) {
        void saveBranch(storyId, newBranch)
        const edgeDocs: EdgeDoc[] = newEdges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          color: (e.style?.stroke as string) ?? palette.edgeColor,
          animated: e.animated ?? true,
          strokeWidth: (e.style?.strokeWidth as number) ?? 2,
        }))
        void saveEdges(storyId, edgeDocs)
      }

      setMessages((cur) => [
        ...cur,
        {
          id: `m-${Date.now()}-branch-gen`,
          role: "assistant",
          text: `Forking to ${palette.label}…`,
        },
      ])

      const priorPanels = collectFullContext({ targetNodeId: sourceNodeId, branchMap, nodes })

      try {
        await streamPanels({
          prompt: `${promptInput.trim()}\nDirection: ${directionPrompt}`,
          priorPanels,
          panelCount: batchPanelCount,
          onPanel: ({ panel, index }) => {
            fillPanel({
              panelIds,
              panel,
              index,
              storyId,
              position: placeholders[index]?.position,
            })
            onPanelProgress?.(index)
          },
        })
        setMessages((cur) => [
          ...cur,
          {
            id: `m-${Date.now()}-branch-done`,
            role: "assistant",
            text: `${palette.label} is ready. Chat to keep building this branch.`,
          },
        ])
      } catch (error) {
        markFailed(panelIds)
        const msg = error instanceof Error ? error.message : "Branch generation failed."
        setMessages((cur) => [
          ...cur,
          {
            id: `m-${Date.now()}-branch-err`,
            role: "assistant",
            text: `Branch failed: ${msg}`,
          },
        ])
      }
    },
    [branchMap, fillPanel, markFailed, nodes, promptInput, setEdges, setNodes, storyId],
  )

  // ------- open animation for a specific branch -------
  const openAnimation = useCallback(
    (branchId: string, upToNodeId?: string) => {
      const branch = branchMap.get(branchId)
      if (!branch) return

      const upToPanel = upToNodeId ? parsePanelNumber(upToNodeId) : Infinity

      // Build ordered panel list up to the clicked panel
      const ownPanels = nodes
        .filter((n) => {
          if (branchIdOfNode(n.id) !== branchId) return false
          if (n.data.isLoading || !n.data.imageUrl) return false
          return parsePanelNumber(n.id) <= upToPanel
        })
        .sort(sortByPanelNumber)

      if (!ownPanels.length) return

      // Prepend ancestor panels if any
      const ancestorImages: { panelId: string; url: string; title: string; caption: string; videoUrl?: string }[] = branch.sourceNodeId
        ? collectAncestorNodes({ targetNodeId: branch.sourceNodeId, branchMap, nodes }).map((n) => ({
            panelId: n.id,
            url: n.data.imageUrl,
            title: n.data.title,
            caption: n.data.caption,
            videoUrl: n.data.videoUrl,
          }))
        : []

      const ownImages = ownPanels.map((n) => ({
        panelId: n.id,
        url: n.data.imageUrl,
        title: n.data.title,
        caption: n.data.caption,
        videoUrl: n.data.videoUrl,
      }))

      const images = [...ancestorImages, ...ownImages]

      if (images.length < 2) {
        setMessages((cur) => [
          ...cur,
          {
            id: `m-${Date.now()}-anim-warn`,
            role: "assistant",
            text: "Need at least 2 panels to animate.",
          },
        ])
        return
      }

      const animStatusId = `m-${Date.now()}-anim-status`
      const animTasks: TaskStep[] = images.map((img, i) => ({
        label: `Animating frame ${i + 1}`,
        status: "pending" as const,
      }))
      setMessages((cur) => [
        ...cur,
        {
          id: animStatusId,
          role: "assistant",
          text: `Animating ${branch.label} (${images.length} frames)…`,
          tasks: animTasks,
        },
      ])

      setAnimation({ open: true, branchId, storyId: storyId ?? undefined, images, statusMessageId: animStatusId })
    },
    [branchMap, nodes, storyId],
  )

  const handleGenerate = useCallback(async (
    overridePrompt?: string,
    overrideTitle?: string | null,
    shouldGenerateTitle?: boolean,
  ) => {
    const trimmedPrompt = (overridePrompt ?? promptInput).trim()
    if (!trimmedPrompt) return
    if (!auth.user) return

    // Abort any in-flight generation
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    if (overridePrompt) setPromptInput(overridePrompt)
    if (overrideTitle) setStoryTitle(overrideTitle)

    setIsGenerating(true)
    setStoryId(null)
    if (!overrideTitle) setStoryTitle(null)
    setNodes([])
    setEdges([])
    setBranchMap(new Map([["main", MAIN_BRANCH]]))
    setActiveBranchId("main")
    branchCounter.current = 0
    if (auth.user) clearSession(auth.user.uid)

    // Build task-based status message
    const statusId = `m-${Date.now()}-status`
    const needsTitle = shouldGenerateTitle && !overrideTitle
    const initialTasks: TaskStep[] = []
    if (needsTitle) {
      initialTasks.push({ label: "Generating title", status: "pending" })
    }
    for (let i = 1; i <= batchPanelCount; i++) {
      initialTasks.push({ label: `Generating frame ${i}`, status: "pending" })
    }

    setMessages((cur) => [
      ...cur,
      { id: `m-${Date.now()}-u`, role: "user", text: `Start: ${trimmedPrompt}` },
      { id: statusId, role: "assistant", text: "Creating your story…", tasks: initialTasks },
    ])

    // Mark title task as running
    const titleTaskIdx = needsTitle ? 0 : -1
    const panelTaskOffset = needsTitle ? 1 : 0

    if (needsTitle) {
      setMessages((cur) => updateTaskInMessage(cur, statusId, titleTaskIdx, { status: "running" }))
    }

    let sid: string | null = null
    if (auth.user) {
      sid = await Promise.race([
        createStory({
          userId: auth.user.uid,
          prompt: trimmedPrompt,
          title: overrideTitle ?? undefined,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]).catch(() => null)
      if (sid) setStoryId(sid)
    }

    // Mark first panel task as running
    setMessages((cur) => updateTaskInMessage(cur, statusId, panelTaskOffset, { status: "running" }))

    try {
      await extendBranch({
        branchId: "main",
        directionPrompt: "Open the story with a compelling inciting incident.",
        overrideStoryId: sid,
        storyPrompt: trimmedPrompt,
        generateTitle: needsTitle || undefined,
        onTitle: (title) => {
          setStoryTitle(title)
          if (sid) void updateStoryTitle(sid, title)
          if (titleTaskIdx >= 0) {
            setMessages((cur) => updateTaskInMessage(cur, statusId, titleTaskIdx, { status: "done", label: `Title: ${title}` }))
          }
        },
        onPanelProgress: (index) => {
          // Mark completed panel
          setMessages((cur) => updateTaskInMessage(cur, statusId, panelTaskOffset + index, { status: "done" }))
          // Mark next panel as running if there is one
          if (index + 1 < batchPanelCount) {
            setMessages((cur) => updateTaskInMessage(cur, statusId, panelTaskOffset + index + 1, { status: "running" }))
          }
        },
        signal: controller.signal,
      })
      // Persist title to Firestore if provided manually
      if (sid && overrideTitle) {
        void updateStoryTitle(sid, overrideTitle)
      }
      setMessages((cur) => [
        ...cur,
        {
          id: `m-${Date.now()}-done`,
          role: "assistant",
          text: "Opening beat ready. Chat to continue, or branch from any panel.",
        },
      ])
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Generation failed."
      setMessages((cur) => [...cur, { id: `m-${Date.now()}-err`, role: "assistant", text: `Error: ${msg}` }])
    } finally {
      setIsGenerating(false)
    }
  }, [auth.user, extendBranch, promptInput, setEdges, setNodes])

  const handleLoadStory = useCallback(
    async (id: string) => {
      const loaded = await loadStory(id)
      if (!loaded) return
      const branchMapLoaded = new Map<string, BranchEntry>(
        loaded.branches.map((b) => [b.id, { ...b, sourceNodeId: b.sourceNodeId ?? "" }])
      )
      setBranchMap(branchMapLoaded)
      setPromptInput(loaded.prompt)
      setStoryId(loaded.storyId)
      setStoryTitle(loaded.title ?? null)
      setPendingBranch(null)

      const maxBranchNum = loaded.branches.reduce((acc, b) => {
        const m = b.id.match(/^b(\d+)$/)
        return m ? Math.max(acc, parseInt(m[1], 10)) : acc
      }, 0)
      branchCounter.current = maxBranchNum

      const nodesFromPanels: FlowNode[] = loaded.panels.map((p) => {
        const branch = branchMapLoaded.get(p.branchId)
        return {
          id: p.id,
          type: "panelNode",
          position: { x: p.positionX, y: p.positionY },
          data: {
            branchId: p.branchId,
            title: p.title,
            caption: p.caption,
            imageUrl: p.imageUrl,
            imagePrompt: p.imagePrompt,
            styleLabel: branch?.label ?? p.branchId,
            branchColor: branch?.nodeColor ?? "#111827",
            isLoading: false,
            hasFailed: p.hasFailed ?? false,
            videoUrl: p.videoUrl,
            videoKey: p.videoKey,
            onBranch: () => {},
            onAnimate: () => {},
          },
        }
      })

      const edgesFromDocs: Edge[] = loaded.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.animated ?? true,
        style: { stroke: e.color, strokeWidth: e.strokeWidth ?? 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: e.color },
      }))

      setNodes(nodesFromPanels)
      setEdges(edgesFromDocs)
      setActiveBranchId(loaded.branches.length ? loaded.branches[loaded.branches.length - 1]!.id : "main")
      const displayName = loaded.title ?? `${loaded.prompt.slice(0, 60)}${loaded.prompt.length > 60 ? "…" : ""}`
      setMessages([
        {
          id: "m-load",
          role: "assistant",
          text: `Loaded "${displayName}". Chat to continue or branch from any panel.`,
        },
      ])
    },
    [setEdges, setNodes]
  )

  // ------- /get-inspiration — fetch actionable ideas to progress the story -------
  const handleGetInspiration = useCallback(async (message?: string) => {
    setIsGenerating(true)
    const displayText = message ? `/get-inspiration ${message}` : "/get-inspiration"
    const statusId = `m-${Date.now()}-insp`
    setMessages((cur) => [
      ...cur,
      { id: `m-${Date.now()}-u`, role: "user", text: displayText },
      { id: statusId, role: "assistant", text: "Thinking about where your story could go…", tasks: [{ label: "Gathering inspiration", status: "running" as const }] },
    ])

    // Build prior panel context from active branch
    const branchNodes = nodes
      .filter((n) => branchIdOfNode(n.id) === activeBranchId && !n.data.isLoading && !!n.data.imageUrl)
      .sort(sortByPanelNumber)
    const lastNode = branchNodes.at(-1)
    const priorPanels = lastNode
      ? collectFullContext({ targetNodeId: lastNode.id, branchMap, nodes })
      : []

    try {
      const res = await fetch("/api/get-inspiration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: promptInput, priorPanels, message }),
      })

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(payload?.error ?? "Failed to fetch inspiration")
      }

      const data = (await res.json()) as {
        nextBeats: string[]
        references: { title: string; type: string; lesson: string }[]
        wildcards: string[]
      }

      setMessages((cur) => updateTaskInMessage(cur, statusId, 0, { status: "done", label: "Inspiration ready" }))

      const lines: string[] = []

      if (data.nextBeats?.length) {
        lines.push("Next beats you could try:")
        data.nextBeats.forEach((beat, i) => {
          lines.push(`  ${i + 1}. ${beat}`)
        })
      }

      if (data.references?.length) {
        lines.push("")
        lines.push("Borrowed from the greats:")
        data.references.forEach((ref) => {
          lines.push(`  ${ref.title} (${ref.type}) — ${ref.lesson}`)
        })
      }

      if (data.wildcards?.length) {
        lines.push("")
        lines.push("Wildcard moves:")
        data.wildcards.forEach((wc) => lines.push(`  ${wc}`))
      }

      // Collect all actionable suggestions for click-to-use
      const suggestions = [
        ...(data.nextBeats ?? []),
        ...(data.wildcards ?? []),
      ]

      setMessages((cur) => [
        ...cur,
        {
          id: `m-${Date.now()}-insp-result`,
          role: "assistant",
          text: lines.join("\n"),
          suggestions,
        },
      ])
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Inspiration failed."
      setMessages((cur) => updateTaskInMessage(cur, statusId, 0, { status: "error", label: msg }))
    } finally {
      setIsGenerating(false)
    }
  }, [activeBranchId, branchMap, nodes, promptInput])

  // ------- chat: either fulfils a pending branch or continues the active branch -------
  const handleChatSend = useCallback(async () => {
    const text = chatInput.trim()
    if (!text) return
    setChatInput("")

    // Slash command: /get-inspiration [optional message]
    if (text.startsWith("/get-inspiration")) {
      const arg = text.slice("/get-inspiration".length).trim() || undefined
      void handleGetInspiration(arg)
      return
    }

    setIsGenerating(true)
    setMessages((cur) => [...cur, { id: `m-${Date.now()}-u`, role: "user", text }])

    if (pendingBranch) {
      const { sourceNodeId } = pendingBranch
      setPendingBranch(null)
      const branchStatusId = `m-${Date.now()}-branch-status`
      const branchTasks: TaskStep[] = Array.from({ length: batchPanelCount }, (_, i) => ({
        label: `Generating frame ${i + 1}`,
        status: (i === 0 ? "running" : "pending") as TaskStep["status"],
      }))
      setMessages((cur) => [
        ...cur,
        { id: branchStatusId, role: "assistant", text: "Forking timeline…", tasks: branchTasks },
      ])
      try {
        await executeBranch({
          sourceNodeId,
          directionPrompt: text,
          onPanelProgress: (index) => {
            setMessages((cur) => updateTaskInMessage(cur, branchStatusId, index, { status: "done" }))
            if (index + 1 < batchPanelCount) {
              setMessages((cur) => updateTaskInMessage(cur, branchStatusId, index + 1, { status: "running" }))
            }
          },
        })
      } finally {
        setIsGenerating(false)
      }
      return
    }

    const contStatusId = `m-${Date.now()}-cont-status`
    const branchLabel = branchMap.get(activeBranchId)?.label ?? activeBranchId
    const contTasks: TaskStep[] = Array.from({ length: batchPanelCount }, (_, i) => ({
      label: `Generating frame ${i + 1}`,
      status: (i === 0 ? "running" : "pending") as TaskStep["status"],
    }))
    setMessages((cur) => [
      ...cur,
      { id: contStatusId, role: "assistant", text: `Continuing ${branchLabel}…`, tasks: contTasks },
    ])

    try {
      await extendBranch({
        branchId: activeBranchId,
        directionPrompt: text,
        onPanelProgress: (index) => {
          setMessages((cur) => updateTaskInMessage(cur, contStatusId, index, { status: "done" }))
          if (index + 1 < batchPanelCount) {
            setMessages((cur) => updateTaskInMessage(cur, contStatusId, index + 1, { status: "running" }))
          }
        },
      })
      setMessages((cur) => [
        ...cur,
        {
          id: `m-${Date.now()}-done`,
          role: "assistant",
          text: "Next beat ready. Keep chatting or branch from any panel.",
        },
      ])
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Continuation failed."
      setMessages((cur) => [...cur, { id: `m-${Date.now()}-err`, role: "assistant", text: `Error: ${msg}` }])
    } finally {
      setIsGenerating(false)
    }
  }, [activeBranchId, branchMap, chatInput, executeBranch, extendBranch, handleGetInspiration, pendingBranch])

  const nodeCount = nodes.length
  const branchNodeCount = useMemo(
    () => nodes.filter((n) => branchIdOfNode(n.id) !== "main").length,
    [nodes],
  )

  const hydratedNodes = useMemo(
    () => withHandlers({ nodes, onBranch: spawnBranch, onAnimate: openAnimation }),
    [nodes, spawnBranch, openAnimation],
  )

  const branchList = useMemo(() => [...branchMap.values()], [branchMap])

  // Persist session (storyId + activeBranchId) to localStorage, scoped by user
  useEffect(() => {
    if (auth.user && storyId) {
      saveSession(auth.user.uid, storyId, activeBranchId)
    }
  }, [auth.user, storyId, activeBranchId])

  // Auto-load last story on mount (only once when auth resolves)
  const hasAutoLoaded = useRef(false)
  useEffect(() => {
    if (!auth.user || hasAutoLoaded.current) return
    hasAutoLoaded.current = true
    const session = loadSession(auth.user.uid)
    if (session) {
      handleLoadStory(session.storyId).then(() => {
        setActiveBranchId(session.activeBranchId)
      })
    }
  }, [auth.user, handleLoadStory])

  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  if (auth.loading) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-background">
        <p className="text-sm uppercase tracking-widest text-muted-foreground">Loading…</p>
      </main>
    )
  }

  if (!auth.user) {
    return (
      <main className="min-h-svh bg-background p-3 md:p-5">
        <AuthModal auth={auth} />
      </main>
    )
  }

  return (
    <SidebarProvider
      defaultOpen
      className="h-svh overflow-hidden bg-background text-foreground"
      style={{ "--sidebar-width": "220px" } as React.CSSProperties}
    >
      {showNewStoryModal && (
        <NewStoryModal
          onConfirm={(idea, title, genTitle) => {
            setShowNewStoryModal(false)
            void handleGenerate(idea, title, genTitle)
          }}
          onClose={() => setShowNewStoryModal(false)}
        />
      )}

      {animation.open && (
        <StoryTransitionOverlay
          key={animation.branchId}
          animation={animation}
          onClose={() => setAnimation((cur) => ({ ...cur, open: false }))}
          onClipProgress={(panelIndex, status) => {
            if (!animation.statusMessageId) return
            setMessages((cur) =>
              updateTaskInMessage(cur, animation.statusMessageId!, panelIndex, { status })
            )
          }}
          onVideoSaved={(panelId, videoUrl, videoKey) => {
            if (storyId) void saveVideoUrl(storyId, panelId, videoUrl, videoKey)
            setNodes((cur) =>
              cur.map((n) => (n.id === panelId ? { ...n, data: { ...n.data, videoUrl, videoKey } } : n))
            )
          }}
          onAllClipsDone={(branchId) => {
            const branchLabel = branchMap.get(branchId)?.label ?? branchId
            setMessages((cur) => [
              ...cur,
              {
                id: `m-${Date.now()}-video-ready`,
                role: "assistant",
                text: `${branchLabel} video is ready.`,
                action: { type: "play-video", branchId },
              },
            ])
          }}
        />
      )}

      <StoryHistorySidebar
        userId={auth.user.uid}
        currentStoryId={storyId}
        refreshKey={storyId}
        onLoadStory={handleLoadStory}
        onNewStory={() => setShowNewStoryModal(true)}
      />

      {/* ---- Right area: director + canvas ---- */}
      <div className="flex flex-1 gap-3 overflow-hidden p-3">

        {/* ---- Director sidebar ---- */}
        <aside className="flex w-[340px] shrink-0 flex-col rounded-2xl border border-border bg-card shadow-lg dark:shadow-[0_14px_40px_rgba(0,0,0,0.4)]">
          {/* Header */}
          <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-4">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <SidebarTrigger className="-ml-1 mt-0.5 shrink-0 text-muted-foreground hover:text-foreground" />
              <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-[0.22em] text-primary">Director Chat</p>
              {storyTitle ? (
                <h1 className="mt-1.5 line-clamp-2 font-['Iowan_Old_Style','Baskerville','Palatino','serif'] text-xl leading-tight text-foreground">
                  {storyTitle}
                </h1>
              ) : (
                <h1 className="mt-1.5 font-['Iowan_Old_Style','Baskerville','Palatino','serif'] text-xl leading-tight text-muted-foreground">
                  No story open
                </h1>
              )}
              <p className="mt-1 text-[11px] text-muted-foreground">Each turn extends the active branch by 3 panels.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void auth.signOut()}
              className="shrink-0 rounded-full border border-border px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              Sign out
            </button>
          </div>

          {/* Empty state — no story open */}
          {!storyId && !isGenerating && nodes.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <div className="rounded-2xl border border-dashed border-border p-6">
                <p className="text-sm text-muted-foreground">No story open yet.</p>
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Create a new story from the history panel, or select one from your library.
                </p>
                <button
                  type="button"
                  onClick={() => setShowNewStoryModal(true)}
                  className="mt-4 rounded-full bg-primary px-5 py-2 text-xs uppercase tracking-[0.16em] text-primary-foreground transition hover:brightness-110"
                >
                  New Story
                </button>
              </div>
            </div>
          )}

          {/* Story is loaded / generating */}
          {(storyId || isGenerating || nodes.length > 0) && (
            <>
              {/* Branch switcher */}
              {branchList.length > 1 && (
                <div className="border-b border-border px-4 py-3">
                  <p className="mb-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Active branch</p>
                  <div className="flex flex-wrap gap-1.5">
                    {branchList.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => setActiveBranchId(b.id)}
                        className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.1em] transition"
                        style={{
                          background: activeBranchId === b.id ? b.nodeColor : "transparent",
                          color: activeBranchId === b.id ? "#fff" : b.nodeColor,
                          border: `1.5px solid ${b.nodeColor}`,
                        }}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Chat */}
              <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Story Direction</p>
                <div ref={chatScrollRef} className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1">
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={
                        msg.role === "assistant"
                          ? "max-w-[92%] rounded-2xl border border-border bg-muted/50 p-2.5 text-sm text-foreground/90"
                          : "ml-auto max-w-[92%] rounded-2xl border border-primary/20 bg-primary/[0.08] p-2.5 text-sm text-foreground/90"
                      }
                    >
                      <span className="whitespace-pre-wrap">{msg.text}</span>
                      {msg.tasks && msg.tasks.length > 0 && (
                        <ul className="mt-2 space-y-1.5">
                          {msg.tasks.map((task, i) => (
                            <li key={i} className="flex items-center gap-2 text-xs">
                              {task.status === "done" && (
                                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="shrink-0 text-green-500">
                                  <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
                                  <polyline points="4 7 6.5 9.5 10 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                              {task.status === "running" && (
                                <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-primary/40 border-t-primary" />
                              )}
                              {task.status === "pending" && (
                                <span className="inline-block h-3 w-3 shrink-0 rounded-full border-[1.5px] border-muted-foreground/30" />
                              )}
                              {task.status === "error" && (
                                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="shrink-0 text-destructive">
                                  <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
                                  <line x1="5" y1="5" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                  <line x1="9" y1="5" x2="5" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                </svg>
                              )}
                              <span className={
                                task.status === "done" ? "text-foreground/70" :
                                task.status === "running" ? "text-foreground" :
                                task.status === "error" ? "text-destructive" :
                                "text-muted-foreground/60"
                              }>
                                {task.label}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {msg.action?.type === "play-video" && (
                        <button
                          type="button"
                          onClick={() => openAnimation(msg.action!.branchId)}
                          className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-xs text-primary transition hover:bg-primary/20"
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" className="shrink-0">
                            <polygon points="2.5,1 10.5,6 2.5,11" />
                          </svg>
                          Watch video
                        </button>
                      )}
                      {msg.suggestions && msg.suggestions.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {msg.suggestions.map((s, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => {
                                setChatInput(s)
                                chatInputRef.current?.focus()
                              }}
                              className="rounded-full border border-primary/20 bg-primary/[0.06] px-2.5 py-1 text-left text-[11px] leading-snug text-foreground/80 transition hover:border-primary/40 hover:bg-primary/[0.12]"
                            >
                              {s.length > 80 ? `${s.slice(0, 77)}…` : s}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="relative mt-3">
                  {/* Slash command popup */}
                  {slashMenuOpen && filteredSlashCommands.length > 0 && (
                    <div className="absolute bottom-full left-0 z-20 mb-1 w-full overflow-hidden rounded-xl border border-border bg-card shadow-lg">
                      {filteredSlashCommands.map((cmd, i) => (
                        <button
                          key={cmd.name}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            const value = cmd.hasArg ? `${cmd.name} ` : cmd.name
                            setChatInput(value)
                            setSlashMenuOpen(false)
                            chatInputRef.current?.focus()
                          }}
                          className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition ${
                            i === slashMenuIndex
                              ? "bg-primary/10 text-foreground"
                              : "text-foreground/80 hover:bg-muted/50"
                          }`}
                        >
                          <span className="font-mono text-xs text-primary">{cmd.name}</span>
                          <span className="text-xs text-muted-foreground">{cmd.description}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      ref={chatInputRef}
                      value={chatInput}
                      onChange={(e) => {
                        const val = e.target.value
                        setChatInput(val)
                        // Open menu when input starts with / and is in the command portion
                        if (val.startsWith("/")) {
                          const spaceIdx = val.indexOf(" ")
                          // Still typing the command name (no space yet, or cursor is before space)
                          if (spaceIdx === -1) {
                            setSlashFilter(val)
                            setSlashMenuOpen(true)
                            setSlashMenuIndex(0)
                          } else {
                            setSlashMenuOpen(false)
                          }
                        } else {
                          setSlashMenuOpen(false)
                        }
                      }}
                      onKeyDown={(e) => {
                        if (slashMenuOpen && filteredSlashCommands.length > 0) {
                          if (e.key === "ArrowDown") {
                            e.preventDefault()
                            setSlashMenuIndex((i) => (i + 1) % filteredSlashCommands.length)
                            return
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault()
                            setSlashMenuIndex((i) => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length)
                            return
                          }
                          if (e.key === "Enter" || e.key === "Tab") {
                            e.preventDefault()
                            const cmd = filteredSlashCommands[slashMenuIndex]
                            if (cmd) {
                              const value = cmd.hasArg ? `${cmd.name} ` : cmd.name
                              setChatInput(value)
                              setSlashMenuOpen(false)
                            }
                            return
                          }
                          if (e.key === "Escape") {
                            e.preventDefault()
                            setSlashMenuOpen(false)
                            return
                          }
                        }
                        if (e.key === "Enter") {
                          e.preventDefault()
                          void handleChatSend()
                        }
                      }}
                      onBlur={() => {
                        // Delay to allow click on menu item
                        setTimeout(() => setSlashMenuOpen(false), 150)
                      }}
                      className={`flex-1 rounded-full border px-4 py-2 text-sm outline-none transition bg-muted/50 text-foreground placeholder-muted-foreground ${
                        pendingBranch
                          ? "border-primary/50 focus:border-primary"
                          : "border-border focus:border-primary"
                      }`}
                      placeholder={
                        pendingBranch
                          ? "Describe the branch direction…"
                          : "Type / for commands, or describe what happens next…"
                      }
                    />
                    <button
                      type="button"
                      onClick={() => void handleChatSend()}
                      disabled={isGenerating}
                      className="rounded-full bg-primary px-4 py-2 text-xs uppercase tracking-[0.14em] text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Send
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </aside>

        {/* ---- Canvas ---- */}
        <div className="flex-1 overflow-hidden rounded-2xl border border-border bg-background shadow-lg dark:shadow-[0_14px_40px_rgba(0,0,0,0.4)]">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card/80 px-4 py-3 backdrop-blur-sm">
            <div>
              <h2 className="font-['Iowan_Old_Style','Baskerville','Palatino','serif'] text-2xl text-foreground">
                {storyTitle ?? "Story Canvas"}
              </h2>
              <p className="text-xs text-muted-foreground">
                Click <strong className="text-foreground/80">Branch here</strong> on any panel to fork. Click <strong className="text-foreground/80">Animate</strong> to play.
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() => openAnimation(activeBranchId)}
                className="glow-amber rounded-full bg-primary px-3 py-1.5 text-[10px] uppercase tracking-[0.14em] text-primary-foreground transition hover:brightness-110"
              >
                Make animation
              </button>
              <span className="rounded-full border border-border bg-muted/50 px-3 py-1 text-muted-foreground">
                Panels: {nodeCount}
              </span>
              <span className="rounded-full border border-border bg-muted/50 px-3 py-1 text-muted-foreground">
                Branches: {branchNodeCount}
              </span>
            </div>
          </header>

          <div className="h-[calc(100%-61px)]">
            <ReactFlow
              nodes={hydratedNodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              fitView
              fitViewOptions={{ padding: 0.22 }}
              minZoom={0.2}
              maxZoom={1.5}
            >
              <Controls />
              <MiniMap
                pannable
                zoomable
                maskColor="rgba(0, 0, 0, 0.6)"
                nodeColor={(node: FlowNode) => node.data?.branchColor ?? "#ef4444"}
              />
              <Background color="oklch(0.35 0.01 60)" gap={24} size={1} />
            </ReactFlow>
          </div>
        </div>
      </div>
    </SidebarProvider>
  )
}
