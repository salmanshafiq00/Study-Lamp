"use client";

import dynamic from "next/dynamic";
import type { SaveStatus } from "@/lib/blobClient";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReaderProgressInput } from "@/lib/readerProgress";
import type { PersonalDocument } from "@/types";

const PdfReader = dynamic(
  () => import("@/components/documents/PdfReader").then((module) => module.PdfReader),
  {
    ssr: false,
    loading: () => <div className="space-y-3 rounded-md border border-border p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-[60vh] w-full" /></div>,
  },
);
const DocxReader = dynamic(
  () => import("@/components/documents/DocxReader").then((module) => module.DocxReader),
  {
    ssr: false,
    loading: () => <div className="space-y-3 rounded-md border border-border p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-[60vh] w-full" /></div>,
  },
);
const XlsxReader = dynamic(
  () => import("@/components/documents/XlsxReader").then((module) => module.XlsxReader),
  {
    ssr: false,
    loading: () => <div className="space-y-3 rounded-md border border-border p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-[60vh] w-full" /></div>,
  },
);

export interface DocumentReaderSwitchProps {
  doc: PersonalDocument;
  signedStreamUrl: string | null;
  streamError: string | null;
  driveViewUrl: string;
  annotations: unknown[];
  requestedPage: number | null;
  explainingPage: boolean;
  onDownload: () => void;
  onPlainText: () => Promise<string>;
  refreshSourceUrl: () => Promise<string>;
  onPageJumpHandled: () => void;
  onProgress: (progress: ReaderProgressInput) => void;
  onAnnotationsChange: (annotations: unknown[]) => void;
  annotationStatus?: SaveStatus;
  onExplainPage: (pageNumber: number, pageText: string) => Promise<void>;
}

/** PDF -> PDF reader; Word / Excel -> their readers; anything else -> Drive's own preview ("Open in Drive" fallback). */
export function DocumentReaderSwitch({
  doc, signedStreamUrl, streamError, driveViewUrl, annotations, requestedPage, explainingPage,
  onDownload, onPlainText, refreshSourceUrl, onPageJumpHandled, onProgress, onAnnotationsChange, annotationStatus, onExplainPage,
}: DocumentReaderSwitchProps) {
  if (doc.fileType === "pdf") {
    return (
      <PdfReader
        documentTitle={doc.title}
        sourceUrl={signedStreamUrl}
        initialError={streamError}
        driveViewUrl={driveViewUrl}
        onDownload={onDownload}
        refreshSourceUrl={refreshSourceUrl}
        initialPage={doc.readerProgress?.lastPage ?? 1}
        initialZoom={doc.readerProgress?.zoom ?? 1}
        requestedPage={requestedPage}
        onPageJumpHandled={onPageJumpHandled}
        onProgress={onProgress}
        savedAnnotations={annotations}
        onAnnotationsChange={onAnnotationsChange}
        annotationStatus={annotationStatus}
        onExplainPage={onExplainPage}
        explainingPage={explainingPage}
      />
    );
  }
  return (
    <DocumentPreview
      document={doc}
      sourceUrl={signedStreamUrl}
      sourceError={streamError}
      driveViewUrl={driveViewUrl}
      onDownload={onDownload}
      onPlainText={onPlainText}
      progress={doc.readerProgress ?? null}
      onProgress={onProgress}
    />
  );
}

/**
 * PowerPoint intentionally remains on Drive's preview surface. Word and
 * Excel use their isolated, dynamically imported in-app readers.
 */
function DocumentPreview({
  document,
  sourceUrl,
  sourceError,
  driveViewUrl,
  onDownload,
  onPlainText,
  progress,
  onProgress,
}: {
  document: PersonalDocument;
  sourceUrl: string | null;
  sourceError: string | null;
  driveViewUrl: string;
  onDownload: () => void;
  onPlainText: () => Promise<string>;
  /** Saved reading position, used only for the initial restore. */
  progress: PersonalDocument["readerProgress"];
  onProgress: (progress: ReaderProgressInput) => void;
}) {
  if (document.fileType === "docx") {
    if (!sourceUrl) return <PreviewUnavailable message={sourceError} onDownload={onDownload} />;
    return <DocxReader title={document.title} sourceUrl={sourceUrl} onDownload={onDownload} onPlainText={onPlainText} initialScrollRatio={progress?.scrollRatio} initialZoom={progress?.zoom} onProgress={onProgress} />;
  }
  if (document.fileType === "xlsx") {
    if (!sourceUrl) return <PreviewUnavailable message={sourceError} onDownload={onDownload} />;
    return <XlsxReader title={document.title} sourceUrl={sourceUrl} onDownload={onDownload} initialSheetIndex={progress?.sheetIndex} initialRowIndex={progress?.rowIndex} onProgress={onProgress} />;
  }
  return (
    <iframe
      src={`https://drive.google.com/file/d/${document.driveFileId}/preview`}
      title={document.title}
      className="h-[70vh] w-full rounded-b-lg border-0"
      allow="autoplay"
    />
  );
}

function PreviewUnavailable({ message, onDownload }: { message: string | null; onDownload: () => void }) {
  return (
    <div className="flex h-[68vh] min-h-[28rem] flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message || "Preparing a secure document preview…"}</p>
      {message && <Button type="button" size="sm" onClick={onDownload}><Download className="mr-1.5 h-4 w-4" />Download</Button>}
    </div>
  );
}
