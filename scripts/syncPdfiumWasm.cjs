// Copies the PDFium engine from the installed package into public/wasm/ so the self-hosted file can never
// drift from the library version (a mismatched engine makes the PDF viewer fail silently).
// Runs before `next dev` and `next build`. It never fails the build: if the package is missing it only warns.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { locate } = require("./pdfiumWasm.cjs");

const found = locate();
if (!found) {
  console.warn("[pdfium] @embedpdf/pdfium is not installed; leaving public/wasm/pdfium.wasm as it is.");
  process.exit(0);
}

const target = path.join(__dirname, "..", "public", "wasm", "pdfium.wasm");
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

if (fs.existsSync(target) && hash(target) === hash(found.wasmPath)) {
  console.log(`[pdfium] public/wasm/pdfium.wasm is up to date (v${found.version}).`);
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(found.wasmPath, target);
  console.log(`[pdfium] Updated public/wasm/pdfium.wasm to v${found.version}.`);
}
