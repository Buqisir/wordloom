import { randomUUID as uuid } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sha256, randomToken, tokensEqual } from './crypto.js';
import { transaction } from './db.js';
import { HttpError } from './errors.js';
import { assertPassword, hashPassword, verifyPassword, warmupPasswordHash } from './passwords.js';
import type { SessionRecord, UserJson } from './types.js';
import { normalizeEmail } from './validate.js';

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SETUP_MS = 10 * 60 * 1000;

export const sessionMaxAgeSeconds = SESSION_SECONDS;

export function issueSetupCsrf(db: DatabaseSync, now: Date): string {
  const token = randomToken();
  const expires = new Date(now.getTime() + SETUP_MS).toISOString();
  db.prepare('INSERT INTO csrf_challenges (token_hash, expires_at) VALUES (?, ?)').run(sha256(token), expires);
  return token;
}

export function consumeSetupCsrf(db: DatabaseSync, now: Date, header: string | undefined, cookie: string | undefined): void {
  if (!header || !cookie || !tokensEqual(header, cookie)) {
    throw new HttpError(403, 'CSRF_FAILED', 'CSRF token is missing or invalid.');
  }
  const hash = sha256(header);
  const nowIso = now.toISOString();
  transaction(db, () => {
    const row = db.prepare('SELECT token_hash FROM csrf_challenges WHERE token_hash = ? AND expires_at > ?').get(hash, nowIso);
    if (!row) {
      throw new HttpError(403, 'CSRF_FAILED', 'CSRF token is missing or invalid.');
    }
    db.prepare('DELETE FROM csrf_challenges WHERE token_hash = ?').run(hash);
  });
}

export function assertSessionCsrf(session: SessionRecord, header: string | undefined, cookie: string | undefined): void {
  if (!header || !cookie || !tokensEqual(header, cookie) || !tokensEqual(sha256(header), session.csrfTokenHash)) {
    throw new HttpError(403, 'CSRF_FAILED', 'CSRF token is missing or invalid.');
  }
}

export async function registerAccount(
  db: DatabaseSync,
  now: Date,
  emailValue: unknown,
  passwordValue: unknown,
): Promise<{ user: UserJson; sessionToken: string; csrfToken: string }> {
  const email = normalizeEmail(emailValue);
  const password = assertPassword(passwordValue);
  const passwordHash = await hashPassword(password);
  return insertSession(db, now, () => {
    try {
      const id = uuid();
      db.prepare('INSERT INTO users (id, email, password_hash, progress_revision, created_at) VALUES (?, ?, ?, 0, ?)').run(
        id,
        email,
        passwordHash,
        now.toISOString(),
      );
      return id;
    } catch (error) {
      if (isUnique(error)) {
        throw new HttpError(409, 'EMAIL_IN_USE', 'An account with that email already exists.');
      }
      throw error;
    }
  });
}

export async function loginAccount(
  db: DatabaseSync,
  now: Date,
  emailValue: unknown,
  passwordValue: unknown,
): Promise<{ user: UserJson; sessionToken: string; csrfToken: string }> {
  const email = normalizeEmail(emailValue);
  const password = assertPassword(passwordValue);
  const row = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email) as
    | { id: string; password_hash: string }
    | undefined;
  const hash = row?.password_hash ?? (await warmupPasswordHash());
  const matches = await verifyPassword(password, hash);
  if (!row || !matches) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
  return insertSession(db, now, () => row.id);
}

export function logoutAccount(db: DatabaseSync, now: Date, sessionId: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now.toISOString(), sessionId);
}

export function lockedOwner(db: DatabaseSync, sessionId: string, expectedOwner: string | undefined, now: Date): string {
  const expected = expectedOwner?.trim() ?? '';
  if (!expected) {
    throw new HttpError(400, 'VALIDATION', 'X-Wordloom-Owner is required.');
  }
  const row = db
    .prepare('SELECT user_id, expires_at, revoked_at FROM sessions WHERE id = ?')
    .get(sessionId) as { user_id: string; expires_at: string; revoked_at: string | null } | undefined;
  if (!row || row.revoked_at !== null || row.expires_at <= now.toISOString()) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in is required.');
  }
  if (row.user_id !== expected) {
    throw new HttpError(409, 'OWNER_MISMATCH', 'This write belongs to a different account.');
  }
  return row.user_id;
}

export function loadSession(db: DatabaseSync, token: string | undefined, now: Date): SessionRecord | undefined {
  if (!token) {
    return undefined;
  }
  const row = db.prepare(
    'SELECT id, user_id, csrf_token_hash, expires_at, revoked_at FROM sessions WHERE token_hash = ?',
  ).get(sha256(token)) as
    | { id: string; user_id: string; csrf_token_hash: string; expires_at: string; revoked_at: string | null }
    | undefined;
  if (!row || row.revoked_at !== null || row.expires_at <= now.toISOString()) {
    return undefined;
  }
  return { id: row.id, userId: row.user_id, csrfTokenHash: row.csrf_token_hash, expiresAt: row.expires_at };
}

export function readUser(db: DatabaseSync, userId: string): UserJson {
  const row = db.prepare('SELECT id, email, progress_revision FROM users WHERE id = ?').get(userId) as
    | { id: string; email: string; progress_revision: number }
    | undefined;
  if (!row) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in is required.');
  }
  return { id: row.id, email: row.email, progressRevision: asNumber(row.progress_revision) };
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  throw new HttpError(500, 'BAD_ROW', 'Expected a number.');
}

function insertSession(db: DatabaseSync, now: Date, userIdFor: () => string): { user: UserJson; sessionToken: string; csrfToken: string } {
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString();
  const userId = transaction(db, () => {
    const id = userIdFor();
    db.prepare(
      'INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, expires_at, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    ).run(uuid(), id, sha256(sessionToken), sha256(csrfToken), expiresAt, createdAt);
    return id;
  });
  return { user: readUser(db, userId), sessionToken, csrfToken };
}

function isUnique(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE');
}
