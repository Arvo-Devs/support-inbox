import assert from "node:assert/strict";
import test from "node:test";

import type { SupportInboxDb } from "../config";
import {
  deriveStorageKey,
  drizzleKeyStore,
  keyHint,
  memoryKeyStore,
  openKey,
  sealKey,
} from "./key-store";

// The inbox key Settings saves (Reacharound mode, 2026-10-29): sealed under a
// key derived from the host's secret, opened only with that secret, never
// stored in the clear, and a key that can't be opened reads as "ask again"
// rather than an error. The drizzle store runs against a stand-in for the
// query builder calls it makes; nothing here needs a database.

const SECRET = "s".repeat(64);
const KEY = `rik_${"k".repeat(32)}`;

test("a sealed key opens with the same secret, and the sealed form never contains it", () => {
  const storageKey = deriveStorageKey(SECRET);
  const sealed = sealKey(KEY, storageKey);
  assert.ok(sealed.startsWith("v1."));
  assert.ok(!sealed.includes(KEY));
  assert.ok(!sealed.includes("kkkk"));
  assert.equal(openKey(sealed, storageKey), KEY);
});

test("every seal uses a fresh iv, so one key never seals the same way twice", () => {
  const storageKey = deriveStorageKey(SECRET);
  assert.notEqual(sealKey(KEY, storageKey), sealKey(KEY, storageKey));
});

test("another secret, a damaged value or an unknown format opens to null, never throws", () => {
  const storageKey = deriveStorageKey(SECRET);
  const sealed = sealKey(KEY, storageKey);
  assert.equal(openKey(sealed, deriveStorageKey("t".repeat(64))), null);
  const [format, iv, body] = sealed.split(".") as [string, string, string];
  const damagedBody = `${body.slice(0, 5)}${body[5] === "A" ? "B" : "A"}${body.slice(6)}`;
  for (const damaged of [
    `${format}.${iv}.${damagedBody}`,
    `v2.${iv}.${body}`,
    `${format}.${iv}`,
    `${sealed}.extra`,
    "v1..",
    "",
    "not sealed at all",
  ]) {
    assert.equal(openKey(damaged, storageKey), null, damaged);
  }
});

test("drizzleKeyStore refuses a short or missing secret at creation", () => {
  const db = {} as SupportInboxDb;
  assert.throws(() => drizzleKeyStore(db, { secret: "too short" }), /at least 32 characters/);
  assert.throws(
    () => drizzleKeyStore(db, { secret: undefined as unknown as string }),
    /at least 32 characters/,
  );
});

/** Stands in for the four drizzle calls the store makes, keeping one row. */
function fakeDb() {
  let row: Record<string, unknown> | undefined;
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
          row = row ? { ...row, ...set } : { ...values };
        },
      }),
    }),
  };
  return { db: db as unknown as SupportInboxDb, row: () => row };
}

test("drizzleKeyStore keeps one row: the key sealed, its last four characters and who saved it", async () => {
  const fake = fakeDb();
  const store = drizzleKeyStore(fake.db, { secret: SECRET });
  assert.equal(await store.read(), null);

  const saved = await store.write({ key: KEY, savedBy: "kai@example.com" });
  assert.equal(saved.hint, "kkkk");
  const row = fake.row()!;
  assert.equal(row.id, "reacharound");
  assert.equal(row.reacharoundKeyHint, "kkkk");
  assert.equal(row.updatedBy, "kai@example.com");
  assert.ok(String(row.reacharoundKeyEncrypted).startsWith("v1."));
  assert.ok(!JSON.stringify(row).includes(KEY), "the key is never stored in the clear");

  const read = await store.read();
  assert.equal(read?.key, KEY);
  assert.equal(read?.savedBy, "kai@example.com");

  // Saving again replaces the key in the same row.
  const next = `rik_${"n".repeat(32)}`;
  await store.write({ key: next, savedBy: "adam@example.com" });
  assert.equal((await store.read())?.key, next);
  assert.equal(fake.row()!.reacharoundKeyHint, "nnnn");
});

test("a key saved under another secret reads as unreadable, with its hint, so Settings asks again", async () => {
  const fake = fakeDb();
  await drizzleKeyStore(fake.db, { secret: SECRET }).write({ key: KEY, savedBy: null });
  const read = await drizzleKeyStore(fake.db, { secret: "t".repeat(64) }).read();
  assert.equal(read?.key, null);
  assert.equal(read?.hint, "kkkk");
});

test("drizzleKeyStore takes the database as a function, for a connection made on first use", async () => {
  const fake = fakeDb();
  let asked = 0;
  const store = drizzleKeyStore(
    async () => {
      asked += 1;
      return fake.db;
    },
    { secret: SECRET },
  );
  assert.equal(asked, 0, "nothing connects at creation");
  await store.write({ key: KEY, savedBy: null });
  assert.equal((await store.read())?.key, KEY);
  assert.equal(asked, 2);
});

test("memoryKeyStore keeps the last key saved, with its hint and who saved it", async () => {
  const store = memoryKeyStore();
  assert.equal(await store.read(), null);
  const saved = await store.write({ key: KEY, savedBy: "kai@example.com" });
  assert.equal(saved.hint, "kkkk");
  assert.deepEqual(await store.read(), saved);
  assert.equal((await memoryKeyStore(KEY).read())?.key, KEY);
  assert.equal(keyHint("rik_abcd1234"), "1234");
});
