"use client";

import * as React from "react";
import Link from "next/link";
import { PDFViewer, type PluginRegistry } from "@embedpdf/react-pdf-viewer";
import { Button } from "@/components/ui/button";
import { BookOpenText, Download, ExternalLink, HardDrive, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { MAX_PDF_PREVIEW_BYTES, formatBytes, readResponseWithLimit } from "@/lib/documentViewerUtils";
import { driveResponseErrorMessage } from "@/lib/driveErrors";
import { pdfiumWasmUrl } from "@/lib/pdfAssets";

const PDF_DOCUMENT_ID = "study-material-pdf";
/** If nothing is on screen after this long, show ways out instead of an endless loading state. */
const SLOW_LOAD_MS = 15_000;
const PROGRESS_UI_INTERVAL_MS = 120;

interface PdfReaderProps {
  documentTitle: string;
  sourceUrl: string | null;
  initialError?: string | null;
  driveViewUrl: string;
  onDownload: () => void;
  refreshSourceUrl: () => Promise<string>;
  initialPage?: number;
  initialZoom?: number;
  requestedPage?: number | null;
  savedAnnotations?: unknown[];
  onPageJumpHandled?: () => void;
  onProgress?: (progress: { lastPage: number; zoom: number }) => void;
  onAnnotationsChange?: (annotations: unknown[]) => void;
  onExplainPage?: (pageNumber: number, text: string) => Promise<void>;
  explainingPage?: boolean;
}

/**
 * How loading works (and why):
 *  - The viewer (PDFium engine, ~4.6 MB wasm) starts immediately, while this component downloads the PDF
 *    itself through the signed Drive proxy. The two used to run one after the other, because EmbedPDF only
 *    starts fetching the file after its engine is ready (its "range-request" mode is not implemented in
 *    2.15.x; the whole file is always fetched). Doing the download here also gives real progress and the
 *    same Drive error messages the Word and Excel readers show.
 *  - The finished bytes are handed to the viewer only after every event listener is attached, so the
 *    "document opened" event can never be missed (a missed event left the skeleton on screen forever).
 */
export function PdfReader({
  documentTitle,
  sourceUrl,
  initialError,
  driveViewUrl,
  onDownload,
  refreshSourceUrl,
  initialPage = 1,
  initialZoom = 1,
  requestedPage = null,
  savedAnnotations = [],
  onPageJumpHandled,
  onProgress,
  onAnnotationsChange,
  onExplainPage,
  explainingPage = false,
}: PdfReaderProps) {
  const [readerError, setReaderError] = React.useState<string | null>(initialError ?? null);
  const [activeSourceUrl, setActiveSourceUrl] = React.useState(sourceUrl);
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const [reloading, setReloading] = React.useState(false);
  const [documentReady, setDocumentReady] = React.useState(false);
  const [download, setDownload] = React.useState<{ loaded: number; total: number | null } | null>(null);
  const [downloaded, setDownloaded] = React.useState(false);
  const [slowLoad, setSlowLoad] = React.useState(false);
  const [currentPage, setCurrentPage] = React.useState(Math.max(1, initialPage));
  const latestRefresh = React.useRef(refreshSourceUrl);
  const latestProgress = React.useRef(onProgress);
  const latestAnnotationChange = React.useRef(onAnnotationsChange);
  const latestSavedAnnotations = React.useRef(savedAnnotations);
  const latestExplainPage = React.useRef(onExplainPage);
  const latestTitle = React.useRef(documentTitle);
  const initialPageRef = React.useRef(Math.max(1, initialPage));
  const initialZoomRef = React.useRef(Math.max(0.1, initialZoom));
  const pageNumber = React.useRef(Math.max(1, initialPage));
  const zoomLevel = React.useRef(Math.max(0.1, initialZoom));
  const restoringInitialPosition = React.useRef(true);
  const annotationExportTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const retrying = React.useRef(false);
  const refreshedUrl = React.useRef<string | null>(null);
  const registry = React.useRef<PluginRegistry | null>(null);
  const eventUnsubscribers = React.useRef<Array<() => void>>([]);
  /** The downloaded file. Kept (the engine copies it) so a remounted viewer can open it again without a new download. */
  const bytesRef = React.useRef<ArrayBuffer | null>(null);
  const handedOff = React.useRef<{ registry: PluginRegistry; bytes: ArrayBuffer } | null>(null);

  // The engine runs in a worker created from a blob: URL, where relative URLs cannot be resolved, so this must be absolute.
  const config = React.useMemo(() => ({
    wasmUrl: typeof window === "undefined"
      ? ""
      : pdfiumWasmUrl(window.location.origin, process.env.NEXT_PUBLIC_PDFIUM_WASM_VERSION),
    worker: true,
    fontFallback: null,
    fonts: { ui: null, signature: null },
    theme: {
      preference: "system" as const,
      light: { accent: { primary: "hsl(var(--primary))" } },
      dark: { accent: { primary: "hsl(var(--primary))" } },
    },
    tabBar: "never" as const,
  }), []);

  latestRefresh.current = refreshSourceUrl;
  latestProgress.current = onProgress;
  latestAnnotationChange.current = onAnnotationsChange;
  latestSavedAnnotations.current = savedAnnotations;
  latestExplainPage.current = onExplainPage;
  latestTitle.current = documentTitle;

  React.useEffect(() => {
    const page = Math.max(1, initialPage);
    const zoom = Math.max(0.1, initialZoom);
    if (page === initialPageRef.current && zoom === initialZoomRef.current) return;
    initialPageRef.current = page;
    initialZoomRef.current = zoom;
    pageNumber.current = page;
    setCurrentPage(page);
    zoomLevel.current = zoom;
    restoringInitialPosition.current = true;
  }, [initialPage, initialZoom]);

  React.useEffect(() => {
    setReaderError(initialError ?? null);
  }, [initialError]);

  React.useEffect(() => {
    setActiveSourceUrl(sourceUrl);
    if (sourceUrl) setReaderError(null);
  }, [sourceUrl]);

  function detachViewer() {
    eventUnsubscribers.current.forEach((unsubscribe) => unsubscribe());
    eventUnsubscribers.current = [];
    registry.current = null;
    handedOff.current = null;
  }

  React.useEffect(() => () => {
    detachViewer();
    if (annotationExportTimer.current) clearTimeout(annotationExportTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While the error panel is shown the viewer is unmounted, so its registry is gone.
  React.useEffect(() => {
    if (readerError) detachViewer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerError]);

  // The engine file is fetched by a worker that swallows its own failures, so check it here and say so out loud.
  React.useEffect(() => {
    const url = config.wasmUrl;
    if (!url) return;
    const controller = new AbortController();
    fetch(url, { method: "HEAD", signal: controller.signal }).then((response) => {
      if (!response.ok) {
        setReaderError(`The PDF engine file couldn't be loaded (HTTP ${response.status}). Reload the page, or open the file in the browser viewer.`);
      }
    }).catch(() => undefined);
    return () => controller.abort();
  }, [config.wasmUrl]);

  // Download the PDF while the engine starts.
  React.useEffect(() => {
    if (!activeSourceUrl) return;
    let cancelled = false;
    const controller = new AbortController();
    bytesRef.current = null;
    setDocumentReady(false);
    setDownloaded(false);
    setDownload({ loaded: 0, total: null });
    let lastUiUpdate = 0;

    void (async () => {
      try {
        const response = await fetch(activeSourceUrl, { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) {
          if (response.status === 401 && refreshedUrl.current !== activeSourceUrl) {
            // The signed link expired (for example a tab left open overnight): get a fresh one once.
            refreshedUrl.current = activeSourceUrl;
            await response.body?.cancel().catch(() => undefined);
            const fresh = await latestRefresh.current();
            if (cancelled) return;
            if (fresh === activeSourceUrl) setReloadNonce((value) => value + 1);
            else setActiveSourceUrl(fresh);
            return;
          }
          throw new Error(await driveResponseErrorMessage(
            response,
            response.status === 404 ? "This file is no longer available in Google Drive." : "Couldn't download this PDF from Google Drive.",
          ));
        }
        const buffer = await readResponseWithLimit(response, MAX_PDF_PREVIEW_BYTES, "This PDF", (loaded, total) => {
          const now = performance.now();
          if (cancelled || now - lastUiUpdate < PROGRESS_UI_INTERVAL_MS) return;
          lastUiUpdate = now;
          setDownload({ loaded, total });
        });
        if (cancelled) return;
        bytesRef.current = buffer;
        setDownload(null);
        setDownloaded(true);
        if (registry.current) openBytes(registry.current);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setDownload(null);
        const isNetwork = error instanceof TypeError;
        setReaderError(!isNetwork && error instanceof Error && error.message
          ? error.message
          : "Couldn't download this PDF. Check your connection and try again.");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // openBytes only reads refs, so it is safe to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSourceUrl, reloadNonce]);

  // Never leave the person staring at a loading state with no explanation.
  React.useEffect(() => {
    setSlowLoad(false);
    if (documentReady || readerError) return;
    const timer = setTimeout(() => setSlowLoad(true), SLOW_LOAD_MS);
    return () => clearTimeout(timer);
  }, [documentReady, readerError, activeSourceUrl, reloadNonce]);

  React.useEffect(() => {
    if (!requestedPage || !documentReady || !registry.current) return;
    const scroll = registry.current.getPlugin("scroll")?.provides?.();
    if (!scroll) return;
    const totalPages = scroll.forDocument(PDF_DOCUMENT_ID).getTotalPages();
    scroll.forDocument(PDF_DOCUMENT_ID).scrollToPage({
      pageNumber: Math.max(1, Math.min(requestedPage, totalPages || requestedPage)),
      behavior: "smooth",
    });
    onPageJumpHandled?.();
  }, [requestedPage, documentReady, onPageJumpHandled]);

  /** Gives the downloaded bytes to a ready viewer, exactly once per (viewer, file) pair. */
  function openBytes(currentRegistry: PluginRegistry) {
    const bytes = bytesRef.current;
    if (!bytes) return;
    if (handedOff.current?.registry === currentRegistry && handedOff.current.bytes === bytes) return;
    const manager = currentRegistry.getPlugin("document-manager")?.provides?.();
    if (!manager) return;
    handedOff.current = { registry: currentRegistry, bytes };
    const open = () => {
      manager.openDocumentBuffer({
        buffer: bytes,
        name: latestTitle.current,
        documentId: PDF_DOCUMENT_ID,
        scale: zoomLevel.current,
        autoActivate: true,
      });
    };
    if (manager.isDocumentOpen(PDF_DOCUMENT_ID)) manager.closeDocument(PDF_DOCUMENT_ID).wait(open, open);
    else open();
  }

  async function retryAtCurrentPage(): Promise<void> {
    if (retrying.current) return;
    retrying.current = true;
    setReloading(true);
    setReaderError(null);
    try {
      const freshUrl = await latestRefresh.current();
      // Reopen on the page and zoom the person was at.
      initialPageRef.current = pageNumber.current;
      initialZoomRef.current = zoomLevel.current;
      restoringInitialPosition.current = true;
      refreshedUrl.current = null;
      setActiveSourceUrl(freshUrl);
      setReloadNonce((value) => value + 1);
    } catch (error) {
      setReaderError(friendlyPdfError(error, false));
    } finally {
      retrying.current = false;
      setReloading(false);
    }
  }

  function handleViewerReady(readyRegistry: PluginRegistry) {
    eventUnsubscribers.current.forEach((unsubscribe) => unsubscribe());
    eventUnsubscribers.current = [];
    registry.current = readyRegistry;
    const manager = readyRegistry.getPlugin("document-manager")?.provides?.();
    const scroll = readyRegistry.getPlugin("scroll")?.provides?.();
    const zoom = readyRegistry.getPlugin("zoom")?.provides?.();
    const annotations = readyRegistry.getPlugin("annotation")?.provides?.();
    const onOpened = manager?.onDocumentOpened((document: { id: string }) => {
      if (document.id !== PDF_DOCUMENT_ID) return;
      setDocumentReady(true);
      if (latestSavedAnnotations.current.length > 0) {
        annotations?.importAnnotations(latestSavedAnnotations.current as never[]);
      }
    });
    const onError = manager?.onDocumentError((event: { documentId: string; message: string; code?: number; reason?: { code?: number; message?: string } }) => {
      if (event.documentId !== PDF_DOCUMENT_ID) return;
      const failure = event.reason ?? { code: event.code, message: event.message };
      const message = `${event.message} ${failure.message || ""}`.trim();
      // Browser console only; URLs are stripped because the Drive link carries a signature.
      console.warn("PDF reader error", { code: failure.code, message: message.replace(/https?:\/\/\S+/g, "<url>").slice(0, 200) });
      const code = failure.code;
      if (code === 4 || /password/i.test(message)) {
        setReaderError("This PDF is password-protected. Open it in Drive to unlock or download it.");
        return;
      }
      if (code === 3 || /corrupt|invalid pdf|wrong format/i.test(message)) {
        setReaderError("This PDF appears to be damaged or uses an unsupported format.");
        return;
      }
      setReaderError("The PDF could not be opened. Try again, or use the browser viewer.");
    });
    const onPageChange = scroll?.onPageChange((event: { documentId: string; pageNumber: number }) => {
      if (event.documentId !== PDF_DOCUMENT_ID) return;
      pageNumber.current = event.pageNumber;
      setCurrentPage(event.pageNumber);
      if (!restoringInitialPosition.current) latestProgress.current?.({ lastPage: event.pageNumber, zoom: zoomLevel.current });
    });
    const onLayoutReady = scroll?.onLayoutReady((event: { documentId: string; isInitial: boolean; totalPages: number }) => {
      if (event.documentId !== PDF_DOCUMENT_ID || !event.isInitial) return;
      const scope = scroll.forDocument(PDF_DOCUMENT_ID);
      const restorePage = Math.max(1, Math.min(initialPageRef.current, event.totalPages));
      pageNumber.current = restorePage;
      setCurrentPage(restorePage);
      if (restorePage !== 1) scope.scrollToPage({ pageNumber: restorePage, behavior: "instant" });
      const zoomScope = zoom?.forDocument(PDF_DOCUMENT_ID);
      if (initialZoomRef.current > 0 && Math.abs(initialZoomRef.current - 1) > 0.01) zoomScope?.requestZoom(initialZoomRef.current);
      restoringInitialPosition.current = false;
    });
    const onZoomChange = zoom?.forDocument(PDF_DOCUMENT_ID).onStateChange((state: { currentZoomLevel: number }) => {
      if (!Number.isFinite(state.currentZoomLevel) || state.currentZoomLevel <= 0) return;
      zoomLevel.current = state.currentZoomLevel;
      if (!restoringInitialPosition.current) latestProgress.current?.({ lastPage: pageNumber.current, zoom: state.currentZoomLevel });
    });
    const onAnnotationChange = annotations?.onAnnotationEvent((event: { documentId: string }) => {
      if (event.documentId !== PDF_DOCUMENT_ID || !annotations) return;
      if (annotationExportTimer.current) clearTimeout(annotationExportTimer.current);
      annotationExportTimer.current = setTimeout(() => {
        void annotations.exportAnnotations(undefined, PDF_DOCUMENT_ID).toPromise().then((items: Array<{ annotation: { type: number } }>) => {
          const serializable = items
            .filter((item) => item.annotation.type !== 13 && item.annotation.type !== 17)
            .map((item) => ({ annotation: item.annotation }));
          latestAnnotationChange.current?.(serializable);
        }).catch(() => {});
      }, 500);
    });
    eventUnsubscribers.current = [onOpened, onError, onPageChange, onLayoutReady, onZoomChange, onAnnotationChange]
      .filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");

    // Listeners are attached, so it is now safe to open the file. If the document is somehow already open
    // (a reused viewer), reflect that instead of waiting for an event that already fired.
    if (manager?.isDocumentOpen(PDF_DOCUMENT_ID) && handedOff.current?.registry !== readyRegistry) setDocumentReady(true);
    openBytes(readyRegistry);
  }

  async function explainCurrentPage() {
    const currentRegistry = registry.current;
    if (!currentRegistry || !latestExplainPage.current) return;
    const documentManager = currentRegistry.getPlugin("document-manager")?.provides?.();
    const document = documentManager?.getDocument(PDF_DOCUMENT_ID);
    const page = document?.pages.find((item: { index: number }) => item.index === pageNumber.current - 1);
    if (!document || !page) throw new Error("The current page is still loading.");
    const pageText = await currentRegistry.getEngine().extractText(document, [page.index]).toPromise();
    const boundedText = pageText.trim().slice(0, 8000);
    if (!boundedText) throw new Error("No selectable text was found on this PDF page.");
    await latestExplainPage.current(pageNumber.current, boundedText);
  }

  if (readerError) {
    return (
      <ReaderFallback message={readerError} driveViewUrl={driveViewUrl} onDownload={onDownload} onRetry={retryAtCurrentPage} reloading={reloading} />
    );
  }

  const percent = download && download.total ? Math.min(100, Math.round((download.loaded / download.total) * 100)) : null;
  const status = reloading
    ? `Reconnecting to Drive and restoring page ${pageNumber.current}…`
    : !activeSourceUrl
      ? "Preparing a secure link to your file…"
      : download
        ? `Downloading from Google Drive… ${formatBytes(download.loaded)}${download.total ? ` of ${formatBytes(download.total)}` : ""}`
        : downloaded
          ? "Opening PDF…"
          : "Starting…";
  const engineStalled = slowLoad && downloaded && !documentReady;

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <p className="text-xs text-muted-foreground">Page {currentPage}</p>
        {onExplainPage && <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => void explainCurrentPage().catch((error) => toast.error(error instanceof Error ? error.message : "Couldn't read this page."))} loading={explainingPage} loadingText="Explaining…"><BookOpenText className="h-4 w-4" />Explain this page</Button>}
      </div>
      <div className="relative h-[68vh] min-h-[28rem] overflow-hidden bg-muted lg:h-[calc(100vh-15rem)] lg:min-h-[35rem]">
        {!documentReady && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-background p-6 text-center" role="status" aria-live="polite">
            <p className="text-sm text-muted-foreground">{status}</p>
            <div
              className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Loading PDF"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
            >
              <div
                className={percent === null ? "h-full w-1/3 animate-pulse rounded-full bg-primary" : "h-full rounded-full bg-primary transition-[width] duration-150"}
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </div>
            {slowLoad && (
              <div className="flex max-w-md flex-col items-center gap-2 rounded-md border border-border bg-card p-3 text-sm text-muted-foreground shadow-sm">
                <p>{engineStalled
                  ? "The viewer is taking longer than usual to start."
                  : "Still loading. Large files can take a while to come from Drive."}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void retryAtCurrentPage()}><RotateCw className="mr-1.5 h-4 w-4" />Try again</Button>
                  <Button type="button" variant="outline" size="sm" onClick={onDownload}><Download className="mr-1.5 h-4 w-4" />Download</Button>
                  <Button asChild size="sm"><a href={driveViewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />Open in browser viewer</a></Button>
                </div>
              </div>
            )}
          </div>
        )}
        <PDFViewer config={config} onReady={handleViewerReady} style={{ width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}

function ReaderFallback({
  message,
  driveViewUrl,
  onDownload,
  onRetry,
  reloading = false,
}: {
  message: string;
  driveViewUrl: string;
  onDownload: () => void;
  onRetry?: () => void;
  reloading?: boolean;
}) {
  return (
    <div className="flex min-h-[24rem] flex-col items-center justify-center gap-4 rounded-md border border-border bg-card p-6 text-center">
      <HardDrive className="h-8 w-8 text-muted-foreground" />
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {message.toLowerCase().includes("connection") && (
        <Button asChild variant="outline" size="sm"><Link href="/settings/drive">Reconnect Google Drive</Link></Button>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {onRetry && <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={reloading}><RotateCw className="mr-1.5 h-4 w-4" />Try again</Button>}
        <Button type="button" variant="outline" size="sm" onClick={onDownload}><Download className="mr-1.5 h-4 w-4" />Download</Button>
        <Button asChild size="sm"><a href={driveViewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />Open in browser viewer</a></Button>
      </div>
    </div>
  );
}

function friendlyPdfError(error: unknown, isConnectionError: boolean): string {
  const errorValue = error as { message?: string; reason?: { message?: string } } | null;
  const message = `${errorValue?.message || ""} ${errorValue?.reason?.message || ""}`.trim() || String(error || "");
  if (isConnectionError || /401|403|409|unauthorized|connection|reconnect|refresh token|drive account/i.test(message)) {
    return "Your Google Drive connection needs attention.";
  }
  if (/password/i.test(message)) return "This PDF is password-protected. Open it in Drive to unlock or download it.";
  if (/404|file (was )?removed|not found/i.test(message)) return "This file is no longer available in Google Drive.";
  if (/corrupt|invalid pdf|wrong format/i.test(message)) return "This PDF appears to be damaged or uses an unsupported format.";
  return "The PDF reader could not start. Open the file in your browser or download it instead.";
}
