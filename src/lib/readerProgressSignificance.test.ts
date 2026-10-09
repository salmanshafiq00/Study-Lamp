import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSignificantReaderProgress } from "./readerProgress";

describe("isSignificantReaderProgress", () => {
  it("is false for identical or tiny changes", () => {
    assert.equal(isSignificantReaderProgress({ lastPage: 3, zoom: 1 }, { lastPage: 3, zoom: 1 }), false);
    assert.equal(isSignificantReaderProgress({ lastPage: 3, zoom: 1 }, { lastPage: 3, zoom: 1.02 }), false);
    assert.equal(isSignificantReaderProgress({ rowIndex: 10 }, { rowIndex: 25 }), false);
    assert.equal(isSignificantReaderProgress({ scrollRatio: 0.3 }, { scrollRatio: 0.32 }), false);
  });
  it("is true for a page, zoom step, sheet, 20 rows or 5% scroll", () => {
    assert.equal(isSignificantReaderProgress({ lastPage: 3, zoom: 1 }, { lastPage: 4, zoom: 1 }), true);
    assert.equal(isSignificantReaderProgress({ lastPage: 3, zoom: 1 }, { lastPage: 3, zoom: 1.1 }), true);
    assert.equal(isSignificantReaderProgress({ sheetIndex: 0 }, { sheetIndex: 1 }), true);
    assert.equal(isSignificantReaderProgress({ rowIndex: 0 }, { rowIndex: 20 }), true);
    assert.equal(isSignificantReaderProgress({ scrollRatio: 0.1 }, { scrollRatio: 0.16 }), true);
  });
});
