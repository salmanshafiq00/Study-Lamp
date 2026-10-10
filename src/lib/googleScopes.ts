// Shared by client and server. Pure — no Node APIs, no secrets, no imports
// from server-only modules, so this file is safe to bundle into the browser.
//
// Step W2 (Workspace connection foundation). Study Lamp asks Google for the
// narrowest scopes that exist for each service:
//   calendar -> calendar.app.created (only calendars/events Study Lamp made)
//   tasks    -> tasks                (NOT narrow: Google has no app-created
//                                     scope for Tasks, so this grants read and
//                                     write access to ALL of the user's task
//                                     lists, not only the "Study Lamp" list)
// Because the Tasks grant is wider than the feature needs, the limit is
// enforced in OUR code: every Tasks call takes the stored Study Lamp list id,
// and the client exposes no way to list or touch other lists (pinned by a test
// in googleTasks.test.ts). The consent copy and docs must say this plainly.
// The userinfo.email scope is always requested so the callback can show which
// Google account was connected; it grants no additional data access.

export type GoogleWorkspaceFeature = "calendar" | "tasks";

// Step G5: Drive joins the same connection. `GoogleFeature` is the wider type
// (drive + calendar + tasks). `GoogleWorkspaceFeature` stays calendar/tasks only,
// so every existing Calendar/Tasks code path keeps its exact types.
//   drive -> drive.file (only files the user picks or Study Lamp creates)
export type GoogleFeature = GoogleWorkspaceFeature | "drive";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const GOOGLE_WORKSPACE_SCOPES: Record<GoogleWorkspaceFeature, string> = {
  calendar: "https://www.googleapis.com/auth/calendar.app.created",
  tasks: "https://www.googleapis.com/auth/tasks",
};

export const GOOGLE_USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

function isWorkspaceFeature(value: unknown): value is GoogleWorkspaceFeature {
  return value === "calendar" || value === "tasks";
}

/** The exact scope list to request for the given features, always including
 *  userinfo.email. Order is stable and duplicates are removed. */
export function scopesForFeatures(features: readonly GoogleWorkspaceFeature[]): string[] {
  const normalized = Array.from(new Set(features.filter(isWorkspaceFeature)));
  const scopes = normalized.map((feature) => GOOGLE_WORKSPACE_SCOPES[feature]);
  if (!scopes.includes(GOOGLE_USERINFO_EMAIL_SCOPE)) {
    scopes.push(GOOGLE_USERINFO_EMAIL_SCOPE);
  }
  return scopes;
}

export function isGoogleFeature(value: unknown): value is GoogleFeature {
  return value === "drive" || value === "calendar" || value === "tasks";
}

/** Like scopesForFeatures, but Drive aware. Order is stable (drive, calendar, tasks, email); never anything wider. */
export function scopesForGoogleFeatures(features: readonly GoogleFeature[]): string[] {
  const wanted = new Set(features.filter(isGoogleFeature));
  const scopes: string[] = [];
  if (wanted.has("drive")) scopes.push(GOOGLE_DRIVE_SCOPE);
  if (wanted.has("calendar")) scopes.push(GOOGLE_WORKSPACE_SCOPES.calendar);
  if (wanted.has("tasks")) scopes.push(GOOGLE_WORKSPACE_SCOPES.tasks);
  scopes.push(GOOGLE_USERINFO_EMAIL_SCOPE);
  return scopes;
}

/** Drive aware version of featuresFromGrantedScopes: reads what Google ACTUALLY granted. */
export function googleFeaturesFromGrantedScopes(scopeString: string | null | undefined): GoogleFeature[] {
  const granted = new Set<string>((scopeString ?? "").split(/\s+/).filter(Boolean));
  const features: GoogleFeature[] = [];
  if (granted.has(GOOGLE_DRIVE_SCOPE)) features.push("drive");
  if (granted.has(GOOGLE_WORKSPACE_SCOPES.calendar)) features.push("calendar");
  if (granted.has(GOOGLE_WORKSPACE_SCOPES.tasks)) features.push("tasks");
  return features;
}

/** Which requested features were NOT granted (user unticked a box). Drive aware. */
export function missingGoogleFeatures(
  requested: readonly GoogleFeature[],
  scopeString: string | null | undefined,
): GoogleFeature[] {
  const granted = new Set(googleFeaturesFromGrantedScopes(scopeString));
  return Array.from(new Set(requested.filter(isGoogleFeature))).filter((feature) => !granted.has(feature));
}

/** Parses the space-separated `scope` string Google returns from the token
 *  endpoint into the features Study Lamp actually got. Unknown scopes (for
 *  example anything granted previously) are ignored. */
export function featuresFromGrantedScopes(scopeString: string | null | undefined): GoogleWorkspaceFeature[] {
  const granted = new Set<GoogleWorkspaceFeature>();
  for (const scope of (scopeString ?? "").split(/\s+/).filter(Boolean)) {
    if (scope === GOOGLE_WORKSPACE_SCOPES.calendar) granted.add("calendar");
    if (scope === GOOGLE_WORKSPACE_SCOPES.tasks) granted.add("tasks");
  }
  return Array.from(granted);
}

/** Which of the requested features were NOT granted. Used by the callback to
 *  report a partial grant (the user unticking a box on Google's consent
 *  screen) back to the settings page as ?missing=… */
export function missingFeatures(
  requested: readonly GoogleWorkspaceFeature[],
  scopeString: string | null | undefined,
): GoogleWorkspaceFeature[] {
  const granted = new Set(featuresFromGrantedScopes(scopeString));
  return Array.from(new Set(requested.filter(isWorkspaceFeature))).filter((feature) => !granted.has(feature));
}
