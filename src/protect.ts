import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors.js';
import { headerValue } from './http.js';

export type RateLimit = {
  limit: number;
  windowMs: number;
};

export type OriginPolicy = { kind: 'loopback' } | { kind: 'list'; origins: ReadonlySet<string> };

export type ListenPolicyInput = {
  host: string;
  production: boolean;
  secureCookies: boolean;
  publicReviewed: boolean;
  allowedOrigins: string[] | undefined;
};

export type ListenPolicy = {
  secureCookies: boolean;
  originPolicy: OriginPolicy;
};

export const DEFAULT_AUTH_RATE_LIMIT: RateLimit = { limit: 40, windowMs: 15 * 60 * 1000 };
export const DEFAULT_CSRF_RATE_LIMIT: RateLimit = { limit: 80, windowMs: 15 * 60 * 1000 };

export class RateLimiter {
  private hits = new Map<string, number[]>();

  take(key: string, nowMs: number, rule: RateLimit): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const windowStart = nowMs - rule.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((stamp) => stamp > windowStart);
    if (recent.length >= rule.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? nowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + rule.windowMs - nowMs) / 1000));
      return { ok: false, retryAfterSeconds };
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return { ok: true };
  }
}

export function clientAddress(req: IncomingMessage): string {
  const raw = req.socket.remoteAddress ?? 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
}

export function statedOrigin(req: IncomingMessage): string | undefined {
  if (req.headers.origin !== undefined) {
    const origin = headerValue(req.headers.origin);
    if (!origin || origin === 'null') {
      return undefined;
    }
    return origin;
  }
  const referer = headerValue(req.headers.referer);
  if (!referer) {
    return undefined;
  }
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

export function originAllowed(origin: string, policy: OriginPolicy): boolean {
  if (policy.kind === 'list') {
    return policy.origins.has(origin);
  }
  return isLoopbackOrigin(origin);
}

export function assertRequestOrigin(req: IncomingMessage, policy: OriginPolicy): void {
  const origin = statedOrigin(req);
  if (!origin || !originAllowed(origin, policy)) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'This origin cannot change cookies.');
  }
}

export function assertRateLimit(limiter: RateLimiter, key: string, nowMs: number, rule: RateLimit): void {
  const decision = limiter.take(key, nowMs, rule);
  if (!decision.ok) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }
}

export function listenHostFromEnv(env: NodeJS.ProcessEnv): string {
  return env.HOST ?? '127.0.0.1';
}

export function listenPortFromEnv(env: NodeJS.ProcessEnv): number {
  const port = Number(env.PORT ?? '8787');
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('PORT must be a positive integer.');
  }
  return port;
}

export function listenPolicyFromEnv(env: NodeJS.ProcessEnv): ListenPolicy {
  const allowedOrigins = env.WORDLOOM_ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim());
  return resolveListenPolicy({
    host: listenHostFromEnv(env),
    production: env.NODE_ENV === 'production',
    secureCookies: env.WORDLOOM_SECURE_COOKIES === '1',
    publicReviewed: env.WORDLOOM_PUBLIC_REVIEWED === '1',
    allowedOrigins,
  });
}

export function resolveListenPolicy(input: ListenPolicyInput): ListenPolicy {
  const loopback = isLoopbackHost(input.host);
  if (!loopback && !input.publicReviewed) {
    throw new Error(
      'Refusing to listen on a public host. Keep HOST on 127.0.0.1 until WORDLOOM_PUBLIC_REVIEWED=1 after review.',
    );
  }
  if (input.production && !input.secureCookies) {
    throw new Error('Production requires WORDLOOM_SECURE_COOKIES=1 so session cookies are marked Secure.');
  }
  if (!loopback && !input.secureCookies) {
    throw new Error('A public listener requires WORDLOOM_SECURE_COOKIES=1.');
  }
  const listed = (input.allowedOrigins ?? []).filter((origin) => origin !== '');
  if ((input.production || !loopback) && listed.length === 0) {
    throw new Error('Production or public listeners require WORDLOOM_ALLOWED_ORIGINS with exact http(s) origins.');
  }
  if (listed.length > 0) {
    for (const origin of listed) {
      assertExactOrigin(origin);
    }
    return { secureCookies: input.secureCookies, originPolicy: { kind: 'list', origins: new Set(listed) } };
  }
  return { secureCookies: input.secureCookies, originPolicy: { kind: 'loopback' } };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return false;
  }
  return isLoopbackHost(url.hostname);
}

function assertExactOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`WORDLOOM_ALLOWED_ORIGINS entry is not an origin: ${origin}`);
  }
  if (url.origin !== origin || url.username || url.password || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(`WORDLOOM_ALLOWED_ORIGINS entry must be an exact http(s) origin: ${origin}`);
  }
}
