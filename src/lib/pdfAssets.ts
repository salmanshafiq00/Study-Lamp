/**
 * Where the self-hosted PDFium engine file lives.
 *
 * The PDF engine runs in a Web Worker that EmbedPDF creates from a blob: URL. Inside such a worker a
 * relative URL like "/wasm/pdfium.wasm" cannot be resolved (a blob: URL has no usable base), so the
 * worker's fetch throws, the library swallows the error, and the viewer waits forever. The URL handed
 * to the viewer must therefore always be absolute.
 */
export const PDFIUM_WASM_PATH = "/wasm/pdfium.wasm";

/** Absolute URL of the engine file. `version` is appended so a package upgrade never serves a stale cached file. */
export function pdfiumWasmUrl(origin: string, version?: string): string {
  const url = new URL(PDFIUM_WASM_PATH, origin);
  if (version) url.searchParams.set("v", version);
  return url.href;
}
