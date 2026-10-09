import * as XLSX from "xlsx";

export const MAX_DOCX_PREVIEW_BYTES = 25 * 1024 * 1024;
export const MAX_XLSX_PREVIEW_BYTES = 10 * 1024 * 1024;
export const MAX_XLSX_ROWS = 20_000;
/** The whole file is held in memory (and copied once into the PDF engine), so very large PDFs are sent to Drive's own viewer instead. */
export const MAX_PDF_PREVIEW_BYTES = 300 * 1024 * 1024;

export interface SpreadsheetSheet {
  name: string;
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

export type DownloadProgress = (loadedBytes: number, totalBytes: number | null) => void;

/**
 * Reads a response body into one ArrayBuffer, refusing anything over `maxBytes`.
 * When the server states a length the buffer is allocated once and filled in place
 * (peak memory = file size, not 2x). `onProgress` receives the running byte count;
 * `totalBytes` is null when the length is unknown (for example a compressed response).
 */
export async function readResponseWithLimit(
  response: Response,
  maxBytes: number,
  label: string,
  onProgress?: DownloadProgress,
): Promise<ArrayBuffer> {
  const limitMessage = `${label} is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB preview limit.`;
  const declared = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (totalBytes !== null && totalBytes > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(limitMessage);
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error(limitMessage);
    onProgress?.(buffer.byteLength, buffer.byteLength);
    return buffer;
  }

  const reader = response.body.getReader();
  // Known length: fill one buffer in place. Unknown: collect chunks and join once at the end.
  let target = totalBytes !== null ? new Uint8Array(totalBytes) : null;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      if (loaded > maxBytes) {
        await reader.cancel();
        throw new Error(limitMessage);
      }
      if (target && loaded <= target.byteLength) {
        target.set(value, loaded - value.byteLength);
      } else {
        // The server sent more than it declared: fall back to chunk collection.
        if (target) {
          chunks.push(target.subarray(0, loaded - value.byteLength));
          target = null;
        }
        chunks.push(value);
      }
      onProgress?.(loaded, totalBytes);
    }
  } finally {
    reader.releaseLock();
  }

  if (target) {
    // A short body (connection ended early) must not be passed off as a complete file.
    if (loaded !== target.byteLength) throw new Error(`${label} download was interrupted. Try again.`);
    return target.buffer as ArrayBuffer;
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/** 1536 -> "1.5 KB". Used for download progress text. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function parseSpreadsheet(buffer: ArrayBuffer): SpreadsheetSheet[] {
  const workbook = XLSX.read(new Uint8Array(buffer), {
    type: "array",
    cellFormula: false,
    cellHTML: false,
    cellText: true,
    cellDates: false,
  });
  let remainingRows = MAX_XLSX_ROWS;

  return workbook.SheetNames.map((name) => {
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
      header: 1,
      raw: false,
      blankrows: false,
    });
    const cappedRows = matrix.slice(0, remainingRows);
    remainingRows -= cappedRows.length;
    const hasHeader = cappedRows.length > 0;
    const headerCells = hasHeader ? cappedRows[0] : [];
    const columnCount = Math.max(1, ...cappedRows.map((row) => row.length));
    const columns = Array.from({ length: columnCount }, (_, index) => {
      const value = headerCells[index];
      return value == null || String(value).trim() === "" ? `Column ${index + 1}` : String(value);
    });
    const rows = (hasHeader ? cappedRows.slice(1) : cappedRows).map((row) => (
      columns.map((_, index) => String(row[index] ?? ""))
    ));

    return {
      name,
      columns,
      rows,
      truncated: matrix.length > cappedRows.length,
    };
  });
}