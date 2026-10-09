import { appendApplyDisabledHandler } from "@/lib/server/appendApplyDisabled";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DISABLED (hotfix D14): returns 503 right after authentication until roadmap step Z2 is done.
 * It does not read the body, call Google, or touch Firestore. The preview route is unchanged.
 */
export const POST = withAuthedRoute(appendApplyDisabledHandler);
