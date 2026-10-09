/**
 * Read-only size report for ONE user (roadmap P1). Run manually:
 *   npx tsx scripts/firestoreSizes.ts <uid> [maxDocsPerCollection=500]
 * Prints document counts and approximate bytes (JSON length) per collection shape and the 20 largest documents
 * (path + bytes only; contents are never printed). It READS documents, so it costs reads: keep the cap low.
 */
import { adminDb } from "../src/lib/server/firebase-admin";

type Stat = { docs: number; bytes: number };

async function main() {
  const uid = process.argv[2];
  const cap = Math.max(1, Number(process.argv[3] ?? 500) || 500);
  if (!uid || !/^[A-Za-z0-9_-]{6,128}$/.test(uid)) {
    console.error("Usage: npx tsx scripts/firestoreSizes.ts <uid> [maxDocsPerCollection]");
    process.exit(1);
  }

  const shapes = new Map<string, Stat>();
  const largest: Array<{ path: string; bytes: number }> = [];

  async function walk(collections: FirebaseFirestore.CollectionReference[], shape: string) {
    for (const collection of collections) {
      const key = `${shape}/${collection.id}`;
      const snapshot = await collection.limit(cap).get();
      for (const doc of snapshot.docs) {
        const bytes = Buffer.byteLength(JSON.stringify(doc.data()));
        const stat = shapes.get(key) ?? { docs: 0, bytes: 0 };
        stat.docs += 1;
        stat.bytes += bytes;
        shapes.set(key, stat);
        largest.push({ path: doc.ref.path, bytes });
        if (largest.length > 400) { largest.sort((a, b) => b.bytes - a.bytes); largest.length = 100; }
        await walk(await doc.ref.listCollections(), key);
      }
      if (snapshot.size === cap) console.warn(`note: ${key} capped at ${cap} documents`);
    }
  }

  const userRef = adminDb.collection("users").doc(uid);
  await walk(await userRef.listCollections(), "users/{uid}");

  console.table(Object.fromEntries([...shapes.entries()].map(([key, stat]) => [key, { docs: stat.docs, approxKB: Math.round(stat.bytes / 102.4) / 10 }])));
  largest.sort((a, b) => b.bytes - a.bytes);
  console.log("20 largest documents:");
  console.table(largest.slice(0, 20).map((item) => ({ path: item.path.replace(uid, "{uid}"), bytes: item.bytes, over20KB: item.bytes > 20 * 1024 })));
}

main().catch((error) => { console.error("firestoreSizes failed:", error instanceof Error ? error.name : typeof error); process.exit(1); });
