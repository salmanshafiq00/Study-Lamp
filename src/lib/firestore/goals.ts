import { addDoc, collection, deleteDoc, doc, getDocs, limit, orderBy, query, serverTimestamp, updateDoc } from "@/lib/firestore/instrumented";
import { db } from "@/lib/firebase";
import type { Goal, PriorityLevel } from "@/types";

const goalsCol = (uid: string) => collection(db, "users", uid, "goals");

export async function listGoals(uid: string): Promise<Goal[]> {
  const q = query(goalsCol(uid), orderBy("createdAt", "desc"), limit(500)); // safety cap; goals stay far below this
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Goal);
}

export interface GoalInput {
  title: string;
  notes?: string;
  /** ISO date string ("YYYY-MM-DD") or null/undefined to leave it unset. */
  targetDate?: string | null;
  priority?: PriorityLevel;
  linkedPlaylists?: { id: string; title: string }[];
  linkedVideos?: { id: string; playlistId: string; playlistTitle: string; title: string }[];
}

/** Returns the new goal's id (so callers can ask Google Calendar sync about exactly this goal). */
export async function addGoal(uid: string, input: GoalInput): Promise<string> {
  const ref = await addDoc(goalsCol(uid), {
    title: input.title,
    notes: input.notes || "",
    targetDate: input.targetDate || null,
    priority: input.priority || null,
    linkedPlaylists: input.linkedPlaylists || [],
    linkedVideos: input.linkedVideos || [],
    completed: false,
    completedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/** Edits an existing goal's fields (title, notes, due date, priority, or
 *  linked playlist) without touching its completed state. */
export async function updateGoal(uid: string, goalId: string, patch: Partial<GoalInput>) {
  await updateDoc(doc(db, "users", uid, "goals", goalId), {
    ...patch,
    updatedAt: serverTimestamp(),
  });
}

export async function toggleGoal(uid: string, goalId: string, completed: boolean) {
  await updateDoc(doc(db, "users", uid, "goals", goalId), {
    completed,
    completedAt: completed ? serverTimestamp() : null,
    updatedAt: serverTimestamp(),
  });
}

export async function removeGoal(uid: string, goalId: string) {
  await deleteDoc(doc(db, "users", uid, "goals", goalId));
}
