import { createBlobHandlers, type BlobParams } from "@/lib/server/blobRouteHandlers";
import { realBlobDeps } from "@/lib/server/blobRouteDeps";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const handlers = createBlobHandlers(realBlobDeps);
const options = { scope: "blob", preset: "blob" } as const;

/** Study Lamp's own storage files in the user's Drive "Study Lamp data" folder (roadmap P4, decision D15). */
export const GET = withAuthedRoute<BlobParams>(handlers.get, options);
export const PUT = withAuthedRoute<BlobParams>(handlers.put, options);
export const DELETE = withAuthedRoute<BlobParams>(handlers.del, options);
