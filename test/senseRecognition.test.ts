import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { classifyWriteFailure, retainPending } from '../src/clientSync.js';
import { canonicalJson, sha256 } from '../src/crypto.js';
import { openDatabase } from '../src/db.js';
import { hashPassword } from '../src/passwords.js';
import { installedRevision, nextContextId, planRecognitionTasks, type ScheduleTuple } from '../src/senseTask.js';
import type { BackupDocumentV2, CardJson, OccurrenceJson, ReviewEventJson, ScheduleJson, SenseJson } from '../src/types.js';
import { api, login, register, startApp, type Jar, type RunningApp } from './support.js';

const password = 'correct-horse-battery';
const when = '2026-06-01T00:00:00.000Z';

type V1Wire = {
  schemaVersion: 1;
  exportedAt: string;
  progressRevision: number;
  senses: SenseJson[];
  occurrences: OccurrenceJson[];
  cards: CardJson[];
  schedules: ScheduleJson[];
  reviewEvents: Array<Omit<ReviewEventJson, 'taskId' | 'occurrenceId'>>;
};

type Item = {
  card: { id: string; senseId: string; occurrenceId: string };
  occurrence: { id: string; sentence: string };
  schedule: {
    due: string;
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
    state: string;
    revision: number;
    updatedAt: string;
  };
  taskId: string;
  taskType: string;
  contextCount: number;
  contexts: Array<{ id: string; sentence: string; cardId: string }>;
};

describe('recognition planner', () => {
  it('copies the earliest-due then lowest-id tuple and rotates only card-backed sentences', () => {
    const early = '2026-02-01T00:00:00.000Z';
    const late = '2026-03-01T00:00:00.000Z';
    const due = '2026-06-01T00:00:00.000Z';
    const mature = tuple({
      due,
      revision: 2,
      stability: 40,
      difficulty: 3.75,
      elapsedDays: 17,
      scheduledDays: 33,
      learningSteps: 0,
      reps: 20,
      lapses: 1,
      state: 'review',
      lastReview: '2026-11-03T07:08:09.000Z',
      updatedAt: '2026-12-20T07:08:09.000Z',
    });
    const fresh = tuple({
      due,
      revision: 8,
      stability: 1.5,
      difficulty: 5.25,
      elapsedDays: 4,
      scheduledDays: 6,
      learningSteps: 2,
      reps: 1,
      lapses: 0,
      state: 'learning',
      lastReview: '2026-04-28T04:05:06.000Z',
      updatedAt: '2026-05-02T04:05:06.000Z',
    });
    const plans = planRecognitionTasks({
      cards: [
        { cardId: 'card-b', senseId: 'sense-1', occurrenceId: 'occ-early', occurrenceCreatedAt: early, schedule: mature },
        { cardId: 'card-a', senseId: 'sense-1', occurrenceId: 'occ-late', occurrenceCreatedAt: late, schedule: fresh },
      ],
      occurrences: [
        { id: 'occ-unlinked', senseId: 'sense-1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'occ-early', senseId: 'sense-1', createdAt: early },
        { id: 'occ-late', senseId: 'sense-1', createdAt: late },
      ],
      floors: [],
      events: [{ cardId: 'card-b', scheduleRevisionBefore: 1, scheduleRevisionAfter: 2 }],
      senseCreatedAt: new Map([['sense-1', early]]),
    });
    assert.equal(plans.length, 1);
    const plan = plans[0];
    assert.ok(plan);
    assert.equal(plan.donorCardId, 'card-a');
    assert.equal(plan.rotationOccurrenceId, 'occ-early');
    assert.deepEqual(plan.active, { cardId: 'card-a', ...fresh, revision: 9 });
    assert.deepEqual(plan.legacy, [
      { cardId: 'card-a', ...fresh },
      { cardId: 'card-b', ...mature },
    ]);
    assert.equal(nextContextId([{ id: 'b', createdAt: late }, { id: 'a', createdAt: early }], 'missing'), 'a');
    assert.equal(nextContextId([{ id: 'a', createdAt: early }, { id: 'b', createdAt: late }], 'a'), 'b');
    assert.equal(installedRevision('recognition-v1', 5, 0), 5);
    assert.equal(installedRevision('recognition-v1', 5, 6), 7);
    assert.equal(installedRevision('explicit-v2', 5, 0), 6);
    assert.equal(installedRevision('explicit-v2', 5, 6), 7);
  });

  it('sets the active revision above an event that outranks both the schedule and the generation floor', () => {
    const early = '2026-02-01T00:00:00.000Z';
    const late = '2026-03-01T00:00:00.000Z';
    const plans = planRecognitionTasks({
      cards: [
        {
          cardId: 'card-a',
          senseId: 'sense-1',
          occurrenceId: 'occ-late',
          occurrenceCreatedAt: late,
          schedule: tuple({ due: '2026-05-02T00:00:00.000Z', revision: 3, stability: 1.5, state: 'learning' }),
        },
        {
          cardId: 'card-b',
          senseId: 'sense-1',
          occurrenceId: 'occ-early',
          occurrenceCreatedAt: early,
          schedule: tuple({ due: '2026-12-20T00:00:00.000Z', revision: 4, stability: 40, state: 'review' }),
        },
      ],
      occurrences: [
        { id: 'occ-early', senseId: 'sense-1', createdAt: early },
        { id: 'occ-late', senseId: 'sense-1', createdAt: late },
      ],
      floors: [
        { cardId: 'card-a', highWater: 5 },
        { cardId: 'card-b', highWater: 6 },
      ],
      events: [{ cardId: 'card-b', scheduleRevisionBefore: 13, scheduleRevisionAfter: 14 }],
      senseCreatedAt: new Map([['sense-1', early]]),
    });
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.donorCardId, 'card-a');
    assert.equal(plans[0]?.active.revision, 15);
  });

  it('keeps a stale revision conflict rejected and visible', () => {
    const outcome = classifyWriteFailure('http', 409, 'REVISION_CONFLICT');
    assert.equal(outcome, 'rejected');
    assert.equal(retainPending(outcome), false);
  });
});

describe('sense recognition', { concurrency: 1 }, () => {
  let app: RunningApp;

  before(async () => {
    app = await startApp({ now: () => new Date('2026-06-01T12:00:00.000Z') });
  });

  after(async () => {
    await app.close();
  });

  it('keeps one recognition task when another sentence joins a sense', async () => {
    const { jar } = await account(app);
    const first = await postCard(app, jar, newSense('keel', 'The keel held.'));
    const created = itemOf(first.response);
    const graded = await postReview(app, jar, created.card.id, { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 });
    assert.equal(graded.response.status, 201, JSON.stringify(graded.response.json));
    const shared = graded.response.json.schedule;
    const second = await postCard(app, jar, {
      senseId: created.card.senseId,
      sentence: 'The keel cut the wake.',
      sentenceTranslation: '龙骨切开尾流。',
    });
    const focused = itemOf(second.response);
    assert.equal(focused.occurrence.sentence, 'The keel cut the wake.');
    assert.equal(focused.schedule.revision, shared.revision);
    assert.equal(focused.schedule.due, shared.due);
    assert.equal(focused.schedule.reps, shared.reps);
    const items = await itemsOf(app, jar);
    assert.equal(items.length, 1);
    const task = items[0];
    assert.ok(task);
    assert.equal(task.taskId, `recognition:${created.card.senseId}`);
    assert.equal(task.taskType, 'recognition');
    assert.equal(task.contextCount, 2);
    assert.equal(task.schedule.revision, 2);
    assert.equal(task.schedule.due, shared.due);
    assert.equal(task.schedule.stability, shared.stability);
    assert.equal(task.schedule.reps, shared.reps);
    assert.deepEqual(task.contexts.map((context) => context.sentence).sort(), ['The keel cut the wake.', 'The keel held.']);
    await postCard(app, jar, newSense('wake', 'The wake spread.'));
    assert.equal((await itemsOf(app, jar)).length, 2);
  });

  it('treats identical text as separate senses and keeps accounts apart', async () => {
    const first = await account(app);
    const second = await account(app);
    const body = newSense('keel', 'The keel held the line.');
    const cardA = itemOf((await postCard(app, first.jar, body)).response);
    const cardB = itemOf((await postCard(app, second.jar, body)).response);
    const again = itemOf((await postCard(app, first.jar, body)).response);
    assert.notEqual(cardA.card.senseId, again.card.senseId);
    assert.notEqual(cardA.taskId, again.taskId);
    const mine = await itemsOf(app, first.jar);
    assert.equal(mine.length, 2);
    assert.equal(new Set(mine.map((item) => item.taskId)).size, 2);
    const cross = await api(app.base, second.jar, 'POST', `/api/cards/${cardA.card.id}/reviews`, reviewBody(1), {
      csrf: 'session',
      idempotencyKey: randomUUID(),
    });
    assert.equal(cross.status, 404);
    assert.equal((await itemsOf(app, second.jar)).length, 1);
    assert.equal((await itemsOf(app, second.jar))[0]?.card.id, cardB.card.id);
  });

  it('rejects a stale review on every alias and allows one shared transition', async () => {
    const { jar } = await account(app);
    const first = itemOf((await postCard(app, jar, newSense('keel', 'The keel held.'))).response);
    const second = itemOf((await postCard(app, jar, { senseId: first.card.senseId, sentence: 'The keel stayed.' })).response);
    const [left, right] = await Promise.all([
      api(app.base, jar, 'POST', `/api/cards/${first.card.id}/reviews`, reviewBody(1), { csrf: 'session', idempotencyKey: randomUUID() }),
      api(app.base, jar, 'POST', `/api/cards/${second.card.id}/reviews`, reviewBody(1), { csrf: 'session', idempotencyKey: randomUUID() }),
    ]);
    const statuses = [left.status, right.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const rejected = left.status === 409 ? left : right;
    assert.equal(rejected.json.error.code, 'REVISION_CONFLICT');
    assert.equal(rejected.replayed, false);
    const again = await api(app.base, jar, 'POST', `/api/cards/${second.card.id}/reviews`, reviewBody(1), {
      csrf: 'session',
      idempotencyKey: randomUUID(),
    });
    assert.equal(again.status, 409);
    assert.equal(again.replayed, false);
    assert.equal(again.json.error.scheduleRevision, 2);
    const items = await itemsOf(app, jar);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.schedule.revision, 2);
    const backup = await backupOf(app, jar);
    assert.equal(backup.reviewEvents.length, 1);
  });

  it('replays committed writes after replace and refuses a tombstoned card on another task', async () => {
    const { jar, userId } = await account(app);
    const added = await postCard(app, jar, newSense('keel', 'The keel held.'));
    const created = itemOf(added.response);
    const graded = await postReview(app, jar, created.card.id, reviewBody(1));
    assert.equal(graded.response.status, 201, JSON.stringify(graded.response.json));
    const backup = await backupOf(app, jar);
    const progress = await progressOf(app, jar);
    const emptied = blankBackup(backup, []);
    const wiped = await restore(app, jar, 'replace', emptied);
    assert.equal(wiped.status, 200, JSON.stringify(wiped.json));
    assert.equal((await itemsOf(app, jar)).length, 0);
    assert.equal(await taskHighWater(app.dbPath, userId, created.taskId), 2);
    const addReplay = await api(app.base, jar, 'POST', '/api/cards', newSense('keel', 'The keel held.'), {
      csrf: 'session',
      idempotencyKey: added.key,
    });
    assert.equal(addReplay.status, 201);
    assert.equal(addReplay.replayed, true);
    assert.deepEqual(addReplay.json, added.response.json);
    assert.equal((await itemsOf(app, jar)).length, 0);
    const reviewReplay = await api(app.base, jar, 'POST', `/api/cards/${created.card.id}/reviews`, reviewBody(1), {
      csrf: 'session',
      idempotencyKey: graded.key,
    });
    assert.equal(reviewReplay.status, 201);
    assert.equal(reviewReplay.replayed, true);
    assert.deepEqual(reviewReplay.json, graded.response.json);
    assert.equal(countOf(app.dbPath, userId, 'review_events'), 0);
    const beforeConflict = await progressOf(app, jar);
    const conflict = await restore(app, jar, 'replace', foreignTask(backup));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'CONFLICT');
    assert.match(conflict.json.error.message, /another recognition task/);
    assert.equal(await progressOf(app, jar), beforeConflict);
    assert.equal((await itemsOf(app, jar)).length, 0);
    const broughtBack = await restore(app, jar, 'replace', backup);
    assert.equal(broughtBack.status, 200, JSON.stringify(broughtBack.json));
    const restored = await itemsOf(app, jar);
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.schedule.revision, 3);
    assert.equal(restored[0]?.schedule.due, backup.schedules[0]?.due);
    const stale = await api(app.base, jar, 'POST', `/api/cards/${created.card.id}/reviews`, reviewBody(2), {
      csrf: 'session',
      idempotencyKey: randomUUID(),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.replayed, false);
    assert.equal(stale.json.error.code, 'REVISION_CONFLICT');
    const staleAgain = await api(app.base, jar, 'POST', `/api/cards/${created.card.id}/reviews`, reviewBody(2), {
      csrf: 'session',
      idempotencyKey: stale.json ? randomUUID() : randomUUID(),
    });
    assert.equal(staleAgain.status, 409);
    assert.equal(staleAgain.replayed, false);
    assert.equal((await itemsOf(app, jar))[0]?.schedule.revision, 3);
    assert.ok((await progressOf(app, jar)) > progress);
  });

  it('starts a restored empty sense above the retained task floor', async () => {
    const { jar, userId } = await account(app);
    const created = itemOf((await postCard(app, jar, newSense('keel', 'The keel held.'))).response);
    const graded = await postReview(app, jar, created.card.id, reviewBody(1));
    assert.equal(graded.response.status, 201, JSON.stringify(graded.response.json));
    const backup = await backupOf(app, jar);
    const replaced = await restore(app, jar, 'replace', blankBackup(backup, backup.senses));
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    assert.equal((await itemsOf(app, jar)).length, 0);
    assert.equal(await taskHighWater(app.dbPath, userId, created.taskId), 2);
    const added = itemOf(
      (await postCard(app, jar, { senseId: created.card.senseId, sentence: 'The keel returned.', sentenceTranslation: null })).response,
    );
    assert.equal(added.taskId, created.taskId);
    assert.equal(added.schedule.revision, 3);
    assert.equal(await taskHighWater(app.dbPath, userId, created.taskId), 3);
    const stale = await api(app.base, jar, 'POST', `/api/cards/${added.card.id}/reviews`, reviewBody(1), {
      csrf: 'session',
      idempotencyKey: randomUUID(),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.replayed, false);
    assert.equal(stale.json.error.scheduleRevision, 3);
    const fresh = itemOf((await postCard(app, jar, newSense('wake', 'The wake spread.'))).response);
    assert.equal(fresh.schedule.revision, 1);
    assert.notEqual(fresh.taskId, created.taskId);
  });

  it('initializes the first card of an empty sense at revision 1 and keeps the unlinked sentence', async () => {
    const { jar, userId } = await account(app);
    const senseId = randomUUID();
    const occurrenceId = randomUUID();
    const document = blankBackup(shellBackup(), [
      { id: senseId, lemma: 'bark', partOfSpeech: 'noun', meaning: 'the rind of a tree', createdAt: when },
    ]);
    document.occurrences = [
      {
        id: occurrenceId,
        senseId,
        sentence: 'Bark covered the trunk.',
        sentenceTranslation: null,
        eqbank: null,
        createdAt: when,
      },
    ];
    const replaced = await restore(app, jar, 'replace', document);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    assert.equal((await itemsOf(app, jar)).length, 0);
    assert.equal(await taskHighWater(app.dbPath, userId, `recognition:${senseId}`), 0);
    const senses = await api(app.base, jar, 'GET', '/api/senses');
    assert.equal(senses.json.senses[0].occurrences.length, 1);
    const added = itemOf((await postCard(app, jar, { senseId, sentence: 'The bark split in the frost.' })).response);
    assert.equal(added.schedule.revision, 1);
    assert.equal(added.contextCount, 1);
    assert.equal(added.occurrence.sentence, 'The bark split in the frost.');
    const after = await api(app.base, jar, 'GET', '/api/senses');
    const sentences = after.json.senses[0].occurrences.map((occurrence: { sentence: string }) => occurrence.sentence).sort();
    assert.deepEqual(sentences, ['Bark covered the trunk.', 'The bark split in the frost.']);
  });

  it('merges an exact snapshot once and rejects changes to that task', async () => {
    const { jar, userId } = await account(app);
    const created = itemOf(
      (
        await postCard(app, jar, {
          ...newSense('keel', 'The keel held.'),
          eqbank: { itemId: 'eq-1', source: 'synthetic', locator: 'p1' },
        })
      ).response,
    );
    const graded = await postReview(app, jar, created.card.id, reviewBody(1));
    assert.equal(graded.response.status, 201, JSON.stringify(graded.response.json));
    const backup = await backupOf(app, jar);
    const before = await capture(app, userId);
    const repeat = await restore(app, jar, 'merge', backup);
    assert.equal(repeat.status, 200, JSON.stringify(repeat.json));
    assert.deepEqual(await capture(app, userId), before);
    const replaced = await restore(app, jar, 'replace', backup);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    const afterReplace = await capture(app, userId);
    assert.equal(afterReplace.revision, before.revision + 1);
    assert.ok(afterReplace.progress > before.progress);
    const mergedAgain = await restore(app, jar, 'merge', backup);
    assert.equal(mergedAgain.status, 200, JSON.stringify(mergedAgain.json));
    assert.deepEqual(await capture(app, userId), afterReplace);
    const extra = structuredClone(backup);
    const prior = extra.reviewEvents[0];
    assert.ok(prior);
    extra.reviewEvents.push({
      ...prior,
      id: randomUUID(),
      clientRequestId: randomUUID(),
      grade: 'hard',
      affectsSchedule: true,
      scheduleRevisionBefore: prior.scheduleRevisionAfter,
      scheduleRevisionAfter: prior.scheduleRevisionAfter + 1,
    });
    const extraResult = await restore(app, jar, 'merge', extra);
    assert.equal(extraResult.status, 409);
    assert.equal(extraResult.json.error.code, 'SNAPSHOT_CONFLICT');
    assert.deepEqual(await capture(app, userId), afterReplace);
    const due = structuredClone(backup);
    const active = due.schedules[0];
    assert.ok(active);
    active.due = '2031-01-01T00:00:00.000Z';
    const dueResult = await restore(app, jar, 'merge', due);
    assert.equal(dueResult.status, 409);
    assert.deepEqual(await capture(app, userId), afterReplace);
    const legacy = structuredClone(backup);
    legacy.legacySchedules = [{ ...active, revision: 1 }];
    const legacyResult = await restore(app, jar, 'merge', legacy);
    assert.equal(legacyResult.status, 409);
    assert.deepEqual(await capture(app, userId), afterReplace);
    const dropped = await restore(app, jar, 'merge', blankBackup(backup, backup.senses));
    assert.equal(dropped.status, 409);
    assert.equal(dropped.json.error.code, 'SNAPSHOT_CONFLICT');
    assert.deepEqual(await capture(app, userId), afterReplace);
    assert.equal((await backupOf(app, jar)).reviewEvents.length, backup.reviewEvents.length);
  });

  it('rejects a v1 sibling and an overlapping event without making the old alias valid', async () => {
    const { jar, userId } = await account(app);
    const created = itemOf((await postCard(app, jar, newSense('keel', 'The keel held.'))).response);
    const graded = await postReview(app, jar, created.card.id, reviewBody(1));
    assert.equal(graded.response.status, 201, JSON.stringify(graded.response.json));
    const backup = await backupOf(app, jar);
    const liveRevision = backup.schedules[0]?.revision;
    assert.equal(liveRevision, 2);
    const sibling = toV1(backup);
    const cardB = randomUUID();
    const occurrenceB = randomUUID();
    const scheduleA = sibling.schedules[0];
    assert.ok(scheduleA);
    sibling.occurrences.push({
      id: occurrenceB,
      senseId: created.card.senseId,
      sentence: 'The later wake spread behind the ship.',
      sentenceTranslation: null,
      eqbank: null,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    sibling.cards.push({
      id: cardB,
      senseId: created.card.senseId,
      occurrenceId: occurrenceB,
      createdAt: '2026-08-01T00:00:00.000Z',
      revision: 1,
    });
    sibling.schedules.push({ ...scheduleA, cardId: cardB, due: '2027-01-01T00:00:00.000Z', revision: liveRevision });
    const before = await capture(app, userId);
    const merged = await restore(app, jar, 'merge', sibling);
    assert.equal(merged.status, 409);
    assert.equal(merged.json.error.code, 'SNAPSHOT_CONFLICT');
    assert.deepEqual(await capture(app, userId), before);
    const reviewSibling = await api(app.base, jar, 'POST', `/api/cards/${cardB}/reviews`, reviewBody(liveRevision), {
      csrf: 'session',
      idempotencyKey: randomUUID(),
    });
    assert.equal(reviewSibling.status, 404);
    assert.equal(reviewSibling.replayed, false);
    assert.equal((await itemsOf(app, jar))[0]?.schedule.revision, liveRevision);
    const overlapped = structuredClone(backup);
    const existing = overlapped.reviewEvents[0];
    assert.ok(existing);
    overlapped.reviewEvents.push({
      ...existing,
      id: randomUUID(),
      clientRequestId: randomUUID(),
      grade: 'easy',
      affectsSchedule: true,
      scheduleRevisionBefore: existing.scheduleRevisionAfter,
      scheduleRevisionAfter: existing.scheduleRevisionAfter + 1,
    });
    const eventMerge = await restore(app, jar, 'merge', overlapped);
    assert.equal(eventMerge.status, 409, JSON.stringify(eventMerge.json));
    assert.equal(eventMerge.json.error.code, 'SNAPSHOT_CONFLICT');
    assert.deepEqual(await capture(app, userId), before);
    assert.equal((await backupOf(app, jar)).reviewEvents.length, 1);
  });

  it('merges a disjoint task and repeats it without another progress bump', async () => {
    const owner = await account(app);
    const other = await account(app);
    await postCard(app, owner.jar, newSense('keel', 'The keel held.'));
    const owned = await backupOf(app, owner.jar);
    const incoming = syntheticV2();
    const before = await progressOf(app, owner.jar);
    const merged = await restore(app, owner.jar, 'merge', incoming);
    assert.equal(merged.status, 200, JSON.stringify(merged.json));
    assert.equal((await itemsOf(app, owner.jar)).length, 2);
    const progress = await progressOf(app, owner.jar);
    assert.ok(progress > before);
    const again = await restore(app, owner.jar, 'merge', incoming);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(await progressOf(app, owner.jar), progress);
    assert.equal((await itemsOf(app, owner.jar)).length, 2);
    const stolen = await restore(app, other.jar, 'merge', owned);
    assert.equal(stolen.status, 409);
    assert.equal(stolen.json.error.code, 'CONFLICT');
    assert.equal((await itemsOf(app, other.jar)).length, 0);
  });

  it('restores a schema 1 file with an unlinked sentence and one shared revision', async () => {
    const { jar } = await account(app);
    const document = syntheticV1();
    const donorSchedule = document.schedules.find((schedule) => schedule.due === '2026-06-01T00:00:00.000Z');
    const matureSchedule = document.schedules.find((schedule) => schedule.due === '2026-07-01T00:00:00.000Z');
    const cardA = document.cards.find((card) => card.id === donorSchedule?.cardId);
    const cardB = document.cards.find((card) => card.id === matureSchedule?.cardId);
    const early = document.occurrences.find((occurrence) => occurrence.sentence === 'The early sentence.');
    const late = document.occurrences.find((occurrence) => occurrence.sentence === 'The late sentence.');
    assert.ok(donorSchedule && matureSchedule && cardA && cardB && early && late);
    const restored = await restore(app, jar, 'replace', document);
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    const items = await itemsOf(app, jar);
    assert.equal(items.length, 1);
    const task = items[0];
    assert.ok(task);
    assert.equal(task.contextCount, 2);
    assert.equal(task.occurrence.sentence, 'The early sentence.');
    assert.equal(task.schedule.revision, 5);
    assert.equal(task.schedule.stability, 1.5);
    assert.equal(task.schedule.difficulty, 5);
    assert.equal(task.schedule.reps, 1);
    assert.equal(task.schedule.lapses, 0);
    assert.equal(task.schedule.state, 'learning');
    assert.equal(task.schedule.due, '2026-06-01T00:00:00.000Z');
    const senses = await api(app.base, jar, 'GET', '/api/senses');
    assert.equal(senses.json.senses[0].occurrences.length, 3);
    const exported = await backupOf(app, jar);
    assert.equal(exported.schedules.length, 1);
    assert.equal(exported.schedules[0]?.cardId, cardA.id);
    assert.equal(exported.schedules[0]?.revision, 5);
    assert.equal(exported.legacySchedules.length, 2);
    const legacyIdentity = (schedule: { cardId: string; revision: number; stability: number }) =>
      `${schedule.cardId}:${schedule.revision}:${schedule.stability}`;
    assert.deepEqual(
      exported.legacySchedules
        .map((schedule) => ({ cardId: schedule.cardId, revision: schedule.revision, stability: schedule.stability }))
        .sort((left, right) => legacyIdentity(left).localeCompare(legacyIdentity(right))),
      [
        { cardId: cardA.id, revision: 3, stability: 1.5 },
        { cardId: cardB.id, revision: 4, stability: 40 },
      ].sort((left, right) => legacyIdentity(left).localeCompare(legacyIdentity(right))),
    );
    assert.equal(exported.reviewEvents.length, 1);
    assert.equal(exported.reviewEvents[0]?.taskId, null);
    assert.equal(exported.reviewEvents[0]?.occurrenceId, null);
    assert.equal(exported.reviewEvents[0]?.cardId, cardA.id);
    assert.equal(exported.rotations[0]?.occurrenceId, early.id);
    const progress = await progressOf(app, jar);
    const repeat = await restore(app, jar, 'merge', document);
    assert.equal(repeat.status, 200, JSON.stringify(repeat.json));
    assert.equal(await progressOf(app, jar), progress);
    assert.equal((await itemsOf(app, jar))[0]?.schedule.revision, 5);
    const staleHigh = await api(app.base, jar, 'POST', `/api/cards/${cardB.id}/reviews`, reviewBody(4), {
      csrf: 'session',
      idempotencyKey: randomUUID(),
    });
    assert.equal(staleHigh.status, 409);
    assert.equal(staleHigh.replayed, false);
    assert.equal(staleHigh.json.error.scheduleRevision, 5);
    const staleDonor = await api(app.base, jar, 'POST', `/api/cards/${cardA.id}/reviews`, reviewBody(4), {
      csrf: 'session',
      idempotencyKey: randomUUID(),
    });
    assert.equal(staleDonor.status, 409);
    const graded = await postReview(app, jar, cardA.id, {
      grade: 'good',
      affectsSchedule: true,
      expectedScheduleRevision: 5,
    });
    assert.equal(graded.response.status, 201, JSON.stringify(graded.response.json));
    assert.equal(graded.response.json.event.cardId, cardA.id);
    assert.equal(graded.response.json.event.occurrenceId, late.id);
    assert.equal((await itemsOf(app, jar))[0]?.occurrence.id, late.id);
    const round = await backupOf(app, jar);
    const imported = round.reviewEvents.find((event) => event.id === exported.reviewEvents[0]?.id);
    assert.ok(imported);
    assert.equal(imported.taskId, null);
    assert.equal(imported.scheduleRevisionBefore, 1);
    assert.equal(imported.scheduleRevisionAfter, 2);
  });

  it('rejects unknown modes, duplicate schema 1 schedules, a cardless rotation, and a mismatched occurrence', async () => {
    const { jar, userId } = await account(app);
    const created = itemOf((await postCard(app, jar, newSense('keel', 'The keel held.'))).response);
    const backup = await backupOf(app, jar);
    const before = await capture(app, userId);
    const wrongType = structuredClone(backup);
    (wrongType.tasks[0] as { taskType: string }).taskType = 'cloze';
    const typed = await restore(app, jar, 'merge', wrongType);
    assert.equal(typed.status, 400);
    assert.match(typed.json.error.message, /taskType is not supported/);
    const duplicate = syntheticV1();
    const keeper = duplicate.cards[0];
    assert.ok(keeper);
    duplicate.cards = [keeper];
    duplicate.occurrences = duplicate.occurrences.filter((occurrence) => occurrence.id === keeper.occurrenceId);
    const schedule = duplicate.schedules.find((item) => item.cardId === keeper.id);
    assert.ok(schedule);
    duplicate.schedules = [schedule, { ...schedule, stability: schedule.stability + 1 }];
    duplicate.reviewEvents = [];
    const duplicated = await restore(app, jar, 'merge', duplicate);
    assert.equal(duplicated.status, 400);
    assert.match(duplicated.json.error.message, /Duplicate schedule cardId/);
    const cardless = syntheticV2();
    const looseId = randomUUID();
    cardless.occurrences.push({
      id: looseId,
      senseId: cardless.senses[0]?.id ?? '',
      sentence: 'This sentence has no card.',
      sentenceTranslation: null,
      eqbank: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const rotation = cardless.rotations[0];
    assert.ok(rotation);
    rotation.occurrenceId = looseId;
    const rotated = await restore(app, jar, 'merge', cardless);
    assert.equal(rotated.status, 400);
    assert.match(rotated.json.error.message, /sentence that has a card/);
    const unknown = await api(app.base, jar, 'POST', `/api/cards/${created.card.id}/reviews`, { ...reviewBody(1), note: 'extra' }, {
      csrf: 'session',
      idempotencyKey: randomUUID(),
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error.message, /unknown field note/);
    const mismatched = await api(
      app.base,
      jar,
      'POST',
      `/api/cards/${created.card.id}/reviews`,
      { ...reviewBody(1), occurrenceId: looseId },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(mismatched.status, 400);
    assert.match(mismatched.json.error.message, /occurrenceId does not match/);
    assert.deepEqual(await capture(app, userId), before);
  });

  it('rejects a changed rotation and still merges the unchanged two-context snapshot', async () => {
    const { jar, userId } = await account(app);
    const first = itemOf((await postCard(app, jar, newSense('keel', 'The keel held.'))).response);
    const second = itemOf((await postCard(app, jar, { senseId: first.card.senseId, sentence: 'The keel stayed.' })).response);
    const backup = await backupOf(app, jar);
    const before = await capture(app, userId);
    const repeat = await restore(app, jar, 'merge', backup);
    assert.equal(repeat.status, 200, JSON.stringify(repeat.json));
    assert.deepEqual(await capture(app, userId), before);
    const turned = structuredClone(backup);
    const pointer = turned.rotations[0];
    assert.ok(pointer);
    pointer.occurrenceId = second.occurrence.id;
    const conflict = await restore(app, jar, 'merge', turned);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'SNAPSHOT_CONFLICT');
    assert.deepEqual(await capture(app, userId), before);
    assert.equal((await itemsOf(app, jar))[0]?.occurrence.id, first.occurrence.id);
  });

  it('rolls back a disjoint task listed ahead of a conflicting task', async () => {
    const { jar, userId } = await account(app);
    const created = itemOf((await postCard(app, jar, newSense('keel', 'The keel held.'))).response);
    const graded = await postReview(app, jar, created.card.id, reviewBody(1));
    assert.equal(graded.response.status, 201, JSON.stringify(graded.response.json));
    const installed = syntheticV2();
    const kept = installed.cards[0];
    const keptTask = installed.tasks[0];
    const keptOccurrence = installed.occurrences[0];
    assert.ok(kept && keptTask && keptOccurrence);
    installed.legacySchedules = [
      scheduleFor(kept.id, {
        due: '2025-02-02T00:00:00.000Z',
        revision: 2,
        stability: 12,
        difficulty: 6.5,
        reps: 4,
        lapses: 1,
        state: 'review',
        elapsedDays: 9,
        scheduledDays: 15,
        learningSteps: 1,
        lastReview: '2025-01-15T00:00:00.000Z',
        updatedAt: '2025-02-02T00:00:00.000Z',
      }),
    ];
    installed.reviewEvents = [
      {
        id: randomUUID(),
        cardId: kept.id,
        grade: 'good',
        affectsSchedule: true,
        reviewedAt: '2026-05-01T00:00:00.000Z',
        clientRequestId: randomUUID(),
        dueBefore: '2026-05-01T00:00:00.000Z',
        dueAfter: '2026-05-03T00:00:00.000Z',
        stateBefore: 'new',
        stateAfter: 'learning',
        scheduleRevisionBefore: 1,
        scheduleRevisionAfter: 2,
        stabilityBefore: 1,
        stabilityAfter: 1.5,
        difficultyBefore: 5,
        difficultyAfter: 5,
        scheduledDaysBefore: 0,
        scheduledDaysAfter: 1,
        repsAfter: 1,
        lapsesAfter: 0,
        elapsedDaysAfter: 0,
        learningStepsAfter: 0,
        createdAt: '2026-05-01T00:00:00.000Z',
        taskId: keptTask.id,
        occurrenceId: keptOccurrence.id,
      },
    ];
    const replaced = await restore(app, jar, 'replace', installed);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    const live = await backupOf(app, jar);
    const before = accountSnapshot(app.dbPath, userId);
    assert.ok(before.alias_tombstones.length > 0);
    assert.ok(before.schedule_archives.length > 0);
    assert.ok(before.idempotency_keys.length > 0);
    assert.ok(before.review_events.length > 0);
    assert.ok(before.task_generation.length > 0);
    assert.ok(before.schedule_generation.length > 0);
    assert.ok(before.task_schedules.length > 0);
    assert.ok(before.task_rotation.length > 0);
    const disjoint = syntheticV2();
    const disjointCard = disjoint.cards[0];
    const disjointTask = disjoint.tasks[0];
    const disjointOccurrence = disjoint.occurrences[0];
    assert.ok(disjointCard && disjointTask && disjointOccurrence);
    disjoint.legacySchedules = [
      scheduleFor(disjointCard.id, {
        due: '2024-04-04T00:00:00.000Z',
        revision: 1,
        stability: 2,
        state: 'learning',
        reps: 1,
        elapsedDays: 3,
        scheduledDays: 4,
        learningSteps: 1,
        lastReview: '2024-04-01T00:00:00.000Z',
        updatedAt: '2024-04-04T00:00:00.000Z',
      }),
    ];
    disjoint.reviewEvents = [
      {
        id: randomUUID(),
        cardId: disjointCard.id,
        grade: 'easy',
        affectsSchedule: true,
        reviewedAt: '2026-04-04T00:00:00.000Z',
        clientRequestId: randomUUID(),
        dueBefore: '2026-04-04T00:00:00.000Z',
        dueAfter: '2026-04-08T00:00:00.000Z',
        stateBefore: 'new',
        stateAfter: 'learning',
        scheduleRevisionBefore: 1,
        scheduleRevisionAfter: 2,
        stabilityBefore: 1,
        stabilityAfter: 2,
        difficultyBefore: 5,
        difficultyAfter: 4.5,
        scheduledDaysBefore: 0,
        scheduledDaysAfter: 4,
        repsAfter: 1,
        lapsesAfter: 0,
        elapsedDaysAfter: 1,
        learningStepsAfter: 0,
        createdAt: '2026-04-04T00:00:00.000Z',
        taskId: disjointTask.id,
        occurrenceId: disjointOccurrence.id,
      },
    ];
    const overlapping = structuredClone(live);
    const prior = overlapping.reviewEvents[0];
    assert.ok(prior);
    overlapping.reviewEvents.push({
      ...prior,
      id: randomUUID(),
      clientRequestId: randomUUID(),
      grade: 'hard',
      affectsSchedule: true,
      scheduleRevisionBefore: prior.scheduleRevisionAfter,
      scheduleRevisionAfter: prior.scheduleRevisionAfter + 1,
    });
    const mixed: BackupDocumentV2 = {
      schemaVersion: 2,
      exportedAt: overlapping.exportedAt,
      progressRevision: overlapping.progressRevision,
      senses: [...disjoint.senses, ...overlapping.senses],
      occurrences: [...disjoint.occurrences, ...overlapping.occurrences],
      cards: [...disjoint.cards, ...overlapping.cards],
      schedules: [...disjoint.schedules, ...overlapping.schedules],
      reviewEvents: [...disjoint.reviewEvents, ...overlapping.reviewEvents],
      tasks: [...disjoint.tasks, ...overlapping.tasks],
      members: [...disjoint.members, ...overlapping.members],
      legacySchedules: [...disjoint.legacySchedules, ...overlapping.legacySchedules],
      rotations: [...disjoint.rotations, ...overlapping.rotations],
    };
    assert.equal(mixed.tasks[0]?.id, disjointTask.id);
    const merged = await restore(app, jar, 'merge', mixed);
    assert.equal(merged.status, 409, JSON.stringify(merged.json));
    assert.equal(merged.json.error.code, 'SNAPSHOT_CONFLICT');
    assert.deepEqual(accountSnapshot(app.dbPath, userId), before);
  });

  it('rejects a task that would leave a stored sentence off that sense', async () => {
    const { jar, userId } = await account(app);
    const senseId = randomUUID();
    const keptId = randomUUID();
    const extraId = randomUUID();
    const cardId = randomUUID();
    const taskId = `recognition:${senseId}`;
    const sense = { id: senseId, lemma: 'bark', partOfSpeech: 'noun', meaning: 'the rind of a tree', createdAt: when };
    const kept = {
      id: keptId,
      senseId,
      sentence: 'Bark covered the trunk.',
      sentenceTranslation: null,
      eqbank: null,
      createdAt: when,
    };
    const extra = {
      id: extraId,
      senseId,
      sentence: 'The bark split in the frost.',
      sentenceTranslation: null,
      eqbank: null,
      createdAt: '2026-06-02T00:00:00.000Z',
    };
    const stored = blankBackup(shellBackup(), [sense]);
    stored.occurrences = [kept, extra];
    const replaced = await restore(app, jar, 'replace', stored);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    const partial = blankBackup(shellBackup(), [sense]);
    partial.occurrences = [kept];
    partial.cards = [{ id: cardId, senseId, occurrenceId: keptId, createdAt: when, revision: 1 }];
    partial.schedules = [scheduleFor(cardId, { due: '2026-07-01T00:00:00.000Z', revision: 1, stability: 1, state: 'new' })];
    partial.tasks = [{ id: taskId, senseId, taskType: 'recognition', policy: 'sense-recognition-v1', donorCardId: cardId, createdAt: when }];
    partial.members = [{ taskId, cardId }];
    partial.rotations = [{ taskId, occurrenceId: keptId }];
    const before = accountSnapshot(app.dbPath, userId);
    const merged = await restore(app, jar, 'merge', partial);
    assert.equal(merged.status, 409, JSON.stringify(merged.json));
    assert.equal(merged.json.error.code, 'SNAPSHOT_CONFLICT');
    assert.deepEqual(accountSnapshot(app.dbPath, userId), before);
    const full = structuredClone(partial);
    full.occurrences = [kept, extra];
    const accepted = await restore(app, jar, 'merge', full);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    const progress = await progressOf(app, jar);
    const again = await restore(app, jar, 'merge', full);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(await progressOf(app, jar), progress);
    const senses = await api(app.base, jar, 'GET', '/api/senses');
    const sentences = senses.json.senses[0].occurrences.map((occurrence: { sentence: string }) => occurrence.sentence).sort();
    assert.deepEqual(sentences, ['Bark covered the trunk.', 'The bark split in the frost.']);
  });
});

describe('context rotation', { concurrency: 1 }, () => {
  it('records the requested sentence and advances only on a new committed grade', async () => {
    let current = new Date('2026-07-01T00:00:00.000Z');
    const now = () => new Date(current.getTime());
    const app = await startApp({ now });
    let closed = false;
    try {
      const email = uniqueEmail('rotate');
      const { jar } = await register(app.base, email, password);
      const first = itemOf((await postCard(app, jar, newSense('keel', 'The keel held.'))).response);
      current = new Date(current.getTime() + 60_000);
      const second = itemOf((await postCard(app, jar, { senseId: first.card.senseId, sentence: 'The keel cut the wake.' })).response);
      assert.equal((await itemsOf(app, jar))[0]?.occurrence.sentence, 'The keel held.');
      const focused = await api(app.base, jar, 'GET', `/api/cards/${second.card.id}`);
      assert.equal(focused.json.item.occurrence.sentence, 'The keel cut the wake.');
      assert.equal((await itemsOf(app, jar))[0]?.occurrence.sentence, 'The keel held.');
      assert.equal((await api(app.base, jar, 'GET', '/api/queue')).json.items.length, 1);
      const mismatch = await api(
        app.base,
        jar,
        'POST',
        `/api/cards/${second.card.id}/reviews`,
        { ...reviewBody(1), occurrenceId: first.occurrence.id },
        { csrf: 'session', idempotencyKey: randomUUID() },
      );
      assert.equal(mismatch.status, 400);
      const practice = await postReview(app, jar, second.card.id, { grade: 'hard', affectsSchedule: false, expectedScheduleRevision: 1 });
      assert.equal(practice.response.status, 201, JSON.stringify(practice.response.json));
      assert.equal(practice.response.json.event.cardId, second.card.id);
      assert.equal(practice.response.json.event.occurrenceId, second.occurrence.id);
      assert.equal(practice.response.json.schedule.revision, 1);
      assert.equal((await itemsOf(app, jar))[0]?.occurrence.id, first.occurrence.id);
      const grade = await postReview(app, jar, second.card.id, {
        grade: 'good',
        affectsSchedule: true,
        expectedScheduleRevision: 1,
        occurrenceId: second.occurrence.id,
      });
      assert.equal(grade.response.status, 201, JSON.stringify(grade.response.json));
      assert.equal(grade.response.json.event.cardId, second.card.id);
      assert.equal(grade.response.json.event.occurrenceId, second.occurrence.id);
      assert.equal((await itemsOf(app, jar))[0]?.occurrence.id, second.occurrence.id);
      assert.equal((await itemsOf(app, jar))[0]?.schedule.revision, 2);
      const replay = await api(app.base, jar, 'POST', `/api/cards/${second.card.id}/reviews`, {
        grade: 'good',
        affectsSchedule: true,
        expectedScheduleRevision: 1,
        occurrenceId: second.occurrence.id,
      }, { csrf: 'session', idempotencyKey: grade.key });
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.json, grade.response.json);
      assert.equal((await itemsOf(app, jar))[0]?.occurrence.id, second.occurrence.id);
      await app.close();
      closed = true;
      const reopened = await startApp({ now, existingPath: app.dbPath });
      try {
        const signedIn = await login(reopened.base, email, password);
        assert.equal((await itemsOf(reopened, signedIn))[0]?.occurrence.id, second.occurrence.id);
        const replayed = await api(reopened.base, signedIn, 'POST', `/api/cards/${second.card.id}/reviews`, {
          grade: 'good',
          affectsSchedule: true,
          expectedScheduleRevision: 1,
          occurrenceId: second.occurrence.id,
        }, { csrf: 'session', idempotencyKey: grade.key });
        assert.equal(replayed.replayed, true);
        assert.equal((await itemsOf(reopened, signedIn))[0]?.occurrence.id, second.occurrence.id);
        const wrapped = await postReview(reopened, signedIn, second.card.id, { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 2 });
        assert.equal(wrapped.response.status, 201, JSON.stringify(wrapped.response.json));
        const held = wrapped.response.json.schedule;
        assert.equal((await itemsOf(reopened, signedIn))[0]?.occurrence.id, first.occurrence.id);
        current = new Date(current.getTime() + 60_000);
        await postCard(reopened, signedIn, { senseId: first.card.senseId, sentence: 'The keel met another swell.' });
        const items = await itemsOf(reopened, signedIn);
        assert.equal(items.length, 1);
        assert.equal(items[0]?.contextCount, 3);
        assert.equal(items[0]?.occurrence.id, first.occurrence.id);
        assert.equal(items[0]?.schedule.revision, 3);
        assert.equal(items[0]?.schedule.due, held.due);
        assert.equal(items[0]?.schedule.stability, held.stability);
      } finally {
        await reopened.close();
      }
    } finally {
      if (!closed) {
        await app.close();
      }
    }
  });
});

describe('schema 3 migration', { concurrency: 1 }, () => {
  it('opens a fresh file at version 3 and stays there', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'wordloom-fresh-')), 'wordloom.sqlite');
    const db = openDatabase(path);
    try {
      assert.equal(versionOf(db), 3);
      assert.equal(countRows(db, 'learning_tasks'), 0);
    } finally {
      db.close();
    }
    const again = openDatabase(path);
    try {
      assert.equal(versionOf(again), 3);
    } finally {
      again.close();
    }
  });

  it('migrates version 1 without blending siblings, rewriting events, or bumping an empty sense', () => {
    const seeded = seedLegacy(1, []);
    const db = openDatabase(seeded.path);
    try {
      assertMigrated(db, seeded, 9);
      assert.deepEqual(floorsOf(db), [
        { card_id: 'card-a', high_water: 9 },
        { card_id: 'card-b', high_water: 9 },
      ]);
    } finally {
      db.close();
    }
    const again = openDatabase(seeded.path);
    try {
      assertMigrated(again, seeded, 9);
    } finally {
      again.close();
    }
  });

  it('migrates version 2 above a retained floor without replaying the mature sibling', () => {
    const seeded = seedLegacy(2, [{ cardId: 'card-a', highWater: 10 }]);
    const db = openDatabase(seeded.path);
    try {
      assertMigrated(db, seeded, 11);
      assert.deepEqual(floorsOf(db), [
        { card_id: 'card-a', high_water: 11 },
        { card_id: 'card-b', high_water: 11 },
      ]);
    } finally {
      db.close();
    }
  });

  it('migrates version 2 above an event revision that exceeds the schedule and the retained floor', () => {
    const seeded = seedLegacy(2, [
      { cardId: 'card-a', highWater: 5 },
      { cardId: 'card-b', highWater: 6 },
    ], { donor: 3, sibling: 4, eventBefore: 13, eventAfter: 14 });
    const db = openDatabase(seeded.path);
    try {
      assertMigrated(db, seeded, 15);
      assert.deepEqual(floorsOf(db), [
        { card_id: 'card-a', high_water: 15 },
        { card_id: 'card-b', high_water: 15 },
      ]);
    } finally {
      db.close();
    }
  });

  it('replays committed pre-v3 add, review, and restore receipts without applying them', async () => {
    const seeded = await seedLegacyReceipts();
    const running = await startApp({ existingPath: seeded.path, now: () => new Date('2026-06-01T12:00:00.000Z') });
    try {
      const jar = await login(running.base, seeded.email, password);
      const before = accountSnapshot(running.dbPath, seeded.userId);
      assert.equal(before.progress, 5);
      await replayReceipts(running, jar, seeded.receipts);
      assert.deepEqual(accountSnapshot(running.dbPath, seeded.userId), before);
      const replaced = await restore(running, jar, 'replace', syntheticV2());
      assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
      const afterReplace = accountSnapshot(running.dbPath, seeded.userId);
      assert.notDeepEqual(afterReplace.word_senses, before.word_senses);
      await replayReceipts(running, jar, seeded.receipts);
      assert.deepEqual(accountSnapshot(running.dbPath, seeded.userId), afterReplace);
    } finally {
      await running.close();
    }
  });

  it('rolls a version 1 file back when a schedule has no card', () => {
    const path = seedOrphan();
    assert.throws(
      () => openDatabase(path),
      (error: unknown) => error instanceof Error && /Schedule has no learner card/.test(error.message),
    );
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(versionOf(db), 1);
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
      for (const name of ['learning_tasks', 'task_schedules', 'schedule_archives', 'schedule_generation', 'task_generation']) {
        assert.equal(names.includes(name), false, name);
      }
      assert.equal(countRows(db, 'schedules'), 1);
    } finally {
      db.close();
    }
  });
});

function tuple(overrides: Partial<ScheduleTuple> & Pick<ScheduleTuple, 'due' | 'revision'>): ScheduleTuple {
  return {
    due: overrides.due,
    stability: overrides.stability ?? 1,
    difficulty: overrides.difficulty ?? 5,
    elapsedDays: overrides.elapsedDays ?? 0,
    scheduledDays: overrides.scheduledDays ?? 1,
    learningSteps: overrides.learningSteps ?? 0,
    reps: overrides.reps ?? 0,
    lapses: overrides.lapses ?? 0,
    state: overrides.state ?? 'learning',
    lastReview: overrides.lastReview ?? null,
    revision: overrides.revision,
    updatedAt: overrides.updatedAt ?? when,
  };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

function newSense(lemma: string, sentence: string): Record<string, unknown> {
  return {
    lemma,
    partOfSpeech: 'noun',
    meaning: `a synthetic sense for ${lemma}`,
    sentence,
    sentenceTranslation: `${lemma} 译文`,
  };
}

function reviewBody(expectedScheduleRevision: number): Record<string, unknown> {
  return { grade: 'good', affectsSchedule: true, expectedScheduleRevision };
}

async function account(app: RunningApp): Promise<{ jar: Jar; userId: string }> {
  const created = await register(app.base, uniqueEmail('sense'), password);
  return { jar: created.jar, userId: created.body.user.id as string };
}

async function postCard(app: RunningApp, jar: Jar, body: Record<string, unknown>, key = randomUUID()) {
  const response = await api(app.base, jar, 'POST', '/api/cards', body, { csrf: 'session', idempotencyKey: key });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return { response, key };
}

async function postReview(app: RunningApp, jar: Jar, cardId: string, body: Record<string, unknown>, key = randomUUID()) {
  const response = await api(app.base, jar, 'POST', `/api/cards/${cardId}/reviews`, body, { csrf: 'session', idempotencyKey: key });
  return { response, key };
}

async function restore(app: RunningApp, jar: Jar, mode: 'merge' | 'replace', document: unknown) {
  const body = mode === 'replace' ? { mode, confirm: 'replace', document } : { mode, document };
  return api(app.base, jar, 'POST', '/api/backup/restore', body, { csrf: 'session', idempotencyKey: randomUUID() });
}

async function itemsOf(app: RunningApp, jar: Jar): Promise<Item[]> {
  const response = await api(app.base, jar, 'GET', '/api/cards');
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json.items as Item[];
}

function itemOf(response: { json: { item: Item } }): Item {
  return response.json.item;
}

async function backupOf(app: RunningApp, jar: Jar): Promise<BackupDocumentV2> {
  const response = await api(app.base, jar, 'GET', '/api/backup');
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.schemaVersion, 2);
  return response.json as BackupDocumentV2;
}

async function progressOf(app: RunningApp, jar: Jar): Promise<number> {
  const response = await api(app.base, jar, 'GET', '/api/auth/me');
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json.user.progressRevision as number;
}

async function capture(app: RunningApp, userId: string): Promise<{ progress: number; revision: number; events: number; cards: number; members: number }> {
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  try {
    const progress = Number((db.prepare('SELECT progress_revision AS n FROM users WHERE id = ?').get(userId) as { n: number | bigint }).n);
    const revisionRow = db.prepare('SELECT COALESCE(MAX(revision), 0) AS n FROM task_schedules WHERE user_id = ?').get(userId) as {
      n: number | bigint;
    };
    return {
      progress,
      revision: Number(revisionRow.n),
      events: countOf(app.dbPath, userId, 'review_events', db),
      cards: countOf(app.dbPath, userId, 'learner_cards', db),
      members: countOf(app.dbPath, userId, 'task_members', db),
    };
  } finally {
    db.close();
  }
}

function countOf(dbPath: string, userId: string, table: string, existing?: DatabaseSync): number {
  const db = existing ?? new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number | bigint }).n);
  } finally {
    if (!existing) {
      db.close();
    }
  }
}

function taskHighWater(dbPath: string, userId: string, taskId: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT high_water FROM task_generation WHERE user_id = ? AND task_id = ?').get(userId, taskId) as
      | { high_water: number | bigint }
      | undefined;
    return row ? Number(row.high_water) : 0;
  } finally {
    db.close();
  }
}

function blankBackup(document: BackupDocumentV2, senses: SenseJson[]): BackupDocumentV2 {
  return {
    schemaVersion: 2,
    exportedAt: document.exportedAt,
    progressRevision: document.progressRevision,
    senses,
    occurrences: [],
    cards: [],
    schedules: [],
    reviewEvents: [],
    tasks: [],
    members: [],
    legacySchedules: [],
    rotations: [],
  };
}

function shellBackup(): BackupDocumentV2 {
  return {
    schemaVersion: 2,
    exportedAt: when,
    progressRevision: 0,
    senses: [],
    occurrences: [],
    cards: [],
    schedules: [],
    reviewEvents: [],
    tasks: [],
    members: [],
    legacySchedules: [],
    rotations: [],
  };
}

function toV1(document: BackupDocumentV2): V1Wire {
  return {
    schemaVersion: 1,
    exportedAt: document.exportedAt,
    progressRevision: document.progressRevision,
    senses: document.senses.map((sense) => ({ ...sense })),
    occurrences: document.occurrences.map((occurrence) => ({ ...occurrence, eqbank: occurrence.eqbank ? { ...occurrence.eqbank } : null })),
    cards: document.cards.map((card) => ({ ...card })),
    schedules: document.schedules.map((schedule) => ({ ...schedule })),
    reviewEvents: document.reviewEvents.map(({ taskId: _taskId, occurrenceId: _occurrenceId, ...event }) => ({ ...event })),
  };
}

function foreignTask(document: BackupDocumentV2): BackupDocumentV2 {
  const senseId = randomUUID();
  const occurrenceId = randomUUID();
  const card = document.cards[0];
  const sense = document.senses[0];
  const schedule = document.schedules[0];
  const task = document.tasks[0];
  assert.ok(card && sense && schedule && task);
  const taskId = `recognition:${senseId}`;
  return {
    ...document,
    senses: [{ ...sense, id: senseId }],
    occurrences: [
      {
        id: occurrenceId,
        senseId,
        sentence: 'A different task tried to reuse the card.',
        sentenceTranslation: null,
        eqbank: null,
        createdAt: when,
      },
    ],
    cards: [{ ...card, senseId, occurrenceId }],
    schedules: [{ ...schedule, cardId: card.id }],
    reviewEvents: [],
    tasks: [{ ...task, id: taskId, senseId, donorCardId: card.id }],
    members: [{ taskId, cardId: card.id }],
    legacySchedules: [],
    rotations: [{ taskId, occurrenceId }],
  };
}

function syntheticV2(): BackupDocumentV2 {
  const senseId = randomUUID();
  const occurrenceId = randomUUID();
  const cardId = randomUUID();
  const taskId = `recognition:${senseId}`;
  const schedule = scheduleFor(cardId, { due: '2026-06-02T00:00:00.000Z', revision: 1, stability: 1, state: 'new', reps: 0 });
  return {
    schemaVersion: 2,
    exportedAt: when,
    progressRevision: 1,
    senses: [{ id: senseId, lemma: 'lee', partOfSpeech: 'noun', meaning: 'shelter from wind', createdAt: when }],
    occurrences: [
      { id: occurrenceId, senseId, sentence: 'The lee of the wall was quiet.', sentenceTranslation: null, eqbank: null, createdAt: when },
    ],
    cards: [{ id: cardId, senseId, occurrenceId, createdAt: when, revision: 1 }],
    schedules: [schedule],
    reviewEvents: [],
    tasks: [{ id: taskId, senseId, taskType: 'recognition', policy: 'sense-recognition-v1', donorCardId: cardId, createdAt: when }],
    members: [{ taskId, cardId }],
    legacySchedules: [],
    rotations: [{ taskId, occurrenceId }],
  };
}

function syntheticV1(): V1Wire {
  const senseId = randomUUID();
  const unlinked = randomUUID();
  const early = randomUUID();
  const late = randomUUID();
  const cardA = randomUUID();
  const cardB = randomUUID();
  const eventId = randomUUID();
  return {
    schemaVersion: 1,
    exportedAt: when,
    progressRevision: 2,
    senses: [{ id: senseId, lemma: 'keel', partOfSpeech: 'noun', meaning: 'a synthetic sense for keel', createdAt: '2026-03-01T00:00:00.000Z' }],
    occurrences: [
      {
        id: unlinked,
        senseId,
        sentence: 'An unlinked sentence stays stored.',
        sentenceTranslation: '未连接',
        eqbank: { itemId: 'eq-unlinked', source: 'synthetic', locator: 'n1' },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: early,
        senseId,
        sentence: 'The early sentence.',
        sentenceTranslation: null,
        eqbank: null,
        createdAt: '2026-02-01T00:00:00.000Z',
      },
      {
        id: late,
        senseId,
        sentence: 'The late sentence.',
        sentenceTranslation: null,
        eqbank: null,
        createdAt: '2026-03-01T00:00:00.000Z',
      },
    ],
    cards: [
      { id: cardB, senseId, occurrenceId: early, createdAt: '2026-02-01T00:00:00.000Z', revision: 1 },
      { id: cardA, senseId, occurrenceId: late, createdAt: '2026-03-01T00:00:00.000Z', revision: 1 },
    ],
    schedules: [
      scheduleFor(cardB, { due: '2026-07-01T00:00:00.000Z', revision: 4, stability: 40, difficulty: 3, reps: 20, lapses: 1, state: 'review' }),
      scheduleFor(cardA, { due: '2026-06-01T00:00:00.000Z', revision: 3, stability: 1.5, difficulty: 5, reps: 1, lapses: 0, state: 'learning' }),
    ],
    reviewEvents: [
      {
        id: eventId,
        cardId: cardA,
        grade: 'good',
        affectsSchedule: true,
        reviewedAt: '2026-04-01T00:00:00.000Z',
        clientRequestId: randomUUID(),
        dueBefore: '2026-04-01T00:00:00.000Z',
        dueAfter: '2026-04-02T00:00:00.000Z',
        stateBefore: 'new',
        stateAfter: 'learning',
        scheduleRevisionBefore: 1,
        scheduleRevisionAfter: 2,
        stabilityBefore: 1,
        stabilityAfter: 1.5,
        difficultyBefore: 5,
        difficultyAfter: 5,
        scheduledDaysBefore: 0,
        scheduledDaysAfter: 1,
        repsAfter: 1,
        lapsesAfter: 0,
        elapsedDaysAfter: 0,
        learningStepsAfter: 0,
        createdAt: '2026-04-01T00:00:00.000Z',
      },
    ],
  };
}

function scheduleFor(cardId: string, overrides: Partial<ScheduleJson> & Pick<ScheduleJson, 'due' | 'revision' | 'stability' | 'state'>): ScheduleJson {
  return {
    cardId,
    due: overrides.due,
    stability: overrides.stability,
    difficulty: overrides.difficulty ?? 5,
    elapsedDays: overrides.elapsedDays ?? 0,
    scheduledDays: overrides.scheduledDays ?? 1,
    learningSteps: overrides.learningSteps ?? 0,
    reps: overrides.reps ?? 0,
    lapses: overrides.lapses ?? 0,
    state: overrides.state,
    lastReview: overrides.lastReview ?? null,
    revision: overrides.revision,
    updatedAt: overrides.updatedAt ?? when,
  };
}

const LEGACY_SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  progress_revision INTEGER NOT NULL DEFAULT 0 CHECK (progress_revision >= 0),
  created_at TEXT NOT NULL
);
CREATE TABLE word_senses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  lemma TEXT NOT NULL,
  part_of_speech TEXT NOT NULL,
  meaning TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE source_occurrences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  sense_id TEXT NOT NULL REFERENCES word_senses(id),
  sentence TEXT NOT NULL,
  sentence_translation TEXT,
  eqbank_item_id TEXT,
  eqbank_source TEXT,
  eqbank_locator TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE learner_cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  sense_id TEXT NOT NULL REFERENCES word_senses(id),
  occurrence_id TEXT NOT NULL REFERENCES source_occurrences(id),
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1)
);
CREATE TABLE schedules (
  card_id TEXT PRIMARY KEY REFERENCES learner_cards(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  due TEXT NOT NULL,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  elapsed_days INTEGER NOT NULL,
  scheduled_days INTEGER NOT NULL,
  learning_steps INTEGER NOT NULL,
  reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  state INTEGER NOT NULL CHECK (state IN (0, 1, 2, 3)),
  last_review TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL
);
CREATE TABLE review_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL REFERENCES learner_cards(id),
  grade TEXT NOT NULL CHECK (grade IN ('again', 'hard', 'good', 'easy')),
  affects_schedule INTEGER NOT NULL CHECK (affects_schedule IN (0, 1)),
  reviewed_at TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  due_before TEXT NOT NULL,
  due_after TEXT NOT NULL,
  state_before TEXT NOT NULL,
  state_after TEXT NOT NULL,
  schedule_revision_before INTEGER NOT NULL,
  schedule_revision_after INTEGER NOT NULL,
  stability_before REAL NOT NULL,
  stability_after REAL NOT NULL,
  difficulty_before REAL NOT NULL,
  difficulty_after REAL NOT NULL,
  scheduled_days_before INTEGER NOT NULL,
  scheduled_days_after INTEGER NOT NULL,
  reps_after INTEGER NOT NULL,
  lapses_after INTEGER NOT NULL,
  elapsed_days_after INTEGER NOT NULL,
  learning_steps_after INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, client_request_id)
);
CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`;

type LegacySnapshot = {
  path: string;
  schedules: unknown[];
  events: unknown[];
};

const LEGACY_SCHEDULE_SQL =
  'SELECT card_id, user_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, revision, updated_at FROM schedules ORDER BY card_id';
const LEGACY_EVENT_SQL =
  'SELECT id, user_id, card_id, grade, affects_schedule, reviewed_at, client_request_id, due_before, due_after, state_before, state_after, schedule_revision_before, schedule_revision_after, stability_before, stability_after, difficulty_before, difficulty_after, scheduled_days_before, scheduled_days_after, reps_after, lapses_after, elapsed_days_after, learning_steps_after, created_at FROM review_events ORDER BY id';

function seedLegacy(
  version: 1 | 2,
  floors: Array<{ cardId: string; highWater: number }>,
  revisions?: { donor?: number; sibling?: number; eventBefore?: number; eventAfter?: number },
): LegacySnapshot {
  const path = join(mkdtempSync(join(tmpdir(), 'wordloom-legacy-')), 'wordloom.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(LEGACY_SCHEMA);
  const createdAt = '2026-04-01T00:00:00.000Z';
  const donorRevision = revisions?.donor ?? 8;
  const siblingRevision = revisions?.sibling ?? 2;
  const eventBefore = revisions?.eventBefore ?? 1;
  const eventAfter = revisions?.eventAfter ?? 2;
  db.prepare('INSERT INTO users (id, email, password_hash, progress_revision, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'user-cards',
    'cards@example.com',
    'scrypt$placeholder',
    4,
    createdAt,
  );
  db.prepare('INSERT INTO users (id, email, password_hash, progress_revision, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'user-empty',
    'empty@example.com',
    'scrypt$placeholder',
    7,
    createdAt,
  );
  insertSense(db, 'sense-keel', 'user-cards', 'keel', createdAt);
  insertSense(db, 'sense-empty', 'user-empty', 'bark', createdAt);
  insertOccurrence(db, 'occ-unlinked', 'user-cards', 'sense-keel', 'No card points here.', '2026-03-01T00:00:00.000Z');
  insertOccurrence(db, 'occ-early', 'user-cards', 'sense-keel', 'The early sentence.', '2026-04-01T00:00:00.000Z');
  insertOccurrence(db, 'occ-late', 'user-cards', 'sense-keel', 'The late sentence.', '2026-05-01T00:00:00.000Z');
  insertOccurrence(db, 'occ-empty', 'user-empty', 'sense-empty', 'An empty sense keeps this sentence.', createdAt);
  insertCard(db, 'card-b', 'user-cards', 'sense-keel', 'occ-early');
  insertCard(db, 'card-a', 'user-cards', 'sense-keel', 'occ-late');
  insertLegacySchedule(db, 'card-b', siblingRevision, 40, 3.75, 20, 1, 2, 'user-cards', {
    due: '2026-12-20T07:08:09.000Z',
    elapsedDays: 17,
    scheduledDays: 33,
    learningSteps: 0,
    lastReview: '2026-11-03T07:08:09.000Z',
    updatedAt: '2026-12-20T07:08:09.000Z',
  });
  insertLegacySchedule(db, 'card-a', donorRevision, 1.5, 5.25, 1, 0, 1, 'user-cards', {
    due: '2026-05-02T04:05:06.000Z',
    elapsedDays: 4,
    scheduledDays: 6,
    learningSteps: 2,
    lastReview: '2026-04-28T04:05:06.000Z',
    updatedAt: '2026-05-02T04:05:06.000Z',
  });
  db.prepare(
    `INSERT INTO review_events (
      id, user_id, card_id, grade, affects_schedule, reviewed_at, client_request_id,
      due_before, due_after, state_before, state_after, schedule_revision_before, schedule_revision_after,
      stability_before, stability_after, difficulty_before, difficulty_after,
      scheduled_days_before, scheduled_days_after, reps_after, lapses_after, elapsed_days_after, learning_steps_after, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'event-1',
    'user-cards',
    'card-b',
    'good',
    1,
    '2026-04-02T01:02:03.000Z',
    'request-1',
    '2026-03-28T00:00:00.000Z',
    '2026-04-09T00:00:00.000Z',
    'review',
    'review',
    eventBefore,
    eventAfter,
    38.5,
    41.25,
    3.25,
    3.5,
    12,
    19,
    21,
    1,
    7,
    0,
    '2026-04-02T01:02:04.000Z',
  );
  db.prepare('INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'user-cards',
    'key-1',
    'hash-1',
    201,
    '{}',
    createdAt,
  );
  if (version === 2) {
    db.exec(`CREATE TABLE schedule_generation (
      user_id TEXT NOT NULL REFERENCES users(id),
      card_id TEXT NOT NULL,
      high_water INTEGER NOT NULL CHECK (high_water >= 1),
      PRIMARY KEY (user_id, card_id)
    )`);
    const insertFloor = db.prepare('INSERT INTO schedule_generation (user_id, card_id, high_water) VALUES (?, ?, ?)');
    for (const floor of floors) {
      insertFloor.run('user-cards', floor.cardId, floor.highWater);
    }
  }
  db.exec('CREATE TABLE schema_migrations (version INTEGER NOT NULL)');
  db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
  const schedules = readPlain(db, LEGACY_SCHEDULE_SQL);
  const events = readPlain(db, LEGACY_EVENT_SQL);
  db.close();
  return { path, schedules, events };
}

function seedOrphan(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'wordloom-orphan-')), 'wordloom.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(LEGACY_SCHEMA);
  db.prepare('INSERT INTO users (id, email, password_hash, progress_revision, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'user-1',
    'orphan@example.com',
    'scrypt$placeholder',
    1,
    when,
  );
  insertLegacySchedule(db, 'missing-card', 1, 1.5, 5, 0, 0, 1, 'user-1');
  db.exec('CREATE TABLE schema_migrations (version INTEGER NOT NULL)');
  db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
  db.close();
  return path;
}

function insertSense(db: DatabaseSync, id: string, userId: string, lemma: string, createdAt: string): void {
  db.prepare('INSERT INTO word_senses (id, user_id, lemma, part_of_speech, meaning, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    userId,
    lemma,
    'noun',
    `a synthetic sense for ${lemma}`,
    createdAt,
  );
}

function insertOccurrence(db: DatabaseSync, id: string, userId: string, senseId: string, sentence: string, createdAt: string): void {
  db.prepare(
    'INSERT INTO source_occurrences (id, user_id, sense_id, sentence, sentence_translation, eqbank_item_id, eqbank_source, eqbank_locator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, userId, senseId, sentence, null, null, null, null, createdAt);
}

function insertCard(db: DatabaseSync, id: string, userId: string, senseId: string, occurrenceId: string): void {
  db.prepare('INSERT INTO learner_cards (id, user_id, sense_id, occurrence_id, created_at, revision) VALUES (?, ?, ?, ?, ?, 1)').run(
    id,
    userId,
    senseId,
    occurrenceId,
    '2026-04-01T00:00:00.000Z',
  );
}

function insertLegacySchedule(
  db: DatabaseSync,
  cardId: string,
  revision: number,
  stability: number,
  difficulty: number,
  reps: number,
  lapses: number,
  state: number,
  userId = 'user-cards',
  fields: {
    due?: string;
    elapsedDays?: number;
    scheduledDays?: number;
    learningSteps?: number;
    lastReview?: string | null;
    updatedAt?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO schedules (
      card_id, user_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps,
      reps, lapses, state, last_review, revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cardId,
    userId,
    fields.due ?? '2026-06-01T00:00:00.000Z',
    stability,
    difficulty,
    fields.elapsedDays ?? 0,
    fields.scheduledDays ?? 1,
    fields.learningSteps ?? 0,
    reps,
    lapses,
    state,
    fields.lastReview === undefined ? null : fields.lastReview,
    revision,
    fields.updatedAt ?? when,
  );
}

function assertMigrated(db: DatabaseSync, seeded: LegacySnapshot, revision: number): void {
  assert.equal(versionOf(db), 3);
  assert.equal(progressOfUser(db, 'user-cards'), 5);
  assert.equal(progressOfUser(db, 'user-empty'), 7);
  assert.deepEqual(readPlain(db, LEGACY_SCHEDULE_SQL), seeded.schedules);
  assert.deepEqual(readPlain(db, LEGACY_EVENT_SQL), seeded.events);
  const event = db.prepare('SELECT task_id, occurrence_id FROM review_events').get() as { task_id: string | null; occurrence_id: string | null };
  assert.equal(event.task_id, null);
  assert.equal(event.occurrence_id, null);
  const donor = rowBy(seeded.schedules, 'card_id', 'card-a');
  const active = rowBy(
    readPlain(
      db,
      'SELECT donor_card_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, revision, updated_at, policy FROM task_schedules',
    ),
    'donor_card_id',
    'card-a',
  );
  assert.equal(active.revision, revision);
  assert.ok(revision > Number(donor.revision));
  assert.deepEqual(fsrsColumns(active), fsrsColumns(donor, revision));
  assert.equal(active.policy, 'sense-recognition-v1');
  const rotation = db.prepare('SELECT occurrence_id FROM task_rotation').get() as { occurrence_id: string };
  assert.equal(rotation.occurrence_id, 'occ-early');
  const archives = readPlain(
    db,
    'SELECT card_id, user_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, revision, updated_at, policy FROM schedule_archives ORDER BY card_id',
  );
  assert.equal(archives.length, seeded.schedules.length);
  for (const schedule of seeded.schedules as Array<Record<string, unknown>>) {
    const archived = rowBy(archives, 'card_id', String(schedule.card_id));
    assert.deepEqual(fsrsColumns(archived), fsrsColumns(schedule));
    assert.equal(archived.user_id, schedule.user_id);
    assert.equal(archived.policy, 'sense-recognition-v1');
  }
  assert.equal(countRows(db, 'learning_tasks', 'user-empty'), 0);
  const kept = db.prepare('SELECT sentence FROM source_occurrences WHERE user_id = ?').get('user-empty') as { sentence: string };
  assert.equal(kept.sentence, 'An empty sense keeps this sentence.');
  const key = db.prepare('SELECT key FROM idempotency_keys WHERE user_id = ?').get('user-cards') as { key: string };
  assert.equal(key.key, 'key-1');
}

function versionOf(db: DatabaseSync): number {
  const row = db.prepare('SELECT version FROM schema_migrations').get() as { version: number | bigint };
  return Number(row.version);
}

function progressOfUser(db: DatabaseSync, userId: string): number {
  const row = db.prepare('SELECT progress_revision FROM users WHERE id = ?').get(userId) as { progress_revision: number | bigint };
  return Number(row.progress_revision);
}

function floorsOf(db: DatabaseSync): Array<{ card_id: string; high_water: number }> {
  return readPlain(db, 'SELECT card_id, high_water FROM schedule_generation ORDER BY card_id') as Array<{
    card_id: string;
    high_water: number;
  }>;
}

function countRows(db: DatabaseSync, table: string, userId?: string): number {
  const sql = userId ? `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?` : `SELECT COUNT(*) AS n FROM ${table}`;
  const row = (userId ? db.prepare(sql).get(userId) : db.prepare(sql).get()) as { n: number | bigint };
  return Number(row.n);
}

function readPlain(db: DatabaseSync, sql: string, args: string[] = []): unknown[] {
  return (db.prepare(sql).all(...args) as Array<Record<string, unknown>>).map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = typeof value === 'bigint' ? Number(value) : value;
    }
    return out;
  });
}

const FSRS_FIELDS = [
  'due',
  'stability',
  'difficulty',
  'elapsed_days',
  'scheduled_days',
  'learning_steps',
  'reps',
  'lapses',
  'state',
  'last_review',
  'revision',
  'updated_at',
] as const;

function fsrsColumns(row: Record<string, unknown>, revision?: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of FSRS_FIELDS) {
    out[field] = field === 'revision' && revision !== undefined ? revision : row[field];
  }
  return out;
}

function rowBy(rows: unknown[], key: string, value: string): Record<string, unknown> {
  const found = (rows as Array<Record<string, unknown>>).find((row) => row[key] === value);
  assert.ok(found, `${key}=${value}`);
  return found;
}

type AccountSnapshot = {
  progress: number;
  word_senses: unknown[];
  source_occurrences: unknown[];
  learner_cards: unknown[];
  schedules: unknown[];
  review_events: unknown[];
  schedule_archives: unknown[];
  learning_tasks: unknown[];
  task_members: unknown[];
  task_schedules: unknown[];
  task_rotation: unknown[];
  task_generation: unknown[];
  schedule_generation: unknown[];
  alias_tombstones: unknown[];
  idempotency_keys: unknown[];
};

function accountSnapshot(dbPath: string, userId: string): AccountSnapshot {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = [
      'word_senses',
      'source_occurrences',
      'learner_cards',
      'schedules',
      'review_events',
      'schedule_archives',
      'learning_tasks',
      'task_members',
      'task_schedules',
      'task_rotation',
      'task_generation',
      'schedule_generation',
      'alias_tombstones',
      'idempotency_keys',
    ] as const;
    const order: Record<(typeof tables)[number], string> = {
      word_senses: 'id',
      source_occurrences: 'id',
      learner_cards: 'id',
      schedules: 'card_id',
      review_events: 'id',
      schedule_archives: 'card_id',
      learning_tasks: 'id',
      task_members: 'card_id',
      task_schedules: 'task_id',
      task_rotation: 'task_id',
      task_generation: 'task_id',
      schedule_generation: 'card_id',
      alias_tombstones: 'card_id',
      idempotency_keys: 'key',
    };
    const snapshot = { progress: progressOfUser(db, userId) } as AccountSnapshot;
    for (const table of tables) {
      snapshot[table] = readPlain(db, `SELECT * FROM ${table} WHERE user_id = ? ORDER BY ${order[table]}`, [userId]);
    }
    return snapshot;
  } finally {
    db.close();
  }
}

type StoredReceipt = {
  key: string;
  method: 'POST';
  path: string;
  body: Record<string, unknown>;
  status: number;
  response: unknown;
};

function requestHash(method: string, path: string, body: unknown): string {
  return sha256(`${method} ${path}\n${canonicalJson(body)}`);
}

async function seedLegacyReceipts(): Promise<{ path: string; email: string; userId: string; receipts: StoredReceipt[] }> {
  const path = join(mkdtempSync(join(tmpdir(), 'wordloom-receipts-')), 'wordloom.sqlite');
  const db = new DatabaseSync(path);
  const userId = randomUUID();
  const email = `legacy-${randomUUID()}@example.com`;
  const senseId = randomUUID();
  const occurrenceId = randomUUID();
  const cardId = randomUUID();
  const eventId = randomUUID();
  const createdAt = '2026-04-01T00:00:00.000Z';
  const reviewedAt = '2026-08-19T10:11:12.000Z';
  const addKey = 'legacy-add-key';
  const reviewKey = 'legacy-review-key';
  const restoreKey = 'legacy-restore-key';
  const addBody = {
    lemma: 'keel',
    partOfSpeech: 'noun',
    meaning: 'the timber along the bottom of a ship',
    sentence: 'The keel held in the swell.',
    sentenceTranslation: '龙骨稳住了。',
  };
  const addResponse = {
    item: {
      card: { id: cardId, senseId, occurrenceId, createdAt, revision: 1 },
      sense: {
        id: senseId,
        lemma: 'keel',
        partOfSpeech: 'noun',
        meaning: 'the timber along the bottom of a ship',
        createdAt,
      },
      occurrence: {
        id: occurrenceId,
        senseId,
        sentence: 'The keel held in the swell.',
        sentenceTranslation: '龙骨稳住了。',
        eqbank: null,
        createdAt,
      },
      schedule: {
        cardId,
        due: '2026-04-01T00:01:00.000Z',
        stability: 1,
        difficulty: 5,
        elapsedDays: 0,
        scheduledDays: 0,
        learningSteps: 0,
        reps: 0,
        lapses: 0,
        state: 'new',
        lastReview: null,
        revision: 1,
        updatedAt: createdAt,
      },
    },
    progressRevision: 1,
  };
  const reviewBody = { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 };
  const reviewPath = `/api/cards/${cardId}/reviews`;
  const reviewResponse = {
    event: {
      id: eventId,
      cardId,
      grade: 'good',
      affectsSchedule: true,
      reviewedAt,
      clientRequestId: reviewKey,
      dueBefore: '2026-04-01T00:01:00.000Z',
      dueAfter: '2026-08-19T10:11:12.000Z',
      stateBefore: 'new',
      stateAfter: 'learning',
      scheduleRevisionBefore: 1,
      scheduleRevisionAfter: 2,
      stabilityBefore: 1,
      stabilityAfter: 2.5,
      difficultyBefore: 5,
      difficultyAfter: 4.25,
      scheduledDaysBefore: 0,
      scheduledDaysAfter: 9,
      repsAfter: 2,
      lapsesAfter: 0,
      elapsedDaysAfter: 5,
      learningStepsAfter: 1,
      createdAt: reviewedAt,
    },
    schedule: {
      cardId,
      due: '2026-08-19T10:11:12.000Z',
      stability: 2.5,
      difficulty: 4.25,
      elapsedDays: 5,
      scheduledDays: 9,
      learningSteps: 1,
      reps: 2,
      lapses: 0,
      state: 'learning',
      lastReview: reviewedAt,
      revision: 2,
      updatedAt: reviewedAt,
    },
    progressRevision: 2,
  };
  const restoreDocument = syntheticV1();
  const restoreBody = { mode: 'replace', confirm: 'replace', document: restoreDocument };
  const restoreResponse = {
    mode: 'replace',
    progressRevision: 6,
    counts: {
      senses: restoreDocument.senses.length,
      occurrences: restoreDocument.occurrences.length,
      cards: restoreDocument.cards.length,
      schedules: restoreDocument.schedules.length,
      reviewEvents: restoreDocument.reviewEvents.length,
    },
  };
  const receipts: StoredReceipt[] = [
    { key: addKey, method: 'POST', path: '/api/cards', body: addBody, status: 201, response: addResponse },
    { key: reviewKey, method: 'POST', path: reviewPath, body: reviewBody, status: 201, response: reviewResponse },
    { key: restoreKey, method: 'POST', path: '/api/backup/restore', body: restoreBody, status: 200, response: restoreResponse },
  ];
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(LEGACY_SCHEMA);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE csrf_challenges (
        token_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE schedule_generation (
        user_id TEXT NOT NULL REFERENCES users(id),
        card_id TEXT NOT NULL,
        high_water INTEGER NOT NULL CHECK (high_water >= 1),
        PRIMARY KEY (user_id, card_id)
      );
    `);
    db.prepare('INSERT INTO users (id, email, password_hash, progress_revision, created_at) VALUES (?, ?, ?, ?, ?)').run(
      userId,
      email,
      await hashPassword(password),
      4,
      createdAt,
    );
    insertSense(db, senseId, userId, 'keel', createdAt);
    insertOccurrence(db, occurrenceId, userId, senseId, 'The keel held in the swell.', createdAt);
    insertCard(db, cardId, userId, senseId, occurrenceId);
    insertLegacySchedule(db, cardId, 2, 2.5, 4.25, 2, 0, 1, userId, {
      due: reviewedAt,
      elapsedDays: 5,
      scheduledDays: 9,
      learningSteps: 1,
      lastReview: reviewedAt,
      updatedAt: reviewedAt,
    });
    db.prepare(
      `INSERT INTO review_events (
        id, user_id, card_id, grade, affects_schedule, reviewed_at, client_request_id,
        due_before, due_after, state_before, state_after, schedule_revision_before, schedule_revision_after,
        stability_before, stability_after, difficulty_before, difficulty_after,
        scheduled_days_before, scheduled_days_after, reps_after, lapses_after, elapsed_days_after, learning_steps_after, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      userId,
      cardId,
      'good',
      1,
      reviewedAt,
      reviewKey,
      '2026-04-01T00:01:00.000Z',
      reviewedAt,
      'new',
      'learning',
      1,
      2,
      1,
      2.5,
      5,
      4.25,
      0,
      9,
      2,
      0,
      5,
      1,
      reviewedAt,
    );
    const insertReceipt = db.prepare(
      'INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const receipt of receipts) {
      insertReceipt.run(userId, receipt.key, requestHash(receipt.method, receipt.path, receipt.body), receipt.status, JSON.stringify(receipt.response), createdAt);
    }
    db.prepare('INSERT INTO schedule_generation (user_id, card_id, high_water) VALUES (?, ?, ?)').run(userId, cardId, 2);
    db.exec('CREATE TABLE schema_migrations (version INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (2)').run();
  } finally {
    db.close();
  }
  return { path, email, userId, receipts };
}

async function replayReceipts(app: RunningApp, jar: Jar, receipts: StoredReceipt[]): Promise<void> {
  for (const receipt of receipts) {
    const response = await api(app.base, jar, receipt.method, receipt.path, receipt.body, {
      csrf: 'session',
      idempotencyKey: receipt.key,
    });
    assert.equal(response.status, receipt.status, JSON.stringify(response.json));
    assert.equal(response.replayed, true, JSON.stringify(response.json));
    assert.deepEqual(response.json, receipt.response);
  }
}
