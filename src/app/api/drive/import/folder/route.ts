import { NextResponse } from "next/server";
import { withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { logServerError } from "@/lib/server/logError";
import { DriveApiError, folderHasVisibleChildren, getFileMetadata, listFolderVideoFiles, isValidDriveConnectionId, isValidDriveId } from "@/lib/server/googleDrive";
import { createPlaylistAdmin, bulkAddDriveVideosAdmin } from "@/lib/server/driveImport";
import { fetchAndSaveDriveThumbnails } from "@/lib/server/driveThumbnails";
import { driveThumbnailMarker } from "@/lib/driveThumbnailMarker";
import { withAuthedRoute, readJsonObject } from "@/lib/server/routeHelpers";

// Imports a picked Drive folder as a new playlist, one video per file in the
// folder (direct children only — no recursive sub-folders, matching Phase
// 14's "one level" design). The playlist's category is left for the user to
// set from the normal playlist-rename dialog afterward; see the note in
// README-drive.md about the AI category-suggestion step this phase skipped.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Imports many files and thumbnails; adjust to the deployment plan limit.
export const maxDuration = 60;

export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsedBody = await readJsonObject(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;

  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const folderId = typeof body.folderId === "string" ? body.folderId : "";
  if (!isValidDriveConnectionId(connectionId) || !isValidDriveId(folderId)) {
    return NextResponse.json({ error: "Valid connectionId and folderId are required." }, { status: 400 });
  }

  try {
    const { folderMeta, files, hasChildren } = await withDriveAccessToken(uid, connectionId, async (accessToken) => {
      const folderMeta = await getFileMetadata(accessToken, folderId);
      const files = await listFolderVideoFiles(accessToken, folderId);
      // Only needed when no video is visible: distinguishes "folder has other files" from
      // "the app can't see this folder's children at all".
      const hasChildren = files.length > 0 ? true : await folderHasVisibleChildren(accessToken, folderId);
      return { folderMeta, files, hasChildren };
    });

    if (files.length === 0) {
      if (!hasChildren) {
        // drive.file only grants access to files the user picked. Nothing is visible, so ask the
        // client to reopen the Picker scoped to this folder; selecting files there grants access.
        return NextResponse.json({ needsSelection: true, folderId, folderName: folderMeta.name });
      }
      return NextResponse.json({ error: `"${folderMeta.name}" doesn't contain any video files.` }, { status: 422 });
    }

    // Thumbnail bytes are stored server-side (driveThumbs, concurrency 5); the
    // video docs below only carry the marker. Never fails the import.
    await fetchAndSaveDriveThumbnails(
      uid,
      connectionId,
      files.map((file) => ({ fileId: file.id, thumbnailLink: file.thumbnailLink })),
      (operation) => withDriveAccessToken(uid, connectionId, operation),
    );

    const playlistId = await createPlaylistAdmin(uid, folderMeta.name);
    const added = await bulkAddDriveVideosAdmin(
      uid,
      playlistId,
      files.map((f) => ({
        title: f.name,
        videoUrl: `https://drive.google.com/file/d/${f.id}/view`,
        thumbnailUrl: driveThumbnailMarker(f.id, connectionId),
        durationSeconds: f.videoMediaMetadata?.durationMillis ? Math.round(Number(f.videoMediaMetadata.durationMillis) / 1000) : 0,
        driveFileId: f.id,
        driveConnectionId: connectionId,
        thumbnailAttempted: true,
      }))
    );

    return NextResponse.json({ playlistId, videoCount: added });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    if (err instanceof DriveApiError && err.status === 429) {
      return NextResponse.json({ error: "Google Drive is rate-limiting requests. Try again in a minute." }, { status: 429, headers: { "Retry-After": "60" } });
    }
    logServerError("Drive folder import failed", err);
    return NextResponse.json({ error: "Couldn't import that folder from Drive." }, { status: 502 });
  }
}, { scope: "drive:import-folder", preset: "import" });
