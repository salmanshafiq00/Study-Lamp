# Deploying Study Lamp

## Regions

- Vercel functions: `bom1` (Mumbai), set in `vercel.json`.
- Firestore: `asia-south2` (Delhi), set in `firebase.json`.

Keep them close; each Firestore round trip from a distant region adds latency to every API route.

## Environment variables

Set these in Vercel (Production and Preview). `NEXT_PUBLIC_*` values are embedded in the browser bundle at **build** time.

| Name | Scope | Required |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | public | yes |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | public | yes (also used to build the CSP `frame-src`) |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | public | yes |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | public | yes |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | public | yes |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | public | yes |
| `NEXT_PUBLIC_APP_URL` | public | yes (OAuth redirects) |
| `NEXT_PUBLIC_SEED_ADMIN_EMAILS` | public | yes (keep in sync with `firestore.rules`) |
| `NEXT_PUBLIC_HAS_YT_KEY` | public | optional |
| `NEXT_PUBLIC_FACEBOOK_APP_ID` | public | optional (Facebook embeds) |
| `NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID` | public | yes for Drive |
| `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` | public | yes for Drive |
| `FIREBASE_PROJECT_ID` | server | optional (falls back to the public project ID) |
| `FIREBASE_CLIENT_EMAIL` | server | yes in production |
| `FIREBASE_PRIVATE_KEY` | server | yes in production (keep `\n` escapes) |
| `AI_CONNECTION_ENCRYPTION_KEY` | server | yes |
| `AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS` | server | only during key rotation |
| `GOOGLE_DRIVE_CLIENT_ID` | server | yes for Drive |
| `GOOGLE_DRIVE_CLIENT_SECRET` | server | yes for Drive |
| `GOOGLE_DRIVE_OAUTH_STATE_SECRET` | server | yes for Drive |
| `GOOGLE_WORKSPACE_CLIENT_ID` | server | yes for Calendar/Tasks |
| `GOOGLE_WORKSPACE_CLIENT_SECRET` | server | yes for Calendar/Tasks |
| `GOOGLE_WORKSPACE_OAUTH_STATE_SECRET` | server | yes for Calendar/Tasks |
| `DRIVE_URL_SIGNING_SECRET` | server | yes for Drive playback |
| `GOOGLE_SYNC_SIGNING_SECRET` | server | recommended for Calendar/Tasks/Docs/Sheets sync. Signs plan tokens. If unset, plan tokens fall back to `DRIVE_URL_SIGNING_SECRET` (see `docs/security.md` section 2b) |
| `YOUTUBE_API_KEY` | server | optional |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | server | optional |
| `QUOTA_TIMEZONE` | server | optional (default `Asia/Dhaka`) |
| `DRIVE_TIMING` | server | optional (`1` logs Drive timings) |
| `CSP_MODE` | build-time | optional (`enforce` sends an enforcing CSP) |

## Function duration (`maxDuration`)

Heavy routes declare `export const maxDuration = 60;`:

- AI generation: `ai/summary`, `ai/quiz/generate`, `ai/roadmap/*`, `ai/goals/suggest`, `ai/suggest-category-name`, `documents/[id]/summary|quiz|explain`.
- Drive: `drive/import/file`, `drive/import/files`, `drive/import/folder`, `drive/thumbnails/backfill`, `drive/backup`, `drive/backup/restore`, `drive/stream/[fileId]`.

Vercel caps this by plan, and the cap can change. Check the current limits in the Vercel docs and your plan. If your plan allows less than 60 s, lower the value in each file, or large imports and AI calls will be cut off.

## Content-Security-Policy

`next.config.js` ships `Content-Security-Policy-Report-Only`: violations appear in the browser console (DevTools → Console, "Content Security Policy" messages) and nothing is blocked. No report endpoint is configured.

Before enforcing, test each of these with the console open and fix or allow any violation (edit the lists in `next.config.js`):

1. Login (Google popup), logout.
2. Dashboard, playlists, favorites, watch-later.
3. YouTube, Facebook and Vimeo playback.
4. Drive connect, Picker, import, Drive video playback and seek.
5. PDF, Word and Excel readers (PDFium worker and wasm, docx iframe).
6. Roadmap, onboarding, settings, AI generation.

After a clean week: set `CSP_MODE=enforce` in Vercel, redeploy, and recheck the same list. To roll back, remove the variable and redeploy.

## PDFium wasm

`public/wasm/pdfium.wasm` is self-hosted. `scripts/syncPdfiumWasm.cjs` runs before `npm run dev` and `npm run build` and copies the file from the installed `@embedpdf/pdfium` package, so it can never drift from the library (a mismatch makes the viewer fail silently). `PdfReader` loads it through an **absolute** URL with `?v=<engine version>`; a relative URL does not work because EmbedPDF's engine runs in a `blob:` worker. The file is served as `application/wasm` with a one-year immutable cache, which is safe because the version is in the URL. Keep `@embedpdf/react-pdf-viewer` pinned to an exact version.

## Thumbnail backfill

`POST /api/drive/thumbnails/backfill` (Bearer Firebase ID token, signed-in user only) processes one batch for the **calling user** and returns `{ processed, remaining }`. Repeat the call until `remaining` is 0. The easiest way is the thumbnail refresh action in **Settings → Drive** (`src/app/settings/drive/page.tsx`), which loops over batches for you. Each user runs it for their own library.

## Rate limiting

`checkRateLimit` (src/lib/server/rateLimit.ts) keeps its counters in each serverless instance's memory, so the real limit is roughly the configured limit × the number of running instances, and it resets on a cold start; use Upstash Redis (or another shared store) as the upgrade path when you need a hard, global limit.

## The `xlsx` dependency (restricted networks)

`package.json` installs SheetJS from a tarball URL, not from the npm registry:
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. A build machine that can only reach the npm registry
will fail at `npm install` with a fetch error for `cdn.sheetjs.com`. Options:

1. Allow `cdn.sheetjs.com` on the build network, or
2. Download the tarball once, commit it (for example `vendor/xlsx-0.20.3.tgz`) and change the dependency to
   `"xlsx": "file:vendor/xlsx-0.20.3.tgz"`, or
3. Point your registry mirror at the tarball and keep the URL unchanged.

Type errors such as "Cannot find module 'xlsx'" and "Parameter 'name' implicitly has an 'any' type" in
`documentText.ts` / `documentViewerUtils.ts` are a symptom of this missing install, not of a code problem.


## Google APIs to enable (Calendar, Tasks, Docs, Sheets)

In the Google Cloud project: **APIs & Services -> Library** and enable **Google Calendar API**, **Google Tasks API**,
**Google Docs API** and **Google Sheets API** (plus Drive API for Drive). Calendar and Tasks use the Workspace OAuth
client; Docs and Sheets write-back uses the Drive connection (`drive.file`). See `docs/google-workspace.md`.
