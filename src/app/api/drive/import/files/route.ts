import { NextResponse } from "next/server";
import { withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { logServerError } from "@/lib/server/logError";
import { getFileMetadata, isValidDriveConnectionId, isValidDriveId, type DriveFileMeta } from "@/lib/server/googleDrive";
import {
  bulkAddDriveDocumentsWithStats,
  bulkAddDriveVideosWithStats,
  createPlaylistAdmin,
  getExistingDriveDocumentFileIds,
  getExistingDriveVideoFileIds,
  getOrCreateUnsortedPlaylistAdmin,
  playlistExistsAdmin,
} from "@/lib/server/driveImport";
import { partitionDriveFiles, uniqueIds, type DriveSkipReason } from "@/lib/server/driveImportUtils";
import { fetchAndSaveDriveThumbnails } from "@/lib/server/driveThumbnails";
import { driveThumbnailMarker } from "@/lib/driveThumbnailMarker";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";
import { mapWithConcurrency } from "@/lib/allVideosUtils";

// Bulk import for a multi-select from the Google Picker: ONE request, one
// duplicate check and one playlist update instead of a request per file.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Metadata + thumbnails for up to 200 files; adjust to the deployment plan limit.
export const maxDuration = 60;

const MAX_FILES = 200;
const METADATA_CONCURRENCY = 8;
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TITLE_LENGTH = 300;

type ImportTarget =
  | { type: "new_playlist"; title: string }
  | { type: "existing_playlist"; playlistId: string }
  | { type: "unsorted" }
  | { type: "documents" };

function parseTarget(value: unknown): ImportTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  switch (target.type) {
    case "new_playlist": {
      if (target.title !== undefined && typeof target.title !== "string") return null;
      const title = (typeof target.title === "string" ? target.title.trim() : "").slice(0, MAX_TITLE_LENGTH);
      return { type: "new_playlist", title: title || "Drive import" };
    }
    case "existing_playlist":
      return typeof target.playlistId === "string" && PLAYLIST_ID_PATTERN.test(target.playlistId)
        ? { type: "existing_playlist", playlistId: target.playlistId }
        : null;
    case "unsorted":
      return { type: "unsorted" };
    case "documents":
      return { type: "documents" };
    default:
      return null;
  }
}

export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsedBody = await readJsonObject(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body: Record<string, unknown> = parsedBody.body;

  const connectionId = body.connectionId;
  const rawIds = body.fileIds;
  const target = parseTarget(body.target);
  if (!isValidDriveConnectionId(connectionId)) {
    return NextResponse.json({ error: "A valid connectionId is required." }, { status: 400 });
  }
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_FILES || !rawIds.every((id) => isValidDriveId(id))) {
    return NextResponse.json({ error: `fileIds must contain between 1 and ${MAX_FILES} valid Drive file ids.` }, { status: 400 });
  }
  if (!target) return NextResponse.json({ error: "A valid import target is required." }, { status: 400 });

  const fileIds = uniqueIds(rawIds as string[]);
  const requestDuplicates = rawIds.length - fileIds.length;

  try {
    if (target.type === "existing_playlist" && !await playlistExistsAdmin(uid, target.playlistId)) {
      return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
    }

    // Picker returns ids only, so fetch metadata for each (concurrency 8).
    const skipped: Array<{ fileId: string; reason: DriveSkipReason }> = [];
    const fetched = await mapWithConcurrency(fileIds, METADATA_CONCURRENCY, async (fileId) => {
      try {
        return await withDriveAccessToken(uid, connectionId, (accessToken) => getFileMetadata(accessToken, fileId));
      } catch (error) {
        if (error instanceof DriveConnectionError) throw error; // whole-account problem, not one file
        skipped.push({ fileId, reason: "inaccessible" });
        return null;
      }
    });
    const metas = fetched.filter((meta): meta is DriveFileMeta => meta !== null);

    const parts = partitionDriveFiles(metas);
    skipped.push(...parts.skipped);

    let videos = parts.videos;
    let documents = parts.documents;
    if (target.type === "documents") {
      // Study Materials only takes documents.
      skipped.push(...videos.map((video) => ({ fileId: video.id, reason: "not_a_document" as const })));
      videos = [];
    }

    // Resolve the playlist (created ONCE) and skip files that are already imported BEFORE fetching thumbnails.
    let playlistId: string | undefined;
    let existingVideoIds = new Set<string>();
    if (videos.length > 0) {
      if (target.type === "new_playlist") playlistId = await createPlaylistAdmin(uid, target.title);
      else if (target.type === "existing_playlist") playlistId = target.playlistId;
      else playlistId = await getOrCreateUnsortedPlaylistAdmin(uid);
      if (target.type !== "new_playlist") existingVideoIds = await getExistingDriveVideoFileIds(uid, playlistId);
    }
    const existingDocumentIds = documents.length > 0 ? await getExistingDriveDocumentFileIds(uid) : new Set<string>();

    const freshVideos = videos.filter((video) => !existingVideoIds.has(video.id));
    const freshDocuments = documents.filter(({ file }) => !existingDocumentIds.has(file.id));

    // Thumbnails for new items only (concurrency 5, stored server-side). Never fails the import.
    await fetchAndSaveDriveThumbnails(
      uid,
      connectionId,
      [...freshVideos, ...freshDocuments.map(({ file }) => file)].map((file) => ({ fileId: file.id, thumbnailLink: file.thumbnailLink })),
      (operation) => withDriveAccessToken(uid, connectionId, operation),
    );

    let addedVideos = 0;
    let duplicates = requestDuplicates + (videos.length - freshVideos.length) + (documents.length - freshDocuments.length);
    if (playlistId && freshVideos.length > 0) {
      const result = await bulkAddDriveVideosWithStats(uid, playlistId, freshVideos.map((file) => ({
        title: file.name,
        videoUrl: `https://drive.google.com/file/d/${file.id}/view`,
        thumbnailUrl: driveThumbnailMarker(file.id, connectionId),
        durationSeconds: file.videoMediaMetadata?.durationMillis ? Math.round(Number(file.videoMediaMetadata.durationMillis) / 1000) : 0,
        driveFileId: file.id,
        driveConnectionId: connectionId,
        thumbnailAttempted: true,
      })));
      addedVideos = result.added;
      duplicates += result.duplicates;
    }

    let addedDocuments = 0;
    if (freshDocuments.length > 0) {
      const result = await bulkAddDriveDocumentsWithStats(uid, freshDocuments.map(({ file, fileType, googleNative }) => ({
        title: file.name,
        fileType,
        mimeType: file.mimeType,
        sizeBytes: googleNative ? null : (file.size ? Number(file.size) : null),
        driveFileId: file.id,
        driveConnectionId: connectionId,
        md5Checksum: googleNative ? null : (file.md5Checksum ?? null),
        modifiedTime: file.modifiedTime ?? null,
        googleNative,
        thumbnailUrl: driveThumbnailMarker(file.id, connectionId),
        thumbnailAttempted: true,
      })));
      addedDocuments = result.added;
      duplicates += result.duplicates;
    }

    return NextResponse.json({ playlistId, addedVideos, addedDocuments, skipped, duplicates }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof DriveConnectionError) {
      return NextResponse.json({ error: error.message }, { status: error.code === "not_found" ? 404 : 409 });
    }
    logServerError("Drive bulk import failed", error);
    return NextResponse.json({ error: "Couldn't import those files from Drive." }, { status: 502 });
  }
}, { scope: "drive:import-files", preset: "import" });
