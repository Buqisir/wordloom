export type ProgressRead = {
  userId: string;
  progress: number;
};

export type ObservedRead = ProgressRead & {
  generation: number;
};

export type DueRef = {
  card: { id: string };
  schedule: { due: string };
};

export type PendingIdentity = {
  key: string;
  ownerId?: string;
};

export type WriteFailureKind = 'network' | 'body-read' | 'http';

export type WriteOutcome = 'committed' | 'retryable' | 'rejected' | 'owner-mismatch' | 'unauthenticated';

export function isDue(due: string, nowMs: number): boolean {
  const parsed = Date.parse(due);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

export function commitProgressRead(
  current: ProgressRead,
  observed: ObservedRead,
  confirmed: ProgressRead,
  fetchSucceeded: boolean,
  latestGeneration: number,
): { progress: number; userId: string; accept: boolean } {
  const sameAccount = current.userId === '' || current.userId === confirmed.userId;
  if (
    fetchSucceeded &&
    observed.generation === latestGeneration &&
    observed.userId === confirmed.userId &&
    observed.progress === confirmed.progress &&
    sameAccount
  ) {
    return { progress: confirmed.progress, userId: confirmed.userId, accept: true };
  }
  return { progress: current.progress, userId: current.userId, accept: false };
}

export function queueOmitsElapsedDue(items: DueRef[], queue: DueRef[], nowMs: number): boolean {
  const shown = new Set(queue.map((item) => item.card.id));
  return items.some((item) => isDue(item.schedule.due, nowMs) && !shown.has(item.card.id));
}

export function shouldReloadLibrary(input: {
  readConfirmed: boolean;
  revisionChanged: boolean;
  userChanged: boolean;
  elapsedDue: boolean;
}): boolean {
  return !input.readConfirmed || input.revisionChanged || input.userChanged || input.elapsedDue;
}

export function mergePendingAfterFlush<T extends { key: string }>(snapshot: T[], remain: T[], latest: T[]): T[] {
  const snapshotKeys = new Set(snapshot.map((item) => item.key));
  const seen = new Set(remain.map((item) => item.key));
  const merged = [...remain];
  for (const item of latest) {
    if (snapshotKeys.has(item.key) || seen.has(item.key)) {
      continue;
    }
    merged.push(item);
    seen.add(item.key);
  }
  return merged;
}

export function pendingSendable<T extends PendingIdentity>(
  sessionUserId: string,
  pending: T[],
): { send: T[]; keep: T[] } {
  const send: T[] = [];
  const keep: T[] = [];
  for (const item of pending) {
    if ((item.ownerId ?? sessionUserId) === sessionUserId) {
      send.push(item);
    } else {
      keep.push(item);
    }
  }
  return { send, keep };
}

export function stampOwner<T extends { ownerId?: string }>(userId: string, item: T): T & { ownerId: string } {
  const ownerId = item.ownerId && item.ownerId.length > 0 ? item.ownerId : userId;
  return { ...item, ownerId };
}

export function classifyWriteFailure(kind: WriteFailureKind, status?: number, code?: string): WriteOutcome {
  if (kind === 'network' || kind === 'body-read') {
    return 'retryable';
  }
  if (status === 401 || code === 'UNAUTHENTICATED') {
    return 'unauthenticated';
  }
  if (code === 'OWNER_MISMATCH') {
    return 'owner-mismatch';
  }
  if (status !== undefined && status >= 500) {
    return 'retryable';
  }
  return 'rejected';
}

export function retainPending(outcome: WriteOutcome): boolean {
  return outcome === 'retryable' || outcome === 'owner-mismatch' || outcome === 'unauthenticated';
}

export function nextProgressRevision(live: number, snapshot: number): number {
  return Math.max(live, snapshot) + 1;
}

export function nextScheduleRevision(live: number, snapshot: number): number {
  return Math.max(live, snapshot) + 1;
}

export class ResponsePayloadError extends Error {
  constructor() {
    super('response-body');
    this.name = 'ResponsePayloadError';
  }
}

export async function readResponseText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch {
    throw new ResponsePayloadError();
  }
}

export type SyncAccount = {
  id: string;
  email: string;
  progressRevision: number;
};

export type WriteFailure = {
  code: string;
  message: string;
};

export type OutboxWrite = PendingIdentity & {
  path: string;
  body: unknown;
  label: string;
  ownerId: string;
  failure?: WriteFailure;
};

export type LibrarySnapshot<TItem, TSense, TEvent> = {
  user: SyncAccount;
  items: TItem[];
  queue: TItem[];
  senses: TSense[];
  events: TEvent[];
};

export type SyncTransport<TItem, TSense, TEvent> = {
  currentUser(): Promise<SyncAccount>;
  loadLibrary(expectedOwnerId: string): Promise<LibrarySnapshot<TItem, TSense, TEvent>>;
  send(item: OutboxWrite): Promise<{ replayed: boolean }>;
};

export type SyncStorage = {
  read(userId: string): OutboxWrite[];
  write(userId: string, items: OutboxWrite[]): void;
};

export type SyncClassifier = {
  outcome(error: unknown): WriteOutcome;
  failure(error: unknown): WriteFailure;
};

export class SyncError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.code = code;
  }
}

export function acceptLibrarySnapshot(input: {
  expectedOwnerId: string;
  epoch: number;
  latestEpoch: number;
  generation: number;
  latestGeneration: number;
  fetchSucceeded: boolean;
  snapshotUserId: string;
}): boolean {
  return (
    input.fetchSucceeded &&
    input.expectedOwnerId.length > 0 &&
    input.epoch === input.latestEpoch &&
    input.generation === input.latestGeneration &&
    input.snapshotUserId === input.expectedOwnerId
  );
}

export type SyncView<TItem, TSense, TEvent> = {
  booting: boolean;
  online: boolean;
  epoch: number;
  user: SyncAccount | null;
  items: TItem[];
  queue: TItem[];
  senses: TSense[];
  events: TEvent[];
  pending: OutboxWrite[];
  notice: string;
  recovery: string;
  readError: string | null;
  readConfirmed: boolean;
  lastRead: string | null;
};

type SyncOptions = {
  online?: boolean;
  onChange?: () => void;
  lock?: (userId: string, run: () => Promise<void>) => Promise<void>;
  stamp?: () => string;
};

export class SyncController<TItem extends DueRef, TSense, TEvent> {
  private epoch = 0;
  private generation = 0;
  private bootSerial = 0;
  private active: Promise<void> | null = null;
  private blocked = false;
  private polling = false;
  private booting = true;
  private online: boolean;
  private user: SyncAccount | null = null;
  private items: TItem[] = [];
  private queue: TItem[] = [];
  private senses: TSense[] = [];
  private events: TEvent[] = [];
  private pending: OutboxWrite[] = [];
  private notice = '';
  private recovery = '';
  private readError: string | null = null;
  private readConfirmed = false;
  private lastRead: string | null = null;
  private progress = 0;

  constructor(
    private readonly transport: SyncTransport<TItem, TSense, TEvent>,
    private readonly storage: SyncStorage,
    private readonly classifier: SyncClassifier,
    private readonly createKey: () => string,
    private readonly options: SyncOptions = {},
  ) {
    this.online = options.online ?? true;
  }

  snapshot(): SyncView<TItem, TSense, TEvent> {
    return {
      booting: this.booting,
      online: this.online,
      epoch: this.epoch,
      user: this.user,
      items: this.items,
      queue: this.queue,
      senses: this.senses,
      events: this.events,
      pending: this.pending,
      notice: this.notice,
      recovery: this.recovery,
      readError: this.readError,
      readConfirmed: this.readConfirmed,
      lastRead: this.lastRead,
    };
  }

  cancelBoot(): void {
    this.bootSerial += 1;
  }

  setOnline(online: boolean): void {
    if (this.online === online) {
      return;
    }
    this.online = online;
    this.touch();
  }

  setNotice(notice: string): void {
    this.notice = notice;
    this.touch();
  }

  adopt(account: SyncAccount): void {
    this.epoch += 1;
    this.generation += 1;
    this.user = account;
    this.items = [];
    this.queue = [];
    this.senses = [];
    this.events = [];
    this.progress = 0;
    this.readConfirmed = false;
    this.readError = null;
    this.pending = this.storage.read(account.id);
    this.notice = '';
    this.recovery = '';
    this.touch();
  }

  logoutLocal(userId: string | null): void {
    const kept = userId ? this.storage.read(userId).length : 0;
    this.epoch += 1;
    this.generation += 1;
    this.user = null;
    this.items = [];
    this.queue = [];
    this.senses = [];
    this.events = [];
    this.pending = [];
    this.progress = 0;
    this.readConfirmed = false;
    this.notice = '';
    this.readError = null;
    this.recovery = kept > 0 ? recoveryCopy(kept) : '';
    this.touch();
  }

  noteRead(): void {
    this.lastRead = this.options.stamp?.() ?? new Date().toISOString();
    this.touch();
  }

  dismiss(key: string): void {
    const userId = this.user?.id;
    if (!userId) {
      return;
    }
    const next = this.storage.read(userId).filter((item) => item.key !== key || !item.failure);
    this.storage.write(userId, next);
    this.pending = next;
    this.touch();
  }

  blocksPath(path: string): boolean {
    return this.pending.some((item) => item.path === path && !item.failure);
  }

  async boot(loadAccount: () => Promise<SyncAccount>): Promise<void> {
    const bootId = ++this.bootSerial;
    const epoch = this.epoch;
    try {
      const account = await loadAccount();
      if (this.bootSerial !== bootId || this.epoch !== epoch) {
        return;
      }
      this.adopt(account);
      await this.reload();
      if (this.bootSerial !== bootId) {
        return;
      }
      await this.flush();
    } catch (error) {
      if (this.bootSerial !== bootId || this.epoch !== epoch) {
        return;
      }
      if (this.classifier.outcome(error) === 'unauthenticated') {
        this.user = null;
        this.touch();
      } else {
        this.readConfirmed = false;
        this.readError = error instanceof Error ? error.message : '没能读取账户。';
        this.touch();
      }
    } finally {
      if (this.bootSerial === bootId) {
        this.booting = false;
        this.touch();
      }
    }
  }

  async reload(): Promise<boolean> {
    const capturedEpoch = this.epoch;
    const expectedOwnerId = this.user?.id ?? '';
    if (!expectedOwnerId) {
      return false;
    }
    const generation = ++this.generation;
    try {
      const snapshot = await this.transport.loadLibrary(expectedOwnerId);
      const accept = acceptLibrarySnapshot({
        expectedOwnerId,
        epoch: capturedEpoch,
        latestEpoch: this.epoch,
        generation,
        latestGeneration: this.generation,
        fetchSucceeded: true,
        snapshotUserId: snapshot.user.id,
      });
      if (!accept || this.user?.id !== expectedOwnerId) {
        if (this.epoch === capturedEpoch && this.generation === generation) {
          this.readConfirmed = false;
          this.touch();
        }
        return false;
      }
      this.user = snapshot.user;
      this.items = snapshot.items;
      this.queue = snapshot.queue;
      this.senses = snapshot.senses;
      this.events = snapshot.events;
      this.pending = this.storage.read(snapshot.user.id);
      this.progress = snapshot.user.progressRevision;
      this.readConfirmed = true;
      this.readError = null;
      this.lastRead = this.options.stamp?.() ?? this.lastRead;
      this.touch();
      return true;
    } catch (error) {
      if (this.epoch !== capturedEpoch || this.generation !== generation) {
        return false;
      }
      if (this.classifier.outcome(error) === 'unauthenticated') {
        this.loseAuth(expectedOwnerId, capturedEpoch);
        return false;
      }
      this.readConfirmed = false;
      this.readError = error instanceof Error ? error.message : '没能读取账户。';
      this.touch();
      return false;
    }
  }

  async submit(path: string, body: unknown, label: string): Promise<{ pending: boolean; replayed: boolean }> {
    const current = this.user;
    if (!current) {
      throw new SyncError(401, 'UNAUTHENTICATED', '需要登录。');
    }
    const capturedEpoch = this.epoch;
    const signature = JSON.stringify(body);
    const existing = this.storage
      .read(current.id)
      .find((item) => item.path === path && JSON.stringify(item.body) === signature && item.ownerId === current.id && !item.failure);
    const entry: OutboxWrite = existing ?? {
      key: this.createKey(),
      path,
      body,
      label,
      ownerId: current.id,
    };
    this.remember(current.id, entry);
    if (!this.online) {
      this.notice = '还没送到服务器。';
      this.touch();
      return { pending: true, replayed: false };
    }
    await this.kick(current.id, capturedEpoch);
    if (this.epoch !== capturedEpoch || this.user?.id !== current.id) {
      return { pending: true, replayed: false };
    }
    const still = this.storage.read(current.id).find((item) => item.key === entry.key);
    if (still?.failure) {
      throw new SyncError(409, still.failure.code, still.failure.message);
    }
    if (still) {
      this.releaseStaleSaveNotice();
      return { pending: true, replayed: false };
    }
    return { pending: false, replayed: this.notice.includes('没有再次写入') };
  }

  async flush(): Promise<void> {
    const current = this.user;
    if (!current || !this.online) {
      return;
    }
    await this.kick(current.id, this.epoch);
  }

  async poll(nowMs: number): Promise<void> {
    if (this.polling) {
      return;
    }
    const capturedEpoch = this.epoch;
    const current = this.user;
    if (!current || !this.online) {
      return;
    }
    this.polling = true;
    let generation = this.generation;
    try {
      if (this.hasSendable(current.id)) {
        await this.kick(current.id, capturedEpoch);
        if (this.epoch !== capturedEpoch || this.user?.id !== current.id) {
          return;
        }
        if (queueOmitsElapsedDue(this.items, this.queue, nowMs)) {
          await this.reload();
        }
        return;
      }
      generation = this.generation;
      const next = await this.transport.currentUser();
      if (this.epoch !== capturedEpoch || this.generation !== generation) {
        return;
      }
      const userChanged = next.id !== current.id;
      const revisionChanged = next.progressRevision !== this.progress;
      const elapsed = queueOmitsElapsedDue(this.items, this.queue, nowMs);
      if (
        !shouldReloadLibrary({
          readConfirmed: this.readConfirmed,
          revisionChanged,
          userChanged,
          elapsedDue: elapsed,
        })
      ) {
        if (this.epoch !== capturedEpoch || this.generation !== generation) {
          return;
        }
        this.user = next;
        this.readError = null;
        this.lastRead = this.options.stamp?.() ?? this.lastRead;
        this.touch();
        return;
      }
      const before = this.progress;
      if (userChanged) {
        this.adopt(next);
      }
      const accepted = await this.reload();
      if (!userChanged && accepted && this.epoch === capturedEpoch && this.progress !== before) {
        this.notice = '进度版本已更新。';
        this.touch();
      }
    } catch (error) {
      if (this.epoch !== capturedEpoch || this.generation !== generation) {
        return;
      }
      if (this.classifier.outcome(error) === 'unauthenticated') {
        this.loseAuth(current.id, capturedEpoch);
        return;
      }
      this.readConfirmed = false;
      this.readError = error instanceof Error ? error.message : '没有连上服务器。';
      this.touch();
    } finally {
      this.polling = false;
    }
  }

  private async kick(userId: string, epoch: number): Promise<void> {
    if (this.active) {
      await this.active;
      if (this.online && !this.blocked && this.epoch === epoch && this.user?.id === userId && this.hasSendable(userId)) {
        await this.kick(userId, epoch);
      }
      return;
    }
    if (!this.online || this.epoch !== epoch || this.user?.id !== userId || !this.hasSendable(userId)) {
      return;
    }
    let finished!: () => void;
    const marker = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.active = marker;
    let stop: 'retry-later' | 'done' = 'done';
    try {
      stop = await this.drain(userId, epoch);
    } finally {
      this.active = null;
      finished();
    }
    if (stop === 'retry-later' || !this.online || this.blocked) {
      return;
    }
    if (this.epoch === epoch && this.user?.id === userId && this.hasSendable(userId)) {
      await this.kick(userId, epoch);
    }
  }

  private async drain(userId: string, capturedEpoch: number): Promise<'retry-later' | 'done'> {
    let stop: 'retry-later' | 'done' = 'done';
    const run = async (): Promise<void> => {
      stop = await this.sendQueued(userId, capturedEpoch);
    };
    if (this.options.lock) {
      await this.options.lock(userId, run);
    } else {
      await run();
    }
    return stop;
  }

  private async sendQueued(userId: string, capturedEpoch: number): Promise<'retry-later' | 'done'> {
    let committed = false;
    this.blocked = false;
    const stillHere = (): boolean => this.epoch === capturedEpoch && this.user?.id === userId;
    while (stillHere()) {
      if (!this.online) {
        this.blocked = true;
        if (committed) {
          await this.reload();
        }
        return 'retry-later';
      }
      const next = this.storage.read(userId).find((item) => item.ownerId === userId && !item.failure);
      if (!next) {
        break;
      }
      const generation = this.generation;
      let live: SyncAccount;
      try {
        live = await this.transport.currentUser();
      } catch (error) {
        if (this.epoch !== capturedEpoch || this.generation !== generation) {
          return 'retry-later';
        }
        this.blocked = true;
        if (this.classifier.outcome(error) === 'unauthenticated') {
          this.loseAuth(userId, capturedEpoch);
          return 'retry-later';
        }
        this.readError = error instanceof Error ? error.message : '没有连上服务器。';
        this.releaseStaleSaveNotice();
        this.touch();
        return 'retry-later';
      }
      if (this.epoch !== capturedEpoch || this.generation !== generation) {
        return 'retry-later';
      }
      if (!this.online) {
        this.blocked = true;
        if (committed) {
          await this.reload();
        }
        return 'retry-later';
      }
      if (live.id !== userId) {
        this.adopt(live);
        await this.reload();
        return 'retry-later';
      }
      try {
        const result = await this.transport.send(next);
        this.removeStored(userId, next.key);
        if (!stillHere() || this.generation !== generation) {
          return 'retry-later';
        }
        committed = true;
        this.pending = this.storage.read(userId);
        this.notice = result.replayed ? '服务器返回了上次同一请求的结果，没有再次写入。' : '已保存到账户。';
        this.touch();
      } catch (error) {
        const stale = this.epoch !== capturedEpoch || this.generation !== generation;
        const outcome = this.classifier.outcome(error);
        if (outcome === 'rejected') {
          this.stampFailure(userId, next.key, this.classifier.failure(error));
          if (stale || !stillHere()) {
            return 'retry-later';
          }
          this.pending = this.storage.read(userId);
          this.touch();
          continue;
        }
        if (stale) {
          return 'retry-later';
        }
        if (outcome === 'unauthenticated') {
          this.loseAuth(userId, capturedEpoch);
          this.blocked = true;
          return 'retry-later';
        }
        if (outcome === 'owner-mismatch') {
          this.notice = '这次写入属于另一个账户，已保留。';
          this.blocked = true;
          this.touch();
          return 'retry-later';
        }
        this.readError = error instanceof Error ? error.message : '没有连上服务器。';
        this.notice = '还没送到服务器。';
        this.blocked = true;
        this.touch();
        return 'retry-later';
      }
    }
    if (committed && stillHere()) {
      await this.reload();
    }
    return 'done';
  }

  private loseAuth(userId: string, capturedEpoch: number): void {
    if (this.epoch !== capturedEpoch) {
      return;
    }
    if (this.user && this.user.id !== userId) {
      return;
    }
    const kept = this.storage.read(userId);
    this.epoch += 1;
    this.generation += 1;
    this.user = null;
    this.items = [];
    this.queue = [];
    this.senses = [];
    this.events = [];
    this.pending = [];
    this.progress = 0;
    this.readConfirmed = false;
    this.notice = '';
    if (kept.length > 0) {
      this.recovery = recoveryCopy(kept.length);
    }
    this.touch();
  }

  private releaseStaleSaveNotice(): void {
    if (!this.notice.includes('已保存到账户')) {
      return;
    }
    this.notice = '';
    this.touch();
  }

  private remember(userId: string, entry: OutboxWrite): void {
    const current = this.storage.read(userId);
    const next = current.some((item) => item.key === entry.key) ? current : [...current, entry];
    this.storage.write(userId, next);
    if (this.user?.id === userId) {
      this.pending = next;
    }
    this.touch();
  }

  private removeStored(userId: string, key: string): void {
    const next = this.storage.read(userId).filter((item) => item.key !== key);
    this.storage.write(userId, next);
    if (this.user?.id === userId) {
      this.pending = next;
    }
  }

  private stampFailure(userId: string, key: string, failure: WriteFailure): void {
    const next = this.storage.read(userId).map((item) => (item.key === key ? { ...item, failure } : item));
    this.storage.write(userId, next);
    if (this.user?.id === userId) {
      this.pending = next;
    }
  }

  private hasSendable(userId: string): boolean {
    return this.storage.read(userId).some((item) => item.ownerId === userId && !item.failure);
  }

  private touch(): void {
    this.options.onChange?.();
  }
}

function recoveryCopy(count: number): string {
  return `这个账户还有 ${count} 次写入没送到服务器。下次用同一账户登录会继续发送。`;
}

export function reconcileFlush<T extends PendingIdentity>(input: {
  snapshot: T[];
  sessionUserId: string;
  outcomes: Array<{ key: string; outcome: WriteOutcome }>;
  latest: T[];
}): T[] {
  const { send } = pendingSendable(input.sessionUserId, input.snapshot);
  const sendKeys = new Set(send.map((item) => item.key));
  const outcomeByKey = new Map(input.outcomes.map((item) => [item.key, item.outcome]));
  const remain = input.snapshot.filter((item) => {
    if (!sendKeys.has(item.key)) {
      return true;
    }
    const outcome = outcomeByKey.get(item.key);
    if (!outcome) {
      return true;
    }
    return retainPending(outcome);
  });
  return mergePendingAfterFlush(input.snapshot, remain, input.latest);
}
