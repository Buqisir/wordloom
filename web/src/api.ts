import { readResponseText, ResponsePayloadError, stampOwner } from '../../src/clientSync.js';
import type { BackupDocument, ItemJson, OccurrenceJson, ReviewEventJson, SenseJson, UserJson } from '../../src/types.js';

export type SenseDetail = SenseJson & { occurrences: OccurrenceJson[] };

export type HistoryRow = ReviewEventJson & {
  lemma: string;
  meaning: string;
  sentence: string;
  partOfSpeech: string;
};

export type PendingWrite = {
  key: string;
  path: string;
  body: unknown;
  label: string;
  ownerId?: string;
  failure?: { code: string; message: string };
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export class NetworkError extends Error {
  constructor() {
    super('没有连上服务器。');
    this.name = 'NetworkError';
  }
}

export class ResponseReadError extends NetworkError {
  constructor() {
    super();
    this.name = 'ResponseReadError';
  }
}

export type WriteResult<T> = {
  pending: boolean;
  replayed: boolean;
  body: T | null;
};

type ErrorBody = { error?: { code?: string; message?: string } & Record<string, unknown> };

let memoryCsrf = '';

export function setCsrf(token: string): void {
  memoryCsrf = token;
}

export function currentCsrf(): string {
  return cookieValue('wl_csrf') || memoryCsrf;
}

export function cookieValue(name: string): string {
  for (const part of document.cookie.split('; ')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index) === name) {
      return decodeURIComponent(part.slice(index + 1));
    }
  }
  return '';
}

export function explainError(error: ApiError): string {
  const known: Record<string, string> = {
    INVALID_CREDENTIALS: '邮箱或密码不正确。',
    EMAIL_IN_USE: '这个邮箱已经注册。请改为登录。',
    CSRF_FAILED: '安全令牌失效。请再提交一次。',
    REVISION_CONFLICT: '日程刚被另一个会话更新。请按新的间隔再评分。',
    IDEMPOTENCY_CONFLICT: '同一次请求编号已经用于不同的内容。',
    SCHEMA_UNSUPPORTED: '备份的 schemaVersion 不受支持。',
    CONFLICT: '备份里有属于另一个账户的记录。',
    OWNER_MISMATCH: '这次写入属于另一个账户，已保留。',
    SNAPSHOT_CONFLICT: '备份和账户里的同一条记录内容不同。',
    VALIDATION: '提交的内容没有通过校验。',
    UNAUTHENTICATED: '需要登录。',
    NOT_FOUND: '没有找到这条记录。',
  };
  const lead = known[error.code] ?? error.message;
  return error.message && error.message !== lead ? `${lead} ${error.message}（${error.code}）` : `${lead}（${error.code}）`;
}

export async function request<T>(path: string, init?: { method?: string; body?: unknown; csrf?: 'setup' | 'session'; key?: string; ownerId?: string }): Promise<{ status: number; body: T; replayed: boolean }> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (init?.csrf === 'setup') {
    headers['x-csrf-token'] = cookieValue('wl_setup_csrf');
  }
  if (init?.csrf === 'session') {
    headers['x-csrf-token'] = currentCsrf();
  }
  if (init?.key) {
    headers['idempotency-key'] = init.key;
  }
  if (init?.ownerId) {
    headers['x-wordloom-owner'] = init.ownerId;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new NetworkError();
  }
  let text: string;
  try {
    text = await readResponseText(response);
  } catch (error) {
    if (error instanceof ResponsePayloadError) {
      throw new ResponseReadError();
    }
    throw error;
  }
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(response.status, 'INVALID_RESPONSE', '服务器没有返回 JSON。');
    }
  }
  if (!response.ok) {
    const errorBody = parsed as ErrorBody | null;
    const code = errorBody?.error?.code ?? 'REQUEST_FAILED';
    const message = errorBody?.error?.message ?? '请求没有成功。';
    const extra = { ...(errorBody?.error ?? {}) };
    delete extra.code;
    delete extra.message;
    throw new ApiError(response.status, code, message, extra);
  }
  return { status: response.status, body: parsed as T, replayed: response.headers.get('idempotency-replayed') === 'true' };
}

export async function setupCsrf(): Promise<void> {
  await request<{ csrfToken: string }>('/api/csrf');
}

export async function registerAccount(email: string, password: string): Promise<UserJson> {
  await setupCsrf();
  const result = await request<{ user: UserJson; csrfToken: string }>('/api/auth/register', {
    method: 'POST',
    body: { email, password },
    csrf: 'setup',
  });
  setCsrf(result.body.csrfToken);
  return result.body.user;
}

export async function loginAccount(email: string, password: string): Promise<UserJson> {
  await setupCsrf();
  const result = await request<{ user: UserJson; csrfToken: string }>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    csrf: 'setup',
  });
  setCsrf(result.body.csrfToken);
  return result.body.user;
}

export async function logoutAccount(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST', csrf: 'session' });
  setCsrf('');
}

export async function currentUser(): Promise<UserJson> {
  const result = await request<{ user: UserJson }>('/api/auth/me');
  return result.body.user;
}

export async function loadLibrary(ownerId: string): Promise<{
  user: UserJson;
  items: ItemJson[];
  queue: ItemJson[];
  senses: SenseDetail[];
  events: ReviewEventJson[];
}> {
  const result = await request<{
    user: UserJson;
    items: ItemJson[];
    queue: ItemJson[];
    senses: SenseDetail[];
    events: ReviewEventJson[];
  }>('/api/library', { ownerId });
  return result.body;
}

export async function loadBackup(): Promise<BackupDocument> {
  const result = await request<BackupDocument>('/api/backup');
  return result.body;
}

export function storageKey(userId: string): string {
  return `wordloom.pending.v1.${userId}`;
}

export function readPending(userId: string): PendingWrite[] {
  const raw = sessionStorage.getItem(storageKey(userId));
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isPending).map((item) => stampOwner(userId, item));
  } catch {
    return [];
  }
}

export function writePending(userId: string, pending: PendingWrite[]): void {
  sessionStorage.setItem(storageKey(userId), JSON.stringify(pending));
}

export function clearPending(userId: string): void {
  sessionStorage.removeItem(storageKey(userId));
}

function isPending(value: unknown): value is PendingWrite {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.key !== 'string' || typeof record.path !== 'string' || typeof record.label !== 'string' || !('body' in record)) {
    return false;
  }
  if (record.ownerId !== undefined && typeof record.ownerId !== 'string') {
    return false;
  }
  if (record.failure === undefined) {
    return true;
  }
  if (typeof record.failure !== 'object' || record.failure === null) {
    return false;
  }
  const failure = record.failure as Record<string, unknown>;
  return typeof failure.code === 'string' && typeof failure.message === 'string';
}
