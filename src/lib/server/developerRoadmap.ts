import { logServerError } from "@/lib/server/logError";
import {
  developerRoadmapJsonUrl,
  developerRoadmapUrl,
  resolveDeveloperRoadmapSlug,
  type RoadmapMatch,
} from "@/lib/roadmapReference";
import type { RoadmapDiagramEdge, RoadmapDiagramGraph, RoadmapDiagramNode } from "@/lib/roadmapDiagram";

/**
 * Fetches and normalizes roadmap.sh's public graph JSON.
 *
 * roadmap.sh publishes the same data as github.com/nilbuild/developer-roadmap
 * at https://roadmap.sh/<slug>.json (nodes with x/y positions plus edges), so
 * one cached request gives us both the reference curriculum for the AI prompt
 * and the node/edge graph the roadmap diagram renders.
 *
 * This is always best-effort: generation must still work when roadmap.sh is
 * unreachable or a category has no matching topic.
 */

interface RawRoadmapNode {
  id?: string;
  type?: string;
  position?: { x?: number; y?: number };
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
  data?: {
    label?: string;
    href?: string;
    color?: string;
    backgroundColor?: string;
    borderColor?: string;
    legend?: { color?: string };
    style?: {
      fontSize?: number;
      color?: string;
      backgroundColor?: string;
      borderColor?: string;
      strokeDasharray?: string;
    };
  };
}

interface RawRoadmapEdge {
  id?: string;
  source?: string;
  target?: string;
  style?: { stroke?: string; strokeDasharray?: string };
  data?: { edgeStyle?: string };
}

interface RawRoadmap {
  title?: { card?: string; page?: string };
  description?: string;
  nodes?: RawRoadmapNode[];
  edges?: RawRoadmapEdge[];
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const graphCache = new Map<string, { at: number; graph: RoadmapDiagramGraph }>();

const VISIBLE_TYPES = new Set(["title", "topic", "subtopic", "paragraph", "button", "label"]);
const CONCEPT_TYPES = new Set(["topic", "subtopic", "paragraph", "button", "label"]);
const CONCEPT_LIMIT = 140;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalColor(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Normalizes one roadmap.sh node. Connector nodes (vertical/horizontal) and
 *  visual furniture (section/legend) stay in the graph as invisible anchors
 *  so edges can still route through them. */
export function normalizeRoadmapNode(raw: RawRoadmapNode): RoadmapDiagramNode | null {
  if (!raw || typeof raw.id !== "string" || !raw.id) return null;

  const type = String(raw.type || "");
  const data = raw.data ?? {};
  const label = String(data.label ?? "").trim();
  const isConnector = type === "vertical" || type === "horizontal";
  const visible = VISIBLE_TYPES.has(type) && label.length > 0;

  const style = data.style ?? {};
  const backgroundColor = optionalColor(data.backgroundColor) ?? optionalColor(style.backgroundColor);
  const borderColor = optionalColor(data.borderColor) ?? optionalColor(style.borderColor) ?? optionalColor(data.legend?.color);
  const color = optionalColor(data.color) ?? optionalColor(style.color);

  return {
    id: raw.id,
    type: (isConnector ? "connector" : (VISIBLE_TYPES.has(type) ? type : "label")) as RoadmapDiagramNode["type"],
    label,
    x: numberOr(raw.position?.x, 0),
    y: numberOr(raw.position?.y, 0),
    // Invisible anchors get a tiny box; visible nodes fall back to a size that
    // is readable even if roadmap.sh omitted `measured`.
    width: visible ? Math.max(40, numberOr(raw.measured?.width, numberOr(raw.width, 220))) : 4,
    height: visible ? Math.max(24, numberOr(raw.measured?.height, numberOr(raw.height, 48))) : 4,
    fontSize: numberOr(style.fontSize, visible ? 15 : 0),
    color,
    backgroundColor,
    borderColor,
    borderStyle: data.legend || style.strokeDasharray === "0.8 8" ? "dashed" : "solid",
    href: typeof data.href === "string" && data.href.trim() ? data.href.trim() : undefined,
    visible,
  };
}

export function normalizeRoadmapEdges(rawEdges: RawRoadmapEdge[] | undefined): RoadmapDiagramEdge[] {
  const edges: RoadmapDiagramEdge[] = [];
  const seen = new Set<string>();

  (rawEdges ?? []).forEach((edge, index) => {
    if (!edge || typeof edge.source !== "string" || typeof edge.target !== "string") return;
    const id = typeof edge.id === "string" && edge.id ? edge.id : `edge-${index}-${edge.source}-${edge.target}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({
      id,
      source: edge.source,
      target: edge.target,
      color: optionalColor(edge.style?.stroke),
      dashed: edge.data?.edgeStyle === "dashed" || edge.style?.strokeDasharray === "0.8 8",
    });
  });

  return edges;
}

export function normalizeDeveloperRoadmapGraph(raw: RawRoadmap, match: RoadmapMatch): RoadmapDiagramGraph {
  const nodes = (raw.nodes ?? [])
    .map((node) => normalizeRoadmapNode(node))
    .filter((node): node is RoadmapDiagramNode => !!node);

  return {
    source: "roadmap.sh",
    slug: match.slug,
    title: raw.title?.page || raw.title?.card || match.label,
    description: String(raw.description ?? "").replace("@currentYear@", String(new Date().getFullYear())),
    sourceUrl: developerRoadmapUrl(match.slug),
    nodes,
    edges: normalizeRoadmapEdges(raw.edges),
  };
}

// roadmap.sh graphs contain a few instructional labels that are page chrome,
// not curriculum: "Visit Beginner Friendly Version", "Find the detailed
// version…", the legend link, etc. They would waste prompt tokens and could
// leak into a week title, so drop the obvious ones.
const NON_CONCEPT_LABEL = [
  /^find the detailed version/i,
  /^visit\b/i,
  /^have a look at/i,
  /^at this point/i,
  /^roadmap\.sh$/i,
  /^learn more\b/i,
  /^read more\b/i,
  /^see the\b/i,
];

function isUsefulConcept(label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed) return false;
  return !NON_CONCEPT_LABEL.some((pattern) => pattern.test(trimmed));
}

/** Ordered, de-duplicated concept labels used to ground the AI prompt. */
export function roadmapDiagramConcepts(graph: RoadmapDiagramGraph, limit = CONCEPT_LIMIT): string[] {
  const seen = new Set<string>();
  return graph.nodes
    .filter((node) => node.visible !== false && CONCEPT_TYPES.has(node.type) && node.label.length > 0)
    .slice()
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
    .map((node) => node.label)
    .filter((label) => {
      if (!isUsefulConcept(label)) return false;
      const key = label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, limit));
}

export interface RoadmapReference {
  match: RoadmapMatch;
  graph: RoadmapDiagramGraph;
  concepts: string[];
}

/** Fetches a graph by slug, with a small in-memory cache on top of Next's
 *  fetch cache. Returns null instead of throwing. */
export async function fetchDeveloperRoadmapBySlug(slug: string): Promise<RoadmapDiagramGraph | null> {
  const cached = graphCache.get(slug);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.graph;

  try {
    const res = await fetch(developerRoadmapJsonUrl(slug), {
      next: { revalidate: 86400 },
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Study-Lamp/1.0 (+https://studylamp.vercel.app)" },
    });
    if (!res.ok) return null;

    const raw = (await res.json()) as RawRoadmap;
    if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length === 0) return null;

    const topic = { slug, label: raw.title?.page || raw.title?.card || slug };
    const graph = normalizeDeveloperRoadmapGraph(raw, topic);
    graphCache.set(slug, { at: Date.now(), graph });
    return graph;
  } catch (error) {
    logServerError("roadmap.sh fetch failed", error);
    return null;
  }
}

export async function getRoadmapReference(
  categoryName: string,
  subtopics: string[] = [],
): Promise<RoadmapReference | null> {
  const match = resolveDeveloperRoadmapSlug(categoryName, subtopics);
  if (!match) return null;
  const graph = await fetchDeveloperRoadmapBySlug(match.slug);
  if (!graph) return null;
  return { match, graph, concepts: roadmapDiagramConcepts(graph) };
}
