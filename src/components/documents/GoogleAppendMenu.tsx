"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FilePlus2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth/AuthProvider";
import { ConfirmChangesDialog } from "@/components/sync/ConfirmChangesDialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  GoogleAppendError,
  applyGoogleAppend,
  previewGoogleDocAppend,
  previewGoogleSheetAppend,
  type GoogleDocContentKind,
  type GoogleDocsAppendPreview,
  type GoogleSheetsAppendPreview,
} from "@/lib/googleClient";
import type { PersonalDocument } from "@/types";

type Request = { target: "docs"; kind: GoogleDocContentKind } | { target: "sheets" };
type Session =
  | { request: Request & { target: "docs" }; data: GoogleDocsAppendPreview }
  | { request: Request & { target: "sheets" }; data: GoogleSheetsAppendPreview };

const NOTICE = "This adds to the end of your file. It does not change or delete anything already there.";

function toAppendError(error: unknown): GoogleAppendError {
  if (error instanceof GoogleAppendError) return error;
  return new GoogleAppendError("Couldn't reach Study Lamp. Nothing was written.", "network", 0);
}

/**
 * "Add to Google Doc… / Sheet…" for Google-native study materials (Z2 item 7).
 * Flow: preview (read-only) -> the dialog shows the EXACT text or rows -> Apply. The browser only sends back
 * the plan token and the item the user confirmed; the server rebuilds the content.
 */
export function GoogleAppendMenu({ doc }: { doc: PersonalDocument }) {
  const { user } = useAuth();
  const router = useRouter();
  const [session, setSession] = React.useState<Session | null>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<GoogleAppendError | null>(null);

  const items = React.useMemo(() => (session ? [session.data.item] : []), [session]);
  const isDoc = doc.fileType === "docx";
  const isSheet = doc.fileType === "xlsx";
  if (!doc.googleNative || (!isDoc && !isSheet)) return null;

  async function startPreview(request: Request) {
    if (!user || busy) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      if (request.target === "docs") {
        const data = await previewGoogleDocAppend(idToken, doc.id, request.kind);
        setSession({ request, data });
      } else {
        const data = await previewGoogleSheetAppend(idToken, doc.id);
        setSession({ request, data });
      }
      setOpen(true);
    } catch (caught) {
      const failure = toAppendError(caught);
      if (failure.code === "nothing_to_add") toast.info(failure.message);
      else if (failure.code === "reconnect") toast.error(failure.message, { action: { label: "Reconnect", onClick: () => router.push("/settings/google#drive") } });
      else toast.error(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleApply({ accepted }: { accepted: string[] }) {
    if (!user || !session) return;
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const result = await applyGoogleAppend(idToken, session.request.target, {
        planToken: session.data.planToken,
        accepted,
        documentId: doc.id,
      });
      toast.success(session.request.target === "docs" ? "Added to your Google Doc." : "Added to your Google Sheet.");
      if (result.warnings?.includes("export_marker_failed")) {
        toast.warning("Added, but these results couldn't be marked as exported, so they may be offered again.");
      }
    } catch (caught) {
      const failure = toAppendError(caught);
      setError(failure); // visible in the dialog; rethrow so the dialog stays open
      throw failure;
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setError(null);
      setSession(null);
    }
  }

  const label = session?.request.target === "sheets" ? "Add to Google Sheet" : "Add to Google Doc";
  const openUrl = session?.data.preview.openUrl;

  const footerExtra = error ? (
    <>
      {(error.code === "stale" || error.code === "plan_already_applied") && session && (
        <Button variant="secondary" onClick={() => { const request = session.request; handleOpenChange(false); void startPreview(request); }}>
          Preview again
        </Button>
      )}
      {error.code === "reconnect" && (
        <Button asChild variant="secondary"><a href="/settings/google#drive">Reconnect Google</a></Button>
      )}
      {(error.code === "permission" || error.code === "not_found") && openUrl && (
        <Button asChild variant="secondary"><a href={openUrl} target="_blank" rel="noopener noreferrer">Open in Google</a></Button>
      )}
    </>
  ) : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={busy || !user} loading={busy} loadingText="Preparing preview...">
            <FilePlus2 className="mr-1.5 h-4 w-4" />Add to Google<ChevronDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isDoc && (
            <>
              <DropdownMenuLabel>Add to Google Doc…</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void startPreview({ target: "docs", kind: "summary" })}>Summary</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void startPreview({ target: "docs", kind: "notes" })}>Notes</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void startPreview({ target: "docs", kind: "quiz_review" })}>Quiz review</DropdownMenuItem>
            </>
          )}
          {isSheet && (
            <>
              <DropdownMenuLabel>Add to Google Sheet…</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void startPreview({ target: "sheets" })}>Quiz results</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmChangesDialog
        open={open && session !== null}
        onOpenChange={handleOpenChange}
        items={items}
        title={session ? `${label}: ${session.data.preview.documentTitle}` : label}
        description={NOTICE}
        confirmLabel={label}
        hideFields
        errorMessage={error?.message ?? null}
        footerExtra={footerExtra}
        renderItemExtra={() => (session ? <PreviewBody session={session} /> : null)}
        onApply={handleApply}
      />
    </>
  );
}

function PreviewBody({ session }: { session: Session }) {
  if (session.request.target === "docs") {
    const { preview } = session.data as GoogleDocsAppendPreview;
    return (
      <div className="mt-2 space-y-1">
        <p className="text-xs text-muted-foreground">{preview.kindLabel} — added at the end as a new section:</p>
        <p className="text-sm font-medium">{preview.heading}</p>
        <textarea
          readOnly
          aria-label="The exact text that will be added"
          value={preview.text}
          className="h-48 w-full resize-y rounded-md border bg-muted/30 p-2 text-xs"
        />
        {preview.truncated && <p className="text-xs text-amber-700">Long text: it is shortened to fit the 20,000 character limit.</p>}
      </div>
    );
  }

  const { preview } = session.data as GoogleSheetsAppendPreview;
  const rows = preview.header ? [preview.header, ...preview.rows] : preview.rows;
  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs text-muted-foreground">
        {preview.willCreateTab ? `A new tab “${preview.tab}” will be created.` : `Rows are added below the existing rows in “${preview.tab}”.`}
        {" "}{preview.rows.length} row{preview.rows.length === 1 ? "" : "s"} will be added.
      </p>
      <div className="max-h-56 overflow-auto rounded-md border bg-muted/30">
        <table className="w-full text-left text-xs">
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className={preview.header && rowIndex === 0 ? "font-medium" : ""}>
                {row.map((cell, cellIndex) => <td key={cellIndex} className="whitespace-nowrap border-b px-2 py-1">{String(cell)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.remaining > 0 && <p className="text-xs text-amber-700">{preview.remaining} more result{preview.remaining === 1 ? "" : "s"} will be offered next time (200 rows per export).</p>}
    </div>
  );
}
