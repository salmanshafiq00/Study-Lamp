# Study Lamp — Roadmap v8 (Free-Tier First, Google Smooth, Then Features)

Supersedes v7. Goals, in priority order:

1. **Stay on the Firebase free (Spark) plan for a long time.** Large data lives in the user's Google Drive, not in Firestore.
2. **Make every Google feature (Drive, Docs, Sheets, Calendar, Tasks, PDF, Excel, Word, video) fast, smooth and secure.**
3. Finish the unfinished v7 work, then build the features.

Any model can follow this file: every step has a prompt you can paste, a "Read first" list, exact acceptance tests, and a free-tier cost note.

---

## 0. How to use this file

1. Paste the **Global Rules block** (section 5) once per session.
2. Paste **one step prompt** at a time, in the recommended order (section 4).
3. A step is finished only when its **Test** passes and `tsc`, `npm test` and `npm run lint` are clean (section 12).
4. If a path in "Read first" does not exist, search the repo and say so. Never invent paths or APIs.
5. Anything marked **(verify)** depends on live Google or Firebase behaviour that could not be checked offline. Test it with a throwaway account first and report status codes only.

---

## 1. Status snapshot

### 1.1 Done and verified (this session)

| Item | What was done | Verified how |
|---|---|---|
| PDF never showed (skeleton forever) | Absolute versioned `wasmUrl`; PDF downloaded by our code in parallel with engine start-up; open only after listeners exist; engine-file check; slow-load fallback buttons; 300 MB cap | Read EmbedPDF 2.15.1 source; `tsc` clean; 8 new unit tests pass. **Not run in a browser** |
| Drive stream route | Abort upstream on client disconnect; specific error codes (permission / not found / reconnect); no wrong `Content-Length`; pass-through 416 | `tsc`, review |
| Drive video | Renew expired 6 h link once and resume at same second; no restart when the auth object changes; `preload="metadata"` | `tsc`, review |
| Word and Excel readers | Cancel in-flight download on leave | `tsc` |
| Build safety | `scripts/syncPdfiumWasm.cjs` before `dev` and `build`; wasm version in URL; viewer pinned to `2.15.1`; deploy doc updated | script run, hash equal |

Root cause found: EmbedPDF's engine runs in a `blob:` worker where the relative `/wasm/pdfium.wasm` cannot be fetched. The worker posts `wasmError`, which the library never handles, so there is no error and no PDF. EmbedPDF 2.15.1 also ignores `mode: "range-request"` (it always downloads the whole file, and only after the engine is ready).

### 1.2 Not re-audited this session

The v7 audit numbers (27 complete / 21 partial / 33 not started of 84 instructions) and bugs B1 to B27 are carried over unchanged. Re-run `npx tsc --noEmit` first: B1 reported 5 type errors, but the zip received this session type-checked clean, so Z0 may already be partly done.

---

## 2. Product decisions that are FINAL

Unchanged from v7:

- No PowerPoint tab, viewer or outline route. (PPTX can still be imported and previewed through Drive.)
- AI language is `en` | `bn` only.
- Drive keeps the narrow `drive.file` scope. **Never widen it.** (The hidden `appDataFolder` needs the separate `drive.appdata` scope, so it is NOT used. See D15.)
- Google integration is two-way but never silent. Every write to the user's Google content, in either direction, is previewed and confirmed. Nothing is deleted automatically. Confirmation is enforced on the server.
- **D13** A step is "done" only when its test passes against realistic data (real Google id shapes, not `goal:<id>`).
- **D14** Hotfix first: the Docs/Sheets append apply routes return 503 until step Z2 is done.

New in v8:

- **D15 — Study Lamp's own storage files are exempt from the preview rule.** Files Study Lamp itself creates inside its own Drive folder ("Study Lamp data", created with `drive.file`) are internal storage, not the user's content. Writing them does not need a confirmation dialog, but is restricted by a server allowlist (parent folder id equals the stored folder id, name matches `^(annotations|doctext|transcript|backup)-[A-Za-z0-9_-]{1,80}\.json$`, size cap). Writes to any other Drive, Docs, Sheets, Calendar or Tasks item still need preview, confirm and apply. **Product owner: confirm this decision before step P4.**
- **D16 — Firestore holds small, queryable data only.** Rule of thumb: a Firestore document stays under **20 KB**. Anything larger goes to the Drive blob store (P4). Firestore keeps a pointer plus a short preview.
- **D17 — Every list is bounded.** No `getDocs` without `limit()` on a collection that can grow.
- **D18 — Every step states its read and write cost** (section 11) and must not raise the budget without saying so.

---

## 3. Audit findings (read from the code)

### 3.1 Free-tier findings (new in v8)

| ID | Where | Finding | Fix |
|---|---|---|---|
| **Q1** | `src/lib/firestore/*.ts` (13 files) | `getDocs` is used in 13 files but `limit()` only 2 times. Most lists are unbounded, so reads grow with data. | P2 |
| **Q2** | `src/lib/firestore/users.ts:7` | `getDocs(collection(db, "users"))` reads the **whole users collection** (one read per user, every time). | P2 |
| **Q3** | `src/lib/firestore/quizAttempts.ts:6` | Query orders all attempts with no `limit`. | P2 |
| **Q4** | `src/lib/analytics.ts:20` | Every learning event is its own `addDoc` into `learningEvents`. Unbounded growth in storage, writes and later reads. | P3 |
| **Q5** | `users/{uid}/personalDocuments/{id}/content/*` (`documentContent.ts`) | Extracted document text is stored in Firestore as chunks. Biggest storage hog. | P5 |
| **Q6** | `.../personalDocuments/{id}/annotations/main` | All annotations for a PDF are one JSON string capped at 850 KB (`documentAnnotations.ts`). Hitting it shows "PDF annotations exceed the safe storage limit." and the annotation is lost. | P4 |
| **Q7** | transcripts, summaries, notes, `driveThumbs` | Potentially large text and images in Firestore. Measure first (P1), then move anything over 20 KB. | P1, P5 |
| **Q8** | progress writes (`watchProgress`, `videoStates`, `readerProgress`) | Written often. Must be debounced and written only when changed. | P3 |
| **Q9** | no cleanup tools | Old attempts, events, sync logs, orphan thumbnails and used plan tokens are never removed. | P6 |
| **Q10** | `rateLimit.ts` | The limiter is in memory per serverless instance, so it is weak on Vercel. A Firestore-based limiter would cost writes. Use only if abuse appears. | note in Z6 |

Good news: **no `onSnapshot` listeners exist**, so there is no hidden live-read cost.

### 3.2 Carried over from v7 (still open unless Z0 shows otherwise)

B1 5 type errors (may be fixed) · B2 append apply routes bypass confirmation (hotfix D14) · B3 Calendar connection id mismatch · B4 preview writes to Firestore · B5 planner never matches synced goals · B6 to B12 sync/apply and client defects · B13/B14 Sheets and Docs append defects · B15 sync log never saved · B16 missing Calendar UI · B17 error mapping in Drive export · B18 timed events guessed · B19 10 routes not on `withAuthedRoute` · B20 orphan thumbnails · B21 missing tests · B22 reusable tokens · B23 streak time-zone bug · B24 no ESLint config / line endings · B25 rules gaps · B26 docs · B27 rate-limit test.

---

## 4. Roadmap at a glance

| Step | Title | Fixes | Depends on |
|---|---|---|---|
| **D14** | Hotfix: disable unsafe append routes | B2 | none |
| **Z0** | Green build and honest tests | B1, B24, B27 | none |
| **P1** | Measure Firestore reads/writes/bytes | Q7 | Z0 |
| **Z3** | Finish the confirmation core | B7, B10, B15, B22, B25 | Z0 |
| **Z1** | Repair the Calendar foundation | B3 to B6, B12 | Z0, Z3 |
| **Z2** | Make Docs/Sheets write-back safe | B2, B13, B14 | Z3 |
| **P2** | Bounded and cached reads | Q1 to Q3 | P1 |
| **P3** | Debounced writes, aggregated events | Q4, Q8 | P1 |
| **P4** | Drive blob store + annotations to Drive | Q6 | P1, D15 |
| **P5** | Move large text out of Firestore | Q5, Q7 | P4 |
| **P6** | Storage health and cleanup | Q9, B20 | P2 |
| **Z4** | Finish Calendar two-way sync | B8 to B11, B15, B16, B18 | Z1, Z3 |
| **Z5** | Finish Docs/Sheets import | B17 | Z0 |
| **Z6** | Finish route hygiene | B19, B21 | Z0 |
| **S1** | Excel parsing in a Web Worker | smoothness | none |
| **S2** | Cache downloaded files by revision | smoothness | none |
| **S3** | Prefetch engine and chunks | smoothness | none |
| **S4** | Optional: PDF.js spike | smoothness | S2 |
| **W4** | Tasks two-way sync | new | Z1, Z3, Z4 |
| **W5** | Reconcile, history, removal, docs | B26 | Z4, W4 |
| **F1** | Streak and activity ledger | B23 | P3 |
| **F2** | Today Plan | | F1 |
| **F3** | Flashcards from quiz mistakes | | P4 |
| **F4** | AI study resources | | Z5, P5 |
| **F5** | Backup v2 (to Drive) | | P4, W4 |
| **F6** | Export: Markdown and Anki TSV | | F4 |
| **F7** | Next.js major upgrade | | all features |
| **F8** | PWA | | F7 |

**Recommended order:** D14 → Z0 → P1 → Z3 → Z1 → Z2 → P2 → P3 → P4 → P5 → P6 → Z4 → Z5 → Z6 → S1 → S2 → S3 → W4 → W5 → F1 → F2 → F3 → F4 → F5 → F6 → F7 → F8.

**Parallel-safe:** {Z0, Z5, Z6, S1, S3, P1}. Do not start Z4, W4 or W5 before Z1 and Z3 are merged. Do not start P4 before D15 is confirmed.

---

## 5. Global Rules block (v8) — paste once per session

```
You are working in an existing Next.js 14 (App Router) project called Study Lamp
(Firebase Auth + Firestore on the FREE Spark plan, Tailwind, Radix UI, sonner, driver.js,
Tiptap, EmbedPDF 2.15.1, docx-preview, SheetJS). Source is under src/. Server-only code is in
src/lib/server/ and uses the Firebase ADMIN SDK (adminDb / adminAuth from
src/lib/server/firebase-admin.ts). Client code uses the Firebase CLIENT SDK
(src/lib/firebase.ts). API routes authenticate with `Authorization: Bearer <Firebase ID token>`;
routes use withAuthedRoute (src/lib/server/routeHelpers.ts) with a RATE_LIMITS preset
(src/lib/server/rateLimit.ts). Drive stream/thumbnail routes authenticate with HMAC-signed URLs.
Google APIs are called with plain fetch (no googleapis package).

Product decisions that are FINAL:
- No PowerPoint tab, viewer or outline route.
- AI response language is "en" | "bn" only.
- Drive keeps the drive.file scope. Never widen it. Never use appDataFolder (needs drive.appdata).
- Google integration is two-way, but never silent: every write to the user's Google content, and
  every change to a Study Lamp goal that comes from Google data, is previewed and needs explicit
  user confirmation first. Nothing is deleted on either side automatically.
- Exception D15: files Study Lamp creates in its OWN "Study Lamp data" Drive folder (blob store) may
  be written without a dialog, but only through the allowlisted blob-store functions.
- Firestore stays on the free plan: documents stay under 20 KB, every list query has limit(),
  progress writes are debounced, no onSnapshot on large collections.

Rules:
1. READ FIRST. Open every file listed under "Read first". Never invent paths or APIs; search the
   repo and tell me when something is missing.
2. Smallest change that satisfies the task. No unrelated refactors or reformatting.
3. NEVER use the client Firebase SDK inside src/app/api/** or src/lib/server/**.
4. Never print, log, commit or paste secrets or tokens. Never log or return response bodies from
   Google or AI providers; log status codes and error names only, using logServerError(label, err).
5. Every route authenticates BEFORE touching data, validates every input, and returns generic error
   messages (never error.message from a library or from Google).
6. Any new Firestore collection or field needs explicit rules in firestore.rules. Server-written
   data: client read and write false. Add an index to firestore.indexes.json for any query that
   needs one.
7. Never use `new Date("YYYY-MM-DD")` for goal dates. Use src/lib/isoDate.ts.
8. No broad catch that turns a failure into success. An action is "applied" only after the real
   write returned success. A no-op is "skipped" with a code.
9. Reuse existing UI patterns (src/components/ui/*, sonner, Skeleton).
10. Prefer no new libraries. If one is needed, state version and licence, and pin it exactly.
11. Add unit tests for pure logic. Tests must use the id shapes Google really returns.
12. Run `npx tsc --noEmit`, `npm run lint`, `npm test`. Report honestly. If you cannot run something,
    say so; do not claim it passed.
13. Two-way sync is allowed; silent writes are not (see exception D15). Any write to Google content
    MUST go through preview -> confirm -> apply (signed plan token + per-item fingerprint).
14. Never delete on either side automatically. A delete is its own item with its own confirmation.
15. Preview/plan endpoints perform ZERO writes (Google, goals, AND Firestore mapping or sync-state
    docs). Every integration gets a test with a recording fake proving no write function is called.
16. The apply step must (a) verify the token, (b) re-read CURRENT local and remote state,
    (c) recompute the plan, (d) compare fingerprints, and only then write. Content written to
    Google is built on the server from stored data, never taken from the request body.
17. No `as any` on request, response or Google-API boundaries. Define types.
18. FREE-TIER RULES: (a) every Firestore list uses limit() (default 50) and a cursor; (b) never read
    a whole collection to count it (use getCountFromServer or a stored counter); (c) debounce
    repeated writes (min 30 s, only when the value changed); (d) a document over 20 KB goes to the
    blob store, not Firestore; (e) new data prefers one aggregate document per day/month over one
    document per event; (f) state the expected reads and writes per page load or action in the step
    report.
19. Large downloads are streamed with progress, can be aborted, and are cached by file revision.
20. End with: files changed / manual test steps / read-write cost / anything you were unsure of /
    the actual output of tsc and npm test.
```

---

# PART A — Stabilise

## HOTFIX D14 — Disable unsafe append routes (do today)

```
Make POST /api/drive/docs/append/apply and POST /api/drive/sheets/append/apply return
503 {"error":"Temporarily unavailable"} immediately after authentication, with a comment pointing
to roadmap step Z2. Do not change anything else. Add one test per route proving it returns 503 and
never calls withDriveAccessToken. Leave the preview routes as they are.
```
**Test:** both apply routes return 503; previews still work.

---

## STEP Z0 — Green build and honest tests

**Fixes:** B1, B24, B27. **Depends on:** none.

```
TASK Z0 — make tsc, tests and lint pass, and make them mean something.
Read first: src/lib/server/aiModels.ts, src/lib/server/logError.ts, src/app/api/google/sync/plan/route.ts,
src/lib/server/googleSyncState.ts, src/lib/server/goalSyncPlan.ts (GoalRemoteEvent),
src/lib/server/planToken.ts, src/lib/server/rateLimit.ts + rateLimit.test.ts, package.json, next.config.js.

0. Run `npx tsc --noEmit` first. Fix only errors that still exist.
1. logServerError needs (label, err). Check every call for the same mistake.
2. planToken.ts: after validating `payload.exp` with Number.isInteger, assign to `const exp: number`.
3. GoalRemoteEvent: make `base` and `targetDate` `string | null | undefined` consistently; no `as any`.
4. rateLimit: add `googleApply: { limit: 20 }`, update the test to the full preset list, and make every
   Google route use preset "googleApply" or "googleSync" instead of a custom `scope`.
5. Lint: add .eslintrc.json (extends "next/core-web-vitals") if missing so `npm run lint` is
   non-interactive. Report the warning count; do not fix unrelated ones.
6. Add .gitattributes (`* text=auto eol=lf`) and .editorconfig. Do NOT mass-reformat in this step;
   only report how many files have CRLF or a BOM.
7. Remove the duplicate nativeExportMime: keep src/lib/driveMime.ts and import it in googleDrive.ts.
8. docs/deploy.md: note the xlsx tarball URL (cdn.sheetjs.com) and what to do on a restricted network.
9. The Firebase-env test (thumbnailUrlHandling.test.ts) must skip with a clear message when env vars
   are missing, not fail.
```
**Test:** `tsc` zero errors; `npm test` green; `npm run lint` runs non-interactively.
**Cost:** none.

---

# PART B — Free-tier foundation (new)

Goal: keep Firestore small and cheap before adding more features. Order: measure (P1), bound reads (P2), reduce writes (P3), move big data to Drive (P4, P5), add cleanup (P6).

## STEP P1 — Measure Firestore reads, writes and bytes

**Fixes:** Q7 (find what is big). **Depends on:** Z0.

Free (Spark) limits to stay under, **(verify the current numbers in the Firebase console)**: about 1 GiB stored, 50,000 reads/day, 20,000 writes/day, 20,000 deletes/day. Per-user math: `daily reads = users x sessions x reads per session`.

```
TASK P1 — add a dev-only usage probe and write the baseline into docs/firestore-budget.md.
Read first: src/lib/firebase.ts, every file in src/lib/firestore/, src/lib/analytics.ts,
firestore.rules, src/lib/server/documentContent.ts.

1. Create src/lib/firestore/instrumented.ts that re-exports getDoc, getDocs, setDoc, updateDoc,
   addDoc, deleteDoc, writeBatch from "firebase/firestore" wrapped with counters. Counting rules:
   getDoc = 1 read; getDocs = max(1, snapshot.size) reads; each write/delete = 1.
   Counters exist only when process.env.NODE_ENV !== "production" (production path is a plain
   re-export, zero overhead). Expose `window.__fsUsage()` that console.tables
   {reads, writes, deletes} per top-level collection path and `window.__fsUsageReset()`.
2. Change the imports in src/lib/firestore/*.ts and src/lib/analytics.ts to use the wrapper. No
   behaviour change.
3. Add scripts/firestoreSizes.ts (Admin SDK, run manually with `npx tsx`): for ONE uid given as an
   argument, list each subcollection with document count and approximate bytes
   (JSON.stringify length), and print the 20 largest documents (path + bytes). Never print document
   contents. Read-only.
4. Write docs/firestore-budget.md with a table: page -> reads on load -> writes per minute of
   use. Fill it by loading each main page in dev and calling __fsUsage(): dashboard, videos list,
   a video page (5 minutes watching), study-materials list, a PDF page (5 minutes), goals,
   quizzes, settings.
5. In the same file list the 10 largest document kinds and mark each "keep" (<20 KB) or "move to
   blob store" (>20 KB).
```
**Test:** `window.__fsUsage()` works in dev; the doc exists with real numbers; production bundle contains no counter code.
**Cost:** 0 in production.

---

## STEP P2 — Bounded and cached reads

**Fixes:** Q1, Q2, Q3. **Depends on:** P1.

Target: dashboard at most 60 reads, video page at most 25, document page at most 15, goals at most 20 (adjust after P1 numbers).

```
TASK P2 — make every list bounded and add a small read cache.
Read first: docs/firestore-budget.md, src/lib/firestore/users.ts, quizAttempts.ts, notifications.ts,
playlists.ts, userVideoState.ts, goals.ts, personalDocuments.ts, personalPlaylists.ts, bookmarks.ts,
roadmaps.ts, shares.ts, categoriesTags.ts, and every page that calls them.

1. Create src/lib/readCache.ts (pure, no Firebase import):
   cachedRead<T>(key, ttlMs, loader, now = Date.now) with an in-memory Map, in-flight de-duplication
   (two callers share one promise), and invalidate(prefix). Tests with a fake clock: hit, expiry,
   de-duplication, invalidate by prefix, loader error is not cached.
2. src/lib/firestore/users.ts:7 reads the WHOLE users collection. Find every caller. If it is the
   admin screen: paginate (limit 25 + startAfter cursor) and show totals from getCountFromServer
   (1 read per 1000 index entries) instead of loading every user. If it is anything else, remove it.
3. For every other getDocs on a growing collection, add limit() and a cursor helper:
   quizAttempts (limit 50, "Load more"), notifications (30), bookmarks (100), shares (50),
   learningRoadmaps (50), personalPlaylists/playlists (100), videoStates (needed by dashboard: cache
   for 5 minutes and invalidate on every write to it), categories/tags (cache 10 minutes).
4. Where a page needs a total (for example "12 attempts"), store a counter field on the parent
   document updated in the same write, or use getCountFromServer. Never read all documents to count.
5. Add composite indexes to firestore.indexes.json for each new ordered+limited query.
6. Re-measure with __fsUsage() and update docs/firestore-budget.md (before and after).
```
**Test:** `grep -rn "getDocs(" src/lib/firestore | grep -v "limit("` lists only collections proven small (goals, categories) with a comment saying why; dashboard reads drop versus the P1 baseline.
**Cost:** reads go down. Writes unchanged.

---

## STEP P3 — Debounced writes and aggregated events

**Fixes:** Q4, Q8. **Depends on:** P1.

```
TASK P3 — cut write volume.
Read first: src/lib/watchProgress.ts (+ test), src/lib/analytics.ts, src/hooks/useDocumentProgress.ts,
src/app/video/[videoId]/page.tsx, src/app/playlists/[playlistId]/[videoId]/page.tsx,
src/lib/firestore/userVideoState.ts, src/lib/firestore/personalDocuments.ts, firestore.rules.

1. Progress writes (video, PDF, Word, Excel): one shared helper src/lib/persistThrottle.ts with
   createPersister({ minIntervalMs: 60_000, minDelta, equals, write }). It writes at most once per
   interval, only if the value changed by at least minDelta (video 10 s, PDF 1 page or 5% zoom,
   Excel 1 sheet or 20 rows), and exposes flush() for pause/end/visibilitychange/pagehide.
   Pure and fully unit-tested with a fake clock (changed vs unchanged, interval, flush, write error
   keeps the pending value).
2. Replace per-event addDoc in analytics.ts with an in-memory queue flushed at most every 60 s into
   ONE aggregate document per day: users/{uid}/learningDays/{yyyy-MM-dd} using the user's LOCAL date
   from src/lib/isoDate.ts and increment() fields, for example
   {watchSeconds, docMinutes, quizzes, events, updatedAt}. One write replaces many.
3. Keep reading the old learningEvents only for dates before the cut-over day; stop writing to it.
   Add firestore.rules for learningDays (owner read, owner write with a size and key allowlist).
4. Every `updateDoc` of a document that already holds the same value must be skipped. Add a tiny
   `changed(prev, next)` check where the code already has the previous value.
5. Re-measure: a 5-minute video session should cost at most 6 writes, a 5-minute PDF session at
   most 6.
```
**Test:** unit tests for `createPersister` and the queue; measured writes per 5 minutes drop to the stated target; closing the tab flushes once.
**Cost:** writes drop sharply (events become about 1 write/min of activity).

---

## STEP P4 — Drive blob store and annotations on Drive

**Fixes:** Q6. **Depends on:** P1 and **decision D15 confirmed**.

How it works:
- A normal folder named "Study Lamp data" is created in the user's Drive with the existing `drive.file` scope (files the app creates are accessible to the app). No scope change.
- Each blob is one small JSON file in that folder. Firestore keeps only a pointer.
- The browser keeps a local copy in IndexedDB so reads are instant and edits are saved after a short delay.

Data model:
- `users/{uid}/blobs/{kind}__{key}` → `{ fileId, bytes, version, connectionId, updatedAt }` (server-written; client read and write false).
- `users/{uid}/driveConnections/{id}.appFolderId` → folder id (server-only field).
- Allowed `kind` values: `annotations`, `doctext`, `transcript`, `backup`.

```
TASK P4 — build the blob store and move PDF annotations to it.
Read first: src/lib/server/googleDrive.ts, src/lib/server/driveConnections.ts, src/lib/server/driveRequest.ts,
src/lib/server/routeHelpers.ts, src/lib/documentAnnotations.ts (+ test),
src/lib/firestore/personalDocuments.ts, src/components/documents/PdfReader.tsx,
src/app/study-materials/[documentId]/page.tsx, src/app/api/documents/[id]/route.ts, firestore.rules.

0. DIAGNOSTIC FIRST (throwaway account, status codes only): with the existing Drive connection create a
   folder, create a JSON file in it, files.get alt=media, files.update (media upload), files.list
   with q on the parent. If any returns 403/404 under drive.file, STOP and report.
1. src/lib/server/driveBlobStore.ts (server only):
   - ensureAppFolder(uid, connectionId): use the stored appFolderId; verify it with files.get; if
     404 or trashed, search `name='Study Lamp data' and mimeType='application/vnd.google-apps.folder'
     and trashed=false`; else create it. Store appFolderId.
   - putBlob({uid, kind, key, json}): validate kind (allowlist), key (^[A-Za-z0-9_-]{1,80}$) and size
     (<= 2 MB for annotations, <= 5 MB otherwise); file name `${kind}-${key}.json`; create (multipart,
     parents=[folderId]) or update (media) using the fileId in the pointer; save pointer
     {fileId, bytes, version (from the response), updatedAt}.
   - getBlob({uid, kind, key}): read pointer, files.get alt=media, parse, return {json, version}.
   - deleteBlob(...): files.update trashed=true (never a hard delete), then delete the pointer.
   - assertBlobWriteAllowed: the ONLY gate for D15. The parent id must equal the stored folder id and
     the name must match the allowlist regex. Add a test that other parents/names throw.
   - Classified errors (auth, scope_missing, quota, not_found) with retry and backoff (max 3, honour
     Retry-After), no response bodies in errors.
2. Routes (withAuthedRoute, preset "blob", add { limit: 60 } to RATE_LIMITS):
   GET /api/blobs/[kind]/[key], PUT /api/blobs/[kind]/[key] (body = JSON, size cap enforced while
   reading), DELETE /api/blobs/[kind]/[key]. Validate that the document/video the key refers to
   belongs to the uid (for annotations the key is the personalDocuments id; check ownership).
3. Client src/lib/blobClient.ts: readThrough(kind, key): IndexedDB first (db "study-lamp-blobs", store
   "blobs", record {kind,key,json,version,savedAt}); then GET; update IndexedDB. write(kind, key, json):
   save to IndexedDB immediately, debounce 3 s with persistThrottle (P3), PUT, update version. On
   failure keep the local copy, retry with backoff, and expose a status ("saved" | "saving" | "offline
   copy only") for a small indicator. Clear IndexedDB on sign-out. Keep this module free of React.
4. Annotations: replace getPersonalDocumentAnnotations / savePersonalDocumentAnnotations so they use
   blobClient (kind "annotations"). Remove the 850 KB cap error from the user path; the cap becomes
   2 MB (server). Keep prepareDocumentAnnotations validation on read (a user may edit the file in Drive).
   Show the save status next to the page indicator in PdfReader.
5. Fallback without Drive: if the document has no Drive connection, or Drive returns an auth error, keep
   writing to the legacy Firestore annotations document ONLY when the JSON is <= 200 KB; otherwise show
   "Reconnect Google Drive to save more annotations" and keep the local copy.
6. Migration: POST /api/blobs/migrate-annotations (explicit button "Move my annotations to Drive",
   confirm dialog showing the count). Processes 5 documents per call: read the legacy Firestore doc,
   putBlob, read back and compare a hash, THEN delete the legacy Firestore annotation doc. Return
   {moved, remaining}. Never deletes before the read-back matches.
7. When a personal document is deleted (DELETE /api/documents/[id]) also trash its annotations blob and
   delete its pointer.
8. firestore.rules: `blobs` explicit read/write false. Tests: allowlist, size caps, ownership,
   pointer round trip with a fake Drive client, IndexedDB logic with a fake store, retry/backoff,
   migration refuses to delete on hash mismatch, no tokens or bodies in logs.
```
**Test (throwaway account):** annotate a PDF → within about 3 s a file `annotations-<id>.json` appears in "Study Lamp data" and the Firestore annotations doc is not written; reload → annotations return instantly from IndexedDB; clear browser data → they return from Drive; a 1.5 MB annotation set saves without the old error; trash the file in Drive → app shows an empty set and the next save recreates it.
**Cost:** Firestore: 1 pointer write per save burst (was 1 large write). Storage: near zero (pointer only). Drive: user quota (tiny JSON).

---

## STEP P5 — Move large text out of Firestore

**Fixes:** Q5, Q7. **Depends on:** P4.

```
TASK P5 — apply the 20 KB rule (D16).
Read first: docs/firestore-budget.md (the "move to blob store" list), src/lib/server/documentContent.ts,
src/lib/server/documentText.ts, src/lib/firestore/transcripts.ts, notes.ts, quiz.ts, every reader of
`personalDocuments/{id}/content`, firestore.rules.

1. Add `INLINE_LIMIT_BYTES = 20 * 1024` and assertInlineSize(value) in src/lib/firestore/inlineLimit.ts
   (pure, unit-tested). Writers for summaries, notes, quiz JSON and transcripts call it: if the value is
   larger, store it as a blob and save {blobKind, blobKey, preview (first 300 chars), bytes} in
   Firestore instead.
2. Extracted document text (Q5): stop writing `content/*` chunk documents. Store the extracted text as
   blob kind "doctext", key = documentId, JSON {revision, textHash, text}. The existing revision check in
   documentContent.ts decides whether the cache is still valid; if the blob is missing or the Drive file
   revision changed, re-extract on the server (Drive read, no Firestore write beyond the pointer).
   If the user has no Drive connection, extract on demand and do not cache.
3. Transcripts: kind "transcript", key = videoId, only when over the inline limit.
4. Readers: add getLargeText(ref) that transparently returns inline text or fetches the blob; use it
   in the summary, quiz generation and study-panel code.
5. Migration route (explicit button, 5 items per call, read-back hash before deleting the legacy
   Firestore data, same pattern as P4) for existing `content` chunk documents and oversized fields.
6. Delete paths (document or video removal) also trash the matching blobs.
7. Tests: size rule, pointer round trip with a fake store, revision change refreshes, missing blob
   re-extracts, migration hash check, no Firestore chunk writes remain (a recording fake).
```
**Test:** upload a 40-page PDF and generate a summary → no `content/*` documents are created; Firestore size from `scripts/firestoreSizes.ts` shrinks after migration; summary still works after clearing browser data.
**Cost:** Firestore storage and writes drop; one Drive read when the cache is cold.

---

## STEP P6 — Storage health and cleanup

**Fixes:** Q9, B20. **Depends on:** P2.

```
TASK P6 — give the user cleanup tools, with explicit confirmation.
Read first: src/app/settings/ (existing pages), src/components/ui/*, src/lib/server/driveThumbnails.ts,
src/app/api/documents/[id]/route.ts, src/app/api/drive/thumbnails/backfill/route.ts,
src/lib/firestore/quizAttempts.ts, firestore.rules.

1. New page /settings/storage "Storage health": counts per collection via getCountFromServer (cheap)
   and a short explanation of the free limits. No full reads.
2. Cleanup actions, each with a confirm dialog that shows the exact count first (not window.confirm):
   a. Old quiz attempts: delete attempts older than N months (default 12), keep the newest 200.
   b. Old learningEvents (pre-P3 data): delete in chunks of 400 per request.
   c. Orphaned thumbnails (B20): delete the thumbnail inline in DELETE /api/documents/[id] when no other
      record uses it, plus a prune pass (up to 50 per call) returning {pruned, remaining}.
   d. Expired googleUsedTokens: delete where exp < now (up to 200 per call).
   e. Sync log: keep 200 (Z3).
   Each runs on the server through withAuthedRoute, deletes in batches of at most 400, and reports
   {deleted, remaining}. It never touches Drive files.
3. Show "deletes today" guidance: the free plan allows about 20,000 deletes per day; large cleanups should
   be spread over several runs.
4. Tests: pure "which ids to delete" functions (age cutoff, keep-newest, unreferenced thumbnail), batch
   chunking, a thumbnail shared by two records survives.
```
**Test:** create 30 old attempts and an orphan thumbnail → the page shows counts; cleanup removes only the listed items; counts update.
**Cost:** each cleanup action costs reads+deletes equal to the items removed.

---

# PART C — Finish what v7 started (Google core)

> All steps keep the v7 behaviour. Added in v8: free-tier cost notes and D15 awareness. Do them in the order Z3, Z1, Z2, Z4, Z5, Z6.

## STEP Z3 — Finish the confirmation core

**Fixes:** B7, B10, B15, B22, B25. **Depends on:** Z0. Do this before Z1 and Z2.

```
TASK Z3 — complete the shared preview -> confirm -> apply machinery.
Read first: src/lib/sync/plan.ts, src/lib/sync/threeWay.ts, src/lib/server/planToken.ts (+ test),
src/lib/server/applyGate.ts (+ test), src/lib/server/googleSyncLog.ts,
src/components/sync/ConfirmChangesDialog.tsx (+ test), firestore.rules, firestore.indexes.json.

1. applyGate: a writer returns nothing (= applied) or { skipped: "<code>" }. "applied" only when the
   writer finished without throwing and without a skip code. Every token item missing from the fresh plan
   is reported {status:"stale", code:"item_gone"}. Remove the silent `continue`.
   Tests: skip -> "skipped"; throw -> "failed"; item gone -> "stale".
2. Fingerprint: buildPlanItem takes a `local` snapshot ({title, targetDate, completed, ...} or a hash of
   the content to append) and the remote version (etag/revisionId); both go into the fingerprint.
   Field rows: before = the CURRENT value on the side that will change, after = the new value.
   Conflict items carry BOTH values (fields[].local and fields[].remote).
   Test: change only the local date after a preview of a title pull -> fingerprint differs.
3. Conflict granularity: one PlanItem per goal per target; resolutions are per FIELD
   ({itemId, field} -> choice). Non-conflicting fields in the same item apply normally. Update
   ConfirmChangesDialog with a radio group per conflicting field.
4. Sync log: saveSyncLogEntry(uid, entry) (Admin SDK) -> users/{uid}/googleSyncLog/{autoId}; the entry holds
   goal fields only (title, targetDate, completed), never tokens or document text.
   Free-tier prune: keep a counter on users/{uid}/googleSyncMeta {count}; prune only when count > 220:
   query orderBy at desc, offset 200, delete those (do not slice an unsorted array). Add
   listSyncLog(uid, cursor, limit<=50). Test the prune with a fake store.
5. Ignore list: users/{uid}/googleIgnored/{target_remoteId} {at}. isIgnored, ignoreRemote. Ignoring is a
   write to our own data and also goes through the token.
6. One-time tokens: add `jti` (16 random bytes) to the payload. The apply routes call markTokenUsed(uid,
   jti) in a Firestore transaction (users/{uid}/googleUsedTokens/{jti}, with `exp`) BEFORE writing; a
   second use returns 409 "plan already applied". Expired token docs are removed by the P6 cleanup.
   Test: replay -> 409, nothing written.
7. firestore.rules: explicit `allow read, write: if false` for googleSyncLog, googleIgnored,
   googleUsedTokens, googleSyncMeta and googleSync; fix the stale "Step W3 will..." comment.
8. ConfirmChangesDialog accessibility: default focus on Cancel, Esc closes with nothing written, every
   control keyboard-reachable, direction written in words. Tests for the pure parts (grouping, default
   ticks, button label counts).
```
**Test:** unit tests for every point pass; `grep -rn "googleSyncLog\|googleIgnored" src` shows real reads and writes; a replayed token is rejected.
**Cost:** per applied plan: 1 token write + 1 log write per item. Reads: none unless the user opens history.

---

## STEP Z1 — Repair the Calendar foundation

**Fixes:** B3, B4, B5, B6, B12. **Depends on:** Z0, Z3.

```
TASK Z1 — fix the data model and the planner so Calendar sync can work.
Read first: src/lib/server/googleConnections.ts, googleSyncState.ts, goalSyncPlan.ts (+ test),
goalSyncApply.ts, googleCalendar.ts (+ test), src/app/api/google/sync/{plan,apply,status}/route.ts,
src/app/api/google/connections/[id]/route.ts, src/types/index.ts (GoogleCalendarConnection), firestore.rules.

0. DIAGNOSTIC FIRST (temporary; status codes only; remove afterwards): calendars.insert, events.insert
   (all-day), events.list(showDeleted=true), events.patch with a stale If-Match, calendars.get on the
   created calendar, calendarList.list. If anything returns 403/404 under calendar.app.created, STOP and
   report; do not widen the scope without asking.
1. Connection model: remove the literal "calendar" id everywhere. A connection is addressed by its real doc
   id. Calendar settings live INSIDE that doc: calendar: { enabled, calendarId, calendarName, lastCheckAt }.
   The browser sends connectionId; the server checks it belongs to uid and that the calendar permission was
   granted. With exactly one such connection the routes may default to it.
2. Calendar creation: never look up a calendar by name. Enabling: if a calendarId is stored, verify with
   calendars.get; 404/410 -> "calendar was deleted in Google", require a new explicit enable. Otherwise
   calendars.insert. Enabling writes no events.
3. Mapping storage: one doc per goal users/{uid}/googleSync/{goalId} with { titleSnapshot, calendar:
   { connectionId, calendarId, eventId, remoteEtag, base: {title, targetDate, completed}, hash, status,
   lastSyncAt, lastErrorCode } }. Delete the googleSync/goals/items path. Typed read/write; no `as any`.
4. Planner inputs: goals, mapping docs, and LIVE events from Google (listEvents with pagination). Match by
   mapping.eventId, else the deterministic id for (uid, goalId), else extendedProperties.private.
   studylampGoalId. Never match on goal.id alone. The planner takes a READ-ONLY interface and imports no
   write function.
5. Zero writes in the plan route (remove saveGoalRemoteEvent). `base` changes only in apply, or for a
   "converged" item (bookkeeping only, own mapping doc, never Google or goals; document this single exception).
6. Apply: re-read live events and mappings, recompute, call the Z3 gate. push_update uses events.patch with
   If-Match = the etag the user saw (412 -> "stale"). push_create inserts with the deterministic id; on 409
   fetch it and, if not cancelled, adopt it with a patch.
7. googleCalendar.ts client: error classes (auth, scope_missing, retryable, remote_missing, exists,
   changed_remotely), retry with backoff and jitter (max 3, honour Retry-After), pagination (up to 10 pages),
   If-Match, correct 204 handling, errors without response bodies, getEvent and calendars.get.
8. Tests (recording fakes, realistic hashed ids): plan performs zero writes; an already-synced goal gives NO
   item; a Google-side date change gives pull_update with before = current goal value and after = Google
   value; the same change on both sides -> converged; different changes -> conflict; match by marker when the
   mapping is missing; 204 delete; retry/backoff with injected timers; 412 -> stale; 409 -> adopt.
```
**Test (non-production account):** enable Calendar (call PATCH directly if the UI is not built) -> an empty "Study Lamp goals" calendar; plan twice -> identical and no new Firestore docs; apply one `push_create` -> exactly one event; plan again -> empty; move the event in Google -> plan shows the pull and the goal is unchanged until apply.
**Cost:** plan = 0 Firestore writes, reads = goals + mappings (bounded by goals count, use P2 cache). Apply = 1 mapping write per item.

---

## STEP Z2 — Make Docs/Sheets write-back safe

**Fixes:** B2, B13, B14. **Depends on:** Z3. Remove the D14 hotfix at the end.

```
TASK Z2 — rebuild the append apply routes so they cannot write without a valid, user-confirmed token and the
content is built on the server.
Read first: src/app/api/drive/docs/append/{preview,apply}/route.ts, src/app/api/drive/sheets/append/
{preview,apply}/route.ts, src/lib/server/googleDocs.ts, googleSheets.ts, googleAppend.ts, applyGate.ts,
planToken.ts, documentText.ts, src/lib/quizAttempt.ts, src/app/api/quiz-attempts/route.ts,
firestore.indexes.json, firestore.rules.

0. DIAGNOSTIC FIRST (throwaway Doc and Sheet, status codes only): documents.get, spreadsheets.get, one
   batchUpdate on each. If 403/404 under drive.file, STOP. Also test whether updateParagraphStyle with a
   zero-length range is rejected (expected 400).
1. The apply request is ONLY {planToken, accepted, documentId?}. Remove text, heading and revisionId from the
   body. The token item target = `google-doc:<documentId>:<kind>` (Sheets: `google-sheet:<documentId>:
   quiz_results`); the route checks the id matches the stored record so a token cannot be applied elsewhere.
2. Apply order: verify token (uid, scope) -> mark token used (Z3) -> load the stored personalDocuments record
   (googleNative true, matching type) -> REBUILD the content on the server -> get the current revisionId ->
   recompute the fingerprint -> applyConfirmed with a REAL writer that performs the Google write -> log (Z3).
   The write happens INSIDE the writer, never before the gate.
3. Docs: heading built once. ONE batchUpdate: insertText at endIndex-1 of "\n\n<heading>\n<body>\n", then
   updateParagraphStyle over the heading paragraph only (start = endIndex-1+2, end = start + heading.length + 1)
   with writeControl.requiredRevisionId = the revision read at apply time, compared with the fingerprint. A
   revision mismatch is "stale". Call assertAllowedDocumentRequests. Quiz review lists the wrong questions
   (question, your answer, correct answer; max 20 and 20,000 characters).
4. Sheets: rows built on the server from quiz attempts. Mark exports in a SERVER-ONLY collection
   users/{uid}/googleExports/{attemptId_documentId}. The preview lists attempts without such a doc (query by
   document then filter in code; limit 200 per FREE-TIER RULES). Header row only when the tab is created. Row =
   [date, material title, quiz title, score, total, percent]. Apply marks exactly the attempt ids in the token.
   Call assertAllowedSheetRequests inside createSheet. Use values.append with RAW and INSERT_ROWS.
5. Add the composite index for any quizAttempts query you keep; remove the unused appendToSpreadsheet.
6. documentText.ts: for Google Docs skip text from the first paragraph that starts with "Study Lamp — " to the end
   (AI extraction only). Keep the Sheets tab skip.
7. UI on the document page (googleNative only): menu "Add to Google Doc…" (Summary / Notes / Quiz review) or
   "Add to Google Sheet…" (Quiz results) opening ConfirmChangesDialog with the exact text or rows in a read-only
   box, the line "This adds to the end of your file. It does not change or delete anything already there.",
   Apply labelled "Add to Google Doc" / "Add to Google Sheet", default focus on Cancel, visible errors
   (permission, trashed, changed since preview -> "Preview again", reconnect link).
8. Tests: apply without an accepted id writes nothing; token for A applied to B rejected; replay -> 409; body
   text ignored; stale revision writes nothing; preview performs zero writes; Sheets rows only from unexported
   attempts; header only on a new tab; markers only for ids in the token; 200 cap; allowlists reject other
   request types; documentText skips our section and tab.
```
**Test (throwaway Doc and Sheet):** preview shows the exact text and writes nothing; Apply appends once with one heading; Apply again with the same token fails; editing the Doc between preview and Apply gives "changed since preview" and writes nothing; Sheets rows appear once; the next summary ignores the appended section.
**Cost:** 1 token write + 1 export marker per exported attempt (cap 200 per run).

---

## STEP Z4 — Finish Calendar two-way sync

**Fixes:** B8 to B11, B15, B16, B18. **Depends on:** Z1, Z3.

```
TASK Z4 — all item kinds, safe pulls, settings UI, goal-change hooks.
Read first: everything Z1 and Z3 changed, src/lib/googleClient.ts, src/app/settings/google/page.tsx,
src/components/sync/ConfirmChangesDialog.tsx, src/lib/firestore/goals.ts, src/app/goals/page.tsx,
src/app/roadmap/components/RoadmapEditor.tsx, src/app/roadmap/page.tsx, firestore.rules (goals).

1. eventToGoalFields returns {title, targetDate, completed} or {attention: reason}. Timed, multi-day
   (end != start + 1 day), cancelled events, invalid dates and too-long titles (goals rules limit) are "attention".
   Update the test that currently accepts a timed event.
2. completed (D4): Study Lamp -> Google only. A completion change creates push_update adding/removing the "✓ "
   prefix. Removing the prefix in Google never re-opens the goal.
3. Item kinds: pull_create (events without the marker in the Study Lamp calendar -> "Import as goal", unticked,
   respects googleIgnored), remote_deleted with three choices (unlink = default, recreate, delete_goal =
   destructive, needs confirmedDestructive; destructive ONLY for delete_goal), orphans (mapping without a goal,
   report only). Resolution type: "use_study_lamp" | "use_google" | "skip" | "unlink" | "recreate" |
   "delete_goal" | "ignore".
4. Safe pulls: the writer uses the Admin SDK in a transaction: re-read the goal, compare the fields the user saw,
   update ONLY the pulled fields (title, targetDate), validate against the goals limits (the server bypasses the
   rules), set updatedAt, save the mapping base, write a sync log entry. A changed goal gives "stale".
5. Settings UI: a Calendar card per connection: toggle "Sync goals with Calendar" (off by default) with a proper
   confirm dialog (not window.confirm), last check, counts, "Check for changes" (opens ConfirmChangesDialog),
   plain-language failures, a "What syncs" table (title and date both ways; completion, notes, priority
   Study Lamp -> Google only). Replace the disconnect window.confirm. Never show "Synced" after a failed call.
6. Hooks: addGoal returns the new id. After add/update/toggle on the goals page and after addGoal in the two
   roadmap call sites, if the integration is enabled (cached flag), request a read-only plan for that goalId and
   show a toast "Google Calendar: N change(s) ready to review" with a Review action. On opening Goals: at most one
   read-only plan every 10 minutes, shown as a banner. Nothing is written without the dialog. Goal deletion is
   not synced. After a pull is applied refresh the goals list.
7. Status route: counts come from mapping docs with no Google call.
8. Tests: every kind end to end through plan -> gate -> writers with recording fakes; a pull touches only changed
   fields; stale on local change; delete_goal needs the extra confirm; "ignore" persists; completion prefix rule;
   attention reasons; Study Lamp's own write does not come back as a change.
```
**Test:** the v6.1 manual test plus: complete a goal (proposal adds ✓), remove ✓ in Google (no goal change), create a timed event in the Study Lamp calendar (shown as "can't be applied" with a reason), change a goal after the dialog opened (skipped as "changed since preview").
**Cost:** the 10-minute throttle caps plan reads (about 6 per hour of use); apply writes 1 mapping + 1 log entry per item.

---

## STEP Z5 — Finish Docs and Sheets import

**Fixes:** B17 and missing UI/tests. **Depends on:** Z0.

```
TASK Z5 — finish W1.
Read first: src/lib/server/googleDrive.ts, src/app/api/drive/stream/[fileId]/route.ts,
src/components/documents/DocumentReaderSwitch.tsx, src/app/study-materials/page.tsx,
src/app/study-materials/[documentId]/page.tsx, src/lib/server/documentContent.ts,
src/lib/server/driveImportUtils.ts (+ test), src/lib/driveMime.ts (+ test).

0. DIAGNOSTIC (temporary): export one picked Google Doc and one Sheet; status codes only. If 403/404, STOP.
1. exportFile: classify errors. 403 with reason "exportSizeLimitExceeded" -> "too large"; other 403 ->
   "permission"; 404 -> "not found/trashed". Typed DriveApiError codes; distinct UI messages. (The stream route
   already returns permission/not_found/auth/upstream codes since the v8 PDF work; reuse the same codes.)
2. Stream route: a non-native file with an export purpose -> 400. Move dynamic imports to the top. No
   Accept-Ranges on export responses.
3. UI: "Google Doc" / "Google Sheet" badge on cards and reader; "Open in Google" link from the validated file id;
   "Last changed in Google" from the stored modifiedTime (update it on open when it changed); sizeBytes null
   shows "—" consistently.
4. Picker: Word tab shows Docs, Excel tab shows Sheets (the "All" tab already does).
5. Tests: partitionDriveFiles with native Doc/Sheet/Slides (Slides unsupported); nativeExportMime allowlist;
   signed-URL purposes (wrong purpose, tampered, expired); fetchDocumentBytes routing with an injected fetch;
   revision key with null md5; error classification.
```
**Test:** the W1 manual test plus: a Google Doc you lost access to shows a "permission" message, not "too large".

---

## STEP Z6 — Finish route hygiene

**Fixes:** B19, B21. **Depends on:** Z0. (Orphan thumbnails moved to P6.)

```
TASK Z6 — finish route hygiene.
Read first: the 10 routes in B19, src/lib/server/routeHelpers.ts (+ test), src/lib/server/driveOwnership.ts,
src/lib/server/driveThumbnails.ts, src/lib/server/documentText.test.ts.

1. Move to withAuthedRoute without changing response shapes: ai/system-connections/[id] and [id]/test
   (admin: true), quiz-attempts (default preset; it has NO limit today), find-user (keep 20/min),
   youtube-duration, external-playlist, youtube-playlist, youtube-playlist-search, facebook-video,
   facebook-video/thumbnail. Do NOT touch drive/auth/callback, google/auth/callback, drive/stream,
   drive/thumbnail.
2. facebook-video: stop logging user URLs; log status or error name only.
3. createAuthedRoute with admin set must authenticate once.
4. findDriveOwnedRecord: if driveOwnership.ts and driveThumbnails.ts duplicate the owner lookup, extract and
   share it; otherwise say so.
5. Add the missing 10,000-row XLSX test (capped at 5,000 rows per sheet, "Sheet: name" kept).
6. CSP: if the policy is still Report-Only (verify in next.config.js), review a week of reports, then switch to
   enforcing. The wasm-unsafe-eval and worker-src blob: entries are required for the PDF engine.
7. Rate limiting (Q10): the limiter is per instance. Keep it for now; if abuse appears, consider a free-tier
   external store (for example Upstash Redis, verify limits) rather than Firestore writes.
```
**Test:** `grep -L withAuthedRoute` over the routes lists only the four signed/redirect routes.

---

# PART D — Smoothness for PDF, Word, Excel, video

## STEP S1 — Excel parsing in a Web Worker

**Why:** `parseSpreadsheet` runs on the main thread (up to 20,000 rows), which freezes the page.

```
TASK S1 — move SheetJS parsing off the main thread.
Read first: src/lib/documentViewerUtils.ts (+ test), src/components/documents/XlsxReader.tsx, next.config.js.

1. Create src/workers/xlsxParse.worker.ts that imports `xlsx`, receives {buffer} (transferred), runs the
   existing parse logic (keep it in a pure module shared with the main thread so the same unit tests cover it),
   and posts {sheets} or {error}. Create it with `new Worker(new URL("../workers/xlsxParse.worker.ts",
   import.meta.url), { type: "module" })`.
2. XlsxReader: parse in the worker; terminate it on unmount or URL change; fall back to main-thread parsing
   only if Worker construction fails. Show "Reading workbook…" with the same skeleton.
3. Keep the limits (rows per sheet, preview bytes). Verify the CSP allows the worker (worker-src 'self' blob:).
4. Tests: the pure parser (existing); worker message handling via a small fake.
```
**Test:** open a 15,000-row workbook; the page stays scrollable and clickable during parsing.

---

## STEP S2 — Cache downloaded files by revision

**Why:** signed URLs differ every time, so the browser cache never hits and every open downloads the file again.

```
TASK S2 — add a per-user, size-limited file cache keyed by file revision.
Read first: src/components/documents/PdfReader.tsx, DocxReader.tsx, XlsxReader.tsx, src/lib/driveClient.ts,
src/types/index.ts (PersonalDocument: find the revision fields, for example modifiedTime, md5Checksum).

1. src/lib/fileCache.ts (IndexedDB, db "study-lamp-files"): get(uid, fileId, revision) -> ArrayBuffer | null;
   put(uid, fileId, revision, buffer); LRU eviction to a 300 MB total; delete all on sign-out. Key =
   `${uid}:${fileId}:${revision}`; if no revision is known, do NOT cache. Pure LRU logic is unit-tested with a fake
   store.
2. Readers: check the cache first; on a miss download (with progress) and put. A revision change misses naturally.
   Never cache a response that was not fully read (the truncation check in readResponseWithLimit already guards this).
3. Privacy: the cache holds the user's document bytes locally. Add a "Clear offline files" button in settings and
   clear on sign-out.
4. Tests: LRU order, size cap, revision change, no caching without a revision.
```
**Test:** open a PDF, reload: the second open shows no network request to `/api/drive/stream` and renders immediately; change the file in Drive: the next open downloads again.
**Cost:** zero Firestore.

---

## STEP S3 — Prefetch the engine and chunks

```
TASK S3 — remove the start-up wait.
Read first: src/components/documents/DocumentReaderSwitch.tsx, src/app/study-materials/page.tsx, next.config.js.

1. On the study-materials list, when a PDF card gets pointer-enter or touch-start, call the same dynamic import
   used by DocumentReaderSwitch (preload the reader chunk) and fetch(`/wasm/pdfium.wasm?v=<version>`, {priority:
   "low"}) once per session.
2. Prefetch the signed URL only on click, never on hover (it is a capability).
3. Keep it behind a single `prefetchedOnce` flag; no effect for Word and Excel except their chunks.
```
**Test:** Network tab shows the wasm and reader chunk loading before the click; opening the PDF is faster.

---

## STEP S4 — Optional: PDF.js spike (only if S2 and S3 are not enough)

```
TASK S4 — evaluate pdfjs-dist (Apache-2.0) as the viewer, in a throwaway branch.
Goal: first page visible in under 2 s on a 20 MB Drive PDF using HTTP Range requests through
/api/drive/stream (it already forwards Range and Accept-Ranges).
Deliver a short report (no merge): time to first page, memory, what must be rebuilt (annotations, search, page
restore, explain-page), and a go/no-go. If go, write the migration as its own roadmap step.
```
Trade-off: PDF.js streams pages, but you rebuild the toolbar and annotation features that EmbedPDF gives you.

---

# PART E — Remaining Google features

## STEP W4 — Tasks two-way sync

**Depends on:** Z1, Z3, Z4. Behaviour: a dedicated "Study Lamp" task list, two-phase create with a notes marker, push-only notes and priority, two-way title/date/completed, independent toggles.

```
TASK W4 — Tasks adapter on top of the repaired sync core.
Read first: everything Z1, Z3 and Z4 changed.

0. DIAGNOSTIC FIRST (status codes only): tasklists.insert; tasks.list with showCompleted, showHidden and
   showDeleted=true; tasks.patch with If-Match. Report whether deleted tasks are returned and whether a stale
   If-Match is rejected.
1. Pure tasksGoalMapping.ts: buildTask(goal) (due = `${targetDate}T00:00:00.000Z` only for a valid date; a
   re-opened goal sends status "needsAction" AND completed null; marker line "[studylamp:<goalId>]"),
   taskToGoalFields(task) (due -> isoDatePart; completed from status; notes never read back).
2. googleTasks.ts with the same error classes, backoff and pagination as Z1. EVERY call takes the stored
   Study Lamp list id; nothing may list the user's other lists (test it).
3. The mapping doc gets a `tasks` block next to `calendar`. Build a TasksAdapter with the same interface as
   the Calendar adapter so the planner and applier are shared.
4. Two-phase create (apply only): a transaction sets state "creating" with a timestamp (younger than 2 minutes ->
   "busy"); insert; save taskId; state "synced". A mapping stuck in "creating" for over 2 minutes: list all pages
   and ADOPT the task whose notes contain the marker.
5. PATCH /api/google/connections/[id] accepts {tasks:{enabled}}; plan/apply accept targets
   ("calendar" | "tasks")[]; one token may cover both.
6. UI: a Tasks card like the Calendar card with an independent toggle and the "What syncs" table.
7. Tests: preview performs zero writes; replayed token rejected; only the stored list id is used; independent
   toggles; completion both directions; due removed in Google shows "Target date -> (none)".
```

---

## STEP W5 — Reconcile, history, explicit removal, docs

**Depends on:** Z4, W4.

```
TASK W5 — safe control and documentation.
Read first: the sync code, src/lib/server/googleSyncLog.ts, docs/*.md.

1. Orphans: the status route lists up to 50 mapping docs with no goal (titleSnapshot).
2. History: GET /api/google/sync/history?cursor= returns the newest 50 entries. Settings shows a collapsible
   "Recent changes" list. Read-only, no undo.
3. Removal: POST /api/google/sync/remove/preview {target, scope:"orphans"|"all"} (read-only, token scope
   "remove") and POST /api/google/sync/remove {planToken, confirmCount}. Deletes ONLY remote ids in this user's
   mapping docs, in chunks of 25 with backoff; 404/410 = already gone; a stale confirmCount -> 409 with the fresh
   count; one-time token (Z3). A log entry per removal.
4. Disconnect dialog: an UNCHECKED option "Also remove N events/tasks Study Lamp created", executed through the
   same preview and token BEFORE the stored token is deleted.
5. No cron. Document how a daily Vercel Cron could run the read-only plan and set a "changes waiting" flag
   (CRON_SECRET); leave it unimplemented.
6. Docs: finish docs/google-workspace.md (usage, data lifecycle table, troubleshooting: invalid_grant, 7-day
   token expiry in Testing mode, rate limits, deleted calendar/list, "changed since preview"); update
   docs/deploy.md (APIs to enable: Calendar, Tasks, Docs, Sheets) and docs/security.md (plan token signing and
   its "sync-plan.v1|" prefix, one-time tokens, server-only collections, the D15 blob-store allowlist).
7. Tests: removal touches only mapped ids; confirmCount mismatch -> 409; no token -> 400; 404 handled; orphan
   detection; history paging; disconnect with and without the option.
```

---

# PART F — Features (free-tier friendly designs)

| Step | Goal | Data design (free-tier) | Acceptance test |
|---|---|---|---|
| **F1** Streak and activity ledger | One entry per study day (watch, read, quiz) in the user's **local** date (`isoDate.ts`, never `toISOString()`). Fix B23. | One document per month `users/{uid}/activity/{yyyy-MM}` holding a map `days: {"05": {w,d,q}}`. Reads: 1 per month viewed. Writes through the P3 persister. Reuse `learningDays` from P3 if it already holds the data. | Study at 00:30 Dhaka time -> counts as today; skipping a day resets the streak; dashboard shows the new value with at most 2 reads. |
| **F2** Today Plan | One screen: goals due or behind pace, resume-eligible videos and documents, due reviews. Uses `goalPace`, `resumeGroups`, `reviewUtils`. | No new collection. Computed from data the dashboard already loaded (P2 cache). 0 extra reads. | Three goals (one overdue) and one half-watched video show in a sensible order and each opens the right page. |
| **F3** Flashcards from quiz mistakes | Cards from wrong answers in saved attempts, with a simple spaced-review schedule. | One document per deck (cap 200 cards and 20 KB); larger decks use the blob store (kind `flashcards`). Review state is a compact map `{cardId: [dueDay, box]}`. | Fail two questions -> two cards; marking one "known" delays it. |
| **F4** AI study resources | Study guides, glossaries or practice questions from a document or video (`en`/`bn`). Works with Google-native documents (Z5). | Output over 20 KB goes to the blob store (P5), keyed by documentId + revision + language, so an unchanged file never regenerates. | A Google Doc produces a guide in the chosen language and is cached by revision. |
| **F5** Backup v2 | Back up goals, notes, summaries, quiz attempts and (decide explicitly) sync mappings. **Never** credentials. Restore must not re-create remote items. | The backup is a JSON file in "Study Lamp data" (kind `backup`), not Firestore. Keep the last 5. Restore asks for confirmation and writes with batches of 400. | Back up, delete a goal, restore -> the goal returns and no Google write happens. |
| **F6** Export | Markdown and Anki TSV of notes, summaries and flashcards. | Generated in the browser from already-loaded data; offered as a download (or saved to Drive as a user-visible file only with a confirm dialog, since it is the user's content). | The Anki file imports cleanly; Markdown opens in any editor. |
| **F7** Next.js major upgrade | Move off 14.2.x after all features are done. One PR, no features. Re-check EmbedPDF, the worker URL syntax and `next.config.js` headers. | none | `tsc`, tests and a production build pass; smoke-test login, Drive, PDF, Google settings. |
| **F8** PWA | Manifest, icons, install prompt, offline fallback page. No caching of authenticated API responses. | The S2 file cache stays in IndexedDB, not the service worker. | Lighthouse PWA checks pass; offline shows the fallback page. |

When you reach each F-step, write its detailed prompt in the same format as the steps above (Read first, numbered instructions, tests, cost note) before implementing.

---

# PART G — Reference

## 11. Free-tier budget table (fill with real numbers in P1)

| Area | Target after P2/P3 | How to check |
|---|---|---|
| Dashboard load | at most 60 reads | `window.__fsUsage()` |
| Video page load | at most 25 reads | same |
| Document page load | at most 15 reads (annotations come from IndexedDB or Drive, not Firestore) | same |
| Goals page | at most 20 reads | same |
| 5 minutes of video or PDF | at most 6 writes | same |
| Typical study day (one user) | under 1,500 reads and 150 writes | multiply page counts |
| Documents in Firestore | each under 20 KB | `scripts/firestoreSizes.ts` |

Daily free quota check: `users x sessions x reads per session` must stay well under 50,000 reads and 20,000 writes **(verify the current limits in the Firebase console)**.

## 12. Definition of done (every step)

1. `npx tsc --noEmit` has zero errors, `npm test` is green, `npm run lint` runs.
2. Every new route has tests for 401, validation failure and one success path.
3. Every Google integration has a test proving the preview makes no write (Rule 15) and a test with real id shapes (D13).
4. The manual test in the step passes on a non-production Google account.
5. The report lists files changed, real command output, the read/write cost of the change, and anything uncertain.
6. Free-tier check: no new unbounded query, no document over 20 KB, no new per-event document.

## 13. Security checklist (Google features)

- Drive scope stays `drive.file`. Calendar uses `calendar.app.created` (verify in Z1). No scope is widened without a written decision.
- OAuth tokens stay encrypted at rest; never logged; key rotation script exists (`scripts/reencrypt.ts`).
- Signed Drive URLs carry the purpose and expiry (stream 6 h, download 10 min, thumb 24 h, export 30 min); the stream route checks ownership; errors are generic.
- Plan tokens are signed, one-time (`jti`) and tied to a target id; apply rebuilds content on the server.
- Blob-store writes pass `assertBlobWriteAllowed` (D15): fixed folder, fixed name pattern, size caps.
- Annotation files edited in Drive are validated on read; anything unexpected is dropped.
- Firestore rules: server-written collections are `read, write: if false` for clients; owner-only for everything else; no collection group wildcards.
- Dependencies are pinned (`@embedpdf/react-pdf-viewer` is exactly `2.15.1`; any new package states version and licence).

## 14. Known limits and open questions

- The PDF fix was verified by reading the library source, not in a browser. If the PDF still does not load, report the first red error in the DevTools console and the failing request in the Network tab.
- EmbedPDF 2.15.1 downloads the whole file before showing it (no streaming). S2 (cache) and S3 (prefetch) reduce the wait; S4 evaluates a streaming viewer.
- Drive reads (about 200 to 500 ms) are slower than Firestore reads (about 50 ms). IndexedDB read-through in P4 and S2 hides this for repeat opens; the first open of a cold document is the only slow case.
- Firestore TTL policies could remove old documents automatically but whether they fit the Spark plan and delete quota must be checked **(verify)**; P6 uses explicit, confirmed cleanup instead.
- D15 needs a product-owner decision before P4.
