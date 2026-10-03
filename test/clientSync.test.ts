import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  classifyWriteFailure,
  commitProgressRead,
  isDue,
  mergePendingAfterFlush,
  nextProgressRevision,
  nextScheduleRevision,
  pendingSendable,
  queueOmitsElapsedDue,
  readResponseText,
  reconcileFlush,
  ResponsePayloadError,
  retainPending,
  SyncController,
  type LibrarySnapshot,
  type OutboxWrite,
  type SyncAccount,
  type SyncClassifier,
  type SyncStorage,
  type WriteFailure,
  type WriteOutcome,
  shouldReloadLibrary,
  stampOwner,
} from '../src/clientSync.js';

const accountA = 'account-a';
const accountB = 'account-b';

describe('client sync decisions', () => {
  it('advances a progress read only after the same revision is confirmed for the same account', () => {
    const current = { userId: accountA, progress: 3 };
    const failed = commitProgressRead(current, { userId: accountA, progress: 4, generation: 1 }, { userId: accountA, progress: 4 }, false, 1);
    assert.equal(failed.accept, false);
    assert.equal(failed.progress, 3);

    const drifted = commitProgressRead(current, { userId: accountA, progress: 4, generation: 1 }, { userId: accountA, progress: 5 }, true, 1);
    assert.equal(drifted.accept, false);
    assert.equal(drifted.progress, 3);

    const older = commitProgressRead(
      { userId: accountA, progress: 5 },
      { userId: accountA, progress: 5, generation: 1 },
      { userId: accountA, progress: 5 },
      true,
      2,
    );
    assert.equal(older.accept, false);

    const otherAccount = commitProgressRead(
      { userId: accountB, progress: 5 },
      { userId: accountA, progress: 5, generation: 2 },
      { userId: accountA, progress: 5 },
      true,
      2,
    );
    assert.equal(otherAccount.accept, false);
    assert.equal(otherAccount.userId, accountB);

    const retry = commitProgressRead(current, { userId: accountA, progress: 4, generation: 3 }, { userId: accountA, progress: 4 }, true, 3);
    assert.equal(retry.accept, true);
    assert.equal(retry.progress, 4);
  });

  it('reloads when a known card becomes due without a revision change', () => {
    const due = '2026-04-01T12:01:00.000Z';
    const items = [{ card: { id: 'card-1' }, schedule: { due } }];
    const hidden = queueOmitsElapsedDue(items, [], Date.parse(due));
    const notYet = queueOmitsElapsedDue(items, [], Date.parse(due) - 1);
    const shown = queueOmitsElapsedDue(items, items, Date.parse(due));
    assert.equal(isDue('not-a-date', Date.parse(due)), false);
    assert.equal(notYet, false);
    assert.equal(hidden, true);
    assert.equal(shown, false);
    assert.equal(
      shouldReloadLibrary({ readConfirmed: true, revisionChanged: false, userChanged: false, elapsedDue: hidden }),
      true,
    );
    assert.equal(
      shouldReloadLibrary({ readConfirmed: true, revisionChanged: false, userChanged: false, elapsedDue: false }),
      false,
    );
    assert.equal(
      shouldReloadLibrary({ readConfirmed: false, revisionChanged: false, userChanged: false, elapsedDue: false }),
      true,
    );
  });

  it('keeps the same pending key when the response body cannot be read', () => {
    const entry = { key: 'same-key', ownerId: accountA, path: '/api/cards', body: { lemma: 'keel' } };
    const outcome = classifyWriteFailure('body-read');
    assert.equal(outcome, 'retryable');
    assert.equal(retainPending(outcome), true);
    const kept = reconcileFlush({
      snapshot: [entry],
      sessionUserId: accountA,
      outcomes: [{ key: entry.key, outcome }],
      latest: [entry],
    });
    assert.deepEqual(
      kept.map((item) => item.key),
      ['same-key'],
    );
    const retried = reconcileFlush({
      snapshot: kept,
      sessionUserId: accountA,
      outcomes: [{ key: 'same-key', outcome: 'committed' }],
      latest: kept,
    });
    assert.deepEqual(retried, []);
  });

  it('keeps a write enqueued while a flush is awaiting the network', () => {
    const first = { key: 'a', ownerId: accountA };
    const during = { key: 'b', ownerId: accountA };
    const merged = mergePendingAfterFlush([first], [], [first, during]);
    assert.deepEqual(
      merged.map((item) => item.key),
      ['b'],
    );
  });

  it('preserves account-bound pending writes after 401 and does not send them for another account', () => {
    const owned = { key: 'owned', ownerId: accountA };
    const later = { key: 'later', ownerId: accountA };
    const during = { key: 'during', ownerId: accountA };
    const kept = reconcileFlush({
      snapshot: [owned, later],
      sessionUserId: accountA,
      outcomes: [{ key: owned.key, outcome: classifyWriteFailure('http', 401, 'UNAUTHENTICATED') }],
      latest: [owned, later, during],
    });
    assert.deepEqual(
      kept.map((item) => item.key),
      ['owned', 'later', 'during'],
    );
    const split = pendingSendable(accountB, kept.map((item) => stampOwner(accountA, item)));
    assert.deepEqual(split.send, []);
    assert.equal(split.keep.length, 3);
    const sameAccount = pendingSendable(accountA, [{ key: 'legacy' }]);
    assert.deepEqual(
      sameAccount.send.map((item) => item.key),
      ['legacy'],
    );
  });

  it('moves a replace restore past both the live revision and the snapshot', () => {
    assert.equal(nextProgressRevision(3, 2), 4);
    assert.equal(nextProgressRevision(2, 9), 10);
    assert.equal(nextProgressRevision(4, 4), 5);
    assert.equal(nextScheduleRevision(2, 1), 3);
    assert.equal(nextScheduleRevision(1, 4), 5);
  });

  it('wires the screen to the ordered controller and an owner-bound library read', () => {
    const appSource = readFileSync(new URL('../../web/src/app.tsx', import.meta.url), 'utf8');
    const apiSource = readFileSync(new URL('../../web/src/api.ts', import.meta.url), 'utf8');
    const serverSource = readFileSync(new URL('../../src/app.ts', import.meta.url), 'utf8');
    assert.equal(appSource.includes('clearPending'), false);
    assert.equal(appSource.includes('async function submitWrite'), false);
    assert.equal(appSource.includes('async function flush'), false);
    assert.ok(appSource.includes('new SyncController'));
    assert.ok(appSource.includes('controller.submit'));
    assert.ok(apiSource.includes('readResponseText'));
    assert.ok(apiSource.includes('/api/library'));
    assert.ok(apiSource.includes("headers['x-wordloom-owner']"));
    assert.ok(serverSource.includes("path === '/api/library'"));
    assert.ok(serverSource.includes('lockedOwner'));
  });
});

type DueItem = { card: { id: string }; schedule: { due: string }; sense?: { lemma: string } };

describe('sync controller races', { timeout: 5000 }, () => {
  it('keeps a newer session when an older reload fails or succeeds late', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    const first = fixture.controller.reload();
    fixture.loads[0]?.gate.resolve(library(accountAUser, 'abandon'));
    assert.equal(await first, true);
    assert.equal(fixture.controller.snapshot().items[0]?.card.id, 'abandon');

    const stale = fixture.controller.reload();
    fixture.controller.adopt(accountBUser);
    assert.equal(fixture.controller.snapshot().user?.id, accountB);
    assert.equal(fixture.controller.snapshot().items.length, 0);
    const current = fixture.controller.reload();
    const currentLoad = fixture.loads.find((item) => item.owner === accountB);
    currentLoad?.gate.resolve(library(accountBUser, 'lumen'));
    assert.equal(await current, true);
    assert.equal(fixture.controller.snapshot().items[0]?.card.id, 'lumen');

    const staleLoad = fixture.loads.find((item) => item.owner === accountA && item !== fixture.loads[0]);
    staleLoad?.gate.reject(tagged('unauthenticated'));
    assert.equal(await stale, false);
    assert.equal(fixture.controller.snapshot().user?.id, accountB);
    assert.equal(fixture.controller.snapshot().items[0]?.card.id, 'lumen');

    const lateSuccess = fixture.controller.reload();
    fixture.controller.adopt(accountAUser);
    const switched = fixture.controller.reload();
    fixture.loads.filter((item) => item.owner === accountA).at(-1)?.gate.resolve(library(accountAUser, 'keel'));
    assert.equal(await switched, true);
    fixture.loads.filter((item) => item.owner === accountB).at(-1)?.gate.resolve(library(accountBUser, 'lumen'));
    assert.equal(await lateSuccess, false);
    assert.equal(fixture.controller.snapshot().user?.id, accountA);
    assert.equal(fixture.controller.snapshot().items[0]?.card.id, 'keel');
  });

  it('does not paint another account when the snapshot user does not match', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    const reading = fixture.controller.reload();
    fixture.loads[0]?.gate.resolve(library(accountBUser, 'lumen'));
    assert.equal(await reading, false);
    assert.equal(fixture.controller.snapshot().user?.id, accountA);
    assert.equal(fixture.controller.snapshot().items.length, 0);
    assert.equal(fixture.controller.snapshot().readConfirmed, false);
  });

  it('sends a later add only after a delayed restore resolves', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    const restore = fixture.controller.submit('/api/backup/restore', { mode: 'replace' }, '导入备份');
    await until(() => fixture.sends.length === 1);
    assert.equal(fixture.store.read(accountA).some((item) => item.path === '/api/backup/restore'), true);
    const add = fixture.controller.submit('/api/cards', { lemma: 'keel' }, '添加卡片');
    await until(() => fixture.store.read(accountA).length === 2);
    assert.equal(fixture.sends.length, 1);
    assert.equal(fixture.sends[0]?.item.path, '/api/backup/restore');
    fixture.sends[0]?.gate.resolve({ replayed: false });
    await until(() => fixture.sends.length === 2);
    assert.equal(fixture.sends[1]?.item.path, '/api/cards');
    fixture.sends[1]?.gate.resolve({ replayed: false });
    await until(() => fixture.loads.length === 1);
    fixture.loads[0]?.gate.resolve(library(accountAUser, 'keel'));
    await restore;
    await add;
    assert.deepEqual(
      fixture.sends.map((item) => item.item.path),
      ['/api/backup/restore', '/api/cards'],
    );
  });

  it('keeps the same key when the response body cannot be read and does not skip ahead', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    const log: string[] = [];
    const gate = deferred<void>();
    fixture.transport.send = async (item) => {
      log.push(`start ${item.path} ${item.key}`);
      const started = log.filter((line) => line.startsWith('start')).length;
      if (started === 1) {
        await readResponseText({
          text: () => gate.promise.then(() => Promise.reject(new Error('reset'))),
        });
      }
      const text = await readResponseText({ text: async () => '{"ok":true}' });
      assert.equal(text, '{"ok":true}');
      log.push(`end ${item.path} ${item.key}`);
      return { replayed: false };
    };
    const first = fixture.controller.submit('/api/backup/restore', { mode: 'replace' }, '导入备份');
    await until(() => log.length === 1);
    const second = fixture.controller.submit('/api/cards', { lemma: 'wake' }, '添加卡片');
    await until(() => fixture.store.read(accountA).length === 2);
    assert.equal(log.length, 1);
    const firstKey = log[0]?.split(' ').at(-1);
    gate.resolve();
    assert.deepEqual(await first, { pending: true, replayed: false });
    assert.equal(log.length, 1);
    assert.equal(fixture.store.read(accountA).some((item) => item.key === firstKey && !item.failure), true);
    const retry = fixture.controller.flush();
    await until(() => log.filter((line) => line.startsWith('end')).length === 2);
    assert.deepEqual(log, [
      `start /api/backup/restore ${firstKey}`,
      `start /api/backup/restore ${firstKey}`,
      `end /api/backup/restore ${firstKey}`,
      `start /api/cards ${log.at(-2)?.split(' ').at(-1)}`,
      `end /api/cards ${log.at(-1)?.split(' ').at(-1)}`,
    ]);
    const cardKey = log[3]?.split(' ').at(-1);
    assert.notEqual(cardKey, firstKey);
    assert.ok(log.indexOf(`start /api/cards ${cardKey}`) > log.indexOf(`end /api/backup/restore ${firstKey}`));
    await until(() => fixture.loads.length === 1);
    fixture.loads[0]?.gate.resolve(library(accountAUser, 'wake'));
    await retry;
    await second;
    assert.equal(fixture.store.read(accountA).length, 0);
  });

  it('keeps a rejected review visible after a later add is saved', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    const order: string[] = [];
    fixture.transport.send = async (item) => {
      order.push(item.path);
      if (item.path.includes('/reviews')) {
        throw tagged('rejected', { code: 'REVISION_CONFLICT', message: '日程刚被另一个会话更新。请按新的间隔再评分。' });
      }
      return { replayed: false };
    };
    await assert.rejects(
      () => fixture.controller.submit('/api/cards/card-1/reviews', { grade: 'again', expectedScheduleRevision: 1 }, '复习评分'),
      (error: unknown) => error instanceof Error && error.message.includes('日程刚被另一个会话更新'),
    );
    const saved = fixture.controller.submit('/api/cards', { lemma: 'bilge' }, '添加卡片');
    await until(() => fixture.loads.length === 1);
    fixture.loads[0]?.gate.resolve(library(accountAUser, 'bilge'));
    await saved;
    const view = fixture.controller.snapshot();
    assert.match(view.notice, /已保存到账户/);
    assert.equal(view.pending.length, 1);
    assert.equal(view.pending[0]?.label, '复习评分');
    assert.equal(view.pending[0]?.failure?.code, 'REVISION_CONFLICT');
    assert.deepEqual(order, ['/api/cards/card-1/reviews', '/api/cards']);
    await fixture.controller.flush();
    assert.deepEqual(order, ['/api/cards/card-1/reviews', '/api/cards']);
    fixture.controller.dismiss(view.pending[0]?.key ?? '');
    assert.equal(fixture.controller.snapshot().pending.length, 0);
  });

  it('does not sign out a newer login when an older poll receives 401', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    const opened = fixture.controller.reload();
    fixture.loads[0]?.gate.resolve(library(accountAUser, 'abandon'));
    await opened;
    const identity = deferred<SyncAccount>();
    fixture.transport.currentUser = () => identity.promise;
    const polled = fixture.controller.poll(Date.parse('2026-04-01T12:00:00.000Z'));
    fixture.controller.adopt(accountBUser);
    const reloaded = fixture.controller.reload();
    fixture.loads.at(-1)?.gate.resolve(library(accountBUser, 'lumen'));
    assert.equal(await reloaded, true);
    identity.reject(tagged('unauthenticated'));
    await polled;
    assert.equal(fixture.controller.snapshot().user?.id, accountB);
    assert.equal(fixture.controller.snapshot().items[0]?.card.id, 'lumen');
    assert.equal(fixture.controller.snapshot().recovery, '');
  });

  it('keeps a newer same-account read when an older read finishes later', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    const older = fixture.controller.reload();
    const newer = fixture.controller.reload();
    fixture.loads[1]?.gate.resolve(library(accountAUser, 'keel'));
    assert.equal(await newer, true);
    fixture.loads[0]?.gate.resolve(library(accountAUser, 'abandon'));
    assert.equal(await older, false);
    assert.equal(fixture.controller.snapshot().items[0]?.card.id, 'keel');
    assert.equal(fixture.controller.snapshot().readConfirmed, true);
    assert.equal(fixture.controller.snapshot().readError, null);

    const olderFailure = fixture.controller.reload();
    const newerSuccess = fixture.controller.reload();
    fixture.loads[3]?.gate.resolve(library(accountAUser, 'wake'));
    assert.equal(await newerSuccess, true);
    fixture.loads[2]?.gate.reject(tagged('retryable'));
    assert.equal(await olderFailure, false);
    assert.equal(fixture.controller.snapshot().items[0]?.card.id, 'wake');
    assert.equal(fixture.controller.snapshot().readConfirmed, true);
    assert.equal(fixture.controller.snapshot().readError, null);

    const olderAuth = fixture.controller.reload();
    const newerStay = fixture.controller.reload();
    fixture.loads[5]?.gate.resolve(library(accountAUser, 'harbor'));
    assert.equal(await newerStay, true);
    fixture.loads[4]?.gate.reject(tagged('unauthenticated'));
    assert.equal(await olderAuth, false);
    assert.equal(fixture.controller.snapshot().user?.id, accountA);
    assert.equal(fixture.controller.snapshot().items[0]?.card.id, 'harbor');
    assert.equal(fixture.controller.snapshot().readConfirmed, true);
    assert.equal(fixture.controller.snapshot().recovery, '');
  });

  it('shows a progress notice only when the same account revision changes', async () => {
    const fixture = harness();
    const nowMs = Date.parse('2026-04-01T00:00:00.000Z');
    fixture.controller.adopt(accountAUser);
    fixture.controller.setNotice('旧提示');
    const opened = fixture.controller.reload();
    fixture.loads[0]?.gate.resolve(library(accountAUser, 'abandon'));
    assert.equal(await opened, true);
    assert.equal(fixture.controller.snapshot().notice, '旧提示');

    const revised = { ...accountAUser, progressRevision: 4 };
    fixture.transport.currentUser = () => Promise.resolve(revised);
    const polled = fixture.controller.poll(nowMs);
    await until(() => fixture.loads.length === 2);
    fixture.loads[1]?.gate.resolve(library(revised, 'abandon'));
    await polled;
    assert.equal(fixture.controller.snapshot().notice, '进度版本已更新。');
    assert.equal(fixture.controller.snapshot().user?.progressRevision, 4);

    fixture.controller.setNotice('账户 A 的提示');
    fixture.transport.currentUser = () => Promise.resolve(accountBUser);
    const switched = fixture.controller.poll(nowMs);
    await until(() => fixture.loads.length === 3);
    assert.equal(fixture.controller.snapshot().items.length, 0);
    assert.equal(fixture.controller.snapshot().notice, '');
    fixture.loads[2]?.gate.resolve(library(accountBUser, 'lumen'));
    await switched;
    assert.equal(fixture.controller.snapshot().user?.id, accountB);
    assert.equal(fixture.controller.snapshot().items[0]?.card.id, 'lumen');
    assert.equal(fixture.controller.snapshot().notice, '');
  });

  it('attempts a retryable write once and keeps its key', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    let sends = 0;
    fixture.transport.send = async () => {
      sends += 1;
      throw tagged('retryable');
    };
    const result = await fixture.controller.submit('/api/cards', { lemma: 'keel' }, '添加卡片');
    assert.equal(sends, 1);
    assert.deepEqual(result, { pending: true, replayed: false });
    const kept = fixture.store.read(accountA);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.failure, undefined);
    assert.equal(kept[0]?.key, 'key-1');
    assert.equal(sends, 1);
  });

  it('does not send the next write when the link drops during an attempt', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    let sends = 0;
    const gate = deferred<void>();
    fixture.transport.send = async () => {
      sends += 1;
      await gate.promise;
      throw tagged('retryable');
    };
    const first = fixture.controller.submit('/api/backup/restore', { mode: 'replace' }, '导入备份');
    await until(() => sends === 1);
    const second = fixture.controller.submit('/api/cards', { lemma: 'wake' }, '添加卡片');
    await until(() => fixture.store.read(accountA).length === 2);
    fixture.controller.setOnline(false);
    gate.resolve();
    assert.deepEqual(await first, { pending: true, replayed: false });
    assert.deepEqual(await second, { pending: true, replayed: false });
    assert.equal(sends, 1);
    const kept = fixture.store.read(accountA);
    assert.equal(kept.length, 2);
    assert.equal(kept.every((item) => !item.failure), true);
    const firstKey = kept.find((item) => item.path === '/api/backup/restore')?.key;
    assert.equal(firstKey, 'key-1');
  });

  it('does not apply a stale poll failure over a newer read of the same account', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    const opened = fixture.controller.reload();
    fixture.loads[0]?.gate.resolve(library(accountAUser, 'abandon'));
    await opened;
    let asked = 0;
    const identity = deferred<SyncAccount>();
    fixture.transport.currentUser = () => {
      asked += 1;
      return identity.promise;
    };
    const polled = fixture.controller.poll(Date.parse('2026-04-01T12:00:00.000Z'));
    await until(() => asked === 1);
    const newer = fixture.controller.reload();
    fixture.loads.at(-1)?.gate.resolve(library({ ...accountAUser, progressRevision: 4 }, 'keel'));
    assert.equal(await newer, true);
    identity.reject(tagged('unauthenticated'));
    await polled;
    const view = fixture.controller.snapshot();
    assert.equal(view.user?.id, accountA);
    assert.equal(view.items[0]?.card.id, 'keel');
    assert.equal(view.readConfirmed, true);
    assert.equal(view.readError, null);
    assert.equal(view.recovery, '');
  });

  it('does not sign out when an older drain receives 401 after a newer read', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    let asked = 0;
    const identity = deferred<SyncAccount>();
    fixture.transport.currentUser = () => {
      asked += 1;
      return identity.promise;
    };
    const pending = fixture.controller.submit('/api/cards', { lemma: 'keel' }, '添加卡片');
    await until(() => asked === 1);
    const newer = fixture.controller.reload();
    fixture.loads.at(-1)?.gate.resolve(library(accountAUser, 'harbor'));
    assert.equal(await newer, true);
    identity.reject(tagged('unauthenticated'));
    assert.deepEqual(await pending, { pending: true, replayed: false });
    const view = fixture.controller.snapshot();
    assert.equal(view.user?.id, accountA);
    assert.equal(view.items[0]?.card.id, 'harbor');
    assert.equal(view.readConfirmed, true);
    assert.equal(view.recovery, '');
    assert.equal(fixture.store.read(accountA).length, 1);
    assert.equal(fixture.store.read(accountA)[0]?.failure, undefined);
  });

  it('reloads a card that becomes due while a retryable write is waiting', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    const opened = fixture.controller.reload();
    fixture.loads[0]?.gate.resolve(library(accountAUser, 'abandon'));
    await opened;
    let sends = 0;
    fixture.transport.send = async () => {
      sends += 1;
      throw tagged('retryable');
    };
    await fixture.controller.submit('/api/cards', { lemma: 'keel' }, '添加卡片');
    assert.equal(sends, 1);
    const polled = fixture.controller.poll(Date.parse('2026-04-03T00:00:00.000Z'));
    await until(() => sends === 2);
    await until(() => fixture.loads.length === 2);
    fixture.loads[1]?.gate.resolve({
      ...library(accountAUser, 'abandon'),
      queue: [{ card: { id: 'abandon' }, schedule: { due: '2026-04-02T00:00:00.000Z' } }],
    });
    await polled;
    assert.equal(sends, 2);
    assert.equal(fixture.controller.snapshot().queue[0]?.card.id, 'abandon');
    assert.equal(fixture.store.read(accountA)[0]?.key, 'key-1');
  });

  it('drops a saved-success notice when the next write stays pending after currentUser fails', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    let sends = 0;
    fixture.transport.send = async () => {
      sends += 1;
      return { replayed: false };
    };
    const saved = fixture.controller.submit('/api/cards', { lemma: 'harbor' }, '添加卡片');
    await until(() => fixture.loads.length === 1);
    fixture.loads[0]?.gate.resolve(library(accountAUser, 'harbor'));
    assert.deepEqual(await saved, { pending: false, replayed: false });
    assert.match(fixture.controller.snapshot().notice, /已保存到账户/);
    assert.equal(fixture.store.read(accountA).length, 0);

    fixture.transport.currentUser = () => Promise.reject(tagged('retryable'));
    const review = await fixture.controller.submit(
      '/api/cards/card-1/reviews',
      { grade: 'again', expectedScheduleRevision: 1 },
      '复习评分',
    );
    const view = fixture.controller.snapshot();
    const kept = fixture.store.read(accountA);
    assert.deepEqual(review, { pending: true, replayed: false });
    assert.equal(sends, 1);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.key, 'key-2');
    assert.equal(kept[0]?.failure, undefined);
    assert.equal(view.notice.includes('已保存到账户'), false);
    assert.equal(view.user?.id, accountA);
    assert.equal(view.pending.length, 1);
    assert.equal(view.readError, 'retryable');
  });

  it('keeps an offline existing-sense add body unchanged', async () => {
    const fixture = harness();
    fixture.controller.adopt(accountAUser);
    fixture.controller.setOnline(false);
    const body = { senseId: '11111111-1111-4111-8111-111111111111', sentence: 'The keel held the next sentence.' };
    const pending = await fixture.controller.submit('/api/cards', body, '添加原句');
    assert.deepEqual(pending, { pending: true, replayed: false });
    assert.equal(fixture.sends.length, 0);
    const stored = fixture.store.read(accountA);
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0]?.body, body);
  });
});

describe('review reveal', () => {
  it('hides the sentence translation until reveal and names FSRS 6', async () => {
    const webRoot = fileURLToPath(new URL('../../web', import.meta.url));
    const esbuild = (await import(pathToFileURL(join(webRoot, 'node_modules/esbuild/lib/main.js')).href)) as {
      build: (options: Record<string, unknown>) => Promise<void>;
    };
    const dir = mkdtempSync(join(webRoot, 'node_modules/.wordloom-review-'));
    try {
      await esbuild.build({
        stdin: {
          contents: `
            import { createElement } from 'react';
            import { renderToStaticMarkup } from 'react-dom/server';
            import { RevealedTranslation, reviewIntervalHint } from './reviewPrompt.tsx';
            export { reviewIntervalHint };
            export function markup(revealed, sentenceTranslation) {
              return renderToStaticMarkup(createElement(RevealedTranslation, { revealed, sentenceTranslation }));
            }
          `,
          resolveDir: join(webRoot, 'src'),
          sourcefile: 'review-render.js',
          loader: 'js',
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        outfile: join(dir, 'render.js'),
      });
      const rendered = (await import(pathToFileURL(join(dir, 'render.js')).href)) as {
        markup: (revealed: boolean, sentenceTranslation: string | null) => string;
        reviewIntervalHint: string;
      };
      const hidden = rendered.markup(false, '可以停靠的港湾');
      const shown = rendered.markup(true, '可以停靠的港湾');
      const absent = rendered.markup(true, null);
      assert.equal(hidden.includes('译文'), false);
      assert.equal(hidden.includes('可以停靠的港湾'), false);
      assert.equal(shown, '<p class="meta">译文：可以停靠的港湾</p>');
      assert.equal(absent, '');
      assert.match(rendered.reviewIntervalHint, /FSRS 6/);
      assert.match(rendered.reviewIntervalHint, /ts-fsrs 5\.4\.2/);
      assert.equal(rendered.reviewIntervalHint.includes('FSRS 5.4.2'), false);
      const appSource = readFileSync(join(webRoot, 'src/app.tsx'), 'utf8');
      assert.ok(appSource.includes('<RevealedTranslation revealed={revealed} sentenceTranslation={card.occurrence.sentenceTranslation} />'));
      assert.equal(appSource.includes('译文：{card.occurrence.sentenceTranslation}'), false);
      assert.ok(appSource.includes('{reviewIntervalHint}'));
      assert.equal(appSource.includes('FSRS 5.4.2'), false);
      assert.ok(appSource.includes('<ReviewContextNotes item={card} revealed={revealed} />'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hides other sentences and their translations until reveal', async () => {
    const webRoot = fileURLToPath(new URL('../../web', import.meta.url));
    const esbuild = (await import(pathToFileURL(join(webRoot, 'node_modules/esbuild/lib/main.js')).href)) as {
      build: (options: Record<string, unknown>) => Promise<void>;
    };
    const dir = mkdtempSync(join(webRoot, 'node_modules/.wordloom-context-'));
    try {
      await esbuild.build({
        stdin: {
          contents: `
            import { createElement } from 'react';
            import { renderToStaticMarkup } from 'react-dom/server';
            import { ReviewContextNotes } from './senseContext.tsx';
            export function markup(item, revealed) {
              return renderToStaticMarkup(createElement(ReviewContextNotes, { item, revealed }));
            }
          `,
          resolveDir: join(webRoot, 'src'),
          sourcefile: 'context-render.js',
          loader: 'js',
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        outfile: join(dir, 'render.js'),
      });
      const rendered = (await import(pathToFileURL(join(dir, 'render.js')).href)) as {
        markup: (item: unknown, revealed: boolean) => string;
      };
      const item = {
        occurrence: { id: 'a' },
        contextCount: 2,
        contexts: [
          { id: 'a', sentence: 'The keel held.', sentenceTranslation: '龙骨译文' },
          { id: 'b', sentence: 'The wake spread.', sentenceTranslation: '尾流译文' },
        ],
      };
      const hidden = rendered.markup(item, false);
      const shown = rendered.markup(item, true);
      assert.match(hidden, /原句 1\/2/);
      assert.equal(hidden.includes('The wake spread'), false);
      assert.equal(hidden.includes('尾流译文'), false);
      assert.equal(hidden.includes('龙骨译文'), false);
      assert.equal(shown.includes('The wake spread.'), true);
      assert.equal(shown.includes('尾流译文'), true);
      assert.equal(shown.includes('The keel held.'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('replace confirmation', () => {
  it('starts each replace intent unchecked after cancel, escape, reopen, or a new backup', async () => {
    const webRoot = fileURLToPath(new URL('../../web', import.meta.url));
    const esbuild = (await import(pathToFileURL(join(webRoot, 'node_modules/esbuild/lib/main.js')).href)) as {
      build: (options: Record<string, unknown>) => Promise<void>;
    };
    const dir = mkdtempSync(join(webRoot, 'node_modules/.wordloom-replace-'));
    try {
      await esbuild.build({
        stdin: {
          contents: `
            export {
              initialReplaceIntent,
              replaceConfirmEnabled,
              replaceIntentReducer,
            } from './replaceConfirm.ts';
          `,
          resolveDir: join(webRoot, 'src'),
          sourcefile: 'replace-confirm.js',
          loader: 'js',
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        outfile: join(dir, 'replace.js'),
      });
      const replace = (await import(pathToFileURL(join(dir, 'replace.js')).href)) as {
        initialReplaceIntent: { open: boolean; confirmed: boolean };
        replaceConfirmEnabled: (confirmed: boolean, busy: boolean) => boolean;
        replaceIntentReducer: (
          state: { open: boolean; confirmed: boolean },
          action: { type: 'open' } | { type: 'dismiss' } | { type: 'acknowledge'; checked: boolean },
        ) => { open: boolean; confirmed: boolean };
      };
      const open = { type: 'open' } as const;
      const dismiss = { type: 'dismiss' } as const;
      const check = { type: 'acknowledge', checked: true } as const;
      let intent = replace.initialReplaceIntent;
      assert.deepEqual(intent, { open: false, confirmed: false });
      assert.equal(replace.replaceConfirmEnabled(intent.confirmed, false), false);

      intent = replace.replaceIntentReducer(intent, open);
      intent = replace.replaceIntentReducer(intent, check);
      assert.equal(replace.replaceConfirmEnabled(intent.confirmed, false), true);
      assert.equal(replace.replaceConfirmEnabled(intent.confirmed, true), false);

      intent = replace.replaceIntentReducer(intent, dismiss);
      intent = replace.replaceIntentReducer(intent, open);
      assert.deepEqual(intent, { open: true, confirmed: false });
      assert.equal(replace.replaceConfirmEnabled(intent.confirmed, false), false);

      intent = replace.replaceIntentReducer(intent, check);
      intent = replace.replaceIntentReducer(intent, dismiss);
      intent = replace.replaceIntentReducer(intent, open);
      assert.deepEqual(intent, { open: true, confirmed: false });

      intent = replace.replaceIntentReducer(intent, check);
      intent = replace.replaceIntentReducer(intent, dismiss);
      assert.deepEqual(intent, { open: false, confirmed: false });

      intent = replace.replaceIntentReducer(replace.initialReplaceIntent, check);
      intent = replace.replaceIntentReducer(intent, open);
      assert.deepEqual(intent, { open: true, confirmed: false });

      intent = replace.replaceIntentReducer(intent, check);
      assert.deepEqual(intent, { open: true, confirmed: true });
      assert.equal(replace.replaceConfirmEnabled(intent.confirmed, false), true);

      const appSource = readFileSync(join(webRoot, 'src/app.tsx'), 'utf8');
      const libraryStart = appSource.indexOf('function LibraryPage()');
      const libraryEnd = appSource.indexOf('function HistoryPage()');
      const library = appSource.slice(libraryStart, libraryEnd);
      const commitStart = library.indexOf('async function commit');
      const commitEnd = library.indexOf('return (', commitStart);
      const commit = library.slice(commitStart, commitEnd);
      const failure = commit.slice(commit.indexOf('} catch'), commit.indexOf('} finally'));
      assert.equal(library.includes('setReplaceOpen'), false);
      assert.equal(library.includes('setConfirmed'), false);
      assert.equal(library.split("dispatchReplace({ type: 'dismiss' })").length - 1, 4);
      assert.equal(library.split("dispatchReplace({ type: 'open' })").length - 1, 1);
      assert.ok(library.includes("onClose={() => dispatchReplace({ type: 'dismiss' })}"));
      assert.ok(library.includes("onClick={() => dispatchReplace({ type: 'dismiss' })}"));
      assert.ok(library.includes('disabled={!replaceConfirmEnabled(replaceIntent.confirmed, busy)}'));
      assert.ok(commit.includes("dispatchReplace({ type: 'dismiss' })"));
      assert.equal(failure.includes('dispatchReplace'), false);
      assert.ok(library.slice(library.indexOf('async function onFile'), commitStart).includes("dispatchReplace({ type: 'dismiss' })"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const accountAUser: SyncAccount = { id: accountA, email: 'a@example.com', progressRevision: 2 };
const accountBUser: SyncAccount = { id: accountB, email: 'b@example.com', progressRevision: 5 };

function library(user: SyncAccount, lemma: string): LibrarySnapshot<DueItem, { id: string }, { id: string }> {
  return {
    user,
    items: [{ card: { id: lemma }, schedule: { due: '2026-04-02T00:00:00.000Z' }, sense: { lemma } }],
    queue: [],
    senses: [],
    events: [],
  };
}

function tagged(outcome: WriteOutcome, failure?: WriteFailure): Error & { outcome: WriteOutcome; failure?: WriteFailure } {
  return Object.assign(new Error(failure?.message ?? outcome), { outcome, failure });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

function harness(): {
  controller: SyncController<DueItem, { id: string }, { id: string }>;
  transport: {
    currentUser: () => Promise<SyncAccount>;
    loadLibrary: (owner: string) => Promise<LibrarySnapshot<DueItem, { id: string }, { id: string }>>;
    send: (item: OutboxWrite) => Promise<{ replayed: boolean }>;
  };
  store: SyncStorage;
  loads: Array<{ owner: string; gate: ReturnType<typeof deferred<LibrarySnapshot<DueItem, { id: string }, { id: string }>>> }>;
  sends: Array<{ item: OutboxWrite; gate: ReturnType<typeof deferred<{ replayed: boolean }>> }>;
} {
  let session = accountAUser;
  let keys = 0;
  const loads: Array<{ owner: string; gate: ReturnType<typeof deferred<LibrarySnapshot<DueItem, { id: string }, { id: string }>>> }> = [];
  const sends: Array<{ item: OutboxWrite; gate: ReturnType<typeof deferred<{ replayed: boolean }>> }> = [];
  const saved = new Map<string, OutboxWrite[]>();
  const store: SyncStorage = {
    read(userId) {
      return (saved.get(userId) ?? []).map((item) => ({ ...item }));
    },
    write(userId, items) {
      saved.set(
        userId,
        items.map((item) => ({ ...item })),
      );
    },
  };
  const classifier: SyncClassifier = {
    outcome(error: unknown) {
      if (error instanceof ResponsePayloadError) {
        return 'retryable';
      }
      if (error && typeof error === 'object' && 'outcome' in error) {
        return (error as { outcome: WriteOutcome }).outcome;
      }
      return 'retryable';
    },
    failure(error: unknown) {
      if (error && typeof error === 'object' && 'failure' in error && (error as { failure?: WriteFailure }).failure) {
        return (error as { failure: WriteFailure }).failure;
      }
      return { code: 'REQUEST_FAILED', message: error instanceof Error ? error.message : '失败' };
    },
  };
  const transport = {
    currentUser: () => Promise.resolve(session),
    loadLibrary(owner: string) {
      const gate = deferred<LibrarySnapshot<DueItem, { id: string }, { id: string }>>();
      loads.push({ owner, gate });
      return gate.promise;
    },
    send(item: OutboxWrite) {
      const gate = deferred<{ replayed: boolean }>();
      sends.push({ item, gate });
      return gate.promise;
    },
  };
  const controller = new SyncController(transport, store, classifier, () => `key-${++keys}`, { online: true, stamp: () => '12:00:00' });
  return { controller, transport, store, loads, sends, sessionUser: () => session, setSession(user: SyncAccount) { session = user; } } as never;
}
