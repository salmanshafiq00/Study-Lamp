export type DrivePickerKind = "video" | "pdf" | "docx" | "pptx" | "xlsx" | "gdoc" | "gsheet";

export const DRIVE_PICKER_MIME_BY_KIND: Record<DrivePickerKind, string> = {
  video: "video/*",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  gdoc: "application/vnd.google-apps.document",
  gsheet: "application/vnd.google-apps.spreadsheet",
};

export function nativeExportMime(mimeType: string): string | null {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "application/vnd.google-apps.spreadsheet":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return null;
  }
}

export function isGoogleNativeMime(mimeType: string): boolean {
  return nativeExportMime(mimeType) !== null;
}

export function buildPickerMimeTypes(kinds: DrivePickerKind[]): string[] {
  return kinds.map((kind) => DRIVE_PICKER_MIME_BY_KIND[kind]).filter(Boolean);
}

export type PickerViewId = "DOCS_VIDEOS" | "PDFS" | "DOCUMENTS" | "SPREADSHEETS" | "DOCS";

export interface PickerViewSpec {
  viewId: PickerViewId;
  /** Only set for the combined DOCS view (Word, Excel, PowerPoint files). */
  mimeTypes?: string[];
  label: string;
}

/**
 * One Google Picker view (= one tab) per file type. Order: Videos, PDFs, Google Docs, Google Sheets, then a single
 * combined "Google Drive" view for docx/xlsx/pptx files. pptx never gets its own tab. Empty input returns one
 * unfiltered DOCS view. No duplicates.
 */
export function buildPickerViewSpecs(kinds: DrivePickerKind[]): PickerViewSpec[] {
  const wanted = new Set(kinds);
  const specs: PickerViewSpec[] = [];
  if (wanted.has("video")) specs.push({ viewId: "DOCS_VIDEOS", label: "Videos" });
  if (wanted.has("pdf")) specs.push({ viewId: "PDFS", label: "PDFs" });
  if (wanted.has("gdoc")) specs.push({ viewId: "DOCUMENTS", label: "Google Docs" });
  if (wanted.has("gsheet")) specs.push({ viewId: "SPREADSHEETS", label: "Google Sheets" });
  const officeKinds = (["docx", "xlsx", "pptx"] as const).filter((kind) => wanted.has(kind));
  if (officeKinds.length > 0) {
    specs.push({ viewId: "DOCS", mimeTypes: buildPickerMimeTypes([...officeKinds]), label: "Google Drive" });
  }
  if (specs.length === 0) specs.push({ viewId: "DOCS", label: "Google Drive" });
  return specs;
}
