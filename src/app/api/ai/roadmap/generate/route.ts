import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { withAiConnection } from "@/lib/server/resolveAiConnection";
import { generateRoadmapStepsForLevel, type RoadmapPromptReference } from "@/lib/ai/aiService";
import { sanitizeRoadmapSteps } from "@/lib/roadmapUtils";
import { getRoadmapReference } from "@/lib/server/developerRoadmap";
import type { RoadmapLevel } from "@/types";
import admin from "firebase-admin";
import { resolveAiLanguage } from "@/lib/server/aiPreferences";
import { aiErrorResponse, withAuthedRoute } from "@/lib/server/routeHelpers";

// Calls an AI model; adjust to the deployment plan limit.
export const maxDuration = 60;

export const POST = withAuthedRoute(async ({ uid, req }) => {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }

  const categoryId = String(body?.categoryId ?? "").trim();
  const categoryName = String(body?.categoryName ?? "").trim();
  const level = body?.level as RoadmapLevel;
  const subtopics: string[] = Array.isArray(body?.subtopics) ? body.subtopics.map((s: any) => String(s).trim()).filter(Boolean) : [];
  const roadmapId = String(body?.roadmapId ?? "").trim() || null;
  const language = await resolveAiLanguage(uid, body?.language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });

  if (!categoryId && !categoryName) return NextResponse.json({ error: "A categoryId or categoryName is required." }, { status: 400 });
  if (!["basic", "intermediate", "advanced"].includes(level)) return NextResponse.json({ error: "A valid level is required." }, { status: 400 });

  try {
    const categorySnap = await adminDb.collection("users").doc(uid).collection("categories").get();
    const categories = categorySnap.docs.map((c) => ({ id: c.id, name: String(c.data().name || "") }));
    const resolvedCategory = categories.find((c) => c.id === categoryId) || categories.find((c) => c.name.trim().toLowerCase() === categoryName.toLowerCase());
    const resolvedName = resolvedCategory?.name || categoryName || "Learning topic";
    const targetCategoryId = categoryId || resolvedCategory?.id || resolvedName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "learning-topic";

    // Ground the plan in developer-roadmap / roadmap.sh data when the
    // category maps to one of its topics. Best-effort: a missing match or an
    // unreachable roadmap.sh must never block generation.
    const reference = await getRoadmapReference(resolvedName, subtopics);
    const promptReference: RoadmapPromptReference | undefined = reference
      ? {
          title: reference.graph.title,
          sourceUrl: reference.graph.sourceUrl || "https://roadmap.sh",
          concepts: reference.concepts,
        }
      : undefined;
    const referenceFields = reference
      ? { referenceSlug: reference.match.slug, referenceTitle: reference.graph.title }
      : {};

    const steps = sanitizeRoadmapSteps(
      await withAiConnection(uid, (apiKey, provider, model) =>
        generateRoadmapStepsForLevel(
          { provider, apiKey, model, language },
          { categoryName: resolvedName, level, subtopics, reference: promptReference },
        )
      )
    );

    const roadmapsRef = adminDb.collection("users").doc(uid).collection("learningRoadmaps");

    // Every category+level has exactly one roadmap per user — this route
    // upserts it, whether the caller is "Generate" (no roadmap yet),
    // "Regenerate" (roadmapId supplied), or a level that already has a
    // roadmap but no roadmapId was passed (fall back to finding it by
    // categoryId+level so we never create a second doc for the same slot).
    let targetRef = roadmapId ? roadmapsRef.doc(roadmapId) : null;

    if (targetRef) {
      const snap = await targetRef.get();
      const data = snap.data() as { categoryId?: string; level?: RoadmapLevel } | undefined;
      if (!snap.exists || data?.categoryId !== targetCategoryId || data?.level !== level) {
        return NextResponse.json({ error: "This roadmap could not be found for regeneration." }, { status: 404 });
      }
    } else {
      const existingSnap = await roadmapsRef.where("categoryId", "==", targetCategoryId).where("level", "==", level).limit(1).get();
      if (!existingSnap.empty) targetRef = existingSnap.docs[0].ref;
    }

    let finalRoadmapId: string;
    if (targetRef) {
      await targetRef.update({
        steps,
        source: "generated",
        ...referenceFields,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      finalRoadmapId = targetRef.id;
    } else {
      const created = await roadmapsRef.add({
        categoryId: targetCategoryId,
        level,
        steps,
        source: "generated",
        adoptedFromTemplateAt: null,
        ...referenceFields,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      finalRoadmapId = created.id;
    }

    return NextResponse.json(
      {
        categoryId: targetCategoryId,
        categoryName: resolvedName,
        level,
        steps,
        roadmapId: finalRoadmapId,
        referenceSlug: reference?.match.slug ?? null,
        referenceTitle: reference?.graph.title ?? null,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (err: any) {
    return aiErrorResponse(err, { fallbackMessage: "Something went wrong generating a roadmap.", logLabel: "Failed to generate roadmap" });
  }
});