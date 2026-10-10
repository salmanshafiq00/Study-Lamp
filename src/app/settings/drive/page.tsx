import { redirect } from "next/navigation";
import { legacyDriveSettingsRedirect } from "@/lib/googleSettings";

export const dynamic = "force-dynamic";

// Drive settings now live on the single Google page. Kept so old bookmarks and any OAuth return that was
// already in flight still land on the Drive card.
export default function LegacyDriveSettingsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  redirect(legacyDriveSettingsRedirect(searchParams));
}
