export const MAX_DOCUMENT_ANNOTATION_BYTES = 850 * 1024;

export const MAX_BLOB_ANNOTATION_BYTES = 2 * 1024 * 1024;
/** Legacy Firestore copy is only used as a fallback without Drive, and only when small (decision D16 spirit). */
export const MAX_FALLBACK_FIRESTORE_ANNOTATION_BYTES = 200 * 1024;

export interface DocumentAnnotationItem {
  annotation: { type: number; [key: string]: unknown };
}

export function prepareDocumentAnnotations(items: unknown[]): DocumentAnnotationItem[] {
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const annotation = (item as { annotation?: unknown }).annotation;
    if (!annotation || typeof annotation !== "object") return [];
    const value = annotation as { type?: unknown; [key: string]: unknown };
    if (typeof value.type !== "number" || value.type === 13 || value.type === 17) return [];
    return [{ annotation: value as DocumentAnnotationItem["annotation"] }];
  });
}

export function serializeDocumentAnnotations(items: unknown[]): string {
  const json = JSON.stringify(prepareDocumentAnnotations(items));
  if (new TextEncoder().encode(json).byteLength > MAX_DOCUMENT_ANNOTATION_BYTES) {
    throw new Error("PDF annotations exceed the safe storage limit.");
  }
  return json;
}

export function parseDocumentAnnotations(json: unknown): unknown[] {
  if (typeof json !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? prepareDocumentAnnotations(parsed) : [];
  } catch {
    return [];
  }
}

export interface AnnotationsBlob { version: 1; annotations: DocumentAnnotationItem[] }

/** Payload stored in Drive (users/.../annotations-<id>.json). Throws a clear error above 2 MB. */
export function buildAnnotationsBlob(items: unknown[]): AnnotationsBlob {
  const blob: AnnotationsBlob = { version: 1, annotations: prepareDocumentAnnotations(items) };
  if (new TextEncoder().encode(JSON.stringify(blob)).byteLength > MAX_BLOB_ANNOTATION_BYTES) {
    throw new Error("PDF annotations exceed the 2 MB limit.");
  }
  return blob;
}

/** Validates on read: a user may have edited the Drive file, so anything unexpected is dropped. */
export function parseAnnotationsBlob(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const annotations = (value as { annotations?: unknown }).annotations;
  return Array.isArray(annotations) ? prepareDocumentAnnotations(annotations) : [];
}
