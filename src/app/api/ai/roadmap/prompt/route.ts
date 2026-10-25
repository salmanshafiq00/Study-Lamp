import { NextResponse } from "next/server";
import { buildRoadmapStepsPrompt, withResponseLanguage } from "@/lib/ai/aiService";
import { getRoadmapReference } from "@/lib/server/developerRoadmap";
import type { RoadmapLevel } from "@/types";
import { resolveAiLanguage } from "@/lib/server/aiPreferences";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

// No AI call here — this just returns the exact prompt text the generate
// route would send, so a user can copy it, run it in a different AI tool,
// and paste the reply back in via "Customize" -> paste/import.
// Calls an AI model; adjust to the deployment plan limit.
export const maxDuration = 60;

export const POST = withAuthedRoute(async ({ uid, req }) => {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }

  const categoryName = String(body?.categoryName ?? "").trim() || "Learning topic";
  const level = body?.level as RoadmapLevel;
  const subtopics: string[] = Array.isArray(body?.subtopics) ? body.subtopics.map((s: any) => String(s).trim()).filter(Boolean) : [];
  const language = await resolveAiLanguage(uid, body?.language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });

  if (!["basic", "intermediate", "advanced"].includes(level)) {
    return NextResponse.json({ error: "A valid level is required." }, { status: 400 });
  }

  // The copied prompt must match what the generate route sends, including
  // the roadmap.sh reference block (when the category matches a topic).
  const reference = await getRoadmapReference(categoryName, subtopics);
  const prompt = withResponseLanguage(
    buildRoadmapStepsPrompt({
      categoryName,
      level,
      subtopics,
      reference: reference
        ? {
            title: reference.graph.title,
            sourceUrl: reference.graph.sourceUrl || "https://roadmap.sh",
            concepts: reference.concepts,
          }
        : undefined,
    }),
    language,
  );
  return NextResponse.json(
    {
      prompt,
      referenceSlug: reference?.match.slug ?? null,
      referenceTitle: reference?.graph.title ?? null,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
});
