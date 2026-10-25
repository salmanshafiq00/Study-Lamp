import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeDeveloperRoadmapGraph,
  normalizeRoadmapEdges,
  normalizeRoadmapNode,
  roadmapDiagramConcepts,
} from "./developerRoadmap";

const raw = {
  title: { page: "Backend Developer", card: "Backend" },
  description: "Become a backend developer in @currentYear@",
  nodes: [
    {
      id: "title-1",
      type: "title",
      position: { x: 0, y: 0 },
      measured: { width: 200, height: 60 },
      data: { label: "Backend", style: { fontSize: 28 } },
    },
    {
      id: "topic-1",
      type: "topic",
      position: { x: 0, y: 100 },
      measured: { width: 280, height: 50 },
      data: { label: "Internet" },
    },
    {
      id: "sub-1",
      type: "subtopic",
      position: { x: 0, y: 180 },
      measured: { width: 280, height: 50 },
      data: { label: "HTTP", legend: { color: "#929292" } },
    },
    {
      id: "connector-1",
      type: "vertical",
      position: { x: 100, y: 250 },
      measured: { width: 20, height: 80 },
      data: { label: "vertical node" },
    },
    {
      id: "legend-1",
      type: "legend",
      position: { x: -300, y: 0 },
      measured: { width: 300, height: 100 },
      data: { label: "" },
    },
  ],
  edges: [
    { id: "e1", source: "title-1", target: "topic-1", style: { stroke: "#2b78e4" } },
    { id: "e2", source: "topic-1", target: "sub-1", data: { edgeStyle: "dashed" } },
    { id: "e2", source: "topic-1", target: "sub-1" },
  ],
};

describe("roadmap.sh graph normalization", () => {
  it("keeps visible labels and hides connectors/furniture", () => {
    const title = normalizeRoadmapNode(raw.nodes[0]);
    assert.equal(title?.visible, true);
    assert.equal(title?.type, "title");

    const connector = normalizeRoadmapNode(raw.nodes[3]);
    assert.equal(connector?.visible, false);
    assert.equal(connector?.type, "connector");

    const legend = normalizeRoadmapNode(raw.nodes[4]);
    assert.equal(legend?.visible, false);
  });

  it("normalizes the graph metadata, node positions and de-duplicated edges", () => {
    const graph = normalizeDeveloperRoadmapGraph(raw, { slug: "backend", label: "Backend" });
    assert.equal(graph.source, "roadmap.sh");
    assert.equal(graph.title, "Backend Developer");
    assert.equal(graph.sourceUrl, "https://roadmap.sh/backend");
    assert.match(graph.description || "", new RegExp(String(new Date().getFullYear())));
    assert.equal(graph.nodes.length, 5);
    assert.equal(graph.edges.length, 2);
    assert.equal(graph.edges[1].dashed, true);
    assert.equal(graph.edges[0].color, "#2b78e4");
  });

  it("orders concepts top-to-bottom for the AI prompt", () => {
    const graph = normalizeDeveloperRoadmapGraph(raw, { slug: "backend", label: "Backend" });
    assert.deepEqual(roadmapDiagramConcepts(graph), ["Internet", "HTTP"]);
  });

  it("ignores malformed edges", () => {
    assert.deepEqual(normalizeRoadmapEdges([{ id: "bad" }, { id: "ok", source: "a", target: "b" }]), [
      { id: "ok", source: "a", target: "b", color: undefined, dashed: false },
    ]);
  });
});
