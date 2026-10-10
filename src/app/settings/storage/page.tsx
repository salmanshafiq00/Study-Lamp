"use client";

import * as React from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toBatches } from "@/lib/batches";
import {
  loadStorageHealth, migrateAnnotationBatch, migrateTextBatch, previewCleanupRequest, runCleanupRequest, scanMigrations,
  type CleanupActionId, type MigrationScan, type StorageCount,
} from "@/lib/storageClient";

interface CleanupCard { action: CleanupActionId; title: string; description: string; warning?: string; months?: number }

const CARDS: CleanupCard[] = [
  { action: "quiz_attempts", title: "Old quiz attempts", months: 12, description: "Removes attempts older than 12 months. The newest 200 attempts are always kept." },
  { action: "learning_events", title: "Old activity events", description: "Removes the old one-document-per-event activity records. Daily activity is kept.", warning: "No screen reads these any more, but they cannot be restored." },
  { action: "thumbnails", title: "Unused Drive thumbnails", description: "Removes saved thumbnails that no video or study material uses. Your Drive files are not touched." },
  { action: "used_tokens", title: "Expired sync confirmations", description: "Removes spent Google sync confirmations that have already expired." },
  { action: "sync_log", title: "Old Google sync history", description: "Keeps the newest 200 history entries and removes the rest." },
];

export default function StoragePage() {
  return (
    <RequireAuth>
      <AppShell>
        <StorageContent />
      </AppShell>
    </RequireAuth>
  );
}

function StorageContent() {
  const [counts, setCounts] = React.useState<StorageCount[] | null>(null);
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState<{ card: CleanupCard; count: number } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState("");
  const [scan, setScan] = React.useState<MigrationScan | null>(null);

  const refresh = React.useCallback(async () => {
    try { const data = await loadStorageHealth(); setCounts(data.counts); setNote(data.note); }
    catch (error: any) { toast.error(error?.message || "Couldn't load storage counts."); }
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);

  async function review(card: CleanupCard) {
    setBusy(card.action);
    try {
      const { count } = await previewCleanupRequest(card.action, card.months);
      if (count === 0) toast.message("Nothing to clean up here.");
      else setPending({ card, count });
    } catch (error: any) { toast.error(error?.message || "Couldn't count the items."); }
    finally { setBusy(null); }
  }

  async function confirmCleanup() {
    if (!pending) return;
    const { card, count } = pending;
    setBusy(card.action);
    let deleted = 0;
    try {
      for (let round = 0; round < 25; round += 1) { // at most 25 batches per click; run again for more
        const result = await runCleanupRequest(card.action, card.months);
        deleted += result.deleted;
        setProgress(`Removed ${deleted} of ${count}…`);
        if (result.remaining === 0 || result.deleted === 0) break;
      }
      toast.success(`Removed ${deleted} item${deleted === 1 ? "" : "s"}.`);
    } catch (error: any) { toast.error(error?.message || "Cleanup stopped. Nothing else was removed."); }
    finally { setBusy(null); setPending(null); setProgress(""); void refresh(); }
  }

  async function checkMigration() {
    setBusy("scan");
    try {
      const found = await scanMigrations();
      if (found.fields.length + found.contentDocumentIds.length + found.annotationDocumentIds.length === 0) toast.message("Nothing needs moving.");
      else setScan(found);
    } catch (error: any) { toast.error(error?.message || "Couldn't check your saved data."); }
    finally { setBusy(null); }
  }

  async function confirmMigration() {
    if (!scan) return;
    setBusy("migrate");
    let moved = 0; let failed = 0;
    try {
      for (const batch of toBatches(scan.annotationDocumentIds, 5)) { const r = await migrateAnnotationBatch(batch); moved += r.moved; failed += r.failed; setProgress(`Moved ${moved}…`); }
      type Item = { kind: "field"; value: MigrationScan["fields"][number] } | { kind: "content"; value: string };
      const items: Item[] = [...scan.fields.map((value) => ({ kind: "field" as const, value })), ...scan.contentDocumentIds.map((value) => ({ kind: "content" as const, value }))];
      for (const batch of toBatches(items, 5)) {
        const r = await migrateTextBatch(batch.filter((i) => i.kind === "field").map((i) => i.value as MigrationScan["fields"][number]), batch.filter((i) => i.kind === "content").map((i) => i.value as string));
        moved += r.moved; failed += r.failed; setProgress(`Moved ${moved}…`);
      }
      if (failed > 0) toast.warning(`Moved ${moved}. ${failed} could not be moved and were left unchanged.`);
      else toast.success(`Moved ${moved} item${moved === 1 ? "" : "s"} to Google Drive.`);
    } catch (error: any) { toast.error(error?.message || "Moving stopped. Nothing was deleted without a verified copy."); }
    finally { setBusy(null); setScan(null); setProgress(""); void refresh(); }
  }

  const migrationTotal = scan ? scan.fields.length + scan.contentDocumentIds.length + scan.annotationDocumentIds.length : 0;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Storage health</h1>
        <p className="mt-1 text-sm text-muted-foreground">Study Lamp keeps small data in its database and large text in your Google Drive. {note}</p>
      </div>

      <Card><CardContent className="space-y-1 p-4">
        <h2 className="mb-2 text-sm font-semibold">What is stored</h2>
        {counts === null ? <p className="text-sm text-muted-foreground">Loading…</p> : counts.map((row) => (
          <div key={row.id} className="flex justify-between text-sm"><span>{row.label}</span><span className="tabular-nums text-muted-foreground">{row.count}</span></div>
        ))}
      </CardContent></Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Clean up</h2>
        {CARDS.map((card) => (
          <Card key={card.action}><CardContent className="flex items-start justify-between gap-4 p-4">
            <div><p className="font-medium">{card.title}</p><p className="text-sm text-muted-foreground">{card.description}</p></div>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void review(card)}>{busy === card.action ? "Counting…" : "Review"}</Button>
          </CardContent></Card>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Move to Google Drive</h2>
        <Card><CardContent className="flex items-start justify-between gap-4 p-4">
          <div><p className="font-medium">Move large saved text</p><p className="text-sm text-muted-foreground">Moves annotations, long notes, summaries, transcripts and document text into your Google Drive folder. Each item is checked after copying before the old copy is removed.</p></div>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void checkMigration()}>{busy === "scan" ? "Checking…" : "Check"}</Button>
        </CardContent></Card>
      </section>

      <Dialog open={!!pending} onOpenChange={(open) => { if (!open && busy === null) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.card.title}</DialogTitle>
            <DialogDescription>{pending ? `${pending.count} item${pending.count === 1 ? "" : "s"} will be permanently removed. ${pending.card.warning ?? ""}` : ""}</DialogDescription>
          </DialogHeader>
          {progress && <p className="text-sm text-muted-foreground" role="status">{progress}</p>}
          <DialogFooter>
            <Button autoFocus variant="outline" disabled={busy !== null} onClick={() => setPending(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy !== null} onClick={() => void confirmCleanup()}>{busy ? "Removing…" : `Remove ${pending?.count ?? 0}`}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!scan} onOpenChange={(open) => { if (!open && busy === null) setScan(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to Google Drive</DialogTitle>
            <DialogDescription>{`${migrationTotal} item${migrationTotal === 1 ? "" : "s"} will be copied to the "Study Lamp data" folder in your Google Drive. Old copies are removed only after the new copy is verified.`}</DialogDescription>
          </DialogHeader>
          {progress && <p className="text-sm text-muted-foreground" role="status">{progress}</p>}
          <DialogFooter>
            <Button autoFocus variant="outline" disabled={busy !== null} onClick={() => setScan(null)}>Cancel</Button>
            <Button disabled={busy !== null} onClick={() => void confirmMigration()}>{busy ? "Moving…" : "Move"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
