// Server only. One Google OAuth client can serve both the Drive and the Workspace flows.
// Lookup order for each flow: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET first, then the legacy
// flow-specific names (GOOGLE_DRIVE_* or GOOGLE_WORKSPACE_*). Values are never logged.

export type GoogleFlow = "drive" | "workspace";

export interface GoogleClientCredentials {
  clientId: string;
  clientSecret: string;
}

type EnvLike = Record<string, string | undefined>;

const LEGACY_NAMES: Record<GoogleFlow, { id: string; secret: string }> = {
  drive: { id: "GOOGLE_DRIVE_CLIENT_ID", secret: "GOOGLE_DRIVE_CLIENT_SECRET" },
  workspace: { id: "GOOGLE_WORKSPACE_CLIENT_ID", secret: "GOOGLE_WORKSPACE_CLIENT_SECRET" },
};

function pair(env: EnvLike, idName: string, secretName: string): GoogleClientCredentials | null {
  const clientId = env[idName]?.trim();
  const clientSecret = env[secretName]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Returns the client for a flow, or null when no complete id+secret pair is configured. */
export function getGoogleClient(flow: GoogleFlow, env: EnvLike = process.env): GoogleClientCredentials | null {
  return pair(env, "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET") ?? pair(env, LEGACY_NAMES[flow].id, LEGACY_NAMES[flow].secret);
}

/** The Picker App ID is the Google Cloud project number: the digits before the first "-" in the client id. */
export function pickerAppIdFromClientId(clientId: string | null | undefined): string | null {
  return /^(\d{6,})-/.exec(clientId ?? "")?.[1] ?? null;
}
