import {
  collection, doc, getCountFromServer, getDoc, getDocs, limit, orderBy, query, serverTimestamp, startAfter, Timestamp, updateDoc, where,
  type QueryDocumentSnapshot,
} from "@/lib/firestore/instrumented";
import { cachedRead } from "@/lib/readCache";
import { db } from "@/lib/firebase";
import type { Role, UserProfile, UserStatsSnapshot, UserVideoState } from "@/types";
import { todayKey } from "@/lib/utils";

export const USER_PAGE_SIZE = 25;

export interface UserPage {
  users: UserProfile[];
  /** Pass back as `after` for the next page; null when this was the last page. */
  cursor: QueryDocumentSnapshot | null;
}

/** One bounded page of users (P2). Replaces the old whole-collection read: reads = page size, not user count. */
export async function listUsersPage(pageSize = USER_PAGE_SIZE, after?: QueryDocumentSnapshot | null): Promise<UserPage> {
  const constraints = [orderBy("createdAt", "desc"), ...(after ? [startAfter(after)] : []), limit(pageSize)];
  const snap = await getDocs(query(collection(db, "users"), ...constraints));
  return {
    users: snap.docs.map((d) => ({ uid: d.id, ...d.data() }) as UserProfile),
    cursor: snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null,
  };
}

async function countUsers(...constraints: Parameters<typeof where>[] ): Promise<number> {
  const filters = constraints.map(([field, op, value]) => where(field, op, value));
  const snap = await getCountFromServer(query(collection(db, "users"), ...filters));
  return snap.data().count;
}

export interface AdminUserCounts {
  totalUsers: number;
  activeToday: number;
  activeThisWeek: number;
  activeThisMonth: number;
  neverLoggedIn: number;
  adminCount: number;
  studentCount: number;
  disabledCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Admin dashboard totals from aggregate COUNT queries (1 read per 1,000 index entries each), cached 10 minutes. */
export function getAdminUserCounts(now: Date = new Date()): Promise<AdminUserCounts> {
  return cachedRead("admin:userCounts", 10 * 60_000, async () => {
    const since = (days: number) => Timestamp.fromMillis(now.getTime() - days * DAY_MS);
    const [totalUsers, adminCount, disabledCount, neverLoggedIn, activeToday, activeThisWeek, activeThisMonth] = await Promise.all([
      countUsers(),
      countUsers(["role", "==", "admin"]),
      countUsers(["status", "==", "disabled"]),
      countUsers(["lastActiveAt", "==", null]),
      countUsers(["lastActiveAt", ">=", since(1)]),
      countUsers(["lastActiveAt", ">=", since(7)]),
      countUsers(["lastActiveAt", ">=", since(30)]),
    ]);
    return { totalUsers, activeToday, activeThisWeek, activeThisMonth, neverLoggedIn, adminCount, studentCount: Math.max(0, totalUsers - adminCount), disabledCount };
  });
}

/** Users who signed up in the last `days` days, capped at `max` documents (signup chart only). */
export function listRecentSignups(days = 30, max = 500, now: Date = new Date()): Promise<UserProfile[]> {
  return cachedRead(`admin:signups:${days}`, 10 * 60_000, async () => {
    const since = Timestamp.fromMillis(now.getTime() - days * DAY_MS);
    const snap = await getDocs(query(collection(db, "users"), where("createdAt", ">=", since), orderBy("createdAt", "desc"), limit(max)));
    return snap.docs.map((d) => ({ uid: d.id, ...d.data() }) as UserProfile);
  });
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? ({ uid: snap.id, ...snap.data() } as UserProfile) : null;
}

export async function setUserRole(uid: string, role: Role) {
  await updateDoc(doc(db, "users", uid), { role });
}

export async function setUserStatus(uid: string, status: "active" | "disabled") {
  await updateDoc(doc(db, "users", uid), { status });
}

/**
 * Computes a stats snapshot for a single student from their (small) personal
 * videoStates collection, then writes it onto users/{uid}.stats so the admin
 * table can render every student's row from ONE read (the users collection)
 * instead of fanning out into every student's subcollections on every page
 * load. Call this on meaningful events (video completed, admin dashboard
 * "refresh") rather than continuously.
 */
export async function recomputeUserStats(uid: string): Promise<UserStatsSnapshot> {
  const snap = await getDocs(query(collection(db, "users", uid, "videoStates"), limit(1000))); // stats snapshot; bounded
  const states = snap.docs.map((d) => d.data() as UserVideoState);

  let completed = 0, inProgress = 0, favorites = 0, watchLater = 0, priority = 0, totalWatchTimeSeconds = 0;
  const watchedDates = new Set<string>();

  for (const s of states) {
    if (s.status === "completed") completed++;
    else if (s.status === "in_progress") inProgress++;
    if (s.isFavorite) favorites++;
    if (s.isWatchLater) watchLater++;
    if (s.priority) priority++;
    // Rough watch-time estimate: percentage watched as a fraction of a nominal
    // slot isn't available without duration here, so this is refined at the
    // video level (see stats.ts) when durations are known; kept simple for MVP.
    if (s.lastWatchedAt && typeof (s.lastWatchedAt as any).toDate === "function") {
      watchedDates.add((s.lastWatchedAt as any).toDate().toISOString().slice(0, 10));
    }
  }

  const currentStreakDays = computeStreak(watchedDates);

  const statsSnapshot: UserStatsSnapshot = {
    totalVideos: states.length,
    completed,
    inProgress,
    notStarted: Math.max(0, states.length - completed - inProgress),
    favorites,
    watchLater,
    priority,
    totalWatchTimeSeconds,
    currentStreakDays,
    lastStreakDate: todayKey(),
    updatedAt: serverTimestamp() as any,
  };

  await updateDoc(doc(db, "users", uid), { stats: statsSnapshot });
  return statsSnapshot;
}

function computeStreak(watchedDates: Set<string>): number {
  let streak = 0;
  const cursor = new Date();
  // Walk backwards from today while consecutive days have activity.
  for (;;) {
    const key = cursor.toISOString().slice(0, 10);
    if (watchedDates.has(key)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}
