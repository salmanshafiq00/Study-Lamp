import type { FieldValue, Timestamp } from "firebase/firestore";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * DATA MODEL OVERVIEW
 * ─────────────────────────────────────────────────────────────────────────
 * Shared library content (created once, visible to everyone):
 *   playlists/{playlistId}
 *   playlists/{playlistId}/videos/{videoId}   (order + shared metadata)
 *   tags/{tagId}
 *
 * Personal, per-user state (never duplicates the video itself):
 *   users/{uid}                                        profile + role
 *   users/{uid}/videoStates/{videoId}                  progress, favorite,
 *                                                       watchLater, priority
 *   users/{uid}/notes/{videoId}                         private notes
 *   users/{uid}/summaries/{videoId}                     personal summary
 *   users/{uid}/bookmarks/{videoId}/items/{bookmarkId}   timestamp bookmarks
 *   users/{uid}/favoritePlaylists/{playlistId}
 *   users/{uid}/goals/{goalId}
 *   users/{uid}/notifications/{id}                       in-app notifications
 *   users/{uid}/categories/{categoryId}                   user's categories
 *
 * A single global "videos" collection group is intentionally avoided —
 * videos live as a subcollection of the playlist that owns them, which keeps
 * ordering (position) co-located with the shared content and avoids
 * duplicating a video document per student (see README > Data Model).
 * ─────────────────────────────────────────────────────────────────────────
 */

export type Role = "admin" | "student";
export type VideoPlatform = "youtube" | "youtube-shorts" | "facebook" | "vimeo" | "generic" | "google_drive";
export type ShareVisibility = "private" | "unlisted" | "public";

export const VIDEO_PLATFORMS: VideoPlatform[] = [
  "youtube",
  "youtube-shorts",
  "facebook",
  "vimeo",
  "generic",
  "google_drive",
];

export const SHARE_VISIBILITIES: ShareVisibility[] = ["private", "unlisted", "public"];

/** Choice offered in ShareDialog's "Expires" control. "never" clears any
 *  previously-set expiry; "7d"/"30d" set expiresAt to now + N days. This is
 *  an action a person picks, not a stored value — the actual persisted
 *  state lives in ShareRecord.expiresAt (a Timestamp or null). */
export type ShareExpiryOption = "never" | "1h" | "24h" | "7d" | "30d";

export const SHARE_EXPIRY_OPTIONS: ShareExpiryOption[] = ["never", "1h", "24h", "7d", "30d"];

export interface VideoTag {
  id: string;
  videoId: string;
  tagId: string;
  createdAt: Timestamp | null;
}

export type ShareEntityType = "video" | "playlist";
export type ShareApprovalStatus = "pending" | "accepted" | "rejected";

export type FirestoreTimeValue = Timestamp | FieldValue | null;

export interface ShareRecord {
  id: string;
  ownerUid: string;
  entityType: ShareEntityType;
  entityId: string;
  visibility: ShareVisibility;
  shareToken: string;
  title: string;
  description?: string | null;
  categoryName?: string | null;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  platform?: VideoPlatform | null;
  creatorName?: string | null;
  videos?: Array<{
    id: string;
    title: string;
    videoUrl: string;
    thumbnailUrl?: string | null;
    durationSeconds?: number | null;
    platform?: VideoPlatform;
    categoryName?: string | null;
  }>;
  revokedAt: FirestoreTimeValue;
  /** Optional automatic expiry, set from ShareDialog's "Expires" control
   *  (never / 7 days / 30 days). null/undefined means "never expires" —
   *  see firestore.rules' isShareActive() for how reads enforce this. */
  expiresAt?: FirestoreTimeValue;
  createdAt: FirestoreTimeValue;
  updatedAt: FirestoreTimeValue;
  recipientEmail?: string | null;
  recipientUid?: string | null;
  approvalStatus?: ShareApprovalStatus | null;
  sharedByName?: string | null;
}

export interface PlaylistShare {
  id: string;
  playlistId: string;
  visibility: ShareVisibility;
  shareToken?: string | null;
  /** Optional automatic expiry, mirrors ShareRecord.expiresAt. */
  expiresAt?: Timestamp | null;
  createdBy: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface WatchProgress {
  userId: string;
  videoId: string;
  playlistId: string;
  currentSeconds: number;
  percentComplete: number;
  lastWatchedAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export type InterestLevel = "basic" | "intermediate" | "advanced" | null;

export interface UserInterest {
  categoryId: string;
  level: InterestLevel;
  subtopics?: string[];
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  status: "active" | "disabled";
  createdAt: Timestamp | null;
  lastActiveAt: Timestamp | null;
  interests?: UserInterest[];
  /** Set the first time the user finishes OR explicitly skips onboarding.
   *  Onboarding's own copy of `interests` can legitimately be empty (the
   *  whole flow is optional), so "has this user seen onboarding?" cannot be
   *  inferred from interests alone — without this flag a user who chose
   *  "Skip for now" would be bounced back into onboarding on every subsequent
   *  visit. */
  onboardingCompletedAt?: Timestamp | null;
  /** Guided-tour progress, keyed by tour id (see src/lib/tour). Absent = never seen. */
  tours?: Record<string, { v: number; status: "completed" | "skipped" | "dismissed"; step?: number; at?: Timestamp | null }>;
  /** Denormalized, cheap-to-read counters updated by client writes at
   *  meaningful events only (not on every keystroke) so the admin table
   *  can render without fanning out reads across every student. */
  stats?: UserStatsSnapshot;
  /** Phase 1 (roadmap v3): set true when the user picks "Don't ask again"
   *  on the dashboard's InterestsBanner. Onboarding is no longer a forced
   *  gate, so this is the only thing standing between an empty-interests
   *  profile and the banner showing again on a future visit. */
  interestsBannerDismissed?: boolean;
}

export interface UserStatsSnapshot {
  totalVideos: number;
  completed: number;
  inProgress: number;
  notStarted: number;
  favorites: number;
  watchLater: number;
  priority: number;
  totalWatchTimeSeconds: number;
  currentStreakDays: number;
  lastStreakDate: string | null; // yyyy-mm-dd, used to compute streak cheaply
  updatedAt: Timestamp | null;
}

export interface Category {
  id: string;
  name: string;
  color?: string;
  createdBy: string;
}

export type RoadmapLevel = "basic" | "intermediate" | "advanced";

export interface RoadmapStep {
  title: string;
  description: string;
  /** Optional bullet points that break the step into concrete actions/checkpoints.
   *  Rendered as a real <ul> under the description. Free-form; AI-generated steps
   *  are asked to always provide at least one bullet. */
  details?: string[];
  order: number;
  week?: number;
}

export interface RoadmapTemplate {
  id: string;
  categoryId: string;
  level: RoadmapLevel;
  steps: RoadmapStep[];
  generatedAt: Timestamp | null;
}

export interface LearningRoadmap {
  id: string;
  categoryId: string;
  level: RoadmapLevel;
  steps: RoadmapStep[];
  source?: "template" | "generated" | "imported";
  adoptedFromTemplateAt: Timestamp | null;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface Tag {
  id: string;
  name: string;
  nameLower?: string;
  createdBy: string;
}

export type CategorySuggestionStatus = "pending" | "approved" | "rejected";

export interface CategorySuggestion {
  id: string;
  suggestedName: string;
  suggestedBy: string;
  aiCleanedName?: string | null;
  similarExistingCategoryId?: string | null;
  status: CategorySuggestionStatus;
  createdAt: Timestamp | null;
  reviewedAt?: Timestamp | null;
}

export type PlaylistVisibility = "shared" | "archived";

export interface Playlist {
  id: string;
  title: string;
  description?: string;
  categoryId?: string | null;
  tagIds?: string[];
  coverThumbnailUrl?: string;
  visibility: PlaylistVisibility;
  videoCount: number;
  source: "manual" | "youtube-import" | "json-import";
  sourceUrl?: string;
  createdBy: string;
  /** Set only on personal playlists (users/{ownerUid}/playlists/...).
   *  Absent/undefined for shared library playlists. */
  ownerUid?: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

/** Shared video metadata, stored under playlists/{playlistId}/videos/{videoId}. */
export interface Video {
  id: string;
  playlistId: string;
  title: string;
  videoUrl: string;
  youtubeVideoId?: string | null;
  thumbnailUrl: string;
  durationSeconds?: number;
  creatorName?: string | null;
  platform?: VideoPlatform;
  categoryId?: string | null;
  tagIds?: string[];
  description?: string;
  videoNo?: number | null;
  lessonNo?: number | null;
  partNo?: number | null;
  pageNo?: number | null;
  /** Position within the playlist; drives default ordering + drag/drop reorder. */
  order: number;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export type WatchStatus = "not_started" | "in_progress" | "completed";
export type PriorityLevel = "high" | "medium" | "low" | null;

/** Per-user, per-video personal state. users/{uid}/videoStates/{videoId} */
export interface UserVideoState {
  videoId: string;
  playlistId: string;
  status: WatchStatus;
  watchedPercentage: number; // 0-100
  currentPositionSeconds: number;
  isFavorite: boolean;
  isWatchLater: boolean;
  priority: PriorityLevel;
  /** Manual order used within Watch Later / Priority lists (drag & drop). */
  watchLaterOrder?: number;
  priorityOrder?: number;
  lastWatchedAt: Timestamp | null;
  completedAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface VideoNote {
  /** P5: set when the full text lives in Drive but only the preview could be loaded (another user's data). */
  truncated?: boolean;
  /** P5 pointer fields: text over 20 KB is stored in the Drive blob store; `content` is then only a preview. */
  blobKind?: "summary" | "note" | "transcript";
  blobKey?: string;
  bytes?: number;
  videoId: string;
  content: string;
  pageNumber?: number | null;
  updatedAt: Timestamp | null;
}

export interface VideoSummary {
  /** P5: set when the full text lives in Drive but only the preview could be loaded (another user's data). */
  truncated?: boolean;
  /** P5 pointer fields: text over 20 KB is stored in the Drive blob store; `content` is then only a preview. */
  blobKind?: "summary" | "note" | "transcript";
  blobKey?: string;
  bytes?: number;
  videoId: string;
  content: string;
  updatedAt: Timestamp | null;
}

/** Phase 4 (roadmap v3) — a manually pasted or uploaded (.srt/.vtt)
 *  transcript, stored per-user/per-video the same way notes/summaries are.
 *  Used as a fallback source for any video with no official captions
 *  (see src/lib/ai/universalTranscript.ts). */
export interface VideoTranscript {
  /** P5: set when the full text lives in Drive but only the preview could be loaded (another user's data). */
  truncated?: boolean;
  /** P5 pointer fields: text over 20 KB is stored in the Drive blob store; `content` is then only a preview. */
  blobKind?: "summary" | "note" | "transcript";
  blobKey?: string;
  bytes?: number;
  videoId: string;
  content: string;
  updatedAt: Timestamp | null;
}

export interface QuizOption {
  id: string;
  text: string;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: QuizOption[];
  correctOptionId: string;
  explanation: string;
}

export interface VideoQuizCache {
  questions: QuizQuestion[];
  generatedAt: Timestamp | null;
  sourceHash: string;
}

export interface QuizAttempt {
  id: string;
  userId: string;
  videoId: string;
  categoryId?: string | null;
  playlistId?: string;
  source?: "shared" | "personal" | "document";
  answers?: QuizAttemptAnswer[];
  score: number;
  totalQuestions: number;
  completedAt: Timestamp | null;
}

export interface QuizAttemptAnswer {
  questionId: string;
  chosenOptionId: string;
  wasCorrect: boolean;
}

export type AiProvider = "gemini" | "openai" | "anthropic" | "openrouter" | "groq";
export const AI_PROVIDERS: AiProvider[] = ["gemini", "openai", "anthropic", "openrouter", "groq"];
export type AiConnectionStatus = "active" | "invalid" | "cooldown";

export interface AiConnection {
  id: string;
  provider: AiProvider;
  encryptedApiKey: string;   // server-only
  maskedKey: string;
  model: string;
  label: string;
  priority: number;
  isActive: boolean;
  status: AiConnectionStatus;
  cooldownUntil: Timestamp | null;
  lastUsedAt: Timestamp | null;
  lastSuccessAt: Timestamp | null;
  lastFailureAt: Timestamp | null;
  createdAt: FirestoreTimeValue;
  updatedAt: FirestoreTimeValue;
}

export interface AiConnectionSummary {
  id: string; provider: AiProvider; model: string; label: string;
  priority: number; isActive: boolean; status: AiConnectionStatus;
  maskedKey: string; lastUsedAt: string | null; lastSuccessAt: string | null;
  lastFailureAt: string | null; createdAt: string | null; updatedAt: string | null;
}

export interface Bookmark {
  id: string;
  videoId: string;
  timestampSeconds: number;
  label: string;
  createdAt: Timestamp | null;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * PERSONAL PLAYLISTS (student-owned content — the third content tier)
 * ─────────────────────────────────────────────────────────────────────────
 * Unlike the shared library (admin-authored, visible to everyone) or the
 * per-video "state" documents (personal state layered on TOP of shared
 * videos), a personal playlist is content a student creates and owns
 * outright: users/{uid}/personalPlaylists/{playlistId}/videos/{videoId}.
 *
 * It's invisible to every other student and only readable/writable by the
 * owner and admins (see firestore.rules). Because nobody but the owner ever
 * touches it, progress/favorite/watchLater/priority live directly on the
 * video document instead of a separate videoStates collection — there's no
 * "shared metadata vs personal state" split to make here, since it's all
 * personal already.
 * ─────────────────────────────────────────────────────────────────────────
 */
export type PersonalPlaylistVisibility = "private" | "link" | "public";
export type PersonalPlaylistSortMode =
  | "custom"
  | "newest"
  | "oldest"
  | "title-asc"
  | "title-desc"
  | "title-natural"
  // | "lesson-part-page"
  | "advanced-keywords"
  | "watched-first"
  | "unwatched-first"
  | "priority"
  | "duration";

/**
 * Denormalized rollup stored on the playlist doc so the Playlists page can show a
 * cover, progress and a "Continue" target WITHOUT reading every video (Firestore
 * bills per document read). Maintained by recomputePlaylistSummary() — see
 * src/lib/playlistSummary.ts. Safe to be missing or stale: the UI degrades to a
 * plain card and the backfill/detail page repairs it.
 */
export interface PlaylistSummary {
  completedCount: number;
  /** Up to 3 still-valid thumbnail URLs, de-duplicated, in playlist order. */
  covers: string[];
  /** Parallel to `covers`: the video page URL each cover came from (Facebook handling). */
  coverVideoUrls: string[];
  /** First unwatched video in the playlist's own order, or null when all are watched / empty. */
  nextVideoId: string | null;
  lastWatchedAt: Timestamp | null;
  computedAt?: Timestamp | FieldValue | null;
}

export interface PersonalPlaylist {
  id: string;
  ownerId: string;
  title: string;
  description?: string;
  categoryId?: string | null;
  tagIds?: string[];
  isUnsorted?: boolean;
  visibility: PersonalPlaylistVisibility;
  sortMode?: PersonalPlaylistSortMode;
  sortOrder?: string[];
  /** User-defined keywords for "advanced-keywords" sort mode, in priority
   *  order (e.g. ["Chapter", "Unit"] sorts by Chapter number first, Unit
   *  number as a tiebreaker). Only meaningful when sortMode is
   *  "advanced-keywords"; see src/lib/keywordSort.ts. */
  sortKeywords?: string[];
  /** Whether finishing a video in this playlist automatically advances to
   *  the next one. Defaults to off (undefined/false) for existing
   *  playlists so nothing changes behavior until a user opts in. */
  autoPlay?: boolean;
  videoCount: number;
  totalDurationSeconds?: number;
  summary?: PlaylistSummary | null;
  /** Set by writes that change what the summary shows (add/remove/move/watched). */
  summaryStale?: boolean;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface PersonalVideo {
  id: string;
  playlistId: string;
  ownerId: string;
  title: string;
  videoUrl: string;
  youtubeVideoId?: string | null;
  thumbnailUrl: string;
  /** @deprecated Legacy base64 thumbnail. Bytes now live in users/{uid}/driveThumbs
   *  (server-only); `thumbnailUrl` is a marker resolved via a signed URL. Cleared by
   *  POST /api/drive/thumbnails/backfill. Do not read this field. */
  thumbnailData?: string | null;
  thumbnailAttemptedAt?: Timestamp | null;
  durationSeconds?: number;
  description?: string | null;
  categoryId?: string | null;
  tagIds?: string[];
  creator?: string | null;
  publishedAt?: string | null;
  platform?: VideoPlatform;
  order: number;
  status: WatchStatus;
  watchedPercentage: number;
  currentPositionSeconds: number;
  isFavorite: boolean;
  isWatchLater: boolean;
  priority: PriorityLevel;
  /** Manual order used within Watch Later / Priority lists (drag & drop), mirrors UserVideoState. */
  watchLaterOrder?: number | null;
  priorityOrder?: number | null;
  /** Set only when platform === "google_drive" (Phase 14/16). The video's
   *  bytes live in Google Drive, not at videoUrl — playback goes through
   *  the signed proxy at /api/drive/stream/[fileId], never a direct Drive
   *  URL or OAuth token in the browser. Ownership is checked when signing.
   *  driveConnectionId records
   *  which of the owner's linked Google accounts holds the file, since a
   *  user may connect more than one (Phase 13). */
  driveFileId?: string | null;
  driveConnectionId?: string | null;
  lastWatchedAt: Timestamp | null;
  completedAt: Timestamp | null;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * GOOGLE DRIVE (Phases 13-17)
 * ─────────────────────────────────────────────────────────────────────────
 * A user can link one or more Google accounts (independent of their Study
 * Lamp login email) via OAuth, using the narrow `drive.file` scope — Study
 * Lamp can only see files the user explicitly picks via the Google Picker
 * or uploads itself, never their whole Drive. This avoids Google's
 * sensitive-scope security review that the broader `drive.readonly`/`drive`
 * scopes require.
 *
 * Stored at users/{uid}/driveConnections/{connectionId}. Like AiConnection,
 * this is denied to the client SDK entirely (see firestore.rules) — every
 * read/write goes through the authenticated /api/drive/* routes using the
 * Admin SDK, and the refresh token is encrypted at rest with the same
 * AES-256-GCM helper used for AI provider keys (src/lib/server/aiEncryption.ts).
 * ─────────────────────────────────────────────────────────────────────────
 */
export type DriveConnectionStatus = "active" | "invalid";

export interface DriveConnection {
  id: string;
  googleEmail: string;
  encryptedRefreshToken: string; // server-only, never sent to the client
  scope: string;
  status: DriveConnectionStatus;
  createdAt: FirestoreTimeValue;
  updatedAt: FirestoreTimeValue;
  lastUsedAt: FirestoreTimeValue | null;
}

/** Safe-to-return projection of a DriveConnection — no token, ever. */
export interface DriveConnectionSummary {
  id: string;
  googleEmail: string;
  status: DriveConnectionStatus;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export type GoogleWorkspaceFeature = "calendar" | "tasks";

export interface GoogleSyncCounts {
  synced: number;
  failed: number;
  remoteDeleted: number;
  /** Goals the user chose to stop syncing after their Google event was deleted. */
  unlinked: number;
  noDate: number;
  orphaned: number;
}

export interface GoogleCalendarConnection {
  id: string;
  enabled: boolean;
  calendarId?: string | null;
  calendarName?: string | null;
  lastSyncAt?: string | null;
  counts: GoogleSyncCounts;
  createdAt: FirestoreTimeValue;
  updatedAt: FirestoreTimeValue;
}

export interface GoogleTasksConnection {
  id: string;
  enabled: boolean;
  listId: string | null;
  listName: string | null;
  lastSyncAt: string | null;
}

/** A mapping whose goal no longer exists (W5). `titleSnapshot` is the goal title as last synced. */
export interface GoogleSyncOrphan {
  goalId: string;
  titleSnapshot: string;
}

export interface GoogleTasksStatus {
  enabled: boolean;
  connectionId: string | null;
  listName: string | null;
  lastSyncAt: string | null;
  counts: GoogleSyncCounts;
  /** Up to 50 mappings whose goal was deleted (W5). Reported only; removal is a separate, confirmed step. */
  orphans?: GoogleSyncOrphan[];
}

/** One line of the sync history (W5). Goal-level fields only: never tokens or document text. */
export interface GoogleSyncHistoryEntry {
  at: string;
  scope: string;
  direction: string;
  itemKind: string;
  goalId?: string;
  titleSnapshot: string;
  fields: Array<{ name: string; before: string | boolean | null; after: string | boolean | null }>;
  result: "applied" | "stale" | "skipped" | "failed";
}

export interface GoogleConnectionSummary {
  id: string;
  googleEmail: string;
  status: "active" | "invalid";
  grantedScopes: GoogleWorkspaceFeature[];
  calendarEnabled: boolean;
  tasksEnabled: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface GoogleSyncStatus {
  enabled: boolean;
  connectionId?: string | null;
  calendarName: string | null;
  lastSyncAt: string | null;
  counts: GoogleSyncCounts;
  /** Up to 50 mappings whose goal was deleted (W5). Reported only; removal is a separate, confirmed step. */
  orphans?: GoogleSyncOrphan[];
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * STUDY MATERIALS (Phases 18-19) — PDFs and Office documents
 * ─────────────────────────────────────────────────────────────────────────
 * A document a student imports from Drive or uploads directly. Lives at
 * users/{uid}/personalDocuments/{id}. The file bytes always live in Google
 * Drive (driveFileId/driveConnectionId) — Study Lamp never stores the raw
 * file itself, matching the video pipeline in Phase 13-16. Notes and AI
 * summaries reuse the existing users/{uid}/notes and /summaries
 * collections with a "d_" id prefix (see src/lib/firestore/notes.ts),
 * the same convention personal videos already use with "p_".
 * ─────────────────────────────────────────────────────────────────────────
 */
export type DocumentFileType = "pdf" | "docx" | "pptx" | "xlsx";
export const DOCUMENT_FILE_TYPES: DocumentFileType[] = ["pdf", "docx", "pptx", "xlsx"];

export interface PersonalDocument {
  id: string;
  ownerId: string;
  title: string;
  fileType: DocumentFileType;
  mimeType: string;
  googleNative?: boolean;
  /** Drive modifiedTime (ISO). For Google-native files this is the "last changed in Google" time. */
  modifiedTime?: string | null;
  sizeBytes?: number | null;
  driveFileId: string;
  driveConnectionId: string;
  /** Marker (see driveThumbnailMarker), resolved to a signed URL by the client.
   *  Absent on documents imported before R3 — derive it from the Drive ids. */
  thumbnailUrl?: string | null;
  /** @deprecated Legacy base64 thumbnail; see PersonalVideo.thumbnailData. Do not read. */
  thumbnailData?: string | null;
  thumbnailAttemptedAt?: Timestamp | null;
  categoryId?: string | null;
  tagIds?: string[];
  readerProgress?: {
    /** PDF page (1-based); always 1 for DOCX/XLSX. */
    lastPage: number;
    /** Zoom factor 0.1..10. */
    zoom: number;
    /** DOCX vertical position, 0..1. */
    scrollRatio?: number;
    /** XLSX active sheet (0-based). */
    sheetIndex?: number;
    /** XLSX first visible data row (0-based). */
    rowIndex?: number;
    updatedAt: Timestamp | null;
  } | null;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export type NotificationType =
  | "goal_pace"
  | "roadmap_ready"
  | "system";

/**
 * A step in the onboarding → roadmap hand-off. Built once when onboarding
 * completes, then carried on the URL (`/roadmap?from=onboarding&generate=…`)
 * so the roadmap page can offer "generate this now" without re-deriving
 * anything — and without writing a half-configured roadmap the user then has
 * to clean up if they decline.
 */
export interface OnboardingRoadmapOffer {
  categoryId: string;
  categoryName: string;
  level: RoadmapLevel;
}

/**
 * One in-app notification, stored at users/{uid}/notifications/{id}.
 *
 * Deliberately shape-only: notifications are created by whichever
 * server-side logic detects the triggering event (goal pace check, roadmap
 * generation complete), read via a plain on-load query (no live listener —
 * same free-tier reasoning as the rest of this app), and updated only when
 * the user marks one read. That's why firestore.rules allows `update` from
 * the client (read-state) but never `create` — see firestore.rules.
 */
export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  /** In-app route to open when the notification is clicked (e.g.
   *  "/goals"). Optional so a purely informational notification can exist
   *  without a destination. */
  linkHref?: string | null;
  read: boolean;
  /** Set when marked read. Used to "mark all read" and to decide which
   *  unread notifications still warrant a badge. */
  readAt?: Timestamp | null;
  createdAt: Timestamp | null;
}

export interface Goal {
  id: string;
  title: string;
  /** Optional free-text detail — "why this matters", success criteria, etc. */
  notes?: string;
  /** ISO date string ("YYYY-MM-DD"), so it sorts/compares as plain text
   *  without needing a Firestore Timestamp for a date-only value the user
   *  picked from a plain <input type="date">. */
  targetDate?: string | null;
  priority?: PriorityLevel;
  completed: boolean;
  completedAt?: Timestamp | null;
  /** Optional link to one of the user's own personal playlists — lets the
   *  Goals page show real watched/total progress instead of a plain
   *  checkbox, e.g. "Finish the ASP.NET Core playlist" tracking itself. The
   *  title is denormalized so the list can render it without an extra
   *  fetch per goal; it's cosmetic only; the id is what's authoritative. */
  /** Deprecated in favor of linkedPlaylists (a goal can now reference
   *  multiple playlists) — kept so goals created before this existed keep
   *  working. New code should read linkedPlaylists first and treat this as
   *  a fallback (see goalUtils.getGoalLinkedPlaylists). Never written by
   *  new/edited goals. */
  linkedPlaylistId?: string | null;
  linkedPlaylistTitle?: string | null;
  /** Personal playlists this goal tracks. Title is denormalized so the
   *  list/card can render without an extra fetch per goal — the id is
   *  authoritative for progress calculation. */
  linkedPlaylists?: { id: string; title: string }[];
  /** Individual videos this goal tracks directly, independent of any
   *  linked playlist. playlistId/playlistTitle are carried along since a
   *  personal video's watch page and progress live under its playlist. If
   *  a video here also belongs to a linkedPlaylists entry, progress
   *  calculation de-duplicates by id rather than double-counting it — see
   *  goalUtils.getGoalVideoIds. */
  linkedVideos?: { id: string; playlistId: string; playlistTitle: string; title: string }[];
  createdAt: Timestamp | null;
  updatedAt?: Timestamp | null;
}

/** Convenience shape combining shared Video + the current user's state,
 *  used throughout the UI (home grid, lists, video page). */
export interface VideoWithState extends Video {
  state: UserVideoState | null;
  playlistTitle?: string;
  /** Which content tier this video came from — the shared/admin library, or
   *  the signed-in user's own "My Playlists". Cross-cutting personal views
   *  (Watch Later, Favorites, Priority, Continue Watching, Dashboard) merge
   *  both tiers, and this tag tells write-handlers which Firestore path to
   *  update. Undefined is treated as "shared" for backward compatibility. */
  source?: "shared" | "personal";
  shareToken?: string;
  shareEntityType?: ShareEntityType;
}

export interface HomeFilters {
  playlistId?: string | null;
  categoryId?: string | null;
  tagId?: string | null;
  platform?: VideoPlatform | null;
  status?: WatchStatus | null;
  favoriteOnly?: boolean;
  watchLaterOnly?: boolean;
  priority?: PriorityLevel;
  query?: string;
}

export type SortOption =
  | "recently-added"
  | "recently-watched"
  | "title-asc"
  | "title-desc"
  | "progress"
  | "duration"
  | "priority"
  | "favorites"
  | "custom-order"
  | "lesson-no"
  | "part-no"
  | "page-no";

export const SORT_LABELS: Record<SortOption, string> = {
  "recently-added": "Recently Added",
  "recently-watched": "Recently Watched",
  "title-asc": "Title A–Z",
  "title-desc": "Title Z–A",
  progress: "Progress",
  duration: "Duration",
  priority: "Priority",
  favorites: "Favorites",
  "custom-order": "Custom Order",
  "lesson-no": "Lesson Number",
  "part-no": "Part Number",
  "page-no": "Page Number",
};

export const PRIORITY_ORDER: Record<Exclude<PriorityLevel, null>, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
