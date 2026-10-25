import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWeeklyDiagramGraph, diagramBounds } from "./roadmapDiagram";

describe("weekly roadmap diagram fallback", () => {
  const graph = buildWeeklyDiagramGraph({
    categoryName: "Spanish",
    level: "basic",
    steps: [
      { title: "Greetings", description: "Say hello", details: ["Learn 10 phrases", "e.g. Hola"], order: 0, week: 1 },
      { title: "Verbs", description: "Present tense", details: ["Conjugate -ar verbs"], order: 1, week: 2 },
    ],
  });

  it("creates a title, one node per step, and one node per detail", () => {
    const visible = graph.nodes.filter((node) => node.visible !== false);
    assert.equal(visible.filter((node) => node.type === "title").length, 1);
    assert.equal(visible.filter((node) => node.type === "step").length, 2);
    assert.equal(visible.filter((node) => node.type === "detail").length, 3);
  });

  it("chains the steps and hangs details off their own step", () => {
    const titleToFirst = graph.edges.find((edge) => edge.source === "weekly-title");
    assert.equal(titleToFirst?.target, "weekly-step-0");
    assert.ok(graph.edges.some((edge) => edge.source === "weekly-step-0" && edge.target === "weekly-step-1"));
    const detailEdges = graph.edges.filter((edge) => edge.dashed);
    assert.equal(detailEdges.length, 3);
    assert.ok(detailEdges.every((edge) => edge.source.startsWith("weekly-step-")));
  });

  it("computes bounds that contain every visible node", () => {
    const bounds = diagramBounds(graph.nodes);
    for (const node of graph.nodes.filter((item) => item.visible !== false)) {
      assert.ok(node.x >= bounds.minX);
      assert.ok(node.y >= bounds.minY);
      assert.ok(node.x + node.width <= bounds.minX + bounds.width);
      assert.ok(node.y + node.height <= bounds.minY + bounds.height);
    }
  });
});
