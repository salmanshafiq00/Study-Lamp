import { NextResponse } from "next/server";
import { withAiConnection } from "@/lib/server/resolveAiConnection";
import { logServerError } from "@/lib/server/logError";
import { AiServiceError, generateTopicClarification, generateFocusClarification } from "@/lib/ai/aiService";
import { resolveAiLanguage } from "@/lib/server/aiPreferences";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

// Calls an AI model; adjust to the deployment plan limit.
export const maxDuration = 60;

export const POST = withAuthedRoute(async ({ uid, req }) => {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }

  const rawName = String(body?.name ?? "").trim();
  const context = String(body?.context ?? "").trim();
  const kind = body?.kind === "focus" ? "focus" : "topic";
  const language = await resolveAiLanguage(uid, body?.language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });

  if (!rawName) return NextResponse.json({ error: "A name is required." }, { status: 400 });
  if (kind === "focus" && !context) return NextResponse.json({ error: "A category context is required for focus clarification." }, { status: 400 });

  try {
    const result = await withAiConnection(uid, (apiKey, provider, model) =>
      kind === "focus"
        ? generateFocusClarification({ provider, apiKey, model, language }, context, rawName)
        : generateTopicClarification({ provider, apiKey, model, language }, rawName)
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    // Clarification is best-effort — never block saving over it.
    if (err instanceof AiServiceError) logServerError(`Clarify AI error [${err.code}]`, err);
    return NextResponse.json({ ambiguous: false });
  }
});