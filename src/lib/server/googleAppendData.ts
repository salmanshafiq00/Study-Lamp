import { readStoredTextServer } from "@/lib/server/largeTextServer";
import { realBlobDeps } from "@/lib/server/blobRouteDeps";
import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { getDocumentQuiz } from "@/lib/server/quiz";
import type { DocAppendSourceData, GoogleDocAppendKind, QuizAttemptRecord, QuizQuestionRecord } from "@/lib/server/googleAppend";
import type { PersonalDocumentRecord } from "@/lib/server/googleAppendApply";

/**
 * Firestore reads/writes for the Docs/Sheets append flow. ADMIN SDK ONLY (Rule 3): the previous
 * version imported getNote/getSummary from the client SDK module, which cannot read user data on the server.
 */

const MAX_ATTEMPTS_READ = 500;

function userRef(uid: string) {
  return adminDb.collection("users").doc(uid);
}

export async function loadPersonalDocumentRecord(uid: string, documentId: string): Promise<PersonalDocumentRecord | null> {
  const snap = await userRef(uid).collection("personalDocuments").doc(documentId).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  return {
    title: typeof data.title === "string" && data.title ? data.title : "Study material",
    googleNative: data.googleNative === true,
    fileType: typeof data.fileType === "string" ? data.fileType : undefined,
    driveFileId: typeof data.driveFileId === "string" ? data.driveFileId : undefined,
    driveConnectionId: typeof data.driveConnectionId === "string" ? data.driveConnectionId : undefined,
  };
}

/**
 * Quiz attempts for one document. A single equality filter (no orderBy) needs no composite index;
 * ordering and the source check happen in code.
 */
export async function loadDocumentAttempts(uid: string, documentId: string): Promise<QuizAttemptRecord[]> {
  const snap = await userRef(uid).collection("quizAttempts").where("videoId", "==", `d_${documentId}`).limit(MAX_ATTEMPTS_READ).get();
  const attempts: QuizAttemptRecord[] = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.source !== "document") continue;
    const completed = data.completedAt;
    attempts.push({
      id: doc.id,
      score: Number(data.score ?? 0),
      totalQuestions: Number(data.totalQuestions ?? 0),
      completedAt: completed && typeof completed.toDate === "function" ? completed.toDate() : null,
      quizTitle: typeof data.quizTitle === "string" ? data.quizTitle : undefined,
      answers: Array.isArray(data.answers)
        ? data.answers
            .filter((entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === "object")
            .map((entry: Record<string, unknown>) => ({
              questionId: String(entry.questionId ?? ""),
              chosenOptionId: String(entry.chosenOptionId ?? ""),
              wasCorrect: entry.wasCorrect === true,
            }))
        : [],
    });
  }
  return attempts;
}

export async function loadDocAppendInputs(uid: string, documentId: string, kind: GoogleDocAppendKind): Promise<DocAppendSourceData> {
  if (kind === "summary") {
    const snap = await userRef(uid).collection("summaries").doc(`d_${documentId}`).get();
    return { summaryHtml: await readStoredTextServer(realBlobDeps, uid, snap.data()) };
  }
  if (kind === "notes") {
    const snap = await userRef(uid).collection("notes").doc(`d_${documentId}`).get();
    return { note: await readStoredTextServer(realBlobDeps, uid, snap.data()) };
  }
  const [attempts, quiz] = await Promise.all([loadDocumentAttempts(uid, documentId), getDocumentQuiz(uid, documentId).catch(() => null)]);
  const questions: QuizQuestionRecord[] = (quiz?.questions ?? []).map((question) => ({
    id: question.id,
    prompt: question.prompt,
    options: question.options.map((option) => ({ id: option.id, text: option.text })),
    correctOptionId: question.correctOptionId,
  }));
  return { attempts, questions };
}

// ─── Export markers (server-only): users/{uid}/googleExports/{attemptId}_{documentId} ──────────

function exportRef(uid: string, attemptId: string, documentId: string) {
  return userRef(uid).collection("googleExports").doc(`${attemptId}_${documentId}`);
}

export async function loadExportedAttemptIds(uid: string, documentId: string, attemptIds: string[]): Promise<Set<string>> {
  const exported = new Set<string>();
  for (let start = 0; start < attemptIds.length; start += 100) {
    const chunk = attemptIds.slice(start, start + 100);
    if (chunk.length === 0) continue;
    const snaps = await adminDb.getAll(...chunk.map((id) => exportRef(uid, id, documentId)));
    snaps.forEach((snap, index) => {
      if (snap.exists) exported.add(chunk[index]);
    });
  }
  return exported;
}

/** Marks exactly the given attempts (the ones in the confirmed plan) as exported to this document. */
export async function markAttemptsExported(uid: string, documentId: string, attemptIds: string[]): Promise<void> {
  for (let start = 0; start < attemptIds.length; start += 400) {
    const batch = adminDb.batch();
    for (const attemptId of attemptIds.slice(start, start + 400)) {
      batch.set(exportRef(uid, attemptId, documentId), {
        attemptId,
        documentId,
        at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
}
