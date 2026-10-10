import type { GoogleConnectionSummary, GoogleWorkspaceFeature } from "@/types";

/** The three cards on the single Settings → Google page. */
export type GoogleCardId = "drive" | "calendar" | "tasks";

export const GOOGLE_CARD_IDS: readonly GoogleCardId[] = ["drive", "calendar", "tasks"];

export const FEATURE_LABELS: Record<GoogleWorkspaceFeature, string> = {
  calendar: "Calendar",
  tasks: "Tasks",
};

/** Query parameters the OAuth callbacks add to the return URL; the page shows them once, then removes them. */
export const GOOGLE_RETURN_PARAMS = ["connected", "error", "missing", "tab"] as const;

export function isGoogleCardId(value: unknown): value is GoogleCardId {
  return typeof value === "string" && (GOOGLE_CARD_IDS as readonly string[]).includes(value);
}

function isWorkspaceFeature(value: string): value is GoogleWorkspaceFeature {
  return Object.prototype.hasOwnProperty.call(FEATURE_LABELS, value);
}

/** Which card the user should land on. `?tab=` (set by the callbacks) wins over `#hash` (set by in-app links). */
export function cardFromLocation(tab: string | null | undefined, hash: string | null | undefined): GoogleCardId | null {
  if (isGoogleCardId(tab)) return tab;
  const fromHash = (hash ?? "").replace(/^#/, "");
  return isGoogleCardId(fromHash) ? fromHash : null;
}

export interface GoogleSettingsMessage {
  kind: "success" | "error";
  text: string;
}

interface ParamReader {
  get(name: string): string | null;
}

/** Maps the callback's ?connected / ?missing / ?error parameters to the toasts the old two pages showed. */
export function messagesFromParams(params: ParamReader): GoogleSettingsMessage[] {
  const messages: GoogleSettingsMessage[] = [];
  const connected = params.get("connected");
  const missing = params.get("missing");
  const error = params.get("error");
  if (connected) messages.push({ kind: "success", text: `Connected ${connected}` });
  if (missing) {
    const words = missing
      .split(",")
      .filter(Boolean)
      .map((feature) => (feature === "drive" ? "Drive" : isWorkspaceFeature(feature) ? FEATURE_LABELS[feature] : feature))
      .join(" and ");
    if (words) messages.push({ kind: "error", text: `You did not allow ${words} access, so that feature stays off.` });
  }
  if (error) messages.push({ kind: "error", text: error });
  return messages;
}

export type GoogleCardStatus = "connected" | "needs_reconnect" | "not_connected";

/** Status of the Drive card from the Drive connection list. */
export function driveStatus(connections: ReadonlyArray<{ status: string }>): GoogleCardStatus {
  if (connections.some((connection) => connection.status !== "invalid")) return "connected";
  return connections.length > 0 ? "needs_reconnect" : "not_connected";
}

/** Status of the Calendar or Tasks card: only connections that were granted that feature count. */
export function featureStatus(
  connections: ReadonlyArray<Pick<GoogleConnectionSummary, "status" | "grantedScopes">>,
  feature: GoogleWorkspaceFeature,
): GoogleCardStatus {
  const granted = connections.filter((connection) => connection.grantedScopes.includes(feature));
  if (granted.some((connection) => connection.status !== "invalid")) return "connected";
  return granted.length > 0 ? "needs_reconnect" : "not_connected";
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

type RawSearchParams = Record<string, string | string[] | undefined>;

/** Target of the old /settings/drive page: keep an in-flight callback's message, land on the Drive card. */
export function legacyDriveSettingsRedirect(searchParams: RawSearchParams): string {
  const query = new URLSearchParams();
  for (const key of ["connected", "error", "missing"] as const) {
    const raw = searchParams[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) query.set(key, value);
  }
  const queryString = query.toString();
  return `/settings/google${queryString ? `?${queryString}` : ""}#drive`;
}
