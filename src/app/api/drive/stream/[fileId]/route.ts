import { NextRequest, NextResponse } from "next/server";
import { getAccessTokenForConnection, withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { logServerError } from "@/lib/server/logError";
import { DriveApiError, exportFile, fetchFileContent, getFileMetadata, nativeExportMime } from "@/lib/server/googleDrive";
import { DRIVE_ERROR_MESSAGES, driveHttpStatusForCode, type DriveErrorCode } from "@/lib/driveErrors";
import { checkRateLimit } from "@/lib/server/rateLimit";
import { createDriveTiming, type DriveTiming } from "@/lib/server/timing";
import { verifyDriveUrl, type DriveUrlPurpose } from "@/lib/server/driveSignedUrl";

interface RouteParams {
  params: { fileId: string };
}

// Signed capability URLs let native media elements fetch this proxy without
// exposing Firebase or Google tokens. The signature binds the file,
// connection, purpose, and user until the URL expires.
//
// Range headers are forwarded both ways so seeking/resuming a large video
// works exactly like any other platform — the browser's own <video> element
// issues ranged requests automatically once it sees Accept-Ranges: bytes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stay within the route duration supported by the deployment plan.
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: RouteParams) {
  const timing = createDriveTiming("stream");
  try {
    return await getStreamResponse(req, params, timing);
  } finally {
    timing.log();
  }
}

async function getStreamResponse(req: NextRequest, params: RouteParams["params"], timing: DriveTiming) {
  const uid = req.nextUrl.searchParams.get("u") || "";
  const connectionId = req.nextUrl.searchParams.get("c") || "";
  const exp = Number(req.nextUrl.searchParams.get("e"));
  const purpose = req.nextUrl.searchParams.get("p") as DriveUrlPurpose | null;
  const sig = req.nextUrl.searchParams.get("s") || "";
  const exportPurpose = purpose === "export" || purpose === "export_download";
  const allowedPurpose = purpose === "stream" || purpose === "download" || exportPurpose;
  if (!purpose || !allowedPurpose) {
    return NextResponse.json({ error: "Invalid or expired Drive URL." }, { status: 401 });
  }
  const validSignature = await timing.measure("signature_ms", async () => (
    verifyDriveUrl({ uid, fileId: params.fileId, connectionId, purpose, exp, sig })
  ));
  if (!validSignature) {
    return NextResponse.json({ error: "Invalid or expired Drive URL." }, { status: 401 });
  }
  if (!checkRateLimit(uid, { scope: "drive:stream", preset: "stream" })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });

  const download = purpose === "download" || purpose === "export_download";

  try {
    const upstream = await withDriveAccessToken(
      uid,
      connectionId,
      async (accessToken) => {
        if (exportPurpose) {
          const meta = await getFileMetadata(accessToken, params.fileId);
          const exportMime = nativeExportMime(meta.mimeType);
          if (!exportMime) throw new DriveApiError(400, DRIVE_ERROR_MESSAGES.unsupported_type, "unsupported_type");
          return timing.measure("upstream_ms", () => exportFile(accessToken, params.fileId, exportMime));
        }
        return timing.measure("upstream_ms", () => fetchFileContent(accessToken, params.fileId, req.headers.get("range"), req.signal));
      },
      () => timing.measure("token_ms", () => getAccessTokenForConnection(uid, connectionId)),
    );

    if (upstream.status === 416) {
      // Range outside the file: pass it on as-is so players and viewers can recover.
      const rangeHeaders = new Headers();
      const contentRange = upstream.headers.get("content-range");
      if (contentRange) rangeHeaders.set("Content-Range", contentRange);
      await upstream.body?.cancel().catch(() => undefined);
      return new NextResponse(null, { status: 416, headers: rangeHeaders });
    }
    if (!upstream.ok && upstream.status !== 206) {
      // Specific, safe codes so the reader can say what is wrong (no access / deleted / reconnect) instead of "failed".
      await upstream.body?.cancel().catch(() => undefined);
      const code: DriveErrorCode = upstream.status === 404 ? "not_found"
        : upstream.status === 403 ? "permission"
        : upstream.status === 401 ? "auth"
        : "upstream";
      return NextResponse.json({ error: DRIVE_ERROR_MESSAGES[code], code }, { status: driveHttpStatusForCode(code) });
    }

    const headers = new Headers();
    for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }
    // fetch() already decoded a compressed body, so the upstream length no longer matches what is sent;
    // a wrong Content-Length makes browsers cut the file short.
    if (upstream.headers.get("content-encoding")) headers.delete("content-length");
    const contentType = (upstream.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
    // Exports are generated on the fly and cannot be range-requested.
    if (exportPurpose) headers.delete("accept-ranges");
    else headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "private, max-age=0, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    if (download || !(contentType.startsWith("video/") || contentType === "application/pdf" || contentType.startsWith("image/"))) {
      headers.set("Content-Disposition", "attachment");
    }

    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    // The browser went away (tab closed, video seek, navigation): nothing to report and nobody to answer.
    if (req.signal.aborted) return new NextResponse(null, { status: 499 });
    if (err instanceof DriveApiError && err.code) {
      return NextResponse.json({ error: DRIVE_ERROR_MESSAGES[err.code], code: err.code }, { status: driveHttpStatusForCode(err.code) });
    }
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    logServerError("Drive stream proxy failed", err);
    return NextResponse.json({ error: "Couldn't reach Google Drive." }, { status: 502 });
  }
}
