// Locates the PDFium engine file that ships with the installed @embedpdf packages.
// Shared by next.config.js (cache-busting version) and scripts/syncPdfiumWasm.cjs (copy into public/).
const fs = require("node:fs");
const path = require("node:path");

function locate() {
  try {
    const wasmPath = require.resolve("@embedpdf/pdfium/pdfium.wasm");
    const packageJson = JSON.parse(fs.readFileSync(path.join(path.dirname(wasmPath), "..", "package.json"), "utf8"));
    return { wasmPath, version: String(packageJson.version || "") };
  } catch {
    return null;
  }
}

module.exports = { locate };
