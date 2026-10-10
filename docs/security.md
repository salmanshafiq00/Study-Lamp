# Security Operations

Keep secrets out of source control, logs, screenshots and shell history. Prefer `--env-file` or your host's secret manager over inline literals.

## 1. Rotate `AI_CONNECTION_ENCRYPTION_KEY`

`AI_CONNECTION_ENCRYPTION_KEY` encrypts user/system AI API keys and Google Drive + Google Workspace refresh tokens. Do not replace it without keeping the old key until every stored credential has been re-encrypted.

1. Back up Firestore. Generate a new key: `openssl rand -base64 32`.
2. In the deployment environment set `AI_CONNECTION_ENCRYPTION_KEY` to the **new** key and `AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS` to the **old** key. Redeploy so reads accept either key and new writes use the new one.
3. Run the **dry run** (this is the default; nothing is written):
   `npx tsx --env-file=.env.local scripts/reencrypt.ts`
   It prints found/ok/failed counts for `aiConnections`, `driveConnections`, `googleConnections` and `systemAiConnections`, and exits non-zero (writing nothing) if any credential cannot be decrypted.
4. When the dry run is clean, apply: `npx tsx --env-file=.env.local scripts/reencrypt.ts --apply`.
5. Verify an AI connection, a Drive connection and a Google Workspace connection in the app, then remove `AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS` and redeploy.

Keep the old key in a temporary secure location until step 5 is done, then destroy it.

## 2. Rotate `DRIVE_URL_SIGNING_SECRET`

Signs the short-lived Drive stream/thumbnail/download URLs. Changing it **invalidates every outstanding signed URL**. The client requests fresh URLs automatically, so the effect is a brief reload of players and thumbnails. Do it off-peak.

1. Generate: `openssl rand -base64 32`.
2. Replace the variable and redeploy.
3. Open a Drive video and a PDF to confirm playback.

TTLs (`src/lib/server/driveSignedUrl.ts`): stream 6 h, download 10 min, thumbnail 24 h. A leaked URL works until it expires or the secret is rotated.

## 2b. `GOOGLE_SYNC_SIGNING_SECRET` (sync plan tokens)

Every Google write (Calendar, Tasks, Docs, Sheets) goes through preview -> confirm -> apply. The preview returns a **plan token**: an HMAC-signed, per-user, per-scope, one-time token that lists the exact items the user was shown. It is signed over the prefix `sync-plan.v1|`, so it cannot be confused with a Drive signed URL even if both use the same key.

- **Use a dedicated secret.** Set `GOOGLE_SYNC_SIGNING_SECRET` (`openssl rand -base64 32`), different from `DRIVE_URL_SIGNING_SECRET`. Plan tokens use it when set.
- **Fallback.** If it is not set, plan tokens are signed with `DRIVE_URL_SIGNING_SECRET`. This works, but then one leaked secret (for example from a Drive URL signing incident) could also be used to forge plan tokens, so treat the fallback as temporary.
- **Rotation.** Plan tokens live 15 minutes. Changing the secret only invalidates previews that are open right now; users just press "Check for changes" again. Nothing stored is affected.
- **Switching from the fallback.** Add the new variable and redeploy. No migration is needed.

## 3. Other secrets

| Secret | How to rotate |
|---|---|
| `GOOGLE_DRIVE_OAUTH_STATE_SECRET` | Generate a new random value, redeploy. Only Drive connect flows in progress (10 min window) fail; users just retry. |
| `GOOGLE_WORKSPACE_OAUTH_STATE_SECRET` | Same as above, for the Google Workspace (Calendar/Tasks) connect flow. In-flight connects (10 min) fail; users retry. |
| Firebase Admin key (`FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`) | Google Cloud Console → IAM → Service accounts → create a new key → update the env vars → redeploy → confirm API routes work → **delete the old key**. |
| Google OAuth client secret (`GOOGLE_DRIVE_CLIENT_SECRET`) | Cloud Console → Credentials → OAuth client → add a new secret → update env → redeploy → disable the old secret. Existing refresh tokens keep working. |
| Google Workspace OAuth client secret (`GOOGLE_WORKSPACE_CLIENT_SECRET`) | Same as above, on the "Study Lamp Workspace" OAuth client. Existing refresh tokens keep working. |
| Facebook app secret | The current code does not read `FACEBOOK_APP_SECRET`. If it is in your env files, remove it. If you ever use it, reset it in Meta for Developers → App settings → Basic. |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | Generate a new Page token in Meta for Developers, update env, redeploy, revoke the old token. |
| `YOUTUBE_API_KEY` (server) | Create a new key, restrict it to **YouTube Data API v3**, update env, redeploy, delete the old key. |
| `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` (public) | Public by design, so restrict it: HTTP referrers = your production/preview domains, API restriction = **Google Picker API** (and Drive API if required). |
| `NEXT_PUBLIC_FIREBASE_API_KEY` (public) | Not a secret, but restrict by HTTP referrer in Cloud Console. Security comes from `firestore.rules`. |

## 4. Drive OAuth nonce cookie

`sl_drive_nonce` is set by `/api/drive/auth/state`: `httpOnly`, `secure`, `SameSite=Lax`, path `/api/drive/auth`, 10-minute lifetime. The callback must receive the same nonce that is embedded in the signed `state`; this prevents a stolen or replayed `state` from linking someone else's Drive. The cookie is cleared by the callback.

## 4b. Google Workspace OAuth nonce cookie

`sl_google_nonce` works exactly like `sl_drive_nonce` (Section 4) for `/api/google/auth/*`. The Workspace `state` is signed with `GOOGLE_WORKSPACE_OAUTH_STATE_SECRET` and the HMAC input is domain-separated with a `workspace.v1|` prefix, so a Drive state can never be replayed as a Workspace state (or vice versa) even if the two secrets were ever the same value.

## 5. Rate limiting caveat

`checkRateLimit` (`src/lib/server/rateLimit.ts`) stores counters in each serverless instance's memory. The effective limit is roughly `limit × running instances`, and counters reset on cold start. It stops casual abuse, not a determined attacker. Use a shared store (for example Upstash Redis) if you need a hard global limit.

## 6. Content-Security-Policy

`next.config.js` sends the CSP as **Report-Only** until `CSP_MODE=enforce` is set at build time. See `docs/deploy.md` for the switch-over checklist.

## 7. If secrets leaked

1. **Rotate first**, in this order: Firebase Admin key, `AI_CONNECTION_ENCRYPTION_KEY` (section 1), `DRIVE_URL_SIGNING_SECRET`, `GOOGLE_SYNC_SIGNING_SECRET`, `GOOGLE_DRIVE_OAUTH_STATE_SECRET`, `GOOGLE_WORKSPACE_OAUTH_STATE_SECRET`, Google OAuth client secrets, API keys/tokens (YouTube, Facebook).
2. If encrypted credentials or the encryption key could have leaked: ask users to remove and re-add AI keys, and revoke Drive access at https://myaccount.google.com/permissions (delete the app's `driveConnections` and `googleConnections` docs if needed).
3. Review Firestore usage (Console → Usage) and Cloud Audit Logs for unusual reads or writes; check AI provider dashboards for unexpected spend.
4. Remove the leaked file from git **history** (for example `git filter-repo`), not just the latest commit. Rotating is still required, because the old values stay valid until you change them.
5. Confirm `.gitignore` covers `.env*` (except `.env.example`).


## 2c. Plan tokens, one-time use and server-only data (Google sync)

- **Signing.** A plan token is `base64url(payload).HMAC`, signed over the prefix `sync-plan.v1|` with
  `GOOGLE_SYNC_SIGNING_SECRET` (fallback `DRIVE_URL_SIGNING_SECRET`). The payload holds the user id, a scope
  (`calendar`, `tasks`, `docs_append`, `sheets_append`, `remove`), the item ids with fingerprints, an expiry (15 min)
  and a random `jti`. A token for one user or scope is rejected for another.
- **One-time.** Apply claims the `jti` in a Firestore transaction (`googleUsedTokens/{jti}`) before any write; a second
  use returns 409. Spent docs are pruned after they expire.
- **Re-check at apply.** Apply re-reads current data, recomputes the plan and compares each item's fingerprint; a
  changed item is reported as stale and not written. Content sent to Google is built on the server.
- **Removal** additionally needs the exact `confirmCount`; a mismatch returns 409 with the fresh count and writes nothing.
  Only ids from the user's own mapping docs, for one connection and its stored calendar/list, can be deleted.
- **Server-only collections** (client read/write denied): `googleConnections`, `googleSync`, `googleSyncLog`,
  `googleIgnored`, `googleUsedTokens`.

## Blob-store allowlist (D15, updated by roadmap P5/P6)

- Kinds: `annotations`, `doctext`, `transcript`, `backup`, `summary`, `note`. File names must match `^(annotations|doctext|transcript|backup|summary|note)-[A-Za-z0-9_-]{1,80}\.json$`, parent = the stored "Study Lamp data" folder id, size caps per kind (summary/note 1 MB).
- `summary`/`note` were added in P5 so text over 20 KB can leave Firestore; the allowlist is otherwise unchanged.
- Cleanup (P6) runs only through `/api/storage/*`, requires `confirm: true`, deletes at most 400 documents per call and never touches Drive files.
