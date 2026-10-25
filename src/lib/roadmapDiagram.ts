import type { RoadmapStep } from "@/types";

/**
 * Small, render-friendly representation of a roadmap diagram. Two producers
 * fill it in:
 *   - src/lib/server/developerRoadmap.ts normalizes roadmap.sh's JSON graph;
 *   - buildWeeklyDiagramGraph() below draws the user's own AI roadmap.
 * The client renderer only knows this shape.
 */

export type RoadmapDiagramNodeType =
  | "title"
  | "topic"
  | "subtopic"
  | "paragraph"
  | "button"
  | "label"
  | "step"
  | "detail"
  | "connector";

export interface RoadmapDiagramNode {
  id: string;
  type: RoadmapDiagramNodeType;
  label: string;
  description?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderStyle?: "solid" | "dashed";
  href?: string;
  /** Reference graph nodes like vertical/horizontal connectors carry no
   *  visible card but are still needed to route edges through their points. */
  visible?: boolean;
}

export interface RoadmapDiagramEdge {
  id: string;
  source: string;
  target: string;
  color?: string;
  dashed?: boolean;
}

export interface RoadmapDiagramGraph {
  source: "roadmap.sh" | "generated";
  title: string;
  description?: string;
  slug?: string;
  sourceUrl?: string;
  nodes: RoadmapDiagramNode[];
  edges: RoadmapDiagramEdge[];
}

export interface DiagramBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export function diagramBounds(nodes: RoadmapDiagramNode[], padding = 40): DiagramBounds {
  const visible = nodes.filter((node) => node.visible !== false);
  if (visible.length === 0) return { minX: 0, minY: 0, width: 1, height: 1 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of visible) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }

  return {
    minX: minX - padding,
    minY: minY - padding,
    width: Math.max(1, maxX - minX + padding * 2),
    height: Math.max(1, maxY - minY + padding * 2),
  };
}

/** Fallback diagram built from the weekly plan itself, so every roadmap has
 *  a visual version even when its category does not match a roadmap.sh topic. */
export function buildWeeklyDiagramGraph(input: {
  categoryName: string;
  steps: RoadmapStep[];
  level?: string;
}): RoadmapDiagramGraph {
  const nodes: RoadmapDiagramNode[] = [];
  const edges: RoadmapDiagramEdge[] = [];

  const titleId = "weekly-title";
  const titleText = input.level
    ? `${input.categoryName} — ${input.level}`
    : input.categoryName;
  nodes.push({
    id: titleId,
    type: "title",
    label: titleText,
    x: 0,
    y: 0,
    width: 360,
    height: 64,
    fontSize: 24,
  });

  const steps = input.steps ?? [];
  steps.forEach((step, index) => {
    const stepId = `weekly-step-${index}`;
    const stepY = 110 + index * 190;
    nodes.push({
      id: stepId,
      type: "step",
      label: step.title || `Week ${index + 1}`,
      description: step.description || undefined,
      x: 0,
      y: stepY,
      width: 340,
      height: 104,
      fontSize: 15,
    });

    const previousId = index === 0 ? titleId : `weekly-step-${index - 1}`;
    edges.push({
      id: `weekly-edge-${index}`,
      source: previousId,
      target: stepId,
      color: "#2b78e4",
    });

    const details = (step.details ?? []).filter(Boolean).slice(0, 6);
    details.forEach((detail, detailIndex) => {
      const detailId = `weekly-detail-${index}-${detailIndex}`;
      nodes.push({
        id: detailId,
        type: "detail",
        label: detail,
        x: 400,
        y: stepY + 8 + detailIndex * 44,
        width: 320,
        height: 36,
        fontSize: 13,
      });
      edges.push({
        id: `weekly-detail-edge-${index}-${detailIndex}`,
        source: stepId,
        target: detailId,
        dashed: true,
        color: "#929292",
      });
    });
  });

  return {
    source: "generated",
    title: titleText,
    description: "Built from your weekly plan.",
    nodes,
    edges,
  };
}
