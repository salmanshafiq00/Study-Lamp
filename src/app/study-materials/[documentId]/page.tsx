"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AiLanguagePicker } from "@/components/ai/AiLanguagePicker";
import { DocumentReaderSwitch } from "@/components/documents/DocumentReaderSwitch";
import { GoogleAppendMenu } from "@/components/documents/GoogleAppendMenu";
import { DocumentStudyMobileSheet, DocumentStudyPanel } from "@/components/documents/DocumentStudyPanel";
import { useDocumentProgress } from "@/hooks/useDocumentProgress";
import { useDocumentStudy } from "@/hooks/useDocumentStudy";
import { getPersonalDocumentAnnotations, getPersonalDocumentClient } from "@/lib/firestore/personalDocuments";
import { getNote, getSummary } from "@/lib/firestore/notes";
import { getSignedDriveUrls, refreshGoogleDocumentMeta, refreshSignedDriveUrl } from "@/lib/driveClient";
import { formatGoogleModified, googleNativeLabel, googleOpenUrl } from "@/lib/googleLinks";
import type { PersonalDocument } from "@/types";
import { Download, ExternalLink } from "lucide-react";
import { toast } from "sonner";

export default function StudyMaterialDetailPage() {
  return (
    <RequireAuth>
      <StudyMaterialDetailContent />
    </RequireAuth>
  );
}

function StudyMaterialDetailContent() {
  const { documentId } = useParams<{ documentId: string }>();
  const { user } = useAuth();
  const [doc, setDoc] = React.useState<PersonalDocument | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [requestedPage, setRequestedPage] = React.useState<number | null>(null);
  const [signedStreamUrl, setSignedStreamUrl] = React.useState<string | null>(null);
  const [streamError, setStreamError] = React.useState<string | null>(null);
  const study = useDocumentStudy(user, documentId, doc);
  const { setSummary, setNote, setNotePageNumber } = study;
  const { annotations, setAnnotations, annotationStatus, queueReaderProgress, queueAnnotationSave } = useDocumentProgress(user, doc);

  React.useEffect(() => {
    (async () => {
      if (!user || !documentId) return;
      setLoading(true);
      try {
        const [fetchedDoc, cachedSummary, cachedNote, cachedAnnotations] = await Promise.all([
          getPersonalDocumentClient(user.uid, documentId),
          getSummary(user.uid, `d_${documentId}`),
          getNote(user.uid, `d_${documentId}`),
          getPersonalDocumentAnnotations(user.uid, documentId),
        ]);
        setDoc(fetchedDoc);
        setSummary(cachedSummary?.content ?? "");
        setNote(cachedNote?.content ?? "");
        setNotePageNumber(cachedNote?.pageNumber ?? null);
        setAnnotations(cachedAnnotations);
      } catch (error: any) {
        toast.error(error?.message || "Failed to load this document.");
      } finally {
        setLoading(false);
      }
    })();
  }, [user, documentId, setSummary, setNote, setNotePageNumber, setAnnotations]);

  // Google-native files: check Drive once per open and keep the stored "last changed" time current.
  const googleNativeId = doc?.googleNative ? doc.id : null;
  React.useEffect(() => {
    if (!user || !googleNativeId) return;
    let active = true;
    void (async () => {
      try {
        const result = await refreshGoogleDocumentMeta(await user.getIdToken(), googleNativeId);
        if (active && result.changed) setDoc((current) => (current && current.id === googleNativeId ? { ...current, modifiedTime: result.modifiedTime } : current));
      } catch {
        // Best effort: the reader shows its own error if the file can't be opened.
      }
    })();
    return () => { active = false; };
  }, [user, googleNativeId]);

  React.useEffect(() => {
    let active = true;
    setSignedStreamUrl(null);
    setStreamError(null);
    if (!user || !doc || doc.fileType === "pptx") return () => { active = false; };
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const [url] = await getSignedDriveUrls(idToken, user.uid, [{
          fileId: doc.driveFileId,
          connectionId: doc.driveConnectionId,
          purpose: doc.googleNative ? "export" : "stream",
        }]);
        if (active) setSignedStreamUrl(url);
      } catch (error) {
        if (active) setStreamError(error instanceof Error ? error.message : "Couldn't prepare the document preview.");
      }
    })();
    return () => { active = false; };
  }, [user, doc]);

  async function refreshSignedStreamUrl(): Promise<string> {
    if (!user || !doc) throw new Error("Sign in again to reconnect to Google Drive.");
    const idToken = await user.getIdToken();
    return refreshSignedDriveUrl(idToken, user.uid, {
      fileId: doc.driveFileId,
      connectionId: doc.driveConnectionId,
      purpose: doc.googleNative ? "export" : "stream",
    });
  }

  async function handleDownload() {
    if (!user || !doc) return;
    try {
      const idToken = await user.getIdToken();
      const [url] = await getSignedDriveUrls(idToken, user.uid, [{
        fileId: doc.driveFileId,
        connectionId: doc.driveConnectionId,
        purpose: doc.googleNative ? "export_download" : "download",
      }]);
      window.location.href = url;
    } catch {
      toast.error("Couldn't prepare the download.");
    }
  }

  async function handlePlainText(): Promise<string> {
    if (!user || !documentId) throw new Error("Sign in again to load document text.");
    const idToken = await user.getIdToken();
    const response = await fetch(`/api/documents/${documentId}/text`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.text !== "string") throw new Error(data.error || "Couldn't load the plain text view.");
    return data.text;
  }

  if (loading) {
    return <AppShell><div className="mx-auto max-w-4xl space-y-4"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-[500px] w-full" /></div></AppShell>;
  }

  if (!doc) {
    return <AppShell><div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Document not found.</p></div></AppShell>;
  }

  const driveViewUrl = `https://drive.google.com/file/d/${doc.driveFileId}/view`;
  const nativeLabel = doc.googleNative ? googleNativeLabel(doc.mimeType) : null;
  const googleUrl = doc.googleNative ? googleOpenUrl(doc.mimeType, doc.driveFileId) : null;
  const lastChanged = doc.googleNative ? formatGoogleModified(doc.modifiedTime) : null;
  const jumpToNotePage = () => { if (study.notePageNumber) setRequestedPage(study.notePageNumber); };

  return (
    <AppShell>
      <div className="mx-auto max-w-[96rem] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words font-display text-2xl font-semibold">{doc.title}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{nativeLabel ?? doc.fileType.toUpperCase()} · Google Drive{lastChanged ? ` · Last changed in Google ${lastChanged}` : ""}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AiLanguagePicker value={study.language} onChange={study.setLanguage} disabled={!study.languageReady || study.generatingSummary || study.generatingQuiz || study.explainingPage} />
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="mr-1.5 h-4 w-4" />Download
            </Button>
            <GoogleAppendMenu doc={doc} />
            {googleUrl && <Button asChild variant="outline" size="sm"><a href={googleUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />Open in Google</a></Button>}
            <Button asChild variant="outline" size="sm"><a href={driveViewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />Open in Drive</a></Button>
          </div>
        </div>

        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(20rem,0.9fr)]">
          <section className="min-w-0">
            <DocumentReaderSwitch
              doc={doc}
              signedStreamUrl={signedStreamUrl}
              streamError={streamError}
              driveViewUrl={driveViewUrl}
              annotations={annotations}
              requestedPage={requestedPage}
              explainingPage={study.explainingPage}
              onDownload={handleDownload}
              onPlainText={handlePlainText}
              refreshSourceUrl={refreshSignedStreamUrl}
              onPageJumpHandled={() => setRequestedPage(null)}
              onProgress={queueReaderProgress}
              onAnnotationsChange={queueAnnotationSave}
              annotationStatus={annotationStatus}
              onExplainPage={study.handleExplainPage}
            />
          </section>

          <DocumentStudyPanel study={study} isPdf={doc.fileType === "pdf"} onJumpToNotePage={jumpToNotePage} />
        </div>

        <DocumentStudyMobileSheet study={study} isPdf={doc.fileType === "pdf"} onJumpToNotePage={jumpToNotePage} />
      </div>
    </AppShell>
  );
}
