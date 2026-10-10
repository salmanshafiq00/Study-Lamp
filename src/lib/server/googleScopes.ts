// Step W2: the scope helpers are pure and shared by client and server, so the
// canonical implementation lives in src/lib/googleScopes.ts. This module stays
// as the server-side import path used across src/lib/server and the API routes,
// to avoid a churny rename — it only re-exports.
export {
  GOOGLE_WORKSPACE_SCOPES,
  GOOGLE_USERINFO_EMAIL_SCOPE,
  GOOGLE_DRIVE_SCOPE,
  isGoogleFeature,
  scopesForGoogleFeatures,
  googleFeaturesFromGrantedScopes,
  missingGoogleFeatures,
  scopesForFeatures,
  featuresFromGrantedScopes,
  missingFeatures,
  type GoogleWorkspaceFeature,
  type GoogleFeature,
} from "@/lib/googleScopes";
