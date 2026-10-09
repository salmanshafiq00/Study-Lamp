import { collection, getDocs, limit, orderBy, query, startAfter, type QueryConstraint, type QueryDocumentSnapshot } from "@/lib/firestore/instrumented";
import { db } from "@/lib/firebase";
import type { QuizAttempt } from "@/types";

export const QUIZ_ATTEMPT_PAGE_SIZE = 50;

export interface QuizAttemptPage {
  items: QuizAttempt[];
  /** Pass back as `after` to load the next page; null when there is nothing more. */
  cursor: QueryDocumentSnapshot | null;
}

/** One bounded page, newest first. A full page returns a cursor ("Load more"). */
export async function listQuizAttemptsPage(uid: string, pageSize = QUIZ_ATTEMPT_PAGE_SIZE, after?: QueryDocumentSnapshot | null): Promise<QuizAttemptPage> {
  const constraints: QueryConstraint[] = [orderBy("completedAt", "desc")];
  if (after) constraints.push(startAfter(after));
  constraints.push(limit(pageSize));
  const snap = await getDocs(query(collection(db, "users", uid, "quizAttempts"), ...constraints));
  const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as QuizAttempt));
  return { items, cursor: snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null };
}

/** Newest attempts only (first page). Use listQuizAttemptsPage for "Load more". */
export async function listQuizAttempts(uid: string): Promise<QuizAttempt[]> {
  return (await listQuizAttemptsPage(uid)).items;
}
