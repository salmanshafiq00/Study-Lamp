"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import type { LearningRoadmap } from "@/types";
import {
  buildWeeklyDiagramGraph,
  diagramBounds,
  type RoadmapDiagramEdge,
  type RoadmapDiagramGraph,
  type RoadmapDiagramNode,
} from "@/lib/roadmapDiagram";
import { ExternalLink, Loader2, Maximize2, Network, ZoomIn, ZoomOut } from "lucide-react";

const MIN_SCALE = 0.1;
const MAX_SCALE = 2.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isLightColor(value?: string): boolean {
  if (!value) return false;
  const hex = value.trim().toLowerCase();
  return hex === "#fff" || hex === "#ffffff" || hex === "white" || hex === "#f8f8f8";
}

/**
 * roadmap.sh-style diagram.
 *
 * When the category matches a developer-roadmap topic we render its real
 * node/edge graph (positions included) with pan/zoom. Otherwise we draw the
 * user's own weekly plan as a diagram, so the visual view is never empty.
 */
export function RoadmapDiagram({
  categoryName,
  subtopics,
  roadmap,
}: {
  categoryName: string;
  subtopics: string[];
  roadmap: LearningRoadmap | undefined;
}) {
  const { user } = useAuth();
  const [reference, setReference] = React.useState<RoadmapDiagramGraph | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const fallback = React.useMemo(
    () =>
      buildWeeklyDiagramGraph({
        categoryName,
        steps: roadmap?.steps ?? [],
        level: roadmap?.level,
      }),
    [categoryName, roadmap?.steps, roadmap?.level],
  );

  // Parents often pass a fresh [] for "no subtopics"; depend on its contents
  // so the reference fetch does not restart on every render.
  const subtopicsKey = subtopics.join("\u0000");

  React.useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);

    const params = new URLSearchParams();
    if (roadmap?.referenceSlug) params.set("slug", roadmap.referenceSlug);
    else params.set("categoryName", categoryName);
    const subtopicList = subtopicsKey ? subtopicsKey.split("\u0000") : [];
    if (subtopicList.length > 0) params.set("subtopics", subtopicList.join(","));

    (async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch(`/api/roadmap/reference?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Could not load the roadmap reference.");
        if (data?.matched && Array.isArray(data.nodes)) {
          setReference(data as RoadmapDiagramGraph);
        } else {
          setReference(null);
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        setReference(null);
        setLoadError(error instanceof Error ? error.message : "Could not load the roadmap reference.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [user, categoryName, subtopicsKey, roadmap?.referenceSlug]);

  const graph = reference ?? fallback;
  const bounds = React.useMemo(() => diagramBounds(graph.nodes), [graph]);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const interactedRef = React.useRef(false);
  const dragRef = React.useRef<{ pointerId: number; startX: number; startY: number; viewX: number; viewY: number } | null>(null);
  const [view, setView] = React.useState({ x: 0, y: 0, k: 1 });
  const viewRef = React.useRef(view);
  viewRef.current = view;

  const fit = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const width = el.clientWidth || 800;
    const height = el.clientHeight || 480;
    const k = clamp(Math.min(width / bounds.width, height / bounds.height) * 0.92, MIN_SCALE, 1.15);
    setView({
      k,
      x: (width - bounds.width * k) / 2,
      y: (height - bounds.height * k) / 2,
    });
  }, [bounds.width, bounds.height]);

  React.useEffect(() => {
    interactedRef.current = false;
    fit();
  }, [fit, graph.source, graph.slug, graph.nodes.length]);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (interactedRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fit, 150);
    });
    observer.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [fit]);

  // Native (non-passive) wheel listener so zooming does not scroll the page.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const current = viewRef.current;
      const nextK = clamp(current.k * (event.deltaY < 0 ? 1.12 : 0.89), MIN_SCALE, MAX_SCALE);
      const ratio = nextK / current.k;
      interactedRef.current = true;
      setView({
        k: nextK,
        x: px - (px - current.x) * ratio,
        y: py - (py - current.y) * ratio,
      });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function zoomBy(factor: number) {
    const el = containerRef.current;
    const current = viewRef.current;
    const px = el ? el.clientWidth / 2 : 400;
    const py = el ? el.clientHeight / 2 : 240;
    const nextK = clamp(current.k * factor, MIN_SCALE, MAX_SCALE);
    const ratio = nextK / current.k;
    interactedRef.current = true;
    setView({
      k: nextK,
      x: px - (px - current.x) * ratio,
      y: py - (py - current.y) * ratio,
    });
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-node-card]")) return;
    const current = viewRef.current;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: current.x,
      viewY: current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    interactedRef.current = true;
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const current = viewRef.current;
    setView({
      ...current,
      x: drag.viewX + (event.clientX - drag.startX),
      y: drag.viewY + (event.clientY - drag.startY),
    });
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }

  const nodeById = React.useMemo(() => {
    const map = new Map<string, RoadmapDiagramNode>();
    for (const node of graph.nodes) map.set(node.id, node);
    return map;
  }, [graph.nodes]);

  const visibleNodes = graph.nodes.filter((node) => node.visible !== false);
  const isReference = graph.source === "roadmap.sh";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          <Network className="h-3.5 w-3.5 shrink-0 text-accent" />
          {isReference ? (
            <span className="truncate">
              Based on{" "}
              <a
                href={graph.sourceUrl || "https://roadmap.sh"}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent hover:underline"
              >
                {graph.title}
              </a>{" "}
              from roadmap.sh
            </span>
          ) : (
            <span className="truncate">Diagram of your weekly plan{loading ? " · loading reference…" : ""}</span>
          )}
          {loading && <Loader2 className="h-3 w-3 animate-spin" />}
        </div>

        <div className="flex items-center gap-1">
          <Button type="button" size="icon" variant="outline" className="h-7 w-7" onClick={() => zoomBy(1.2)} title="Zoom in">
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="icon" variant="outline" className="h-7 w-7" onClick={() => zoomBy(0.83)} title="Zoom out">
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-7 w-7"
            onClick={() => {
              interactedRef.current = false;
              fit();
            }}
            title="Fit to view"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
          {isReference && graph.sourceUrl && (
            <Button asChild type="button" size="icon" variant="outline" className="h-7 w-7" title="Open on roadmap.sh">
              <a href={graph.sourceUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        role="img"
        aria-label={`${categoryName} roadmap diagram`}
        className="relative h-[26rem] cursor-grab touch-none select-none overflow-hidden rounded-md border border-border bg-muted/20 active:cursor-grabbing sm:h-[32rem] lg:h-[36rem]"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: bounds.width,
            height: bounds.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
            backgroundImage: "radial-gradient(circle, hsl(var(--border)) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        >
          <svg
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            width={bounds.width}
            height={bounds.height}
            viewBox={`0 0 ${bounds.width} ${bounds.height}`}
            aria-hidden="true"
          >
            {graph.edges.map((edge) => (
              <DiagramEdge
                key={edge.id}
                edge={edge}
                source={nodeById.get(edge.source)}
                target={nodeById.get(edge.target)}
                offsetX={bounds.minX}
                offsetY={bounds.minY}
              />
            ))}
          </svg>

          {visibleNodes.map((node) => (
            <DiagramNodeCard
              key={node.id}
              node={node}
              offsetX={bounds.minX}
              offsetY={bounds.minY}
            />
          ))}
        </div>

        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/85 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur">
          Drag to pan · Scroll to zoom
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {isReference
          ? "The diagram is the roadmap.sh reference graph; the weekly plan above is your personalized, level-scoped version of it."
          : loadError
            ? `Showing your weekly plan as a diagram (${loadError}).`
            : "No roadmap.sh topic matched this category, so this diagram is generated from your weekly plan."}
      </p>
    </div>
  );
}

function DiagramEdge({
  edge,
  source,
  target,
  offsetX,
  offsetY,
}: {
  edge: RoadmapDiagramEdge;
  source: RoadmapDiagramNode | undefined;
  target: RoadmapDiagramNode | undefined;
  offsetX: number;
  offsetY: number;
}) {
  if (!source || !target) return null;

  const sx = source.x - offsetX + source.width / 2;
  const sy = source.y - offsetY + source.height / 2;
  const tx = target.x - offsetX + target.width / 2;
  const ty = target.y - offsetY + target.height / 2;
  const dx = tx - sx;
  const dy = ty - sy;

  const path =
    Math.abs(dy) >= Math.abs(dx)
      ? `M ${sx} ${sy} C ${sx} ${sy + dy * 0.5}, ${tx} ${ty - dy * 0.5}, ${tx} ${ty}`
      : `M ${sx} ${sy} C ${sx + dx * 0.5} ${sy}, ${tx - dx * 0.5} ${ty}, ${tx} ${ty}`;

  return (
    <path
      d={path}
      fill="none"
      stroke={edge.color || "#b1b1b1"}
      strokeWidth={1.8}
      strokeDasharray={edge.dashed ? "6 6" : undefined}
      strokeLinecap="round"
      opacity={0.65}
      vectorEffect="non-scaling-stroke"
    />
  );
}

function DiagramNodeCard({
  node,
  offsetX,
  offsetY,
}: {
  node: RoadmapDiagramNode;
  offsetX: number;
  offsetY: number;
}) {
  if (node.type === "connector") return null;

  const isPlain = node.type === "title" || node.type === "label";
  const isButton = node.type === "button";
  const isDetail = node.type === "detail";

  const background =
    !isPlain && !isLightColor(node.backgroundColor)
      ? node.backgroundColor
      : isDetail
        ? "hsl(var(--background))"
        : isPlain
          ? "transparent"
          : "hsl(var(--card))";
  const border =
    node.borderColor && !isLightColor(node.borderColor)
      ? node.borderColor
      : isPlain
        ? "transparent"
        : "hsl(var(--border))";
  const color = node.color && node.color.toLowerCase() !== "#000000"
    ? node.color
    : "hsl(var(--foreground))";

  const justify =
    node.type === "title" || node.type === "topic" || node.type === "subtopic" || isButton
      ? "center"
      : "flex-start";
  const weight =
    node.type === "title" ? 700 : node.type === "topic" || node.type === "step" || isButton ? 600 : 500;
  const lineClamp = node.type === "title" ? 3 : isDetail ? 2 : 4;

  const content = (
    <div
      data-node-card
      title={node.label}
      className="flex h-full w-full items-center overflow-hidden rounded-md px-2 py-1 text-center"
      style={{
        justifyContent: justify,
        alignItems: "center",
        textAlign: node.type === "step" || isDetail ? "left" : "center",
        backgroundColor: background,
        borderColor: border,
        borderWidth: isPlain || isButton ? 0 : 1.2,
        borderStyle: node.borderStyle || "solid",
        color,
        fontWeight: weight,
        fontSize: node.fontSize || 14,
        boxShadow: isPlain ? "none" : node.type === "step" || node.type === "topic" ? "0 1px 2px hsl(var(--border))" : "none",
      }}
    >
      <span
        style={{
          display: "-webkit-box",
          WebkitLineClamp: lineClamp,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          wordBreak: "break-word",
          lineHeight: 1.25,
        }}
      >
        {node.label}
      </span>
    </div>
  );

  const style: React.CSSProperties = {
    position: "absolute",
    left: node.x - offsetX,
    top: node.y - offsetY,
    width: node.width,
    height: node.height,
  };

  if (node.href) {
    return (
      <a
        href={node.href}
        target="_blank"
        rel="noreferrer"
        style={style}
        className="block transition hover:brightness-95"
      >
        {content}
      </a>
    );
  }

  return (
    <div style={style} data-node-card>
      {content}
    </div>
  );
}
