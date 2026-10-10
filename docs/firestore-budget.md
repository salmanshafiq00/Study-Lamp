# Firestore budget (Spark plan) — roadmap P1–P4

Free-plan limits to stay under (verify the current numbers in the Firebase console): about 1 GiB stored,
50,000 reads/day, 20,000 writes/day, 20,000 deletes/day.

## How to measure
1. `npm run dev`, sign in, open the browser console.
2. `window.__fsUsageReset()`, use one page, then `window.__fsUsage()` (table of reads/writes/deletes per collection).
3. For stored size: `npx tsx scripts/firestoreSizes.ts <uid> [cap]` (read-only; prints paths and bytes only).

Counted: getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, writeBatch in `src/lib/firestore/*` and `analytics.ts`.
Not counted: transactions, `getCountFromServer`, code that imports Firebase directly.

## Measured baseline
Not measured yet: it needs a browser session with real data. Fill this table with `__fsUsage()` output
(before = commit before P2, after = current).

| Page | Reads on load (before) | Reads (after) | Writes per 5 min of use |
|---|---|---|---|
| Dashboard | _measure_ | _measure_ | – |
| Video page | _measure_ | _measure_ | _measure_ (target ≤ 6) |
| Study-materials list | _measure_ | _measure_ | – |
| PDF page | _measure_ | _measure_ | _measure_ (target ≤ 6) |
| Goals | _measure_ | _measure_ | – |
| Quizzes | _measure_ | _measure_ | – |
| Settings | _measure_ | _measure_ | – |

## What changed (expected effect, from the code)
| Area | Before | After |
|---|---|---|
| Admin users list | read the whole `users` collection | 25 per page + COUNT queries |
| Admin dashboard | whole `users` collection | 7 COUNT queries + ≤ 500 recent signups, cached 10 min |
| quizAttempts, bookmarks, shares, roadmaps, playlists, personal docs | unbounded `getDocs` | `limit()` (50–300) |
| videoStates, categories, tags | read on every call | cached 5 / 10 min, invalidated on every write |
| Learning events | 1 document per event | ≤ 1 write/min into `learningDays/{yyyy-MM-dd}` |
| Reader progress | write every ~2 s of change | ≤ 1 write/min and only if it moved enough; flushed on hide/leave |
| PDF annotations | one Firestore document up to 850 KB | JSON file in the user's Drive; Firestore holds a pointer |

## Document kinds and the 20 KB rule (D16)
| Kind | Typical size | Decision |
|---|---|---|
| goals, bookmarks, categories, tags, shares, pointers, `learningDays` | < 2 KB | keep |
| `userVideoStates`, reader progress | < 1 KB | keep |
| PDF annotations | up to 850 KB | **moved to Drive blob store (P4)** |
| extracted document text (`content/*` chunks) | large | **move to blob store (P5, not done yet)** |
| transcripts, summaries, notes, quiz JSON | unknown | measure with `firestoreSizes.ts`, then move anything > 20 KB (P5) |

## P5 / P6 notes

- Extracted document text: no `content/*` chunk writes any more; cache = `doctext` Drive blob (1 pointer read per extraction, +1 pointer write when cold). Legacy chunks are read once, copied, hash-verified, then deleted.
- Notes, summaries and transcripts over 20 KB: Firestore keeps `{content: preview, blobKind, blobKey, bytes, preview}`; full text is in Drive. Without Drive and under 50,000 characters the text is written inline instead.
- Not moved: quiz JSON (shared playlist quizzes are not one user's data; a quiz is capped at 50 questions by rules).
- `/settings/storage`: health page = 12 count aggregations (about 12 reads); each cleanup preview = 1 count (+200 index reads for the keep-newest rules); thumbnails scan up to 3,000 ids.
