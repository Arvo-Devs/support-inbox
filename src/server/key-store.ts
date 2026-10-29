import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import type { SupportInboxDb } from "../config";
import { supportInboxSettings } from "../schema";

// Reacharound mode: the brand's inbox key, kept by the app itself (2026-10-28,
// Kai: "There should be a settings button in the top right to be able to add
// the key over here. That should be a part of the import too"). An admin
// pastes the key on the Email page's Settings and it lives here from then on,
// so connecting an app needs no server setting and no redeploy, and a key
// replaced in Reacharound is fixed from the same page.
//
// The key can send email as the brand, so it is stored encrypted (AES-256-GCM
// under a key derived from the host's own secret) and never leaves the
// server: the browser only ever sees its last four characters.

/** What Settings saved: the key, and what the dialog shows about it. */
export type ReacharoundSavedKey = {
  /** The key itself, or null when one is saved but can't be opened (the app's secret changed since). */
  key: string | null;
  /** Its last four characters: all the browser ever sees of it. */
  hint: string;
  savedAt: Date;
  /** Who saved it (the admin's email), when known. */
  savedBy: string | null;
};

/**
 * Where the Email page keeps the brand's inbox key. `drizzleKeyStore` keeps it
 * in the app's database; `memoryKeyStore` is for tests and trying the page
 * locally.
 */
export type ReacharoundKeyStore = {
  read(): Promise<ReacharoundSavedKey | null>;
  write(input: { key: string; savedBy: string | null }): Promise<ReacharoundSavedKey>;
};

/** The one row Settings writes. A fixed id, so saving again replaces it. */
const ROW_ID = "reacharound";
const FORMAT = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function keyHint(key: string): string {
  return key.slice(-4);
}

/**
 * A key for this one purpose, derived from the host's secret: the raw secret
 * (usually the app's Better Auth secret) is never used as an AES key, and
 * nothing else derived from it can open what this seals.
 */
export function deriveStorageKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "@arvo/support-inbox", "reacharound inbox key v1", 32));
}

/** `v1.<iv>.<ciphertext + tag>`, base64url, a fresh iv every time. */
export function sealKey(plain: string, storageKey: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", storageKey, iv);
  const sealed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${FORMAT}.${iv.toString("base64url")}.${sealed.toString("base64url")}`;
}

/**
 * The key, or null when it can't be opened: sealed under another secret,
 * damaged, or in a format this version doesn't know.
 */
export function openKey(stored: string, storageKey: Buffer): string | null {
  const [format, ivPart, sealedPart, extra] = stored.split(".");
  if (format !== FORMAT || !ivPart || !sealedPart || extra !== undefined) return null;
  try {
    const iv = Buffer.from(ivPart, "base64url");
    const sealed = Buffer.from(sealedPart, "base64url");
    if (iv.length !== IV_BYTES || sealed.length <= TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", storageKey, iv);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Keeps the key in the app's own database: the `support_inbox_settings` table
 * (`@arvo/support-inbox/schema`; its DDL is migrations/0002_support_inbox_settings.sql,
 * which the host copies into its own migrations like 0001).
 *
 * `db` may be a function, for a host whose connection is made (or migrated) on
 * first use. `secret` encrypts the key: pass the app's Better Auth secret. If
 * that secret ever changes, the saved key can't be opened any more and the
 * Email page asks for it again; nothing else breaks.
 */
export function drizzleKeyStore(
  db: SupportInboxDb | (() => SupportInboxDb | Promise<SupportInboxDb>),
  options: { secret: string },
): ReacharoundKeyStore {
  if (typeof options?.secret !== "string" || options.secret.length < 32) {
    throw new Error(
      "[support-inbox] drizzleKeyStore needs a secret of at least 32 characters to encrypt the inbox key: pass the app's Better Auth secret",
    );
  }
  const storageKey = deriveStorageKey(options.secret);
  const handle = async (): Promise<SupportInboxDb> => (typeof db === "function" ? await db() : db);

  return {
    async read() {
      const [row] = await (await handle())
        .select()
        .from(supportInboxSettings)
        .where(eq(supportInboxSettings.id, ROW_ID))
        .limit(1);
      if (!row?.reacharoundKeyEncrypted) return null;
      return {
        key: openKey(row.reacharoundKeyEncrypted, storageKey),
        hint: row.reacharoundKeyHint ?? "",
        savedAt: row.updatedAt,
        savedBy: row.updatedBy,
      };
    },
    async write({ key, savedBy }) {
      const values = {
        reacharoundKeyEncrypted: sealKey(key, storageKey),
        reacharoundKeyHint: keyHint(key),
        updatedAt: new Date(),
        updatedBy: savedBy,
      };
      await (await handle())
        .insert(supportInboxSettings)
        .values({ id: ROW_ID, ...values })
        .onConflictDoUpdate({ target: supportInboxSettings.id, set: values });
      return { key, hint: values.reacharoundKeyHint, savedAt: values.updatedAt, savedBy };
    },
  };
}

/** Keeps the key in this process only: for tests, and for trying the page locally. */
export function memoryKeyStore(initialKey?: string): ReacharoundKeyStore {
  let saved: ReacharoundSavedKey | null = initialKey
    ? { key: initialKey, hint: keyHint(initialKey), savedAt: new Date(), savedBy: null }
    : null;
  return {
    async read() {
      return saved;
    },
    async write({ key, savedBy }) {
      saved = { key, hint: keyHint(key), savedAt: new Date(), savedBy };
      return saved;
    },
  };
}
