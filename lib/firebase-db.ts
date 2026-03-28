import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type QueryDocumentSnapshot,
  type Timestamp,
} from "firebase/firestore"
import { getFirebaseDb } from "./firebase"

export type { Timestamp }

function dbLog(action: string, details?: Record<string, unknown>) {
  console.log(`[firebase-db] ${action}`, details ?? "")
}

function dbError(action: string, err: unknown) {
  console.error(`[firebase-db] ${action} FAILED`, err instanceof Error ? err.message : err)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms — check Firestore rules`)), ms)
    ),
  ])
}

export interface BranchEntry {
  id: string
  sourceNodeId: string
  label: string
  edgeColor: string
  nodeColor: string
}

export interface PanelDoc {
  id: string
  branchId: string
  panelNum: number
  title: string
  caption: string
  /** URI of the generated image (no Storage upload — stored as reference only to save cost) */
  imageUrl: string
  imagePrompt: string
  positionX: number
  positionY: number
  hasFailed?: boolean
}

export interface EdgeDoc {
  id: string
  source: string
  target: string
  color: string
  animated: boolean
  strokeWidth?: number
}

export interface StoryDoc {
  userId: string
  prompt: string
  title?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface StorySummary {
  id: string
  prompt: string
  title?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface LoadedStory {
  storyId: string
  prompt: string
  title?: string
  branches: BranchEntry[]
  panels: PanelDoc[]
  edges: EdgeDoc[]
}

function storyRef(db: ReturnType<typeof getFirebaseDb>, storyId: string) {
  return doc(db, "stories", storyId)
}

function branchesRef(db: ReturnType<typeof getFirebaseDb>, storyId: string) {
  return collection(db, "stories", storyId, "branches")
}

function branchRef(db: ReturnType<typeof getFirebaseDb>, storyId: string, branchId: string) {
  return doc(db, "stories", storyId, "branches", branchId)
}

function panelsRef(db: ReturnType<typeof getFirebaseDb>, storyId: string) {
  return collection(db, "stories", storyId, "panels")
}

function panelRef(db: ReturnType<typeof getFirebaseDb>, storyId: string, panelId: string) {
  return doc(db, "stories", storyId, "panels", panelId)
}

function edgesRef(db: ReturnType<typeof getFirebaseDb>, storyId: string) {
  return collection(db, "stories", storyId, "edges")
}

function edgeRef(db: ReturnType<typeof getFirebaseDb>, storyId: string, edgeId: string) {
  return doc(db, "stories", storyId, "edges", edgeId)
}

export async function createStory({
  userId,
  prompt,
  title,
}: {
  userId: string
  prompt: string
  title?: string
}): Promise<string> {
  dbLog("createStory", { userId, promptLen: prompt.length, title })
  try {
    const db = getFirebaseDb()
    const storiesCol = collection(db, "stories")
    const newRef = doc(storiesCol)
    const storyId = newRef.id
    dbLog("createStory: writing doc", { storyId })
    await withTimeout(setDoc(newRef, {
      userId,
      prompt: prompt.trim(),
      ...(title ? { title: title.trim() } : {}),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }), 10000, "createStory:setDoc")
    dbLog("createStory: doc written, writing main branch")
    await withTimeout(setDoc(branchRef(db, storyId, "main"), {
      id: "main",
      sourceNodeId: "",
      label: "Main story",
      edgeColor: "#111827",
      nodeColor: "#111827",
    }), 10000, "createStory:setBranch")
    dbLog("createStory: done", { storyId })
    return storyId
  } catch (err) {
    dbError("createStory", err)
    throw err
  }
}

const FIRESTORE_FIELD_LIMIT = 1_000_000 // ~1MB safe limit

function compressImage(dataUrl: string, quality = 0.7): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement("canvas")
      canvas.width = img.width
      canvas.height = img.height
      canvas.getContext("2d")!.drawImage(img, 0, 0)
      resolve(canvas.toDataURL("image/jpeg", quality))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

export async function savePanel(storyId: string, panel: PanelDoc): Promise<void> {
  dbLog("savePanel", { storyId, panelId: panel.id, branchId: panel.branchId })
  try {
    let { imageUrl } = panel
    if (imageUrl.length > FIRESTORE_FIELD_LIMIT) {
      dbLog("savePanel: compressing image", { panelId: panel.id, originalSize: imageUrl.length })
      imageUrl = await compressImage(imageUrl, 0.6)
      dbLog("savePanel: compressed", { panelId: panel.id, newSize: imageUrl.length })
      if (imageUrl.length > FIRESTORE_FIELD_LIMIT) {
        imageUrl = await compressImage(imageUrl, 0.3)
        dbLog("savePanel: re-compressed", { panelId: panel.id, newSize: imageUrl.length })
      }
    }
    const db = getFirebaseDb()
    await setDoc(panelRef(db, storyId, panel.id), {
      ...panel,
      imageUrl,
      updatedAt: serverTimestamp(),
    })
    dbLog("savePanel: done", { panelId: panel.id })
  } catch (err) {
    dbError("savePanel", err)
  }
}

export async function saveBranch(storyId: string, branch: BranchEntry): Promise<void> {
  dbLog("saveBranch", { storyId, branchId: branch.id })
  try {
    const db = getFirebaseDb()
    await setDoc(branchRef(db, storyId, branch.id), branch)
    dbLog("saveBranch: done", { branchId: branch.id })
  } catch (err) {
    dbError("saveBranch", err)
  }
}

export async function saveEdge(storyId: string, edge: EdgeDoc): Promise<void> {
  const db = getFirebaseDb()
  await setDoc(edgeRef(db, storyId, edge.id), edge)
}

export async function saveEdges(storyId: string, edges: EdgeDoc[]): Promise<void> {
  dbLog("saveEdges", { storyId, count: edges.length })
  try {
    const db = getFirebaseDb()
    const batch = writeBatch(db)
    for (const edge of edges) {
      batch.set(edgeRef(db, storyId, edge.id), edge)
    }
    await batch.commit()
    dbLog("saveEdges: done", { count: edges.length })
  } catch (err) {
    dbError("saveEdges", err)
  }
}

export async function loadStory(storyId: string): Promise<LoadedStory | null> {
  dbLog("loadStory", { storyId })
  try {
    const db = getFirebaseDb()
    const storySnap = await withTimeout(getDoc(storyRef(db, storyId)), 10000, "loadStory:getDoc")
    if (!storySnap.exists()) {
      dbLog("loadStory: story not found", { storyId })
      return null
    }

    const [branchesSnap, panelsSnap, edgesSnap] = await withTimeout(Promise.all([
      getDocs(branchesRef(db, storyId)),
      getDocs(panelsRef(db, storyId)),
      getDocs(edgesRef(db, storyId)),
    ]), 10000, "loadStory:subcollections")

    const branches: BranchEntry[] = branchesSnap.docs.map((d: QueryDocumentSnapshot) => d.data() as BranchEntry)
    const panels: PanelDoc[] = panelsSnap.docs.map((d: QueryDocumentSnapshot) => d.data() as PanelDoc)
    const edges: EdgeDoc[] = edgesSnap.docs.map((d: QueryDocumentSnapshot) => d.data() as EdgeDoc)

    const data = storySnap.data() as StoryDoc
    dbLog("loadStory: loaded", { storyId, title: data.title, branches: branches.length, panels: panels.length, edges: edges.length })
    return {
      storyId,
      prompt: data.prompt,
      title: data.title,
      branches,
      panels,
      edges,
    }
  } catch (err) {
    dbError("loadStory", err)
    return null
  }
}

export async function listUserStories(userId: string): Promise<StorySummary[]> {
  dbLog("listUserStories", { userId })
  try {
    const db = getFirebaseDb()
    const q = query(
      collection(db, "stories"),
      where("userId", "==", userId)
    )
    const snap = await withTimeout(getDocs(q), 10000, "listUserStories:getDocs")
    dbLog("listUserStories: query returned", { count: snap.docs.length })
    const list = snap.docs.map((d: QueryDocumentSnapshot) => {
      const data = d.data() as StoryDoc
      return {
        id: d.id,
        prompt: data.prompt,
        title: data.title,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      } as StorySummary
    })
    list.sort((a, b) => {
      const aTime = a.updatedAt?.toMillis?.() ?? 0
      const bTime = b.updatedAt?.toMillis?.() ?? 0
      return bTime - aTime
    })
    dbLog("listUserStories: done", { count: list.length, titles: list.map((s) => s.title ?? s.id) })
    return list
  } catch (err) {
    dbError("listUserStories", err)
    return []
  }
}

export async function deleteStory(storyId: string): Promise<void> {
  const db = getFirebaseDb()
  const [branchesSnap, panelsSnap, edgesSnap] = await Promise.all([
    getDocs(branchesRef(db, storyId)),
    getDocs(panelsRef(db, storyId)),
    getDocs(edgesRef(db, storyId)),
  ])
  const batch = writeBatch(db)
  batch.delete(storyRef(db, storyId))
  branchesSnap.docs.forEach((d: QueryDocumentSnapshot) => batch.delete(d.ref))
  panelsSnap.docs.forEach((d: QueryDocumentSnapshot) => batch.delete(d.ref))
  edgesSnap.docs.forEach((d: QueryDocumentSnapshot) => batch.delete(d.ref))
  await batch.commit()
}

export async function updateStoryPrompt(storyId: string, prompt: string): Promise<void> {
  const db = getFirebaseDb()
  await setDoc(
    storyRef(db, storyId),
    { prompt: prompt.trim(), updatedAt: serverTimestamp() },
    { merge: true }
  )
}

export async function updateStoryTitle(storyId: string, title: string): Promise<void> {
  const db = getFirebaseDb()
  await setDoc(
    storyRef(db, storyId),
    { title: title.trim(), updatedAt: serverTimestamp() },
    { merge: true }
  )
}
