import { EJSON } from "bson";
import type { Db } from "mongodb";

// A full snapshot of every collection in the database. We dump and restore at the raw
// collection level (rather than per Mongoose model) so the backup captures everything —
// launches, the funding/tx caches, attendee reports, wallet labels, and all the persisted
// indexer settings/checkpoints (IndexState, IndexerControl, IndexerStatus) — in one file.
//
// Documents are serialized with Extended JSON so non-plain BSON values (ObjectId `_id`s,
// any Date fields) round-trip losslessly through export -> file -> import.

export const BACKUP_TYPE = "token-launch-analyzer-backup";
export const BACKUP_VERSION = 1;

export interface Backup {
  type: string;
  version: number;
  exportedAt: string;
  // collection name -> array of documents (Extended JSON form)
  collections: Record<string, unknown[]>;
}

// Internal Mongo bookkeeping collections that must never be exported or overwritten.
function isSystemCollection(name: string): boolean {
  return name.startsWith("system.");
}

// Serialize the whole database to an Extended-JSON string ready to stream to the client.
export async function exportDatabase(db: Db, exportedAt: string): Promise<string> {
  const collections = await db.collections();
  const dump: Record<string, unknown[]> = {};
  for (const collection of collections) {
    if (isSystemCollection(collection.collectionName)) continue;
    dump[collection.collectionName] = await collection.find({}).toArray();
  }
  const backup: Backup = { type: BACKUP_TYPE, version: BACKUP_VERSION, exportedAt, collections: dump };
  // relaxed: false keeps numeric/date types unambiguous so import reconstructs them exactly.
  return EJSON.stringify(backup, { relaxed: false });
}

// Parse + validate a backup string. Throws a descriptive error if it isn't one of ours.
export function parseBackup(raw: string): Backup {
  let parsed: unknown;
  try {
    parsed = EJSON.parse(raw);
  } catch {
    throw new Error("File is not valid JSON");
  }
  const backup = parsed as Partial<Backup>;
  if (!backup || backup.type !== BACKUP_TYPE || typeof backup.collections !== "object" || backup.collections === null) {
    throw new Error("Not a Launch Analyzer backup file");
  }
  return backup as Backup;
}

// Replace every collection in the backup with its saved contents. Each restored collection is
// fully cleared first, so the result is an exact mirror of the snapshot (not a merge).
export async function importDatabase(db: Db, backup: Backup): Promise<Record<string, number>> {
  const summary: Record<string, number> = {};
  for (const [name, docs] of Object.entries(backup.collections)) {
    if (isSystemCollection(name) || !Array.isArray(docs)) continue;
    const collection = db.collection(name);
    await collection.deleteMany({});
    if (docs.length) await collection.insertMany(docs as Record<string, unknown>[]);
    summary[name] = docs.length;
  }
  return summary;
}
