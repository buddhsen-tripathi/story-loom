"use client"

import { Handle, NodeProps, Position } from "@xyflow/react"
import type { Node } from "@xyflow/react"

export interface PanelData extends Record<string, unknown> {
  branchId: string
  title: string
  caption: string
  imageUrl: string
  imagePrompt: string
  styleLabel: string
  branchColor: string
  isLoading: boolean
  hasFailed: boolean
  videoUrl?: string
  videoKey?: string
  onBranch: (nodeId: string) => void
  onAnimate: (branchId: string, nodeId: string) => void
}

export type PanelNodeType = Node<PanelData>

export function PanelNode({ data, id }: NodeProps<PanelNodeType>) {
  const panelNum = id.replace(/.*-p/, "")
  const hasImage = !data.isLoading && !!data.imageUrl

  return (
    <article
      className="w-[220px] rounded-2xl border border-border bg-card p-3 shadow-md dark:shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
      style={{ boxShadow: `inset 0 0 0 1.5px ${data.branchColor}18, 0 8px 30px rgba(0,0,0,0.5)` }}
    >
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-border !bg-muted-foreground" />
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        <span style={{ color: `${data.branchColor}aa` }}>{data.styleLabel}</span>
        <span>#{panelNum}</span>
      </div>
      <div className="aspect-[4/5] w-full overflow-hidden rounded-xl border border-border bg-muted/30">
        {data.isLoading && (
          <div className="flex h-full w-full animate-pulse items-center justify-center bg-muted/50 text-[10px] uppercase tracking-[0.1em] text-muted-foreground/60">
            Rendering panel
          </div>
        )}
        {data.hasFailed && !data.isLoading && (
          <div className="flex h-full w-full items-center justify-center bg-muted/30 text-[10px] uppercase tracking-[0.1em] text-destructive">
            Failed
          </div>
        )}
        {hasImage && (
          <img
            src={data.imageUrl}
            alt={`${data.title} panel art`}
            className="h-full w-full object-cover object-center transition-opacity duration-500"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
      <h3 className="mt-2 font-['Iowan_Old_Style','Baskerville','Palatino','serif'] text-base font-semibold text-foreground">
        {data.title}
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{data.caption}</p>
      <div className="mt-3 grid grid-cols-2 items-center gap-1.5">
        <button
          type="button"
          disabled={data.isLoading}
          onClick={() => data.onBranch(id)}
          className="flex min-h-8 items-center justify-center rounded-full bg-muted/60 px-2 py-1 text-center text-[10px] uppercase tracking-[0.06em] text-foreground/70 whitespace-nowrap transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          Branch here
        </button>
        <button
          type="button"
          disabled={!hasImage}
          onClick={() => data.onAnimate(data.branchId, id)}
          className="flex min-h-8 items-center justify-center rounded-full border border-primary/30 px-2 py-1 text-center text-[10px] uppercase tracking-[0.06em] text-primary/80 whitespace-nowrap transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          Animate
        </button>
      </div>
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-border !bg-muted-foreground" />
    </article>
  )
}
