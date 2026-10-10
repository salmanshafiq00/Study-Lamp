import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPickerMimeTypes, buildPickerViewSpecs, isGoogleNativeMime, nativeExportMime, type DrivePickerKind } from "./driveMime";

describe("Drive picker MIME helpers", () => {
  it("maps typed picker kinds to Google Picker mime filters", () => {
    const types = buildPickerMimeTypes(["video", "pdf", "docx", "pptx", "xlsx"]);
    assert.deepEqual(types, [
      "video/*",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]);
  });

  it("accepts a subset of kinds without adding unsupported values", () => {
    const kinds: DrivePickerKind[] = ["video", "xlsx"];
    assert.deepEqual(buildPickerMimeTypes(kinds), ["video/*", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
  });
});

describe("Google-native export mapping", () => {
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  it("exports Docs as .docx and Sheets as .xlsx only", () => {
    assert.equal(nativeExportMime("application/vnd.google-apps.document"), docx);
    assert.equal(nativeExportMime("application/vnd.google-apps.spreadsheet"), xlsx);
  });

  it("has no export for Slides, folders or regular files", () => {
    for (const mime of ["application/vnd.google-apps.presentation", "application/vnd.google-apps.folder", "application/pdf", docx, ""]) {
      assert.equal(nativeExportMime(mime), null);
      assert.equal(isGoogleNativeMime(mime), false);
    }
    assert.equal(isGoogleNativeMime("application/vnd.google-apps.document"), true);
  });

  it("maps gdoc and gsheet picker kinds to the native MIME types", () => {
    assert.deepEqual(buildPickerMimeTypes(["docx", "gdoc"]), [docx, "application/vnd.google-apps.document"]);
    assert.deepEqual(buildPickerMimeTypes(["xlsx", "gsheet"]), [xlsx, "application/vnd.google-apps.spreadsheet"]);
  });
});

describe("buildPickerViewSpecs", () => {
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  it("creates one tab per type in a fixed order", () => {
    const specs = buildPickerViewSpecs(["xlsx", "gsheet", "docx", "gdoc", "pdf", "video"]);
    assert.deepEqual(specs.map((spec) => spec.viewId), ["DOCS_VIDEOS", "PDFS", "DOCUMENTS", "SPREADSHEETS", "DOCS"]);
    assert.deepEqual(specs[4].mimeTypes, [docx, xlsx]);
  });

  it("merges docx, xlsx and pptx into one view and never gives pptx its own tab", () => {
    const specs = buildPickerViewSpecs(["pptx"]);
    assert.equal(specs.length, 1);
    assert.equal(specs[0].viewId, "DOCS");
    assert.equal(specs[0].mimeTypes?.length, 1);
  });

  it("returns a single unfiltered view for empty input", () => {
    assert.deepEqual(buildPickerViewSpecs([]), [{ viewId: "DOCS", label: "Google Drive" }]);
  });

  it("has no duplicates", () => {
    const specs = buildPickerViewSpecs(["pdf", "pdf", "docx", "docx"]);
    assert.deepEqual(specs.map((spec) => spec.viewId), ["PDFS", "DOCS"]);
  });
});
