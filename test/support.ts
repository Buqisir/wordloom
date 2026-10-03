import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import type { OriginPolicy, RateLimit } from '../src/protect.js';

export type Jar = {
  cookies: Map<string, string>;
  setup: string;
  csrf: string;
};

export type ApiResponse = {
  status: number;
  json: any;
  replayed: boolean;
  setCookie: string[];
  retryAfter: string | null;
};

export type RunningApp = {
  base: string;
  dbPath: string;
  close: () => Promise<void>;
};

export function emptyJar(): Jar {
  return { cookies: new Map(), setup: '', csrf: '' };
}

export async function startApp(options?: {
  secureCookies?: boolean;
  now?: () => Date;
  originPolicy?: OriginPolicy;
  authRateLimit?: RateLimit;
  csrfRateLimit?: RateLimit;
}): Promise<RunningApp> {
  const dir = mkdtempSync(join(tmpdir(), 'wordloom-'));
  const dbPath = join(dir, 'wordloom.sqlite');
  const db: DatabaseSync = openDatabase(dbPath);
  const server: Server = createApp({
    db,
    now: options?.now,
    secureCookies: options?.secureCookies,
    originPolicy: options?.originPolicy,
    authRateLimit: options?.authRateLimit,
    csrfRateLimit: options?.csrfRateLimit,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind a TCP port.');
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    dbPath,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      db.close();
    },
  };
}

export async function api(
  base: string,
  jar: Jar,
  method: string,
  path: string,
  body?: unknown,
  options?: { csrf?: 'setup' | 'session'; idempotencyKey?: string; origin?: string | null; referer?: string },
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  const cookie = [...jar.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  if (cookie) {
    headers.cookie = cookie;
  }
  if (options?.csrf === 'setup') {
    headers['x-csrf-token'] = jar.setup;
  }
  if (options?.csrf === 'session') {
    headers['x-csrf-token'] = jar.csrf;
  }
  if (options?.idempotencyKey) {
    headers['idempotency-key'] = options.idempotencyKey;
  }
  if (options?.origin !== null) {
    headers.origin = options?.origin ?? new URL(base).origin;
  }
  if (options?.referer) {
    headers.referer = options.referer;
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(jar, response.headers.getSetCookie());
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
    replayed: response.headers.get('idempotency-replayed') === 'true',
    setCookie: response.headers.getSetCookie(),
    retryAfter: response.headers.get('retry-after'),
  };
}

export async function register(
  base: string,
  email: string,
  password: string,
): Promise<{ jar: Jar; body: any; setCookie: string[] }> {
  const jar = emptyJar();
  const setup = await api(base, jar, 'GET', '/api/csrf');
  if (setup.status !== 200) {
    throw new Error(`CSRF setup failed: ${setup.status} ${JSON.stringify(setup.json)}`);
  }
  const created = await api(base, jar, 'POST', '/api/auth/register', { email, password }, { csrf: 'setup' });
  if (created.status !== 201) {
    throw new Error(`Register failed: ${created.status} ${JSON.stringify(created.json)}`);
  }
  return { jar, body: created.json, setCookie: created.setCookie };
}

export async function login(base: string, email: string, password: string): Promise<Jar> {
  const jar = emptyJar();
  const setup = await api(base, jar, 'GET', '/api/csrf');
  if (setup.status !== 200) {
    throw new Error(`CSRF setup failed: ${setup.status}`);
  }
  const signedIn = await api(base, jar, 'POST', '/api/auth/login', { email, password }, { csrf: 'setup' });
  if (signedIn.status !== 200) {
    throw new Error(`Login failed: ${signedIn.status} ${JSON.stringify(signedIn.json)}`);
  }
  return jar;
}

function absorb(jar: Jar, lines: string[]): void {
  for (const line of lines) {
    const [pair] = line.split(';');
    if (!pair) {
      continue;
    }
    const separator = pair.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    const value = decodeURIComponent(pair.slice(separator + 1).trim());
    if (/Max-Age=0/i.test(line)) {
      jar.cookies.delete(name);
      if (name === 'wl_csrf') {
        jar.csrf = '';
      }
      if (name === 'wl_setup_csrf') {
        jar.setup = '';
      }
      continue;
    }
    jar.cookies.set(name, value);
    if (name === 'wl_setup_csrf') {
      jar.setup = value;
    }
    if (name === 'wl_csrf') {
      jar.csrf = value;
    }
  }
}
