import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { logServerError } from "@/lib/server/logError";
import { BLOB_MAX_BYTES, BlobStoreError, isBlobKey, isBlobKind, type BlobKind } from "@/lib/server/driveBlobStore";

export interface BlobRouteDeps {
  get(uid: string, kind: BlobKind, key: string): Promise<{ json: unknown; version: string | null } | null>;
  put(uid: string, kind: BlobKind, key: string, jsonText: string): Promise<{ bytes: number; version: string | null }>;
  del(uid: string, kind: BlobKind, key: string): Promise<boolean>;
  ownsDocument(uid: string, documentId: string): Promise<boolean>;
}

export type BlobParams = { kind: string; key: string };
interface Context { uid: string; req: NextRequest; params: BlobParams }

const NO_STORE = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/** Maps a blob-store failure to a generic response. `code` lets the client choose a fallback; no provider text is returned. */
export function blobErrorResponse(err: unknown, label: string): NextResponse {
  if (err instanceof BlobStoreError) {
    switch (err.code) {
      case "invalid": return json({ error: "Invalid request." }, 400);
      case "too_large": return json({ error: "Too large.", code: "too_large" }, 413);
      case "auth":
      case "scope_missing": return json({ error: "Reconnect Google Drive.", code: "reconnect" }, 409);
      case "no_connection": return json({ error: "Connect Google Drive first.", code: "no_drive" }, 409);
      case "quota": return json({ error: "Your Google Drive is full.", code: "quota" }, 507);
      case "not_found": return json({ error: "Not found." }, 404);
      case "forbidden": logServerError(label, err); return json({ error: "Not allowed." }, 403);
      default: logServerError(label, err); return json({ error: "Google Drive is unavailable. Try again." }, 502);
    }
  }
  logServerError(label, err);
  return json({ error: "Something went wrong." }, 500);
}

/** Reads at most maxBytes of the request body; null when it is larger (the stream is cancelled while reading). */
export async function readTextCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function check(deps: BlobRouteDeps, uid: string, params: BlobParams): Promise<{ kind: BlobKind; key: string } | NextResponse> {
  if (!isBlobKind(params?.kind) || !isBlobKey(params?.key)) return json({ error: "Invalid request." }, 400);
  // annotations/doctext keys are personal document ids: the document must belong to the caller.
  if ((params.kind === "annotations" || params.kind === "doctext") && !(await deps.ownsDocument(uid, params.key))) {
    return json({ error: "Not found." }, 404);
  }
  return { kind: params.kind, key: params.key };
}

export function createBlobHandlers(deps: BlobRouteDeps) {
  return {
    async get({ uid, params }: Context): Promise<Response> {
      const checked = await check(deps, uid, params);
      if (checked instanceof NextResponse) return checked;
      try {
        const blob = await deps.get(uid, checked.kind, checked.key);
        return blob ? json({ json: blob.json, version: blob.version }) : json({ error: "Not found." }, 404);
      } catch (err) { return blobErrorResponse(err, "Blob read failed"); }
    },

    async put({ uid, req, params }: Context): Promise<Response> {
      const checked = await check(deps, uid, params);
      if (checked instanceof NextResponse) return checked;
      const text = await readTextCapped(req, BLOB_MAX_BYTES[checked.kind]);
      if (text === null) return json({ error: "Too large.", code: "too_large" }, 413);
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") return json({ error: "Body must be a JSON object or array." }, 400);
      } catch {
        return json({ error: "Invalid JSON body." }, 400);
      }
      try {
        const saved = await deps.put(uid, checked.kind, checked.key, text);
        return json({ ok: true, bytes: saved.bytes, version: saved.version });
      } catch (err) { return blobErrorResponse(err, "Blob write failed"); }
    },

    async del({ uid, params }: Context): Promise<Response> {
      const checked = await check(deps, uid, params);
      if (checked instanceof NextResponse) return checked;
      try {
        return json({ deleted: await deps.del(uid, checked.kind, checked.key) });
      } catch (err) { return blobErrorResponse(err, "Blob delete failed"); }
    },
  };
}
