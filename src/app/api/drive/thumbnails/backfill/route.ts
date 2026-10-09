import { NextResponse } from "next/server";
import { withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { logServerError } from "@/lib/server/logError";
import { getFileMetadata } from "@/lib/server/googleDrive";
import {
  countLegacyThumbnails,
  countUnattemptedThumbnails,
  ensureThumbnailAttemptFieldsNormalized,
  fetchAndStoreDriveThumbnail,
  listLegacyThumbnailTargets,
  listUnattemptedThumbnailTargets,
  markThumbnailAttempted,
  migrateLegacyThumbnail,
  saveDriveThumbnail,
  type DriveThumbnailTarget,
} from "@/lib/server/driveThumbnails";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Heavy Drive work; adjust to the deployment plan limit.
export const maxDuration = 60;

const BATCH_SIZE = 25;
const CONCURRENCY = 5;

/**
 * Two jobs, oldest first:
 *  1. Migrate legacy docs that still carry base64 `thumbnailData` into the
 *     server-only driveThumbs collection and delete the field.
 *  2. Fetch thumbnails for Drive items that were never attempted.
 * Each call handles up to BATCH_SIZE items; `remaining` tells the caller
 * (Settings -> Google Drive) whether to call again.
 */
export const POST = withAuthedRoute(async ({ uid }) => {
  try {
    // One-time per user (skipped via users/{uid}.driveThumbsNormalizedAt): make items with a MISSING
    // thumbnailAttemptedAt field visible to the `== null` queries below.
    await ensureThumbnailAttemptFieldsNormalized(uid);

    const legacy = await listLegacyThumbnailTargets(uid, BATCH_SIZE);
    let fresh: DriveThumbnailTarget[] = [];
    if (legacy.length < BATCH_SIZE) {
      const unattempted = await listUnattemptedThumbnailTargets(uid, BATCH_SIZE - legacy.length);
      // A doc can appear in both queries; the legacy pass already covers it.
      const legacyPaths = new Set(legacy.map((target) => target.ref.path));
      fresh = unattempted.filter((target) => !legacyPaths.has(target.ref.path) && typeof target.legacyThumbnailData !== "string");
    }

    const jobs: Array<{ target: DriveThumbnailTarget; legacy: boolean }> = [
      ...legacy.map((target) => ({ target, legacy: true })),
      ...fresh.map((target) => ({ target, legacy: false })),
    ];

    let cursor = 0;
    let succeeded = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const { target, legacy: isLegacy } = jobs[cursor++];
        try {
          if (isLegacy) {
            await migrateLegacyThumbnail(uid, target);
          } else {
            try {
              const image = await withDriveAccessToken(uid, target.connectionId, async (accessToken) => {
                const metadata = await getFileMetadata(accessToken, target.fileId);
                return fetchAndStoreDriveThumbnail(accessToken, metadata.thumbnailLink);
              });
              if (image) await saveDriveThumbnail(uid, target.connectionId, target.fileId, image);
            } catch (error) {
              if (!(error instanceof DriveConnectionError)) {
                logServerError("Drive thumbnail backfill item failed", error);
              }
            }
            // Mark as attempted even on failure so one bad file can't stall the queue;
            // the thumbnail route still self-heals when the item is viewed.
            await markThumbnailAttempted(target);
          }
          succeeded++;
        } catch (error) {
          logServerError("Drive thumbnail backfill write failed", error);
        }
      }
    }));

    // If nothing in this batch could be written, report 0 remaining so the
    // client's "call again while remaining > 0" loop cannot spin forever.
    const remaining = succeeded === 0 && jobs.length > 0
      ? 0
      : (await Promise.all([countLegacyThumbnails(uid), countUnattemptedThumbnails(uid)])).reduce((sum, count) => sum + count, 0);
    return NextResponse.json({ processed: succeeded, remaining });
  } catch (error) {
    logServerError("Drive thumbnail backfill failed", error);
    return NextResponse.json({ error: "Couldn't refresh Drive thumbnails." }, { status: 500 });
  }
}, { scope: "drive:thumbnail-backfill" });
