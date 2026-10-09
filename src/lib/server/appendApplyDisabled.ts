import { NextResponse } from "next/server";

/**
 * HOTFIX D14. The Docs/Sheets append APPLY routes are switched off until roadmap step Z2 rebuilds them
 * (token-bound target, server-built content, one-time token). This handler is deliberately dependency-free:
 * it must never import Drive, Docs, Sheets or Firestore code, so nothing can be written while it is in place.
 * Remove it (and re-enable the real handlers) in step Z2.
 */
export function appendApplyDisabledHandler(): Response {
  return NextResponse.json({ error: "Temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
}
