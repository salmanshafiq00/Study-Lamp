import { NextResponse } from "next/server";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { fetchDeveloperRoadmapBySlug, getRoadmapReference } from "@/lib/server/developerRoadmap";
import { DEVELOPER_ROADMAP_TOPICS, resolveDeveloperRoadmapSlug } from "@/lib/roadmapReference";

// Returns the roadmap.sh graph for a category (or an explicit slug). The
// client uses it for the diagram tab; generation uses the same data
// server-side, so the two never disagree about which roadmap grounded the
// plan. Authenticated + cached: the graph is ~150 KB upstream and identical
// for every user.
export const GET = withAuthedRoute(async ({ req }) => {
  const slugParam = (req.nextUrl.searchParams.get("slug") || "").trim();
  const categoryName = (req.nextUrl.searchParams.get("categoryName") || "").trim();
  const subtopics = (req.nextUrl.searchParams.get("subtopics") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (slugParam) {
    const known = DEVELOPER_ROADMAP_TOPICS.some((topic) => topic.slug === slugParam);
    if (!known) {
      return NextResponse.json({ error: "Unknown roadmap topic." }, { status: 400 });
    }
    const graph = await fetchDeveloperRoadmapBySlug(slugParam);
    if (!graph) {
      return NextResponse.json({ matched: false, reason: "unavailable" }, { headers: { "Cache-Control": "private, max-age=300" } });
    }
    return NextResponse.json(
      { matched: true, ...graph },
      { headers: { "Cache-Control": "private, max-age=3600" } },
    );
  }

  if (!categoryName) {
    return NextResponse.json({ error: "categoryName or slug is required." }, { status: 400 });
  }

  const reference = await getRoadmapReference(categoryName, subtopics);
  if (!reference) {
    const match = resolveDeveloperRoadmapSlug(categoryName, subtopics);
    return NextResponse.json(
      { matched: false, reason: match ? "unavailable" : "no-match" },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  }

  return NextResponse.json(
    { matched: true, ...reference.graph },
    { headers: { "Cache-Control": "private, max-age=3600" } },
  );
}, { scope: "roadmap-reference", limit: 40 });
