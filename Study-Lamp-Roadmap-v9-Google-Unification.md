# Study Lamp — Roadmap v9 (One Google Connection: Drive + Workspace)

Companion to v8. v8 stays valid for free-tier work (P1 to P6), smoothness (S1 to S4) and features (F1 to F8). v9 only covers **merging Google Drive into Google Workspace**, the **Picker tabs**, the **env keys** and the **redirect URIs**.

No code was changed to produce this file. Everything below was read from the uploaded zip. Nothing was run (no `tsc`, no tests, no browser), so every **(verify)** item must be checked on a throwaway Google account.

---

## 1. Your five questions, answered

### Q1. Do I need a separate Google Drive page? Can it move into Google Workspace?

**Yes, merge them in the UI. It is the better decision.** Drive is just one Google service next to Calendar and Tasks, and today the user sees two settings pages, two "Connect" buttons and two Google consent screens for the same Google account.

What the code does today:

| Part | Drive | Workspace |
|---|---|---|
| Settings page | `/settings/drive` (212 lines) | `/settings/google` (269 lines) |
| Sidebar | "Google Drive" | "Google Workspace" |
| OAuth callback | `/api/drive/auth/callback` | `/api/google/auth/callback` |
| Firestore connection | `users/{uid}/driveConnections/{id}` | `users/{uid}/googleConnections/{id}` |
| Scopes | `drive.file` + `userinfo.email` | `calendar.app.created`, `tasks`, `userinfo.email` |
| Env keys | `GOOGLE_DRIVE_*` | `GOOGLE_WORKSPACE_*` |
| State signing | no prefix | `workspace.v1|` prefix |

So there are really **two separate connections**. A merge has two levels:

- **Level 1 (UI only, safe, do now):** one page "Google" with cards Drive, Calendar, Tasks. Backend stays as it is. No data migration. Steps G1 to G4.
- **Level 2 (backend, optional, later):** one connection document, one callback, incremental consent. Needs a data migration. Step G5.

Recommendation: do Level 1 now. Do Level 2 only after Level 1 is stable, because it touches stored tokens, `driveConnectionId` on documents and the blob store pointers.

### Q2. Do I still need the Drive key values in `.env.local`?

**Short answer: you can use one Google OAuth client, but the code still reads both sets of names, so do not delete `GOOGLE_DRIVE_*` yet.**

Findings:

| Variable | Used by | Verdict |
|---|---|---|
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET` | Drive OAuth flow, token refresh, and the Picker App ID (derived from the digits in the client id) | **Keep until G5.** Can hold the same values as the Workspace pair. |
| `GOOGLE_DRIVE_OAUTH_STATE_SECRET` | signs Drive OAuth state | Keep until G5. |
| `GOOGLE_WORKSPACE_CLIENT_ID`, `..._SECRET`, `..._OAUTH_STATE_SECRET` | Workspace flow | Keep. |
| `NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID` | **Nothing in `src/`.** Only a comment, `.env.example` and `docs/deploy.md` mention it. | **Safe to remove** (step G2). |
| `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` | Picker | **Keep.** Browser API key restricted to the Picker API and your two site origins. |
| `DRIVE_URL_SIGNING_SECRET` | signed stream and thumbnail URLs | Keep. Not an OAuth value, name is just historic. |
| `GOOGLE_SYNC_SIGNING_SECRET` | plan tokens | Keep (must differ from the URL secret). |

Important detail: the Picker App ID is taken from `GOOGLE_DRIVE_CLIENT_ID`. The Picker API key and that client must be in the **same Google Cloud project**.

Because you already created one client called "Google Workspace Client" with all four redirect URIs, the simplest working setup today is: put **the same client id and secret** in both pairs. The two state secrets should stay **different**.

### Q3. The Picker shows only one "Google Drive" tab. I want PDF, Docs, Sheets, Videos and Google Drive.

**Cause (in `src/components/drive/DrivePickerButton.tsx`):** all wanted types are joined into one comma-separated MIME filter on a single `DocsView`. One view = one tab. The tab name comes from the view, so it says "Google Drive".

Second cause: `QuickAddVideoDialog` does not pass `kinds`, and `DriveImportPanel` defaults to `["video"]` when folders are allowed, so the video dialog can only ever show one tab.

**Fix (step G1):** one view per type. Google's built-in view ids give each tab its own name automatically **(verify names in your account)**:

| Tab | View |
|---|---|
| Videos | `ViewId.DOCS_VIDEOS` |
| PDFs | `ViewId.PDFS` |
| Google Docs | `ViewId.DOCUMENTS` |
| Google Sheets | `ViewId.SPREADSHEETS` |
| Google Drive (Word, Excel, everything allowed) | `ViewId.DOCS` with a MIME filter |

Limit that stays: with the narrow `drive.file` scope, the Picker lists files, but the app only gets access to files the user selects. That is by design. Do not widen the scope.

### Q4. Do I need separate redirect URIs for Drive?

**Yes, as long as two callback routes exist.** Google compares the redirect URI exactly. Your four URIs match the current code:

1. `http://localhost:3000/api/drive/auth/callback`
2. `https://studylamp.vercel.app/api/drive/auth/callback`
3. `http://localhost:3000/api/google/auth/callback`
4. `https://studylamp.vercel.app/api/google/auth/callback`

After step G5 (one callback) you need only two: the `/api/google/auth/callback` pair. Do not remove the `/api/drive/...` pair until G5 is deployed and tested.

Notes:
- Vercel preview deployments have changing domains. They cannot be added to the list. Test OAuth on `localhost` or the production domain only.
- The Drive route builds the redirect from the request origin. Keep `NEXT_PUBLIC_APP_URL` equal to your production domain **(verify the Workspace route uses the same rule)**.

### Q5. Is my client setup right?

Your client is right for the **current** code. Small fixes:

- The client name has a typo: "Google Workspance Client". Rename it (cosmetic).
- **Authorized JavaScript origins** should list `http://localhost:3000` and `https://studylamp.vercel.app` **(verify)**.
- The **Picker API key** must be restricted to HTTP referrers `localhost:3000/*` and `studylamp.vercel.app/*`, and to the Picker API.
- **APIs to enable** in the same project: Drive, Picker, Docs, Sheets, Calendar, Tasks.
- **OAuth consent screen scopes** must include all of: `drive.file`, `calendar.app.created`, `tasks`, `userinfo.email`. `docs/google-workspace.md` currently lists only the last three.
- In **Testing** status, refresh tokens expire after 7 days. That is the most likely reason users see "Needs reconnect".

---

## 2. Where to improve (found in the code)

| # | Finding | Why it matters | Step |
|---|---|---|---|
| 1 | Two parallel connection systems (`driveConnections`, `googleConnections`), two settings pages, two consent screens | Confusing; users reconnect twice | G3, G5 |
| 2 | Picker: one `DocsView` with joined MIME types gives one tab | Not what you want | G1 |
| 3 | `QuickAddVideoDialog` offers only videos | No PDF/Docs/Sheets tab there | G1 |
| 4 | `NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID` is not used anywhere | Dead config, confusing | G2 |
| 5 | Drive OAuth state has no domain-separation prefix (Workspace has `workspace.v1|`) | Must be fixed before the two flows can share a secret | G5 |
| 6 | `docs/google-workspace.md` says the clients are separate and names "Study Lamp Workspace"; scope list lacks `drive.file` | Stale docs | G6 |
| 7 | `.env.example` says Drive credentials "are rotated every 90 days" | Misleading; Google client secrets do not rotate by themselves **(verify)** | G2 |
| 8 | `.env.local` is inside the zip | Secrets can leak when the zip is shared | G0 |
| 9 | `googleOAuth.ts` starts with a BOM and uses `err: any` | Breaks the "no `as any` on boundaries" rule | G6 |
| 10 | Links such as "Reconnect Google Drive" point to `/settings/drive` in six places | Must be changed with the merge | G4 |
| 11 | The v8 roadmap lists steps as open that the code seems to have already (for example `driveBlobStore.ts`, `googleTasks.ts`, `googleSyncRemoval.ts` exist) | The roadmap status table is stale | G0 |

---

## 3. Decisions (FINAL for v9)

- **D17 (v9)** One Google OAuth client for the whole app. Same client id and secret for Drive and Workspace.
- **D18 (v9)** The user sees one page: **Settings → Google**. Drive, Calendar and Tasks are cards on it. `/settings/drive` redirects there.
- **D19 (v9)** Scopes stay narrow: `drive.file`, `calendar.app.created`, `tasks`, `userinfo.email`. Never add `drive`, `drive.readonly` or `drive.appdata`.
- **D20 (v9)** Level 2 (one connection document) is optional and only starts after G1 to G4 are merged and tested.
- Everything from v8 stays: preview, confirm, apply for every write to Google content; free-tier rules; D15 for the blob store.

---

## 4. Steps at a glance

| Step | Title | Type | Risk | Depends on |
|---|---|---|---|---|
| G0 | Audit and secrets check | manual | none | none |
| G1 | Picker tabs | code | low | none |
| G2 | One OAuth client in config and docs | code + config | low | G0 |
| G3 | One "Google" settings page | code | medium | G2 |
| G4 | Links, copy and redirects | code | low | G3 |
| G5 | One connection and one callback (optional) | code + migration | high | G1 to G4 |
| G6 | Tests, docs, hygiene | code | low | G3 |
| G7 | Remove the old Drive routes | code | medium | G5 in production for a while |

**Order:** G0 → G1 → G2 → G3 → G4 → G6 → (later) G5 → G7.
**Parallel-safe:** G1 can run alone at any time.

---

## 5. Global Rules block (short version)

Paste once per session. Use the full v8 block if you have it. This short block is enough for v9.

```
You are working in the existing Next.js 14 (App Router) project Study Lamp (Firebase Auth + Firestore on the
FREE Spark plan, Tailwind, Radix UI, sonner). Source is under src/. Server code is in src/lib/server/ and uses
the Firebase ADMIN SDK only. API routes authenticate with a Firebase ID token and use withAuthedRoute.
Google APIs are called with plain fetch (no googleapis package).

FINAL decisions:
- Drive keeps the drive.file scope. Calendar uses calendar.app.created. Tasks uses tasks. Never widen scopes.
- Every write to the user's Google content is previewed and confirmed. Nothing is deleted automatically.
- Study Lamp's own "Study Lamp data" Drive blob files follow decision D15.
- One Google OAuth client is used for Drive and Workspace.
- Firestore stays free-tier friendly: documents under 20 KB, every list has limit().

Rules:
1. READ FIRST. Open every file under "Read first". Never invent paths or APIs. Search the repo and say so
   when something is missing.
2. Smallest change that satisfies the task. No unrelated refactors or reformatting.
3. Never use the client Firebase SDK inside src/app/api/** or src/lib/server/**.
4. Never print, log or commit secrets or tokens. Never log Google response bodies. Use logServerError(label, err).
5. Every route authenticates BEFORE touching data, validates input, returns generic error messages.
6. A failed call is never shown as success.
7. No `as any` on request, response or Google-API boundaries.
8. Keep old behaviour working until a step says to remove it. No data is deleted by a migration before a
   read-back check passes.
9. Add unit tests for pure logic. Run `npx tsc --noEmit`, `npm run lint`, `npm test`. Report the real output.
   If something cannot be run, say so.
10. Anything marked (verify) depends on live Google behaviour. Test it with a throwaway account, report status
    codes only.
11. End with: files changed / manual test steps / read-write cost / anything unsure / real command output.
```

---

# PART A — Level 1: one experience, no backend risk

## STEP G0 — Audit and secrets check (manual, no code)

**Do this first. About 30 minutes.**

Checklist:

1. **Google Cloud Console → APIs & Services → Credentials**
   - [ ] Only one OAuth client "Google Workspace Client" is used (rename the typo "Workspance").
   - [ ] Authorized redirect URIs are exactly the four in section 1, Q4.
   - [ ] Authorized JavaScript origins: `http://localhost:3000`, `https://studylamp.vercel.app` **(verify)**.
   - [ ] The Picker API key is restricted: referrers `localhost:3000/*`, `studylamp.vercel.app/*`; API restriction = Picker API (add Drive API only if Google asks).
   - [ ] The key and the OAuth client are in the **same project** (the Picker App ID is the project number inside the client id).
2. **APIs & Services → Library:** Drive, Picker, Docs, Sheets, Calendar, Tasks are enabled.
3. **OAuth consent screen:** scopes `drive.file`, `calendar.app.created`, `tasks`, `userinfo.email` are listed. Note the publishing status (Testing = 7-day refresh tokens).
4. **Secrets:** `.env.local` was inside the zip you uploaded. If that zip was shared anywhere (chat, email, cloud link), rotate: Google client secret, Firebase Admin private key, the AI encryption key (use the re-encrypt script), the signing secrets, YouTube key and Facebook secret. Exclude `.env.local` and `node_modules` from future zips.
5. **Env values:** check that `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_WORKSPACE_CLIENT_ID` are the same string, and likewise the two secrets. The two `*_OAUTH_STATE_SECRET` values must differ.
6. **Vercel:** the same variables exist in Project Settings → Environment Variables for Production.
7. **Status check of v8:** run `npx tsc --noEmit`, `npm test`, `npm run lint` and write down the result. The v8 table seems out of date (see finding 11).

**Test:** you can connect Drive and Workspace on production with the same client without "redirect_uri_mismatch".

---

## STEP G1 — Picker tabs (PDF, Docs, Sheets, Videos, Google Drive)

**Fixes:** finding 2 and 3. **Depends on:** none. **Firestore cost:** 0.

```
TASK G1 — build one Picker view (tab) per file type.
Read first: src/components/drive/DrivePickerButton.tsx, src/components/drive/DriveImportPanel.tsx,
src/lib/driveMime.ts (+ driveMime.test.ts), src/components/video/QuickAddVideoDialog.tsx,
src/app/study-materials/page.tsx (find importOptions), src/lib/driveClient.ts (getDrivePickerAuth).

0. DIAGNOSTIC FIRST (throwaway account, browser console, no code committed): confirm that
   google.picker.ViewId contains DOCS_VIDEOS, PDFS, DOCUMENTS, SPREADSHEETS, DOCS and print the tab labels
   Google shows. Report the labels. If a ViewId is missing, use DocsView(ViewId.DOCS) with setMimeTypes and
   tell me the tab would then be called "Google Drive".
1. In driveMime.ts add a pure function
   buildPickerViewSpecs(kinds: DrivePickerKind[]): PickerViewSpec[]
   where PickerViewSpec = { viewId: "DOCS_VIDEOS" | "PDFS" | "DOCUMENTS" | "SPREADSHEETS" | "DOCS";
   mimeTypes?: string[]; label: string }.
   Mapping:
     video  -> DOCS_VIDEOS
     pdf    -> PDFS
     gdoc   -> DOCUMENTS
     gsheet -> SPREADSHEETS
     docx, xlsx, pptx -> ONE combined DOCS view with mimeTypes = those kinds (label "Google Drive")
   Order: video, pdf, gdoc, gsheet, then the combined view. No duplicates. Empty input returns one DOCS view
   with no filter. Keep buildPickerMimeTypes for existing callers.
2. DrivePickerButton: replace the two hand-built views with a loop over buildPickerViewSpecs. Each DocsView gets
   setIncludeFolders(allowFolders) and setSelectFolderEnabled(allowFolders). The video view keeps folders on only
   when allowFolders is true. Title text depends on the kinds (video / document / both). Remove the duplicated
   `any` casts where a small local type is enough.
3. Defaults (so every dialog shows the useful tabs):
   - DriveImportPanel default kinds when `kinds` is undefined: allowFolders true -> ["video"] stays (video dialog),
     allowFolders false -> ["pdf","gdoc","gsheet","docx","xlsx"] (no pptx tab; PowerPoint is out of scope, but
     keep "pptx" in the type so existing preview-through-Drive code still compiles).
   - Study materials page: importOptions.kinds must include pdf, gdoc, gsheet, docx, xlsx for the "All" tab; each
     of its own tabs (Word, Excel, PDF) passes only its kinds, plus gdoc for Word and gsheet for Excel.
   - QuickAddVideoDialog keeps videos only (that dialog is for videos).
4. openFolderChildrenPicker keeps working (one view, parent folder).
5. Tests (pure): buildPickerViewSpecs returns the right order for every combination, no duplicates, empty input
   returns a single unfiltered view, docx+xlsx merge into one view, pptx never produces its own tab.
```

**Test (throwaway account):** open "Add a study material" → the Picker shows tabs **Videos, PDFs, Google Docs, Google Sheets, Google Drive** (labels as Google names them). Pick a PDF, a Google Doc and a Google Sheet in one go → all three import. In the video dialog only the video tab appears.

---

## STEP G2 — One OAuth client in config and docs

**Fixes:** finding 4 and 7. **Depends on:** G0. **Cost:** 0.

```
TASK G2 — make "one Google OAuth client" the documented and supported setup, without breaking existing env files.
Read first: src/lib/server/googleDrive.ts (env(), isDriveConfigured, driveClient), src/lib/server/googleWorkspaceAuth.ts
(workspaceClient, isWorkspaceConfigured), src/app/api/drive/access-token/route.ts, .env.example, docs/deploy.md,
docs/google-workspace.md, src/lib/server/googleOAuth.ts.

1. Create src/lib/server/googleClientConfig.ts (server only, no logging of values):
   getGoogleClient(flow: "drive" | "workspace"): { clientId, clientSecret } with this lookup order:
     GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  ->  flow-specific old names (GOOGLE_DRIVE_* or GOOGLE_WORKSPACE_*).
   Returns null when nothing is configured. Pure and unit-tested with an injected env object
   (new names win; old names still work; partial pairs return null; whitespace is trimmed).
2. googleDrive.ts and googleWorkspaceAuth.ts use getGoogleClient. isDriveConfigured / isWorkspaceConfigured use it
   too. The state secrets stay separate for now (GOOGLE_DRIVE_OAUTH_STATE_SECRET, GOOGLE_WORKSPACE_OAUTH_STATE_SECRET).
3. access-token route: derive the Picker appId from getGoogleClient("drive").clientId (same regex as today).
4. Remove NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID from .env.example, docs/deploy.md and the comment in googleDrive.ts
   (it is unused). Do NOT touch .env.local; tell me to delete that line myself.
5. .env.example: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as the recommended pair, mark the old pairs
   "legacy, still read", and replace the sentence about "rotated every 90 days" with a note that the client secret
   only changes when you rotate it in Google Cloud Console.
6. docs/google-workspace.md and docs/deploy.md: describe ONE client named "Study Lamp Google Client", list the four
   redirect URIs and the four scopes, and the APIs to enable (Drive, Picker, Docs, Sheets, Calendar, Tasks).
7. Do not change scopes, routes or stored data.
```

**Test:** with only the old env names the app works as before; with only `GOOGLE_CLIENT_ID/SECRET` both connect flows work; unit tests cover the lookup order.

---

## STEP G3 — One "Google" settings page

**Fixes:** finding 1 (UI level). **Depends on:** G2. **Cost:** 0 extra reads (same calls as the two old pages).

```
TASK G3 — merge the two settings pages into one page with three cards.
Read first: src/app/settings/drive/page.tsx, src/app/settings/google/page.tsx, src/components/layout/Sidebar.tsx,
src/components/sync/DisconnectGoogleDialog.tsx, src/lib/driveClient.ts, src/lib/googleClient.ts,
src/app/api/drive/connections/route.ts, src/app/api/google/connections/route.ts, src/app/api/drive/auth/callback/route.ts,
src/app/api/google/auth/callback/route.ts.

1. Move the content of both pages into reusable components, keeping their logic unchanged:
   src/components/google/DriveCard.tsx (from settings/drive), CalendarCard.tsx and TasksCard.tsx (from settings/google).
   Do NOT rewrite the logic; move it and import it.
2. Make /settings/google the single page. Layout: a short intro ("Study Lamp uses your Google account for Drive,
   Calendar and Tasks. Connect only what you need."), then the cards in this order: Google Drive (import, upload,
   backup), Google Calendar, Google Tasks. Each card shows its own status, its own Connect / Reconnect / Disconnect
   and its own "What Study Lamp can access" text (Drive: only files you pick or Study Lamp creates; Calendar: only the
   calendar Study Lamp creates; Tasks: ALL your task lists, limited by Study Lamp's own code to its list).
3. The Drive flow keeps using /api/drive/auth/* and the Workspace flow keeps using /api/google/auth/* in this step.
   Only the return URL changes: both callbacks redirect to /settings/google (with ?tab=drive or the existing
   ?connected / ?missing parameters). Make sure the existing query-parameter messages still show on the right card.
4. /settings/drive becomes a server redirect to /settings/google#drive (keep old bookmarks working).
5. Sidebar: ONE entry "Google" (keep the CalendarRange icon or use a Google-style icon already in the project).
   Remove the "Google Drive" entry.
6. Mobile: cards stack; no horizontal scroll at 360 px width.
7. Tests: pure helpers (which card is "connected", message mapping from query parameters). Component tests only if
   the project already tests components.
```

**Test:** Settings shows one "Google" page. Connect Drive → returns to the Drive card. Connect Calendar → returns to the Calendar card. Opening `/settings/drive` lands on `/settings/google#drive`.

---

## STEP G4 — Links, copy and redirects

**Fixes:** finding 10. **Depends on:** G3.

```
TASK G4 — update every link and text that mentions the old Drive settings page.
Read first (all places found by search): src/components/drive/DriveImportPanel.tsx (link to /settings/drive),
src/components/documents/GoogleAppendMenu.tsx, src/components/documents/PdfReader.tsx, src/app/settings/backup/page.tsx,
src/app/settings/ai/page.tsx, src/lib/driveClient.ts (comment), then run: grep -rn "settings/drive" src docs.

1. Replace /settings/drive with /settings/google#drive in app code. Keep the redirect from G3 as the safety net.
2. Change the wording "Reconnect Google Drive" / "Google Drive settings" to "Reconnect Google" / "Google settings"
   where the user would land on the merged page. Keep "Google Drive" when the sentence is about files.
3. Update the redirect target comments in the two callback routes.
4. Do not change any route path or API response.
```

**Test:** `grep -rn "settings/drive" src` shows only the redirect page itself and its test.

---

## STEP G6 — Tests, docs and hygiene

**Fixes:** finding 6 and 9. **Depends on:** G3.

```
TASK G6 — close the small gaps.
Read first: docs/google-workspace.md, docs/deploy.md, docs/security.md, src/lib/server/googleOAuth.ts, .gitattributes.

1. docs/google-workspace.md: rewrite section "Create the OAuth client" for the single client; add a "Picker tabs"
   section; add troubleshooting rows: redirect_uri_mismatch (exact match, scheme, trailing slash), "Picker shows
   nothing" (API key referrer or wrong project number), invalid_grant, 7-day token expiry in Testing mode.
2. docs/security.md: list the four scopes and why each is narrow; say plainly that Tasks is the one wide scope and how
   the code limits it; say that .env.local must never be zipped or committed.
3. googleOAuth.ts: remove the BOM and replace `const err: any` with a small typed error class
   (GoogleOAuthError with `status` and `googleAuthInvalid`). Keep BOTH flag names `googleAuthInvalid` and
   `driveAuthInvalid` working for existing callers. Add a test for the 400/401 flag.
4. Add a unit test that every OAuth redirect path used by the code is documented in docs/deploy.md (read the file in
   the test and compare), so docs cannot drift again.
```

**Test:** `tsc`, `npm test`, `npm run lint` are clean; the docs match your Cloud Console setup.

---

# PART B — Level 2: one connection and one callback (optional, later)

## STEP G5 — One connection document, one callback

**Do this only after G1 to G4 and G6 are merged and the old flow has been stable for a while.** This changes stored data. Take a Firestore export or backup first.

Target model (one document per Google account):

```
users/{uid}/googleConnections/{id} {
  googleEmail, status, createdAt, lastUsedAt,
  refreshToken (encrypted),
  grantedFeatures: { drive: bool, calendar: bool, tasks: bool },   // from the scope string Google returns
  appFolderId?, calendar: {...}, tasks: {...},
  legacyDriveConnectionId?: string                                   // maps the old driveConnections id
}
```

Why it is possible: with one OAuth client, a refresh token issued for `drive.file` can simply be copied. New features are added with `include_granted_scopes=true` (the code already sends it), so the user is asked only for the **new** scope.

```
TASK G5 — unify the connection model WITHOUT breaking existing documents.
Read first: src/lib/server/driveConnections.ts, googleConnections.ts, googleWorkspaceAuth.ts, googleDrive.ts,
googleOAuth.ts, driveBlobPointers.ts, driveBlobStore.ts, driveRequest.ts, driveTokenCache.ts,
src/lib/googleScopes.ts, src/app/api/drive/**, src/app/api/google/auth/**, src/app/api/google/connections/**,
src/types/index.ts (DriveConnection, GoogleConnection*), firestore.rules, every place that stores or reads
`driveConnectionId` (search the repo).

0. DIAGNOSTIC FIRST (throwaway account, status codes only): confirm that (a) a refresh token created by the Drive
   flow keeps working after being copied to another document, and (b) a second consent with
   include_granted_scopes=true returns a scope string containing BOTH the old and the new scope.
   If either fails, STOP and report.
1. Add "drive" to GoogleWorkspaceFeature in src/lib/googleScopes.ts with scope
   https://www.googleapis.com/auth/drive.file. Update scopesForFeatures / featuresFromGrantedScopes /
   missingFeatures and their tests. Do not add any other Drive scope.
2. Domain-separate the states: both flows use a prefix ("drive.v1|", "workspace.v1|") and one secret
   GOOGLE_OAUTH_STATE_SECRET (fallback to the old names). Tests: a Drive state cannot be verified as a Workspace
   state and the reverse.
3. One callback /api/google/auth/callback handles every feature. /api/drive/auth/callback stays as a thin handler for
   consents that were started before the deploy (state older than 10 minutes expires anyway) and redirects.
4. Connection resolver: resolveConnection(uid, id) accepts either a googleConnections id or a legacy
   driveConnections id (via legacyDriveConnectionId) so existing personalDocuments with `driveConnectionId` keep
   opening. Do NOT rewrite documents.
5. Migration route POST /api/google/migrate-drive (explicit button on the Google page, confirm dialog with the count):
   for each driveConnection, find a googleConnection with the same email; if found, set grantedFeatures.drive = true and
   legacyDriveConnectionId, copy the encrypted refresh token ONLY if the existing one lacks drive; else create a new
   googleConnection with the copied token. Move appFolderId. Verify by refreshing an access token and calling
   files.get on the app folder BEFORE marking the old document "migrated". Never delete the old document in this step.
6. Update all Drive server helpers (withDriveAccessToken, getAccessTokenForConnection, blob pointers) to use the
   resolver. Keep their public signatures.
7. Settings: the Drive card now uses the same connection as Calendar and Tasks: "Add Drive access" asks only for the
   Drive scope.
8. Tests (recording fakes, realistic id shapes): resolver with both id kinds; migration idempotent (second run does
   nothing); migration refuses to mark done when the refresh check fails; state separation; partial consent (user
   unticks Drive) leaves grantedFeatures.drive false; no tokens in logs.
```

**Test:** an existing PDF imported before the migration still opens; "Connect Calendar" for an account that already has Drive asks only for Calendar; one Google account shows one connection with three feature switches.

**Cost:** one read per connection and one write per migrated connection. No new per-event data.

---

## STEP G7 — Remove the old Drive routes

**Depends on:** G5 live in production for at least a few weeks, and the migration run on every account.

```
TASK G7 — remove legacy code, carefully.
Read first: everything G5 changed, plus grep -rn "driveConnections" src docs scripts.

1. Confirm in Firestore (read-only script, counts only) that every driveConnections document has a matching
   googleConnections document with legacyDriveConnectionId. If any is missing, STOP.
2. Remove /api/drive/auth/callback and /api/drive/auth/state (keep the other /api/drive/* routes; they are file
   operations, not auth).
3. Remove GOOGLE_DRIVE_* names from the config helper and docs. Keep GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
   GOOGLE_OAUTH_STATE_SECRET.
4. Tell me to remove the two /api/drive/auth/callback redirect URIs from the Google client AFTER the deploy.
5. Keep the old driveConnections documents (do not delete them automatically). Offer an explicit "Clean up old
   Google Drive records" button with a confirm dialog and a count.
```

---

## 6. Definition of done (every step)

1. `npx tsc --noEmit` has zero errors, `npm test` is green, `npm run lint` runs.
2. The manual test in the step passes on a non-production Google account.
3. No scope was widened. No secret was printed or committed.
4. The report lists files changed, real command output, the read/write cost, and anything uncertain.

## 7. Quick summary

- Merge Drive into Google Workspace **in the UI now** (G3, G4). Merge the backend **later and only if you want to** (G5).
- You can use **one OAuth client** today. Keep both env pairs with identical client values until G5. Remove `NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID`.
- The Picker shows one tab because of one joined MIME filter. G1 fixes it with one view per type.
- Keep all four redirect URIs until G5 is live. After G7 you need only two.
- Before anything else: check that `.env.local` was not shared (G0).
