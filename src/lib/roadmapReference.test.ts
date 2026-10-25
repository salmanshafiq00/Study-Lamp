import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeRoadmapMatchText, resolveDeveloperRoadmapSlug } from "./roadmapReference";

describe("developer-roadmap category matching", () => {
  it("normalizes punctuation and common developer spellings", () => {
    assert.equal(normalizeRoadmapMatchText("ASP.NET Core"), "aspnet core");
    assert.equal(normalizeRoadmapMatchText("C++"), "cpp");
    assert.equal(normalizeRoadmapMatchText("C#"), "csharp");
    assert.equal(normalizeRoadmapMatchText("UI/UX Design"), "ui ux design");
  });

  it("matches common category names", () => {
    assert.equal(resolveDeveloperRoadmapSlug("Frontend Development")?.slug, "frontend");
    assert.equal(resolveDeveloperRoadmapSlug("React")?.slug, "react");
    assert.equal(resolveDeveloperRoadmapSlug("Node.js")?.slug, "nodejs");
    assert.equal(resolveDeveloperRoadmapSlug("ASP.NET Core")?.slug, "aspnet-core");
    assert.equal(resolveDeveloperRoadmapSlug("C++")?.slug, "cpp");
    assert.equal(resolveDeveloperRoadmapSlug("Machine Learning")?.slug, "machine-learning");
    assert.equal(resolveDeveloperRoadmapSlug("UI/UX")?.slug, "ux-design");
  });

  it("does not let Java swallow JavaScript", () => {
    assert.equal(resolveDeveloperRoadmapSlug("JavaScript")?.slug, "javascript");
    assert.equal(resolveDeveloperRoadmapSlug("Java")?.slug, "java");
  });

  it("keeps the category in charge when a subtopic names a narrower tool", () => {
    assert.equal(resolveDeveloperRoadmapSlug("Web Development", ["React", "CSS"])?.slug, "frontend");
  });

  it("returns null for a topic with no developer-roadmap equivalent", () => {
    assert.equal(resolveDeveloperRoadmapSlug("Cooking"), null);
    assert.equal(resolveDeveloperRoadmapSlug(""), null);
  });
});
