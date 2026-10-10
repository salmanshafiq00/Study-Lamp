import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INLINE_LIMIT_BYTES, InlineTooLargeError, assertInlineSize, exceedsInline, planTextStorage, pointerOf, previewOf, utf8Bytes, fitsInlineFallback } from "@/lib/firestore/inlineLimit";

function pick(actual: unknown, expected: unknown): unknown {
  if (!expected || typeof expected !== "object" || !actual || typeof actual !== "object") return actual;
  return Object.fromEntries(Object.keys(expected).map((k) => [k, (actual as Record<string, unknown>)[k]]));
}

describe("inline size rule (P5 / D16)", () => {
  it("counts UTF-8 bytes, not characters (Bengali is 3 bytes per character)", () => {
    assert.equal(utf8Bytes("আ"), 3);
    assert.equal(exceedsInline("আ".repeat(7000)), true); // 21,000 bytes, 7,000 chars
    assert.equal(exceedsInline("a".repeat(INLINE_LIMIT_BYTES)), false);
    assert.equal(exceedsInline("a".repeat(INLINE_LIMIT_BYTES + 1)), true);
  });
  it("assertInlineSize throws only over the limit", () => {
    assert.doesNotThrow(() => assertInlineSize("hello"));
    assert.throws(() => assertInlineSize("a".repeat(INLINE_LIMIT_BYTES + 1)), InlineTooLargeError);
  });
  it("small text stays inline", () => {
    assert.deepEqual(planTextStorage("note", "abc", "short"), { mode: "inline", content: "short" });
  });
  it("large text becomes a pointer with a short preview", () => {
    const plan = planTextStorage("summary", "d_Xy12", "x".repeat(30_000));
    assert.equal(plan.mode, "blob");
    if (plan.mode !== "blob") return;
    assert.equal(plan.content.length, 300);
    assert.deepEqual(pick(plan.pointer, { blobKind: "summary", blobKey: "d_Xy12", bytes: 30_000 }), { blobKind: "summary", blobKey: "d_Xy12", bytes: 30_000 });
  });
  it("preview never splits a surrogate pair", () => {
    const preview = previewOf("😀".repeat(400));
    assert.equal(Array.from(preview).length, 300);
    assert.equal(preview.endsWith("😀"), true);
  });
  it("pointerOf accepts only known kinds with a key", () => {
    assert.deepEqual(pointerOf({ blobKind: "note", blobKey: "k" }), { kind: "note", key: "k" });
    assert.equal(pointerOf({ blobKind: "annotations", blobKey: "k" }), null);
    assert.equal(pointerOf({ blobKind: "note" }), null);
    assert.equal(pointerOf(undefined), null);
  });
  it("inline fallback respects the 50,000-character rules cap", () => {
    assert.equal(fitsInlineFallback("a".repeat(50_000)), true);
    assert.equal(fitsInlineFallback("a".repeat(50_001)), false);
  });
});
