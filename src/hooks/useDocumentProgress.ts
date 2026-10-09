import * as React from "react";
import { toast } from "sonner";
import { createPersister, type Persister } from "@/lib/persistThrottle";
import { isSignificantReaderProgress, mergeReaderProgress, normalizeReaderProgress, type ReaderProgress, type ReaderProgressInput } from "@/lib/readerProgress";
import {
  savePersonalDocumentAnnotations,
  subscribeAnnotationSaveStatus,
  updatePersonalDocumentReadingProgress,
} from "@/lib/firestore/personalDocuments";
import type { SaveStatus } from "@/lib/blobClient";
import type { PersonalDocument } from "@/types";

/**
 * Saving of the reading position and PDF annotations for one document (roadmap P3/P4).
 *  - Reading position: at most one Firestore write a minute, only when it moved enough, plus a flush when the tab is
 *    hidden/closed or the reader unmounts.
 *  - Annotations: stored in the user's Drive via the blob client (IndexedDB first, sent at most every 3 s).
 */
export function useDocumentProgress(user: { uid: string } | null, doc: PersonalDocument | null) {
  const [annotations, setAnnotations] = React.useState<unknown[]>([]);
  const [annotationStatus, setAnnotationStatus] = React.useState<SaveStatus>({ state: "saved" });
  const latestProgress = React.useRef<ReaderProgressInput | null>(null);
  const persisterRef = React.useRef<Persister<ReaderProgress> | null>(null);

  const uid = user?.uid ?? null;
  const docId = doc?.id ?? null;
  const fileType = doc?.fileType ?? "pdf";

  React.useEffect(() => {
    if (!uid || !docId) return;
    latestProgress.current = null;
    const persister = createPersister<ReaderProgress>({
      minIntervalMs: 60_000,
      initial: doc?.readerProgress ? normalizeReaderProgress(doc.readerProgress, fileType) : undefined,
      isSignificant: isSignificantReaderProgress,
      write: (value) => updatePersonalDocumentReadingProgress(uid, docId, value, fileType),
    });
    persisterRef.current = persister;
    const flush = () => { void persister.flush().then((ok) => { if (!ok) toast.error("Couldn't save reading progress."); }); };
    const onPageHide = () => flush();
    const onVisibility = () => { if (window.document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", onPageHide);
    window.document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.document.removeEventListener("visibilitychange", onVisibility);
      void persister.flush();
      persister.dispose();
      persisterRef.current = null;
    };
    // doc.readerProgress is only the starting point; changing it must not rebuild the persister.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, docId, fileType]);

  React.useEffect(() => {
    if (!uid || !docId) return;
    setAnnotationStatus({ state: "saved" });
    return subscribeAnnotationSaveStatus(uid, docId, setAnnotationStatus);
  }, [uid, docId]);

  /** Shared by the PDF, Word and Excel readers; each reports only the fields that belong to its type. */
  const queueReaderProgress = React.useCallback((progress: ReaderProgressInput) => {
    if (!persisterRef.current) return;
    latestProgress.current = mergeReaderProgress(latestProgress.current, progress);
    persisterRef.current.update(normalizeReaderProgress(latestProgress.current, fileType));
  }, [fileType]);

  const queueAnnotationSave = React.useCallback((nextAnnotations: unknown[]) => {
    if (!uid || !docId) return;
    setAnnotations(nextAnnotations);
    void savePersonalDocumentAnnotations(uid, docId, nextAnnotations).catch((error) => {
      toast.error(error instanceof Error ? error.message : "Couldn't save PDF annotations.");
    });
  }, [uid, docId]);

  return { annotations, setAnnotations, annotationStatus, queueReaderProgress, queueAnnotationSave };
}
