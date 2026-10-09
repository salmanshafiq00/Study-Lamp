import assert from "node:assert/strict";
import test from "node:test";
import { pdfiumWasmUrl } from "./pdfAssets";
import { MAX_PDF_PREVIEW_BYTES, formatBytes, readResponseWithLimit } from "./documentViewerUtils";

function streamOf(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
  });
  return new Response(body, { headers });
}

test("pdfiumWasmUrl is absolute and versioned (a relative URL fails inside the blob worker)", () => {
  assert.equal(pdfiumWasmUrl("https://study.example.com", "2.15.1"), "https://study.example.com/wasm/pdfium.wasm?v=2.15.1");
  assert.equal(pdfiumWasmUrl("http://localhost:3000"), "http://localhost:3000/wasm/pdfium.wasm");
  assert.throws(() => new URL("/wasm/pdfium.wasm", "blob:http://localhost:3000/3f1c"), "the failure this guards against");
});

test("readResponseWithLimit reports progress and fills a pre-sized buffer", async () => {
  const seen: Array<[number, number | null]> = [];
  const response = streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])], { "content-length": "5" });
  const buffer = await readResponseWithLimit(response, 100, "This PDF", (loaded, total) => seen.push([loaded, total]));
  assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3, 4, 5]);
  assert.deepEqual(seen, [[3, 5], [5, 5]]);
});

test("readResponseWithLimit works without a content-length and reports a null total", async () => {
  const seen: Array<number | null> = [];
  const buffer = await readResponseWithLimit(streamOf([new Uint8Array([9, 8]), new Uint8Array([7])]), 100, "This PDF", (_l, total) => seen.push(total));
  assert.deepEqual([...new Uint8Array(buffer)], [9, 8, 7]);
  assert.deepEqual(seen, [null, null]);
});

test("readResponseWithLimit rejects an oversized declared length without reading the body", async () => {
  await assert.rejects(
    readResponseWithLimit(streamOf([new Uint8Array(4)], { "content-length": "999" }), 10, "This PDF"),
    /larger than the/,
  );
});

test("readResponseWithLimit rejects a stream that grows past the limit", async () => {
  await assert.rejects(readResponseWithLimit(streamOf([new Uint8Array(6), new Uint8Array(6)]), 10, "This PDF"), /larger than the/);
});

test("readResponseWithLimit does not accept a truncated download", async () => {
  await assert.rejects(
    readResponseWithLimit(streamOf([new Uint8Array(3)], { "content-length": "10" }), 100, "This PDF"),
    /interrupted/,
  );
});

test("readResponseWithLimit survives a server that sends more than it declared", async () => {
  const buffer = await readResponseWithLimit(streamOf([new Uint8Array([1, 2]), new Uint8Array([3, 4])], { "content-length": "3" }), 100, "This PDF");
  assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3, 4]);
});

test("formatBytes and the PDF limit", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(38 * 1024 * 1024), "38.0 MB");
  assert.equal(formatBytes(-1), "0 B");
  assert.equal(MAX_PDF_PREVIEW_BYTES, 300 * 1024 * 1024);
});
