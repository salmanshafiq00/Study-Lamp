"use client";

import * as React from "react";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  listDriveConnections, createDriveBackup, listDriveBackups,
  previewDriveRestore, confirmDriveRestore, type BackupSummary, type RestorePreview,
} from "@/lib/driveClient";
import type { DriveConnectionSummary } from "@/types";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

export default function BackupPage() {
  return (
    <RequireAuth>
      <BackupContent />
    </RequireAuth>
  );
}

function BackupContent() {
  const { user } = useAuth();
  const [connections, setConnections] = React.useState<DriveConnectionSummary[]>([]);
  const [connectionId, setConnectionId] = React.useState<string | null>(null);
  const [backups, setBackups] = React.useState<{ fileId: string; name: string }[]>([]);
  const [backingUp, setBackingUp] = React.useState(false);
  const [loadingBackups, setLoadingBackups] = React.useState(false);
  const [pendingRestore, setPendingRestore] = React.useState<{ fileId: string; name: string; preview: RestorePreview } | null>(null);
  const [restoring, setRestoring] = React.useState(false);

  const loadBackups = React.useCallback(async (cid: string) => {
    if (!user) return;
    setLoadingBackups(true);
    try {
      const idToken = await user.getIdToken();
      setBackups(await listDriveBackups(idToken, cid));
    } catch (error: any) {
      toast.error(error?.message || "Failed to list backups.");
    } finally {
      setLoadingBackups(false);
    }
  }, [user]);

  React.useEffect(() => {
    (async () => {
      if (!user) return;
      const idToken = await user.getIdToken();
      const list = await listDriveConnections(idToken).catch(() => []);
      setConnections(list.filter((c) => c.status !== "invalid"));
      const first = list.find((c) => c.status !== "invalid");
      if (first) {
        setConnectionId(first.id);
        loadBackups(first.id);
      }
    })();
  }, [user, loadBackups]);

  async function handleBackupNow() {
    if (!user || !connectionId) return;
    setBackingUp(true);
    try {
      const idToken = await user.getIdToken();
      const result: BackupSummary = await createDriveBackup(idToken, connectionId);
      toast.success(`Backed up ${result.counts?.playlists ?? 0} playlists and ${result.counts?.videos ?? 0} videos to Drive.`);
      loadBackups(connectionId);
    } catch (error: any) {
      toast.error(error?.message || "Backup failed.");
    } finally {
      setBackingUp(false);
    }
  }

  async function handleChooseRestore(backup: { fileId: string; name: string }) {
    if (!user || !connectionId) return;
    try {
      const idToken = await user.getIdToken();
      const preview = await previewDriveRestore(idToken, connectionId, backup.fileId);
      setPendingRestore({ fileId: backup.fileId, name: backup.name, preview });
    } catch (error: any) {
      toast.error(error?.message || "Couldn't read that backup.");
    }
  }

  async function handleConfirmRestore() {
    if (!user || !connectionId || !pendingRestore) return;
    setRestoring(true);
    try {
      const idToken = await user.getIdToken();
      const result = await confirmDriveRestore(idToken, connectionId, pendingRestore.fileId);
      toast.success(`Restored ${result.playlistsToRestore} playlists and ${result.videosToRestore} videos.`);
      setPendingRestore(null);
    } catch (error: any) {
      toast.error(error?.message || "Restore failed.");
    } finally {
      setRestoring(false);
    }
  }

  if (connections.length === 0) {
    return (
      <AppShell>
        <div className="mx-auto max-w-2xl space-y-4">
          <h1 className="font-display text-2xl font-semibold">Backups</h1>
          <p className="text-sm text-muted-foreground">Connect a Google Drive account first — see Settings → Google.</p>
          <Button asChild variant="outline" size="sm"><a href="/settings/google#drive">Go to Google settings</a></Button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold">Backups</h1>
          <p className="text-sm text-muted-foreground">
            A backup is a plain JSON snapshot of your playlists, videos, notes, summaries, goals and quiz history, saved
            to a &quot;Study Lamp Backups&quot; folder in your connected Drive.
          </p>
        </div>

        <Card>
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <div>
              <h2 className="font-display text-base font-semibold">Back up now</h2>
              <p className="mt-1 text-sm text-muted-foreground">Creates a new snapshot — it never overwrites a previous one.</p>
            </div>
            <Button onClick={handleBackupNow} loading={backingUp} loadingText="Backing up…">Back up now</Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <h2 className="font-display text-base font-semibold">Restore</h2>
            {loadingBackups && <p className="text-sm text-muted-foreground">Loading backups…</p>}
            {!loadingBackups && backups.length === 0 && <p className="text-sm text-muted-foreground">No backups yet.</p>}
            {backups.map((backup) => (
              <div key={backup.fileId} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                <span className="min-w-0 truncate text-sm">{backup.name}</span>
                <Button variant="outline" size="sm" onClick={() => handleChooseRestore(backup)}>Restore…</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!pendingRestore} onOpenChange={(open) => !open && setPendingRestore(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore &quot;{pendingRestore?.name}&quot;?</DialogTitle>
          </DialogHeader>
          {pendingRestore && (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                This only adds back what&apos;s currently missing — anything you still have is left untouched, nothing is
                overwritten.
              </p>
              <ul className="list-inside list-disc space-y-1">
                <li>{pendingRestore.preview.playlistsToRestore} playlists ({pendingRestore.preview.videosToRestore} videos)</li>
                <li>{pendingRestore.preview.notesToRestore} notes</li>
                <li>{pendingRestore.preview.summariesToRestore} summaries</li>
                <li>{pendingRestore.preview.goalsToRestore} goals</li>
                <li>{pendingRestore.preview.quizAttemptsToRestore} quiz attempts</li>
              </ul>
              {pendingRestore.preview.playlistTitles.length > 0 && (
                <p className="text-xs text-muted-foreground">Playlists: {pendingRestore.preview.playlistTitles.join(", ")}</p>
              )}
              {pendingRestore.preview.playlistsToRestore === 0 && pendingRestore.preview.notesToRestore === 0 && (
                <p className="text-xs text-muted-foreground">Everything in this backup already exists — restoring will do nothing.</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRestore(null)}>Cancel</Button>
            <Button onClick={handleConfirmRestore} loading={restoring} loadingText="Restoring…">Confirm restore</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
