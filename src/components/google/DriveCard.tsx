"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getDriveMigrationStatus, getLegacyDriveCleanupStatus, runDriveMigration, runLegacyDriveCleanup } from "@/lib/googleClient";
import { backfillDriveThumbnails, listDriveConnections, disconnectDrive, startDriveConnect } from "@/lib/driveClient";
import { cn } from "@/lib/utils";
import { driveStatus, errorMessage } from "@/lib/googleSettings";
import type { DriveConnectionSummary } from "@/types";
import { HardDrive, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

const STATUS_LABEL = { connected: "Connected", needs_reconnect: "Needs reconnecting", not_connected: "Not connected" } as const;

/** Google Drive card on Settings → Google (moved unchanged from the old /settings/drive page). */
export function DriveCard({ highlight = false }: { highlight?: boolean }) {
  const { user } = useAuth();
  const [connections, setConnections] = React.useState<DriveConnectionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [connecting, setConnecting] = React.useState(false);
  const [disconnectingId, setDisconnectingId] = React.useState<string | null>(null);
  const [refreshingThumbnails, setRefreshingThumbnails] = React.useState(false);
  const [thumbnailsRemaining, setThumbnailsRemaining] = React.useState<number | null>(null);
  const [pendingMigration, setPendingMigration] = React.useState(0);
  const [migrating, setMigrating] = React.useState(false);
  const [cleanable, setCleanable] = React.useState(0);
  const [cleaning, setCleaning] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const idToken = await user.getIdToken();
      setConnections(await listDriveConnections(idToken));
      setPendingMigration((await getDriveMigrationStatus(idToken).catch(() => ({ pending: 0 }))).pending);
      setCleanable((await getLegacyDriveCleanupStatus(idToken).catch(() => ({ deletable: 0, blocked: 0 }))).deletable);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to load your Google Drive connections."));
    } finally {
      setLoading(false);
    }
  }, [user]);

  React.useEffect(() => { load(); }, [load]);

  async function handleConnect() {
    if (!user) return;
    setConnecting(true);
    try {
      const idToken = await user.getIdToken();
      await startDriveConnect(idToken); // navigates away to Google
    } catch (error) {
      toast.error(errorMessage(error, "Failed to start connecting Google Drive."));
      setConnecting(false);
    }
  }

  async function handleDisconnect(connection: DriveConnectionSummary) {
    if (!user) return;
    if (!confirm(`Disconnect ${connection.googleEmail}? Videos and documents already imported from it will stop playing until you reconnect.`)) return;
    setDisconnectingId(connection.id);
    try {
      const idToken = await user.getIdToken();
      await disconnectDrive(idToken, connection.id);
      setConnections((prev) => prev.filter((c) => c.id !== connection.id));
      toast.success("Disconnected. Nothing was deleted from your Drive.");
    } catch (error) {
      toast.error(errorMessage(error, "Failed to disconnect."));
    } finally {
      setDisconnectingId(null);
    }
  }

  async function handleMigrate() {
    if (!user || migrating) return;
    if (!confirm(`Move ${pendingMigration} Google Drive connection${pendingMigration === 1 ? "" : "s"} onto your single Google connection? Nothing is deleted, and imported files keep working.`)) return;
    setMigrating(true);
    try {
      const idToken = await user.getIdToken();
      const { counts } = await runDriveMigration(idToken);
      if (counts.needs_drive_consent > 0) toast.info('One account also uses Calendar or Tasks. Use "Add Drive access" for it, then run this again.');
      if (counts.verify_failed > 0 || counts.skipped_invalid > 0) toast.error("Some connections could not be verified. They were left as they are. Reconnect them, then try again.");
      if (counts.migrated > 0) toast.success(`Moved ${counts.migrated} connection${counts.migrated === 1 ? "" : "s"}.`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error, "Failed to move your Drive connections."));
    } finally {
      setMigrating(false);
    }
  }

  async function handleCleanup() {
    if (!user || cleaning) return;
    if (!confirm(`Delete ${cleanable} old Google Drive record${cleanable === 1 ? "" : "s"}? They were already moved onto your Google connection. Your files, imported documents and Google access are not affected.`)) return;
    setCleaning(true);
    try {
      const idToken = await user.getIdToken();
      const { deleted } = await runLegacyDriveCleanup(idToken);
      toast.success(`Deleted ${deleted} old record${deleted === 1 ? "" : "s"}.`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error, "Failed to clean up the old Drive records."));
    } finally {
      setCleaning(false);
    }
  }

  async function handleRefreshThumbnails() {
    if (!user || refreshingThumbnails) return;
    setRefreshingThumbnails(true);
    setThumbnailsRemaining(null);
    let processed = 0;
    try {
      const idToken = await user.getIdToken();
      let remaining = 1;
      while (remaining > 0) {
        const batch = await backfillDriveThumbnails(idToken);
        processed += batch.processed;
        remaining = batch.remaining;
        setThumbnailsRemaining(remaining);
      }
      toast.success(processed ? `Refreshed ${processed} Drive thumbnails.` : "Drive thumbnails are up to date.");
    } catch (error) {
      toast.error(errorMessage(error, "Failed to refresh Drive thumbnails."));
    } finally {
      setRefreshingThumbnails(false);
      setThumbnailsRemaining(null);
    }
  }

  const status = driveStatus(connections);

  return (
    <section id="drive" aria-label="Google Drive" className="scroll-mt-4 space-y-4">
      <Card className={cn(highlight && "ring-2 ring-accent")}>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <HardDrive className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-display text-base font-semibold">Google Drive</h2>
                  {!loading && (
                    <Badge variant={status === "connected" ? "success" : status === "needs_reconnect" ? "destructive" : "secondary"}>
                      {STATUS_LABEL[status]}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  Pick videos and documents from Drive, upload new ones and back up your library. Link one or more Google
                  accounts, independent of the one you log into Study Lamp with.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">What Study Lamp can access:</span> only files you pick or that
                  Study Lamp creates (the narrow &quot;drive.file&quot; permission) — never your whole Drive.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {connections.some((connection) => connection.status !== "invalid") && (
                <Button size="sm" variant="outline" className="gap-1.5" onClick={handleRefreshThumbnails} disabled={refreshingThumbnails}>
                  <RefreshCw className={`h-4 w-4 ${refreshingThumbnails ? "animate-spin" : ""}`} />
                  {refreshingThumbnails ? `Refreshing${thumbnailsRemaining === null ? "…" : ` (${thumbnailsRemaining} left)`}` : "Refresh thumbnails"}
                </Button>
              )}
              {pendingMigration > 0 && (
                <Button size="sm" variant="outline" onClick={handleMigrate} loading={migrating} loadingText="Moving…">
                  Merge into Google connection ({pendingMigration})
                </Button>
              )}
              {cleanable > 0 && (
                <Button size="sm" variant="outline" onClick={handleCleanup} loading={cleaning} loadingText="Cleaning…">
                  Clean up old Drive records ({cleanable})
                </Button>
              )}
              <Button size="sm" className="gap-1.5" onClick={handleConnect} loading={connecting} loadingText="Redirecting…">
                <Plus className="h-4 w-4" /> {status === "needs_reconnect" ? "Reconnect Google Drive" : "Connect Google Drive"}
              </Button>
            </div>
          </div>

          {loading && (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
            </div>
          )}

          {!loading && connections.length === 0 && (
            <div className="space-y-1 rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">No Google account connected yet</p>
              <p>Connect one to pick videos/folders from Drive, upload new videos, or back up your library.</p>
            </div>
          )}

          {!loading && connections.map((connection) => (
            <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-medium">{connection.googleEmail}</span>
                  {connection.status === "invalid" ? (
                    <Badge variant="destructive">Needs reconnecting</Badge>
                  ) : (
                    <Badge variant="success">Connected</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {connection.lastUsedAt ? `Last used ${new Date(connection.lastUsedAt).toLocaleString()}` : "Not used yet"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleDisconnect(connection)}
                aria-label={`Disconnect ${connection.googleEmail}`}
                loading={disconnectingId === connection.id}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {connections.some((c) => c.status !== "invalid") && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
            <div>
              <h3 className="font-display text-base font-semibold">Backups</h3>
              <p className="mt-1 text-sm text-muted-foreground">Save a portable copy of your library to Drive, or restore from one.</p>
            </div>
            <Button asChild variant="outline" size="sm">
              <a href="/settings/backup">Open backups</a>
            </Button>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
