import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_DOCUMENT_ANNOTATION_BYTES, parseDocumentAnnotations, prepareDocumentAnnotations, serializeDocumentAnnotations } from "./documentAnnotations";

describe("personal PDF annotation cache", () => {
  it("keeps JSON-safe annotations and omits binary stamp/attachment entries", () => {
    const items = [
      { annotation: { type: 9, id: "highlight", pageIndex: 0 } },
      { annotation: { type: 1, id: "note", contents: "Review this" } },
      { annotation: { type: 13, id: "stamp" }, ctx: { data: new ArrayBuffer(8) } },
      { annotation: { type: 17, id: "attachment" } },
    ];
    const serialized = serializeDocumentAnnotations(items);
    const parsed = parseDocumentAnnotations(serialized);
    assert.deepEqual(parsed.map((item: any) => item.annotation.id), ["highlight", "note"]);
    assert.deepEqual(prepareDocumentAnnotations([{ annotation: { type: 9, id: "highlight" }, ctx: { data: new ArrayBuffer(8) } }]), [
      { annotation: { type: 9, id: "highlight" } },
    ]);
  });

  it("drops link, popup and widget annotations that already live inside the PDF", () => {
    const kept = prepareDocumentAnnotations([
      { annotation: { type: 2, id: "link" } },
      { annotation: { type: 16, id: "popup" } },
      { annotation: { type: 20, id: "widget" } },
      { annotation: { type: 10, id: "underline" } },
      { annotation: { type: 15, id: "ink" } },
    ]);
    assert.deepEqual(kept.map((item) => item.annotation.id), ["underline", "ink"]);
  });

  it("rejects annotation JSON beyond the byte budget", () => {
    assert.throws(
      () => serializeDocumentAnnotations([{ annotation: { type: 1, id: "note", contents: "x".repeat(MAX_DOCUMENT_ANNOTATION_BYTES) } }]),
      /safe storage limit/,
    );
  });

  it("returns an empty list for malformed persisted JSON", () => {
    assert.deepEqual(parseDocumentAnnotations("not json"), []);
  });
});