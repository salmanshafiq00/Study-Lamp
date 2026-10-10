import { pointerOf } from "@/lib/firestore/inlineLimit";

export interface LargeTextReader { get(uid: string, kind: "summary" | "note" | "transcript", key: string): Promise<{ json: unknown } | null> }

/** Full text of a stored summary/note/transcript document on the server: inline `content`, or its Drive blob. */
export async function readStoredTextServer(reader: LargeTextReader, uid: string, data: Record<string, unknown> | undefined): Promise<string> {
  const inline = typeof data?.content === "string" ? data.content : "";
  const pointer = pointerOf(data);
  if (!pointer) return inline;
  const blob = await reader.get(uid, pointer.kind, pointer.key);
  const text = (blob?.json as { text?: unknown } | null)?.text;
  if (typeof text !== "string") throw new Error("Stored text is unavailable.");
  return text;
}
