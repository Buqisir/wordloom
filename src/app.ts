import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  assertSessionCsrf,
  consumeSetupCsrf,
  issueSetupCsrf,
  loadSession,
  lockedOwner,
  loginAccount,
  logoutAccount,
  readUser,
  registerAccount,
  sessionMaxAgeSeconds,
} from './auth.js';
import { exportBackup, restoreBackup } from './backup.js';
import { canonicalJson, sha256 } from './crypto.js';
import { transaction } from './db.js';
import { HttpError } from './errors.js';
import { headerValue, parseCookies, readJson, sendJson, serializeCookie } from './http.js';
import { createCard, getItem, listAccountEvents, listEvents, listItems, listQueue, listSenses, reviewCard } from './learning.js';
import { warmupPasswordHash } from './passwords.js';
import {
  assertRateLimit,
  assertRequestOrigin,
  clientAddress,
  DEFAULT_AUTH_RATE_LIMIT,
  DEFAULT_CSRF_RATE_LIMIT,
  RateLimiter,
  type OriginPolicy,
  type RateLimit,
} from './protect.js';
import type { ApiResult, SessionRecord } from './types.js';
import { assertIdempotencyKey, assertUuid } from './validate.js';

const CARD_REVIEWS = /^\/api\/cards\/([^/]+)\/reviews$/;
const CARD_EVENTS = /^\/api\/cards\/([^/]+)\/events$/;
const CARD_ONE = /^\/api\/cards\/([^/]+)$/;

export type AppOptions = {
  db: DatabaseSync;
  now?: () => Date;
  secureCookies?: boolean;
  originPolicy?: OriginPolicy;
  authRateLimit?: RateLimit;
  csrfRateLimit?: RateLimit;
};

type Gate = {
  now: () => Date;
  secureCookies: boolean;
  originPolicy: OriginPolicy;
  limiter: RateLimiter;
  authRateLimit: RateLimit;
  csrfRateLimit: RateLimit;
};

export function createApp(options: AppOptions): Server {
  void warmupPasswordHash();
  const gate: Gate = {
    now: options.now ?? (() => new Date()),
    secureCookies: options.secureCookies ?? false,
    originPolicy: options.originPolicy ?? { kind: 'loopback' },
    limiter: new RateLimiter(),
    authRateLimit: options.authRateLimit ?? DEFAULT_AUTH_RATE_LIMIT,
    csrfRateLimit: options.csrfRateLimit ?? DEFAULT_CSRF_RATE_LIMIT,
  };
  return createServer((req, res) => {
    void handle(options.db, gate, req, res);
  });
}

async function handle(db: DatabaseSync, gate: Gate, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const now = gate.now;
  const secureCookies = gate.secureCookies;
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'GET' && path === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && path === '/api/csrf') {
      if (!allowCookieMutation(req, res, gate, 'csrf')) {
        return;
      }
      const token = issueSetupCsrf(db, now());
      sendJson(res, 200, { csrfToken: token }, { 'set-cookie': setupCookie(token, secureCookies) });
      return;
    }
    if (method === 'POST' && (path === '/api/auth/register' || path === '/api/auth/login')) {
      if (!allowCookieMutation(req, res, gate, 'auth')) {
        return;
      }
      const cookies = parseCookies(headerValue(req.headers.cookie));
      const body = await readJson(req);
      consumeSetupCsrf(db, now(), headerValue(req.headers['x-csrf-token']), cookies.wl_setup_csrf);
      const account =
        path.endsWith('/register')
          ? await registerAccount(db, now(), body.email, body.password)
          : await loginAccount(db, now(), body.email, body.password);
      sendJson(res, path.endsWith('/register') ? 201 : 200, { user: account.user, csrfToken: account.csrfToken }, {
        'set-cookie': authCookies(account.sessionToken, account.csrfToken, secureCookies),
      });
      return;
    }

    const session = requireSession(db, req, now());
    if (method === 'POST' && path === '/api/auth/logout') {
      if (!allowCookieMutation(req, res, gate, 'auth')) {
        return;
      }
      const cookies = parseCookies(headerValue(req.headers.cookie));
      assertSessionCsrf(session, headerValue(req.headers['x-csrf-token']), cookies.wl_csrf);
      logoutAccount(db, now(), session.id);
      sendJson(res, 200, { ok: true }, { 'set-cookie': clearCookies(secureCookies) });
      return;
    }
    if (method === 'GET' && path === '/api/auth/me') {
      sendJson(res, 200, { user: readUser(db, session.userId) });
      return;
    }
    if (method === 'GET' && path === '/api/library') {
      const expectedOwner = headerValue(req.headers['x-wordloom-owner']);
      const snapshot = transaction(db, () => {
        const userId = lockedOwner(db, session.id, expectedOwner, now());
        return {
          user: readUser(db, userId),
          items: listItems(db, userId),
          queue: listQueue(db, userId, now()),
          senses: listSenses(db, userId),
          events: listAccountEvents(db, userId),
        };
      });
      sendJson(res, 200, snapshot);
      return;
    }
    if (method === 'GET' && path === '/api/cards') {
      sendJson(res, 200, { items: listItems(db, session.userId) });
      return;
    }
    if (method === 'GET' && path === '/api/queue') {
      sendJson(res, 200, { items: listQueue(db, session.userId, now()) });
      return;
    }
    if (method === 'GET' && path === '/api/senses') {
      sendJson(res, 200, { senses: listSenses(db, session.userId) });
      return;
    }
    if (method === 'GET' && path === '/api/backup') {
      sendJson(res, 200, exportBackup(db, session.userId, now()));
      return;
    }

    if (method === 'POST') {
      const cookies = parseCookies(headerValue(req.headers.cookie));
      assertSessionCsrf(session, headerValue(req.headers['x-csrf-token']), cookies.wl_csrf);
      const body = await readJson(req);
      const key = assertIdempotencyKey(headerValue(req.headers['idempotency-key']));
      const requestHash = sha256(`${method} ${path}\n${canonicalJson(body)}`);
      const expectedOwner = headerValue(req.headers['x-wordloom-owner']);
      if (path === '/api/cards') {
        sendResult(res, createCard(db, now, session.id, expectedOwner, body, key, requestHash));
        return;
      }
      if (path === '/api/backup/restore') {
        sendResult(res, restoreBackup(db, now, session.id, expectedOwner, body, key, requestHash));
        return;
      }
      const reviewMatch = CARD_REVIEWS.exec(path);
      if (reviewMatch?.[1]) {
        sendResult(res, reviewCard(db, now, session.id, expectedOwner, assertUuid(reviewMatch[1], 'card id'), body, key, requestHash));
        return;
      }
    }

    if (method === 'GET') {
      const eventsMatch = CARD_EVENTS.exec(path);
      if (eventsMatch?.[1]) {
        sendJson(res, 200, { events: listEvents(db, session.userId, assertUuid(eventsMatch[1], 'card id')) });
        return;
      }
      const cardMatch = CARD_ONE.exec(path);
      if (cardMatch?.[1]) {
        sendJson(res, 200, { item: getItem(db, session.userId, assertUuid(cardMatch[1], 'card id')) });
        return;
      }
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
  } catch (error) {
    if (error instanceof HttpError) {
      const retryAfter = error.extra?.retryAfterSeconds;
      sendJson(
        res,
        error.status,
        { error: { code: error.code, message: error.message, ...error.extra } },
        typeof retryAfter === 'number' ? { 'retry-after': String(retryAfter) } : undefined,
      );
      return;
    }
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Internal error.' } });
    }
  }
}

function allowCookieMutation(
  req: IncomingMessage,
  res: ServerResponse,
  gate: Gate,
  bucket: 'auth' | 'csrf',
): boolean {
  try {
    guardCookieMutation(req, gate, bucket);
    return true;
  } catch (error) {
    if (error instanceof HttpError) {
      // The body is unread so the password is never hashed. Close the socket
      // instead of leaving a partial body on a keep-alive connection.
      rejectUnread(req, res, error);
      return false;
    }
    throw error;
  }
}

function rejectUnread(req: IncomingMessage, res: ServerResponse, error: HttpError): void {
  const retryAfter = error.extra?.retryAfterSeconds;
  sendJson(
    res,
    error.status,
    { error: { code: error.code, message: error.message, ...error.extra } },
    {
      connection: 'close',
      ...(typeof retryAfter === 'number' ? { 'retry-after': String(retryAfter) } : {}),
    },
  );
  res.on('finish', () => {
    req.destroy();
  });
}

function guardCookieMutation(req: IncomingMessage, gate: Gate, bucket: 'auth' | 'csrf'): void {
  assertRequestOrigin(req, gate.originPolicy);
  const rule = bucket === 'auth' ? gate.authRateLimit : gate.csrfRateLimit;
  assertRateLimit(gate.limiter, `${bucket}:${clientAddress(req)}`, gate.now().getTime(), rule);
}

function requireSession(db: DatabaseSync, req: IncomingMessage, now: Date): SessionRecord {
  const cookies = parseCookies(headerValue(req.headers.cookie));
  const session = loadSession(db, cookies.wl_session, now);
  if (!session) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in is required.');
  }
  return session;
}

function sendResult(res: ServerResponse, result: ApiResult): void {
  sendJson(res, result.status, result.body, result.replayed ? { 'idempotency-replayed': 'true' } : undefined);
}

function setupCookie(token: string, secure: boolean): string {
  return serializeCookie('wl_setup_csrf', token, { secure, maxAge: 600 });
}

function authCookies(sessionToken: string, csrfToken: string, secure: boolean): string[] {
  return [
    serializeCookie('wl_session', sessionToken, { httpOnly: true, secure, maxAge: sessionMaxAgeSeconds }),
    serializeCookie('wl_csrf', csrfToken, { secure, maxAge: sessionMaxAgeSeconds }),
  ];
}

function clearCookies(secure: boolean): string[] {
  return [
    serializeCookie('wl_session', '', { httpOnly: true, secure, maxAge: 0 }),
    serializeCookie('wl_csrf', '', { secure, maxAge: 0 }),
    serializeCookie('wl_setup_csrf', '', { secure, maxAge: 0 }),
  ];
}
