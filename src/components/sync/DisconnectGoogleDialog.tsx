"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { ConfirmActionDialog } from "@/components/sync/ConfirmActionDialog";
import { applyGoogleRemoval, disconnectGoogleConnection, previewGoogleRemoval } from "@/lib/googleClient";
import { describeRemovalCount, removeThenDisconnect, type RemovalApi, type RemovalTarget } from "@/lib/googleRemovalFlow";
import type { GoogleConnectionSummary } from "@/types";

/**
 * Disconnect dialog (W5). Replaces window.confirm. An UNCHECKED option can also remove what Study Lamp created in
 * Google. That removal runs through the same preview -> confirm -> apply as everywhere else and finishes BEFORE the
 * stored token is deleted. If any removal fails the account stays connected and the error stays in the dialog.
 */
export function DisconnectGoogleDialog({
  connection,
  onOpenChange,
  onDisconnected,
}: {
  connection: GoogleConnectionSummary | null;
  onOpenChange: (open: boolean) => void;
  onDisconnected: (connection: GoogleConnectionSummary, removed: number) => void;
}) {
  const { user } = useAuth();
  const [counts, setCounts] = React.useState<Record<RemovalTarget, number>>({ calendar: 0, tasks: 0 });
  const [loadingCounts, setLoadingCounts] = React.useState(false);
  const [alsoRemove, setAlsoRemove] = React.useState(false);

  const connectionId = connection?.id ?? null;
  const grantedScopes = connection?.grantedScopes;

  // Read-only: counts the mapped events/tasks so the checkbox can say how many there are.
  React.useEffect(() => {
    setAlsoRemove(false);
    setCounts({ calendar: 0, tasks: 0 });
    if (!user || !connectionId || !grantedScopes) return;
    let cancelled = false;
    setLoadingCounts(true);
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const next: Record<RemovalTarget, number> = { calendar: 0, tasks: 0 };
        for (const target of ["calendar", "tasks"] as const) {
          if (!grantedScopes.includes(target)) continue;
          next[target] = (await previewGoogleRemoval(idToken, { target, scope: "all", connectionId })).count;
        }
        if (!cancelled) setCounts(next);
      } catch {
        // Without counts the option is simply not offered; disconnecting still works.
      } finally {
        if (!cancelled) setLoadingCounts(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, connectionId, grantedScopes]);

  const total = counts.calendar + counts.tasks;
  const summary = [counts.calendar > 0 ? describeRemovalCount("calendar", counts.calendar) : null, counts.tasks > 0 ? describeRemovalCount("tasks", counts.tasks) : null]
    .filter(Boolean)
    .join(" and ");

  async function confirm() {
    if (!user || !connection) return;
    const idToken = await user.getIdToken();
    const api: RemovalApi = {
      preview: (input) => previewGoogleRemoval(idToken, input),
      apply: (input) => applyGoogleRemoval(idToken, input),
    };
    // Any removal finishes first; only then is the stored token deleted.
    const removed = await removeThenDisconnect({
      alsoRemove: alsoRemove && total > 0,
      counts,
      connectionId: connection.id,
      api,
      disconnect: () => disconnectGoogleConnection(idToken, connection.id),
    });
    onDisconnected(connection, removed);
  }

  return (
    <ConfirmActionDialog
      open={connection !== null}
      onOpenChange={onOpenChange}
      title="Disconnect this Google account?"
      description={`Study Lamp will stop syncing with ${connection?.googleEmail ?? "this account"} and forget its stored access. By default, anything already created in Google stays there.`}
      confirmLabel={alsoRemove && total > 0 ? "Remove and disconnect" : "Disconnect"}
      destructive
      onConfirm={confirm}
    >
      {total > 0 && (
        <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={alsoRemove}
            onChange={(event) => setAlsoRemove(event.target.checked)}
          />
          <span>
            Also remove {summary} that Study Lamp created
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Only items Study Lamp recorded are deleted. Your goals here are not changed. This cannot be undone.
            </span>
          </span>
        </label>
      )}
      {connection?.driveGranted && (
        <p className="text-xs text-muted-foreground">
          This connection also has Google Drive turned on. Disconnecting removes Drive access too, so files imported from this account stop opening until you reconnect.
        </p>
      )}
      {loadingCounts && <p className="text-xs text-muted-foreground">Checking what Study Lamp created…</p>}
    </ConfirmActionDialog>
  );
}
