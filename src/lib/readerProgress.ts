/**
 * Reading-position helpers shared by the PDF, Word and Excel readers, the
 * document page, Firestore writes and the Continue-learning page.
 * Pure: no React and no Firebase imports.
 *
 * Stored shape (users/{uid}/personalDocuments/{id}.readerProgress, plus a
 * server `updatedAt` added at write time):
 *   lastPage    PDF page (1-based); always 1 for DOCX/XLSX
 *   zoom        factor 0.1..10 (the Word reader's 60-160 % is stored as 0.6-1.6)
 *   scrollRatio DOCX only, 0..1 vertical position
 *   sheetIndex  XLSX only, 0-based active sheet
 *   rowIndex    XLSX only, 0-based first visible data row of that sheet
 * Documents saved before DOCX/XLSX support only have { lastPage, zoom }.
 */

export type ReaderFileType = "pdf" | "docx" | "xlsx" | "pptx";

export interface ReaderProgressInput {
  lastPage?: number;
  zoom?: number;
  scrollRatio?: number;
  sheetIndex?: number;
  rowIndex?: number;
}

export interface ReaderProgress {
  lastPage: number;
  zoom: number;
  scrollRatio?: number;
  sheetIndex?: number;
  rowIndex?: number;
}

export const READER_LIMITS = {
  lastPage: { min: 1, max: 100_000 },
  zoom: { min: 0.1, max: 10 },
  scrollRatio: { min: 0, max: 1 },
  sheetIndex: { min: 0, max: 200 },
  rowIndex: { min: 0, max: 1_000_000 },
} as const;

/** Below this a Word document counts as "still at the top". */
const DOCX_TOP_THRESHOLD = 0.02;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: unknown, limits: { min: number; max: number }, fallback: number): number {
  return isFiniteNumber(value) ? clamp(Math.round(value), limits.min, limits.max) : fallback;
}

/**
 * Clamped, Firestore-rules-valid progress for a file type. Never contains
 * undefined (Firestore rejects it) and only the fields that belong to the type,
 * so a PDF document is written exactly as before: { lastPage, zoom }.
 */
export function normalizeReaderProgress(input: ReaderProgressInput | null | undefined, fileType: ReaderFileType): ReaderProgress {
  const source = input ?? {};
  const zoom = isFiniteNumber(source.zoom) ? clamp(source.zoom, READER_LIMITS.zoom.min, READER_LIMITS.zoom.max) : 1;

  if (fileType === "docx") {
    const result: ReaderProgress = { lastPage: 1, zoom };
    if (isFiniteNumber(source.scrollRatio)) {
      result.scrollRatio = clamp(source.scrollRatio, READER_LIMITS.scrollRatio.min, READER_LIMITS.scrollRatio.max);
    }
    return result;
  }

  if (fileType === "xlsx") {
    const result: ReaderProgress = { lastPage: 1, zoom };
    if (isFiniteNumber(source.sheetIndex)) result.sheetIndex = clampInt(source.sheetIndex, READER_LIMITS.sheetIndex, 0);
    if (isFiniteNumber(source.rowIndex)) result.rowIndex = clampInt(source.rowIndex, READER_LIMITS.rowIndex, 0);
    return result;
  }

  return { lastPage: clampInt(source.lastPage, READER_LIMITS.lastPage, 1), zoom };
}

/** Fields of `next` that are defined override `prev`; everything else is kept. */
export function mergeReaderProgress(
  prev: ReaderProgressInput | null | undefined,
  next: ReaderProgressInput | null | undefined,
): ReaderProgressInput {
  const merged: ReaderProgressInput = { ...(prev ?? {}) };
  for (const [key, value] of Object.entries(next ?? {}) as Array<[keyof ReaderProgressInput, number | undefined]>) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * False for "page 1 / top / first row of the first sheet", so just opening a
 * document does not put it on Continue-learning. The kind of progress is
 * inferred from which fields are present (old PDF objects only have lastPage).
 */
export function isMeaningfulProgress(progress: ReaderProgressInput | null | undefined): boolean {
  if (!progress) return false;
  if (isFiniteNumber(progress.sheetIndex) || isFiniteNumber(progress.rowIndex)) {
    return (progress.sheetIndex ?? 0) > 0 || (progress.rowIndex ?? 0) > 0;
  }
  if (isFiniteNumber(progress.scrollRatio)) return progress.scrollRatio >= DOCX_TOP_THRESHOLD;
  return (progress.lastPage ?? 1) > 1;
}

/** "Page 12" | "Sheet 2, row 300" | "45% through". Row numbers count data rows from 1. */
export function describeReaderProgress(progress: ReaderProgressInput | null | undefined, fileType: ReaderFileType): string {
  const normalized = normalizeReaderProgress(progress, fileType);
  if (fileType === "xlsx") {
    const sheet = (normalized.sheetIndex ?? 0) + 1;
    const row = (normalized.rowIndex ?? 0) + 1;
    return row > 1 ? `Sheet ${sheet}, row ${row}` : `Sheet ${sheet}`;
  }
  if (fileType === "docx") {
    return normalized.scrollRatio === undefined ? "In progress" : `${Math.round(normalized.scrollRatio * 100)}% through`;
  }
  return `Page ${normalized.lastPage}`;
}

/**
 * P3: is `next` far enough from the last saved position to be worth a write? One page, a 5 % zoom step (0.05),
 * another sheet, 20 rows, or 5 % of a Word document. Small drift is saved only when the reader flushes (leave/hide).
 */
export function isSignificantReaderProgress(last: ReaderProgressInput, next: ReaderProgressInput): boolean {
  const differs = (a: number | undefined, b: number | undefined, delta: number) =>
    (a === undefined) !== (b === undefined) || (a !== undefined && b !== undefined && Math.abs(a - b) >= delta);
  return (
    differs(last.lastPage, next.lastPage, 1) ||
    differs(last.zoom, next.zoom, 0.05) ||
    differs(last.sheetIndex, next.sheetIndex, 1) ||
    differs(last.rowIndex, next.rowIndex, 20) ||
    differs(last.scrollRatio, next.scrollRatio, 0.05)
  );
}
