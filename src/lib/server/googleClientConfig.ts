// Server only. ONE Google OAuth client serves Drive, Calendar and Tasks.
// Lookup: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, then the old GOOGLE_WORKSPACE_CLIENT_ID / _SECRET names.
// (The GOOGLE_DRIVE_* names were removed in G7.) Values are never logged.

export interface GoogleClientCredentials {
  clientId: string;
  clientSecret: string;
}

type EnvLike = Record<string, string | undefined>;

function pair(env: EnvLike, idName: string, secretName: string): GoogleClientCredentials | null {
  const clientId = env[idName]?.trim();
  const clientSecret = env[secretName]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Returns the client, or null when no complete id+secret pair is configured. */
export function getGoogleClient(env: EnvLike = process.env): GoogleClientCredentials | null {
  return pair(env, "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET") ?? pair(env, "GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_WORKSPACE_CLIENT_SECRET");
}

/** The Picker App ID is the Google Cloud project number: the digits before the first "-" in the client id. */
export function pickerAppIdFromClientId(clientId: string | null | undefined): string | null {
  return /^(\d{6,})-/.exec(clientId ?? "")?.[1] ?? null;
}
