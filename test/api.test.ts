import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { lockedOwner } from '../src/auth.js';
import { sha256 } from '../src/crypto.js';
import { openDatabase, transaction } from '../src/db.js';
import { HttpError } from '../src/errors.js';
import { listenPolicyFromEnv, listenPortFromEnv, resolveListenPolicy } from '../src/protect.js';
import { api, emptyJar, login, register, startApp, type RunningApp } from './support.js';

const password = 'correct-horse-battery';

describe('wordloom backend', { concurrency: 1 }, () => {
  let app: RunningApp;
  const now = new Date('2026-04-01T12:00:00.000Z');

  before(async () => {
    app = await startApp({ now: () => new Date(now.getTime()) });
  });

  after(async () => {
    await app.close();
  });

  it('creates a scrypt password, an HttpOnly session, and rejects a bad login', async () => {
    const email = uniqueEmail('ada');
    const { jar, body, setCookie } = await register(app.base, email, password);
    assert.equal(body.user.email, email);
    assert.equal(jar.csrf, body.csrfToken);
    assert.ok(jar.cookies.get('wl_session'));
    const registerCookie = setCookie.join('\n');
    assert.match(registerCookie, /wl_session=[^;]+; Path=\/; SameSite=Lax; Max-Age=\d+; HttpOnly/);
    assert.equal(registerCookie.includes('Secure'), false);
    const me = await api(app.base, jar, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);

    const db = new DatabaseSync(app.dbPath);
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email) as {
      id: string;
      password_hash: string;
    };
    const session = db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(user.id) as { token_hash: string };
    db.close();
    assert.match(user.password_hash, /^scrypt\$16384\$8\$1\$/);
    assert.equal(user.password_hash.includes(password), false);
    assert.equal(session.token_hash, sha256(jar.cookies.get('wl_session') ?? ''));
    assert.notEqual(session.token_hash, jar.cookies.get('wl_session'));

    const created = await api(app.base, jar, 'GET', '/api/csrf');
    const lines = created.setCookie.join('\n');
    assert.match(lines, /wl_setup_csrf=/);

    const badJar = emptyJar();
    await api(app.base, badJar, 'GET', '/api/csrf');
    const badLogin = await api(
      app.base,
      badJar,
      'POST',
      '/api/auth/login',
      { email, password: 'not-the-password' },
      { csrf: 'setup' },
    );
    assert.equal(badLogin.status, 401);
    assert.equal(badLogin.json.error.code, 'INVALID_CREDENTIALS');
    assert.equal(badLogin.setCookie.some((line) => line.startsWith('wl_session=')), false);

    const duplicateCookies = await rawRegisterCookies(app.base, email);
    assert.equal(duplicateCookies.some((line) => line.startsWith('wl_session=')), false);

    const stranger = await api(app.base, { cookies: new Map(), setup: '', csrf: '' }, 'GET', '/api/cards');
    assert.equal(stranger.status, 401);
    assert.equal(stranger.json.error.code, 'UNAUTHENTICATED');
  });

  it('shares cards, reviews, and schedules across two sessions of one account', async () => {
    const email = uniqueEmail('shared');
    const first = (await register(app.base, email, password)).jar;
    const second = await login(app.base, email, password);
    const created = await api(
      app.base,
      first,
      'POST',
      '/api/cards',
      {
        lemma: 'harbor',
        partOfSpeech: 'noun',
        meaning: 'a sheltered place for ships',
        sentence: 'The harbor light was a thin line across the water.',
      },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(created.status, 201);
    const item = created.json.item;
    assert.equal(item.sense.meaning, 'a sheltered place for ships');
    assert.equal(item.occurrence.sentence, 'The harbor light was a thin line across the water.');
    assert.equal(item.schedule.revision, 1);
    assert.equal(item.schedule.state, 'new');

    const queued = await api(app.base, second, 'GET', '/api/queue');
    assert.equal(queued.status, 200);
    assert.ok(queued.json.items.some((entry: { card: { id: string } }) => entry.card.id === item.card.id));

    const reviewed = await api(
      app.base,
      first,
      'POST',
      `/api/cards/${item.card.id}/reviews`,
      { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(reviewed.status, 201);
    assert.equal(reviewed.json.schedule.revision, 2);
    assert.notEqual(reviewed.json.schedule.due, item.schedule.due);
    assert.ok(Date.parse(reviewed.json.schedule.due) > Date.parse(item.schedule.due));

    const seen = await api(app.base, second, 'GET', `/api/cards/${item.card.id}`);
    assert.equal(seen.json.item.schedule.due, reviewed.json.schedule.due);
    assert.equal(seen.json.item.occurrence.sentence, item.occurrence.sentence);
    assert.equal(seen.json.item.sense.meaning, item.sense.meaning);
    const events = await api(app.base, second, 'GET', `/api/cards/${item.card.id}/events`);
    assert.equal(events.json.events.length, 1);
    assert.equal(events.json.events[0].id, reviewed.json.event.id);
    assert.equal(events.json.events[0].affectsSchedule, true);
    const firstUser = await api(app.base, first, 'GET', '/api/auth/me');
    const secondUser = await api(app.base, second, 'GET', '/api/auth/me');
    assert.equal(secondUser.json.user.progressRevision, firstUser.json.user.progressRevision);
    assert.equal(secondUser.json.user.progressRevision, reviewed.json.progressRevision);
  });

  it('keeps accounts isolated, including restore of another snapshot', async () => {
    const owner = (await register(app.base, uniqueEmail('owner'), password)).jar;
    const other = (await register(app.base, uniqueEmail('other'), password)).jar;
    const created = await api(
      app.base,
      owner,
      'POST',
      '/api/cards',
      {
        lemma: 'keel',
        partOfSpeech: 'noun',
        meaning: 'the spine of a ship',
        sentence: 'The keel held the hull in line.',
      },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    const cardId = created.json.item.card.id;
    const senseId = created.json.item.sense.id;

    const list = await api(app.base, other, 'GET', '/api/cards');
    assert.deepEqual(list.json.items, []);
    const read = await api(app.base, other, 'GET', `/api/cards/${cardId}`);
    assert.equal(read.status, 404);
    const review = await api(
      app.base,
      other,
      'POST',
      `/api/cards/${cardId}/reviews`,
      { grade: 'again', affectsSchedule: true, expectedScheduleRevision: 1 },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(review.status, 404);
    const attach = await api(
      app.base,
      other,
      'POST',
      '/api/cards',
      { senseId, sentence: 'A second sentence should not attach to someone else.' },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(attach.status, 404);

    const backup = await api(app.base, owner, 'GET', '/api/backup');
    const stolen = await api(
      app.base,
      other,
      'POST',
      '/api/backup/restore',
      { mode: 'replace', confirm: 'replace', document: backup.json },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(stolen.status, 409);
    assert.equal(stolen.json.error.code, 'CONFLICT');
    const stillThere = await api(app.base, owner, 'GET', `/api/cards/${cardId}`);
    assert.equal(stillThere.status, 200);
    const otherBackup = await api(app.base, other, 'GET', '/api/backup');
    assert.deepEqual(otherBackup.json.cards, []);
    const replaced = await api(
      app.base,
      other,
      'POST',
      '/api/backup/restore',
      { mode: 'replace', confirm: 'replace', document: otherBackup.json },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(replaced.status, 200);
    const ownerStill = await api(app.base, owner, 'GET', `/api/cards/${cardId}`);
    assert.equal(ownerStill.status, 200);
  });

  it('applies duplicate adds and reviews once, and rejects a reused key with a different body', async () => {
    const jar = (await register(app.base, uniqueEmail('dup'), password)).jar;
    const key = randomUUID();
    const body = {
      lemma: 'lumen',
      partOfSpeech: 'noun',
      meaning: 'a unit of luminous flux',
      sentence: 'The lamp cast a single lumen across the bench.',
      eqbank: { itemId: 'synthetic-item-1', source: 'eqbank', locator: 'fixture/unit-3' },
    };
    const first = await api(app.base, jar, 'POST', '/api/cards', body, { csrf: 'session', idempotencyKey: key });
    const second = await api(app.base, jar, 'POST', '/api/cards', body, { csrf: 'session', idempotencyKey: key });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.replayed, true);
    assert.equal(second.json.item.card.id, first.json.item.card.id);
    assert.equal(second.json.item.occurrence.eqbank.source, 'eqbank');
    const listed = await api(app.base, jar, 'GET', '/api/cards');
    assert.equal(listed.json.items.length, 1);

    const cardId = first.json.item.card.id;
    const reviewKey = randomUUID();
    const reviewBody = { grade: 'easy', affectsSchedule: true, expectedScheduleRevision: 1 };
    const [left, right] = await Promise.all([
      api(app.base, jar, 'POST', `/api/cards/${cardId}/reviews`, reviewBody, { csrf: 'session', idempotencyKey: reviewKey }),
      api(app.base, jar, 'POST', `/api/cards/${cardId}/reviews`, reviewBody, { csrf: 'session', idempotencyKey: reviewKey }),
    ]);
    assert.equal(left.status, 201);
    assert.equal(right.status, 201);
    assert.equal(left.json.event.id, right.json.event.id);
    const events = await api(app.base, jar, 'GET', `/api/cards/${cardId}/events`);
    assert.equal(events.json.events.length, 1);

    const conflict = await api(
      app.base,
      jar,
      'POST',
      `/api/cards/${cardId}/reviews`,
      { grade: 'again', affectsSchedule: true, expectedScheduleRevision: 2 },
      { csrf: 'session', idempotencyKey: reviewKey },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT');
    const afterConflict = await api(app.base, jar, 'GET', `/api/cards/${cardId}/events`);
    assert.equal(afterConflict.json.events.length, 1);
    assert.equal(afterConflict.json.events[0].grade, 'easy');
  });

  it('rejects a stale schedule revision and keeps practice reviews off the scheduler', async () => {
    const jar = (await register(app.base, uniqueEmail('rev'), password)).jar;
    const created = await api(
      app.base,
      jar,
      'POST',
      '/api/cards',
      {
        lemma: 'bilge',
        partOfSpeech: 'noun',
        meaning: 'the lowest inner part of a hull',
        sentence: 'Water gathered in the bilge overnight.',
      },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    const cardId = created.json.item.card.id;
    const due = created.json.item.schedule.due;
    const practice = await api(
      app.base,
      jar,
      'POST',
      `/api/cards/${cardId}/reviews`,
      { grade: 'hard', affectsSchedule: false, expectedScheduleRevision: 1 },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(practice.status, 201);
    assert.equal(practice.json.event.affectsSchedule, false);
    assert.equal(practice.json.schedule.revision, 1);
    assert.equal(practice.json.schedule.due, due);

    const graded = await api(
      app.base,
      jar,
      'POST',
      `/api/cards/${cardId}/reviews`,
      { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(graded.status, 201);
    assert.equal(graded.json.schedule.revision, 2);
    const stale = await api(
      app.base,
      jar,
      'POST',
      `/api/cards/${cardId}/reviews`,
      { grade: 'again', affectsSchedule: true, expectedScheduleRevision: 1 },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'REVISION_CONFLICT');
    assert.equal(stale.json.error.scheduleRevision, 2);
    const events = await api(app.base, jar, 'GET', `/api/cards/${cardId}/events`);
    assert.equal(events.json.events.length, 2);
    assert.equal(events.json.events[0].grade, 'hard');
    assert.equal(events.json.events[1].grade, 'good');
    const current = await api(app.base, jar, 'GET', `/api/cards/${cardId}`);
    assert.equal(current.json.item.schedule.due, graded.json.schedule.due);

    const missingCsrf = await api(
      app.base,
      jar,
      'POST',
      `/api/cards/${cardId}/reviews`,
      { grade: 'again', affectsSchedule: true, expectedScheduleRevision: 2 },
      { idempotencyKey: randomUUID() },
    );
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.json.error.code, 'CSRF_FAILED');
    const stillTwo = await api(app.base, jar, 'GET', `/api/cards/${cardId}/events`);
    assert.equal(stillTwo.json.events.length, 2);

    const db = new DatabaseSync(app.dbPath);
    assert.throws(
      () => db.prepare('UPDATE review_events SET grade = ? WHERE id = ?').run('again', events.json.events[0].id),
      /append-only/,
    );
    db.close();
  });

  it('logs out one session and leaves the other session on the same account', async () => {
    const email = uniqueEmail('bye');
    const first = (await register(app.base, email, password)).jar;
    const second = await login(app.base, email, password);
    const created = await api(
      app.base,
      first,
      'POST',
      '/api/cards',
      {
        lemma: 'wake',
        partOfSpeech: 'noun',
        meaning: 'the trail of water behind a boat',
        sentence: 'The wake spread out behind the ferry.',
      },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    const loggedOut = await api(app.base, first, 'POST', '/api/auth/logout', undefined, { csrf: 'session' });
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.setCookie.join('\n'), /wl_session=;[^]*Max-Age=0/);
    assert.match(loggedOut.setCookie.join('\n'), /HttpOnly/);
    const gone = await api(app.base, first, 'GET', '/api/auth/me');
    assert.equal(gone.status, 401);
    const review = await api(
      app.base,
      first,
      'POST',
      `/api/cards/${created.json.item.card.id}/reviews`,
      { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(review.status, 401);
    const still = await api(app.base, second, 'GET', `/api/cards/${created.json.item.card.id}`);
    assert.equal(still.status, 200);
    assert.equal(still.json.item.occurrence.sentence, 'The wake spread out behind the ferry.');
  });

  it('restores a versioned backup and replays the same restore without applying it twice', async () => {
    const email = uniqueEmail('backup');
    const first = (await register(app.base, email, password)).jar;
    const second = await login(app.base, email, password);
    const created = await api(
      app.base,
      first,
      'POST',
      '/api/cards',
      {
        lemma: 'fathom',
        partOfSpeech: 'noun',
        meaning: 'a unit of water depth',
        sentence: 'The sounding line read six fathom.',
      },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    const cardId = created.json.item.card.id;
    await api(
      app.base,
      first,
      'POST',
      `/api/cards/${cardId}/reviews`,
      { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    const backup = await api(app.base, second, 'GET', '/api/backup');
    assert.equal(backup.json.schemaVersion, 1);
    assert.equal(backup.json.cards.length, 1);
    assert.equal(backup.json.reviewEvents.length, 1);
    assert.equal(backup.json.occurrences[0].sentence, 'The sounding line read six fathom.');
    assert.equal(backup.json.senses[0].meaning, 'a unit of water depth');

    await api(
      app.base,
      first,
      'POST',
      '/api/cards',
      {
        lemma: 'extra',
        partOfSpeech: 'adjective',
        meaning: 'added later and not part of the snapshot',
        sentence: 'An extra line arrived after the export.',
      },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    const restoreKey = randomUUID();
    const restored = await api(
      app.base,
      first,
      'POST',
      '/api/backup/restore',
      { mode: 'replace', confirm: 'replace', document: backup.json },
      { csrf: 'session', idempotencyKey: restoreKey },
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.json.counts.cards, 1);
    assert.equal(restored.json.counts.reviewEvents, 1);
    const after = await api(app.base, second, 'GET', '/api/cards');
    assert.equal(after.json.items.length, 1);
    assert.equal(after.json.items[0].card.id, cardId);
    assert.equal(after.json.items[0].occurrence.sentence, 'The sounding line read six fathom.');
    assert.equal(after.json.items[0].sense.meaning, 'a unit of water depth');
    assert.equal(after.json.items[0].schedule.due, backup.json.schedules[0].due);
    assert.equal(after.json.items[0].schedule.stability, backup.json.schedules[0].stability);
    assert.equal(after.json.items[0].schedule.difficulty, backup.json.schedules[0].difficulty);
    assert.equal(after.json.items[0].schedule.state, backup.json.schedules[0].state);
    assert.equal(after.json.items[0].schedule.revision, backup.json.schedules[0].revision + 1);
    const events = await api(app.base, second, 'GET', `/api/cards/${cardId}/events`);
    assert.equal(events.json.events[0].id, backup.json.reviewEvents[0].id);

    await api(
      app.base,
      second,
      'POST',
      '/api/cards',
      {
        lemma: 'again',
        partOfSpeech: 'adverb',
        meaning: 'a card added after restore',
        sentence: 'The line was measured again.',
      },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    const replay = await api(
      app.base,
      second,
      'POST',
      '/api/backup/restore',
      { mode: 'replace', confirm: 'replace', document: backup.json },
      { csrf: 'session', idempotencyKey: restoreKey },
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.json, restored.json);
    const duringReplay = await api(app.base, first, 'GET', '/api/cards');
    assert.equal(duringReplay.json.items.length, 2);

    const freshKey = await api(
      app.base,
      first,
      'POST',
      '/api/backup/restore',
      { mode: 'replace', confirm: 'replace', document: backup.json },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(freshKey.status, 200);
    const rolledBack = await api(app.base, second, 'GET', '/api/cards');
    assert.equal(rolledBack.json.items.length, 1);
    assert.equal(rolledBack.json.items[0].card.id, cardId);

    const newer = structuredClone(backup.json);
    newer.schemaVersion = 2;
    const rejected = await api(
      app.base,
      first,
      'POST',
      '/api/backup/restore',
      { mode: 'replace', confirm: 'replace', document: newer },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.error.code, 'SCHEMA_UNSUPPORTED');
    const unchanged = await api(app.base, second, 'GET', `/api/cards/${cardId}`);
    assert.equal(unchanged.status, 200);
  });

  it('separates senses from source sentences and keeps optional eqbank metadata local', async () => {
    const jar = (await register(app.base, uniqueEmail('sense'), password)).jar;
    const verb = await api(
      app.base,
      jar,
      'POST',
      '/api/cards',
      {
        lemma: 'abandon',
        partOfSpeech: 'verb',
        meaning: 'to leave something and not return',
        sentence: 'They had to abandon the ship before dawn.',
      },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    const noun = await api(
      app.base,
      jar,
      'POST',
      '/api/cards',
      {
        lemma: 'abandon',
        partOfSpeech: 'noun',
        meaning: 'a complete lack of restraint',
        sentence: 'He danced with abandon.',
      },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    const secondSentence = await api(
      app.base,
      jar,
      'POST',
      '/api/cards',
      { senseId: verb.json.item.sense.id, sentence: 'The crew would not abandon the passengers.' },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    assert.notEqual(verb.json.item.sense.id, noun.json.item.sense.id);
    assert.equal(secondSentence.json.item.sense.id, verb.json.item.sense.id);
    assert.notEqual(secondSentence.json.item.occurrence.id, verb.json.item.occurrence.id);
    assert.equal(secondSentence.json.item.sense.meaning, 'to leave something and not return');
    assert.equal(secondSentence.json.item.occurrence.sentence, 'The crew would not abandon the passengers.');

    const senses = await api(app.base, jar, 'GET', '/api/senses');
    const verbSense = senses.json.senses.find((sense: { id: string }) => sense.id === verb.json.item.sense.id);
    const nounSense = senses.json.senses.find((sense: { id: string }) => sense.id === noun.json.item.sense.id);
    assert.equal(verbSense.occurrences.length, 2);
    assert.equal(nounSense.occurrences.length, 1);
    assert.equal(verbSense.lemma, nounSense.lemma);

    const withMeta = await api(
      app.base,
      jar,
      'POST',
      '/api/cards',
      {
        lemma: 'lumen',
        partOfSpeech: 'noun',
        meaning: 'the chosen sense: a unit of luminous flux',
        sentence: 'The lamp cast a single lumen across the bench.',
        eqbank: { itemId: 'synthetic-item-1', source: 'eqbank', locator: 'fixture/unit-3' },
      },
      { csrf: 'session', idempotencyKey: randomUUID() },
    );
    const backup = await api(app.base, jar, 'GET', '/api/backup');
    const stored = backup.json.occurrences.find(
      (occurrence: { sentence: string }) => occurrence.sentence === 'The lamp cast a single lumen across the bench.',
    );
    assert.deepEqual(stored.eqbank, { itemId: 'synthetic-item-1', source: 'eqbank', locator: 'fixture/unit-3' });
    assert.equal(withMeta.json.item.occurrence.eqbank.locator, 'fixture/unit-3');
  });
});

describe('secure cookies', () => {
  it('marks the session cookie Secure when configured', async () => {
    const app = await startApp({ secureCookies: true });
    try {
      const jar = { cookies: new Map<string, string>(), setup: '', csrf: '' };
      const setup = await api(app.base, jar, 'GET', '/api/csrf');
      const created = await api(
        app.base,
        jar,
        'POST',
        '/api/auth/register',
        { email: uniqueEmail('secure'), password },
        { csrf: 'setup' },
      );
      assert.equal(setup.status, 200);
      assert.equal(created.status, 201);
      const sessionLine = created.setCookie.find((line) => line.startsWith('wl_session='));
      assert.ok(sessionLine);
      assert.match(sessionLine, /HttpOnly/);
      assert.match(sessionLine, /Secure/);
      assert.match(sessionLine, /SameSite=Lax/);
    } finally {
      await app.close();
    }
  });
});

describe('cookie mutation guards', () => {
  const windowMs = 15 * 60 * 1000;

  it('limits CSRF setup and does not set a cookie on the blocked call', async () => {
    const app = await startApp({ csrfRateLimit: { limit: 2, windowMs } });
    try {
      const first = await api(app.base, emptyJar(), 'GET', '/api/csrf');
      const second = await api(app.base, emptyJar(), 'GET', '/api/csrf');
      const blocked = await api(app.base, emptyJar(), 'GET', '/api/csrf');
      assert.equal(first.status, 200);
      assert.match(first.setCookie.join('\n'), /wl_setup_csrf=/);
      assert.equal(second.status, 200);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.json.error.code, 'RATE_LIMITED');
      assert.equal(blocked.setCookie.length, 0);
      assert.equal(blocked.retryAfter, String(blocked.json.error.retryAfterSeconds));
      assert.ok(blocked.json.error.retryAfterSeconds >= 1);
    } finally {
      await app.close();
    }
  });

  it('counts register and failed login, then refuses another auth write without a session cookie', async () => {
    const app = await startApp({
      authRateLimit: { limit: 2, windowMs },
      csrfRateLimit: { limit: 20, windowMs },
    });
    try {
      const email = uniqueEmail('limit');
      const registered = await register(app.base, email, password);
      const badJar = emptyJar();
      const setup = await api(app.base, badJar, 'GET', '/api/csrf');
      assert.equal(setup.status, 200);
      const badLogin = await api(
        app.base,
        badJar,
        'POST',
        '/api/auth/login',
        { email, password: 'not-the-password' },
        { csrf: 'setup' },
      );
      assert.equal(badLogin.status, 401);
      assert.equal(badLogin.json.error.code, 'INVALID_CREDENTIALS');
      assert.equal(badLogin.setCookie.some((line) => line.startsWith('wl_session=')), false);

      const blockedJar = emptyJar();
      await api(app.base, blockedJar, 'GET', '/api/csrf');
      const blocked = await api(
        app.base,
        blockedJar,
        'POST',
        '/api/auth/login',
        { email, password },
        { csrf: 'setup' },
      );
      assert.equal(blocked.status, 429);
      assert.equal(blocked.json.error.code, 'RATE_LIMITED');
      assert.equal(blocked.setCookie.length, 0);
      assert.equal(blocked.retryAfter, String(blocked.json.error.retryAfterSeconds));

      const logout = await api(app.base, registered.jar, 'POST', '/api/auth/logout', undefined, { csrf: 'session' });
      assert.equal(logout.status, 429);
      assert.equal(logout.setCookie.length, 0);
      const me = await api(app.base, registered.jar, 'GET', '/api/auth/me');
      assert.equal(me.status, 200);
    } finally {
      await app.close();
    }
  });

  it('rejects a foreign or missing origin and does not spend the rate limit', async () => {
    const app = await startApp({
      authRateLimit: { limit: 1, windowMs },
      csrfRateLimit: { limit: 1, windowMs },
    });
    try {
      const foreign = await api(app.base, emptyJar(), 'GET', '/api/csrf', undefined, { origin: 'http://evil.example' });
      assert.equal(foreign.status, 403);
      assert.equal(foreign.json.error.code, 'ORIGIN_REJECTED');
      assert.equal(foreign.setCookie.length, 0);

      const missing = await api(app.base, emptyJar(), 'GET', '/api/csrf', undefined, { origin: null });
      assert.equal(missing.status, 403);
      assert.equal(missing.json.error.code, 'ORIGIN_REJECTED');
      assert.equal(missing.setCookie.length, 0);

      const opaque = await api(app.base, emptyJar(), 'GET', '/api/csrf', undefined, {
        origin: 'null',
        referer: `${app.base}/`,
      });
      assert.equal(opaque.status, 403);
      assert.equal(opaque.json.error.code, 'ORIGIN_REJECTED');
      assert.equal(opaque.setCookie.length, 0);

      const allowed = await api(app.base, emptyJar(), 'GET', '/api/csrf');
      assert.equal(allowed.status, 200);
      assert.match(allowed.setCookie.join('\n'), /wl_setup_csrf=/);

      const jar = emptyJar();
      jar.cookies.set('wl_setup_csrf', allowed.json.csrfToken);
      jar.setup = allowed.json.csrfToken;
      const email = uniqueEmail('origin');
      const foreignRegister = await api(
        app.base,
        jar,
        'POST',
        '/api/auth/register',
        { email, password },
        { csrf: 'setup', origin: 'http://evil.example' },
      );
      assert.equal(foreignRegister.status, 403);
      assert.equal(foreignRegister.json.error.code, 'ORIGIN_REJECTED');
      assert.equal(foreignRegister.setCookie.some((line) => line.startsWith('wl_session=')), false);

      const missingRegister = await api(
        app.base,
        jar,
        'POST',
        '/api/auth/register',
        { email, password },
        { csrf: 'setup', origin: null },
      );
      assert.equal(missingRegister.status, 403);
      assert.equal(missingRegister.setCookie.length, 0);

      const created = await api(app.base, jar, 'POST', '/api/auth/register', { email, password }, { csrf: 'setup' });
      assert.equal(created.status, 201);
      assert.ok(created.setCookie.some((line) => line.startsWith('wl_session=')));

      const foreignLogout = await api(app.base, jar, 'POST', '/api/auth/logout', undefined, {
        csrf: 'session',
        origin: 'http://evil.example',
      });
      assert.equal(foreignLogout.status, 403);
      assert.equal(foreignLogout.json.error.code, 'ORIGIN_REJECTED');
      assert.equal(foreignLogout.setCookie.length, 0);
      const missingLogout = await api(app.base, jar, 'POST', '/api/auth/logout', undefined, {
        csrf: 'session',
        origin: null,
      });
      assert.equal(missingLogout.status, 403);
      assert.equal(missingLogout.setCookie.length, 0);
      const me = await api(app.base, jar, 'GET', '/api/auth/me');
      assert.equal(me.status, 200);
    } finally {
      await app.close();
    }
  });

  it('accepts a loopback Referer when Origin is absent', async () => {
    const app = await startApp();
    try {
      const jar = emptyJar();
      const setup = await api(app.base, jar, 'GET', '/api/csrf', undefined, {
        origin: null,
        referer: `${app.base}/library`,
      });
      assert.equal(setup.status, 200);
      assert.match(setup.setCookie.join('\n'), /wl_setup_csrf=/);
      assert.equal(jar.setup, setup.json.csrfToken);
    } finally {
      await app.close();
    }
  });

  it('uses an explicit origin list instead of every loopback origin', async () => {
    const allowedOrigin = 'http://127.0.0.1:5173';
    const app = await startApp({
      originPolicy: { kind: 'list', origins: new Set([allowedOrigin]) },
    });
    try {
      const blocked = await api(app.base, emptyJar(), 'GET', '/api/csrf');
      assert.equal(blocked.status, 403);
      assert.equal(blocked.json.error.code, 'ORIGIN_REJECTED');
      const allowed = await api(app.base, emptyJar(), 'GET', '/api/csrf', undefined, { origin: allowedOrigin });
      assert.equal(allowed.status, 200);
      assert.match(allowed.setCookie.join('\n'), /wl_setup_csrf=/);
    } finally {
      await app.close();
    }
  });
});

describe('listen policy', () => {
  it('keeps local loopback testing on non-secure cookies', () => {
    const policy = resolveListenPolicy({
      host: '127.0.0.1',
      production: false,
      secureCookies: false,
      publicReviewed: false,
      allowedOrigins: undefined,
    });
    assert.equal(policy.secureCookies, false);
    assert.equal(policy.originPolicy.kind, 'loopback');
    assert.equal(resolveListenPolicy({
      host: '[::1]',
      production: false,
      secureCookies: false,
      publicReviewed: false,
      allowedOrigins: undefined,
    }).originPolicy.kind, 'loopback');
  });

  it('refuses production without secure cookies or an exact origin list', () => {
    assert.throws(
      () =>
        resolveListenPolicy({
          host: '127.0.0.1',
          production: true,
          secureCookies: false,
          publicReviewed: false,
          allowedOrigins: ['https://words.example'],
        }),
      /WORDLOOM_SECURE_COOKIES=1/,
    );
    assert.throws(
      () =>
        resolveListenPolicy({
          host: '127.0.0.1',
          production: true,
          secureCookies: true,
          publicReviewed: false,
          allowedOrigins: undefined,
        }),
      /WORDLOOM_ALLOWED_ORIGINS/,
    );
    assert.throws(
      () =>
        resolveListenPolicy({
          host: '127.0.0.1',
          production: true,
          secureCookies: true,
          publicReviewed: false,
          allowedOrigins: ['https://words.example/app'],
        }),
      /exact http\(s\) origin/,
    );
    const policy = resolveListenPolicy({
      host: '127.0.0.1',
      production: true,
      secureCookies: true,
      publicReviewed: false,
      allowedOrigins: ['https://words.example'],
    });
    assert.equal(policy.secureCookies, true);
    assert.equal(policy.originPolicy.kind, 'list');
    if (policy.originPolicy.kind === 'list') {
      assert.equal(policy.originPolicy.origins.has('https://words.example'), true);
    }
  });

  it('refuses a public bind until it is reviewed with secure cookies and exact origins', () => {
    assert.throws(
      () =>
        resolveListenPolicy({
          host: '0.0.0.0',
          production: false,
          secureCookies: true,
          publicReviewed: false,
          allowedOrigins: ['https://words.example'],
        }),
      /WORDLOOM_PUBLIC_REVIEWED=1/,
    );
    assert.throws(
      () =>
        resolveListenPolicy({
          host: '0.0.0.0',
          production: false,
          secureCookies: false,
          publicReviewed: true,
          allowedOrigins: ['https://words.example'],
        }),
      /WORDLOOM_SECURE_COOKIES=1/,
    );
    assert.throws(
      () =>
        resolveListenPolicy({
          host: '0.0.0.0',
          production: false,
          secureCookies: true,
          publicReviewed: true,
          allowedOrigins: [],
        }),
      /WORDLOOM_ALLOWED_ORIGINS/,
    );
    const policy = resolveListenPolicy({
      host: '0.0.0.0',
      production: false,
      secureCookies: true,
      publicReviewed: true,
      allowedOrigins: ['https://words.example'],
    });
    assert.equal(policy.secureCookies, true);
    assert.equal(policy.originPolicy.kind, 'list');
  });
});

describe('vite 5173 to api 8787', () => {
  const viteOrigin = 'http://127.0.0.1:5173';

  it('accepts the Vite dev origin under start:dev and keeps production origin checks', async () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: { 'start:dev': string };
    };
    const startDev = packageJson.scripts['start:dev'];
    assert.equal(
      startDev,
      'HOST=127.0.0.1 PORT=8787 WORDLOOM_ALLOWED_ORIGINS=http://127.0.0.1:5173 node dist/src/index.js',
    );
    const devEnv = envFromCommand(startDev);
    assert.equal(devEnv.NODE_ENV, undefined);
    assert.equal(devEnv.WORDLOOM_SECURE_COOKIES, undefined);
    assert.equal(devEnv.WORDLOOM_PUBLIC_REVIEWED, undefined);
    assert.equal(listenPortFromEnv(devEnv), 8787);
    const devPolicy = listenPolicyFromEnv(devEnv);
    assert.equal(devPolicy.secureCookies, false);
    assert.equal(devPolicy.originPolicy.kind, 'list');
    if (devPolicy.originPolicy.kind === 'list') {
      assert.deepEqual([...devPolicy.originPolicy.origins], [viteOrigin]);
    }
    assert.throws(() => listenPolicyFromEnv({ ...devEnv, NODE_ENV: 'production' }), /WORDLOOM_SECURE_COOKIES=1/);

    const viteConfig = readFileSync(new URL('../../web/vite.config.ts', import.meta.url), 'utf8');
    assert.match(viteConfig, /process\.env\.WORDLOOM_API \?\? 'http:\/\/127\.0\.0\.1:8787'/);
    assert.match(viteConfig, /changeOrigin: false/);
    assert.match(viteConfig, /host: '127\.0\.0\.1'/);
    assert.match(viteConfig, /port: 5173/);

    const app = await startApp({
      secureCookies: devPolicy.secureCookies,
      originPolicy: devPolicy.originPolicy,
    });
    try {
      const vite = { origin: viteOrigin };
      const health = await api(app.base, emptyJar(), 'GET', '/api/health', undefined, vite);
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);

      const jar = emptyJar();
      const setup = await api(app.base, jar, 'GET', '/api/csrf', undefined, vite);
      assert.equal(setup.status, 200);
      assert.match(setup.setCookie.join('\n'), /wl_setup_csrf=/);
      assert.equal(setup.setCookie.join('\n').includes('Secure'), false);

      const email = uniqueEmail('vite');
      const created = await api(
        app.base,
        jar,
        'POST',
        '/api/auth/register',
        { email, password },
        { csrf: 'setup', ...vite },
      );
      assert.equal(created.status, 201);
      assert.match(created.setCookie.join('\n'), /wl_session=[^;]+; Path=\/; SameSite=Lax; Max-Age=\d+; HttpOnly/);
      assert.equal(created.setCookie.join('\n').includes('Secure'), false);

      const me = await api(app.base, jar, 'GET', '/api/auth/me', undefined, vite);
      assert.equal(me.status, 200);
      assert.equal(me.json.user.email, email);

      const card = await api(
        app.base,
        jar,
        'POST',
        '/api/cards',
        {
          lemma: 'harbor',
          partOfSpeech: 'noun',
          meaning: 'a sheltered place for ships',
          sentence: 'The harbor light was a thin line across the water.',
        },
        { csrf: 'session', idempotencyKey: randomUUID(), ...vite },
      );
      assert.equal(card.status, 201);
      assert.equal(card.json.item.occurrence.sentence, 'The harbor light was a thin line across the water.');

      const otherPort = await api(app.base, emptyJar(), 'GET', '/api/csrf', undefined, {
        origin: 'http://127.0.0.1:4173',
      });
      assert.equal(otherPort.status, 403);
      assert.equal(otherPort.json.error.code, 'ORIGIN_REJECTED');
      assert.equal(otherPort.setCookie.length, 0);
      const localhost = await api(app.base, emptyJar(), 'GET', '/api/csrf', undefined, {
        origin: 'http://localhost:5173',
      });
      assert.equal(localhost.status, 403);
      assert.equal(localhost.json.error.code, 'ORIGIN_REJECTED');
      const foreign = await api(app.base, emptyJar(), 'GET', '/api/csrf', undefined, {
        origin: 'http://evil.example',
      });
      assert.equal(foreign.status, 403);
      assert.equal(foreign.json.error.code, 'ORIGIN_REJECTED');

      const referer = await api(app.base, emptyJar(), 'GET', '/api/csrf', undefined, {
        origin: null,
        referer: `${viteOrigin}/`,
      });
      assert.equal(referer.status, 200);
      assert.match(referer.setCookie.join('\n'), /wl_setup_csrf=/);

      const logout = await api(app.base, jar, 'POST', '/api/auth/logout', undefined, { csrf: 'session', ...vite });
      assert.equal(logout.status, 200);
      const gone = await api(app.base, jar, 'GET', '/api/auth/me', undefined, vite);
      assert.equal(gone.status, 401);
      assert.equal(gone.json.error.code, 'UNAUTHENTICATED');
    } finally {
      await app.close();
    }

    const production = listenPolicyFromEnv({
      HOST: '127.0.0.1',
      PORT: '8787',
      NODE_ENV: 'production',
      WORDLOOM_SECURE_COOKIES: '1',
      WORDLOOM_ALLOWED_ORIGINS: 'https://words.example',
    });
    assert.equal(production.secureCookies, true);
    assert.equal(production.originPolicy.kind, 'list');
    const prodApp = await startApp({
      secureCookies: production.secureCookies,
      originPolicy: production.originPolicy,
    });
    try {
      const blocked = await api(prodApp.base, emptyJar(), 'GET', '/api/csrf', undefined, { origin: viteOrigin });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.json.error.code, 'ORIGIN_REJECTED');
      assert.equal(blocked.setCookie.length, 0);
      const blockedReferer = await api(prodApp.base, emptyJar(), 'GET', '/api/csrf', undefined, {
        origin: null,
        referer: `${viteOrigin}/`,
      });
      assert.equal(blockedReferer.status, 403);
      assert.equal(blockedReferer.json.error.code, 'ORIGIN_REJECTED');
      const allowed = await api(prodApp.base, emptyJar(), 'GET', '/api/csrf', undefined, {
        origin: 'https://words.example',
      });
      assert.equal(allowed.status, 200);
      assert.match(allowed.setCookie.join('\n'), /Secure/);
    } finally {
      await prodApp.close();
    }
  });
});

describe('owner header, due clock, and restore receipts', { concurrency: 1 }, () => {
  it('does not apply account A writes when the cookies belong to account B', async () => {
    const app = await startApp();
    try {
      const owner = await register(app.base, uniqueEmail('owner'), password);
      const other = await register(app.base, uniqueEmail('other'), password);
      const created = await api(app.base, owner.jar, 'POST', '/api/cards', sampleCard('keel', 'The keel held the line.'), {
        csrf: 'session',
        idempotencyKey: randomUUID(),
      });
      assert.equal(created.status, 201);
      const ownerBefore = await api(app.base, owner.jar, 'GET', '/api/cards');
      const otherBefore = await api(app.base, other.jar, 'GET', '/api/cards');
      const otherKeys = idempotencyCount(app.dbPath, other.body.user.id);
      const mismatched = await api(app.base, other.jar, 'POST', '/api/cards', sampleCard('wake', 'The wake belonged to the first account.'), {
        csrf: 'session',
        idempotencyKey: randomUUID(),
        ownerId: owner.body.user.id,
      });
      assert.equal(mismatched.status, 409);
      assert.equal(mismatched.json.error.code, 'OWNER_MISMATCH');
      const review = await api(
        app.base,
        other.jar,
        'POST',
        `/api/cards/${created.json.item.card.id}/reviews`,
        { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 },
        { csrf: 'session', idempotencyKey: randomUUID(), ownerId: owner.body.user.id },
      );
      assert.equal(review.status, 409);
      assert.equal(review.json.error.code, 'OWNER_MISMATCH');
      const missing = await api(app.base, other.jar, 'POST', '/api/cards', sampleCard('bilge', 'A missing owner header must not write.'), {
        csrf: 'session',
        idempotencyKey: randomUUID(),
        ownerId: null,
      });
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error.code, 'VALIDATION');
      const ownerAfter = await api(app.base, owner.jar, 'GET', '/api/cards');
      const otherAfter = await api(app.base, other.jar, 'GET', '/api/cards');
      assert.equal(ownerAfter.json.items.length, ownerBefore.json.items.length);
      assert.equal(otherAfter.json.items.length, otherBefore.json.items.length);
      assert.equal(idempotencyCount(app.dbPath, other.body.user.id), otherKeys);
      const events = await api(app.base, owner.jar, 'GET', `/api/cards/${created.json.item.card.id}/events`);
      assert.equal(events.json.events.length, 0);
    } finally {
      await app.close();
    }
  });

  it('rejects a revoked or expired session inside the write transaction', async () => {
    const now = new Date('2026-04-01T12:00:00.000Z');
    const app = await startApp({ now: () => now });
    try {
      const owner = await register(app.base, uniqueEmail('locked'), password);
      const db = new DatabaseSync(app.dbPath);
      try {
        const session = db.prepare('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL').get(owner.body.user.id) as {
          id: string;
        };
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now.toISOString(), session.id);
        assert.throws(
          () => transaction(db, () => lockedOwner(db, session.id, owner.body.user.id, now)),
          (error: unknown) => error instanceof HttpError && error.status === 401,
        );
        db.prepare('UPDATE sessions SET revoked_at = NULL, expires_at = ? WHERE id = ?').run('2026-04-01T11:00:00.000Z', session.id);
        assert.throws(
          () => transaction(db, () => lockedOwner(db, session.id, owner.body.user.id, now)),
          (error: unknown) => error instanceof HttpError && error.status === 401,
        );
      } finally {
        db.close();
      }
    } finally {
      await app.close();
    }
  });

  it('includes a card at its due instant and excludes it one millisecond earlier', async () => {
    let clock = Date.parse('2026-04-01T12:00:00.000Z');
    const app = await startApp({ now: () => new Date(clock) });
    try {
      const jar = (await register(app.base, uniqueEmail('due'), password)).jar;
      const created = await api(app.base, jar, 'POST', '/api/cards', sampleCard('harbor', 'The harbor light was a thin line.'), {
        csrf: 'session',
        idempotencyKey: randomUUID(),
      });
      assert.equal(created.status, 201);
      const cardId = created.json.item.card.id as string;
      const initial = await api(app.base, jar, 'GET', '/api/queue');
      assert.equal(
        initial.json.items.some((item: { card: { id: string } }) => item.card.id === cardId),
        true,
      );
      const reviewed = await api(
        app.base,
        jar,
        'POST',
        `/api/cards/${cardId}/reviews`,
        { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 },
        { csrf: 'session', idempotencyKey: randomUUID() },
      );
      assert.equal(reviewed.status, 201);
      const due = Date.parse(reviewed.json.schedule.due);
      assert.ok(due > clock);
      clock = due - 1;
      const before = await api(app.base, jar, 'GET', '/api/queue');
      assert.equal(
        before.json.items.some((item: { card: { id: string } }) => item.card.id === cardId),
        false,
      );
      clock = due;
      const atDue = await api(app.base, jar, 'GET', '/api/queue');
      assert.equal(
        atDue.json.items.some((item: { card: { id: string } }) => item.card.id === cardId),
        true,
      );
      const events = await api(app.base, jar, 'GET', `/api/cards/${cardId}/events`);
      assert.equal(events.json.events.length, 1);
    } finally {
      await app.close();
    }
  });

  it('advances replace revision and keeps receipts so a delayed retry does not apply twice', async () => {
    const app = await startApp();
    try {
      const owner = await register(app.base, uniqueEmail('receipt'), password);
      const other = await register(app.base, uniqueEmail('bystander'), password);
      await api(app.base, other.jar, 'POST', '/api/cards', sampleCard('lumen', 'A lumen marked the other account.'), {
        csrf: 'session',
        idempotencyKey: randomUUID(),
      });
      const otherBefore = await api(app.base, other.jar, 'GET', '/api/auth/me');
      const keel = await api(app.base, owner.jar, 'POST', '/api/cards', sampleCard('keel', 'The keel held the first snapshot.'), {
        csrf: 'session',
        idempotencyKey: randomUUID(),
      });
      assert.equal(keel.status, 201);
      const keelId = keel.json.item.card.id as string;
      const firstBackup = await api(app.base, owner.jar, 'GET', '/api/backup');
      const reviewKey = randomUUID();
      const reviewed = await api(
        app.base,
        owner.jar,
        'POST',
        `/api/cards/${keelId}/reviews`,
        { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 },
        { csrf: 'session', idempotencyKey: reviewKey },
      );
      assert.equal(reviewed.status, 201);
      const createKey = randomUUID();
      const wake = await api(app.base, owner.jar, 'POST', '/api/cards', sampleCard('wake', 'The wake arrived after the first snapshot.'), {
        csrf: 'session',
        idempotencyKey: createKey,
      });
      assert.equal(wake.status, 201);
      const secondBackup = await api(app.base, owner.jar, 'GET', '/api/backup');
      const live = await api(app.base, owner.jar, 'GET', '/api/auth/me');
      const restoreKey = randomUUID();
      const restored = await api(
        app.base,
        owner.jar,
        'POST',
        '/api/backup/restore',
        { mode: 'replace', confirm: 'replace', document: firstBackup.json },
        { csrf: 'session', idempotencyKey: restoreKey },
      );
      assert.equal(restored.status, 200);
      const liveRevision = live.json.user.progressRevision as number;
      const snapshotRevision = firstBackup.json.progressRevision as number;
      assert.equal(restored.json.progressRevision, Math.max(liveRevision, snapshotRevision) + 1);
      assert.ok(restored.json.progressRevision > liveRevision);
      assert.ok(restored.json.progressRevision > snapshotRevision);
      const otherAfter = await api(app.base, other.jar, 'GET', '/api/auth/me');
      assert.equal(otherAfter.json.user.progressRevision, otherBefore.json.user.progressRevision);

      const secondKey = randomUUID();
      const secondRestore = await api(
        app.base,
        owner.jar,
        'POST',
        '/api/backup/restore',
        { mode: 'replace', confirm: 'replace', document: secondBackup.json },
        { csrf: 'session', idempotencyKey: secondKey },
      );
      assert.equal(secondRestore.status, 200);
      const replayFirst = await api(
        app.base,
        owner.jar,
        'POST',
        '/api/backup/restore',
        { mode: 'replace', confirm: 'replace', document: firstBackup.json },
        { csrf: 'session', idempotencyKey: restoreKey },
      );
      assert.equal(replayFirst.status, 200);
      assert.equal(replayFirst.replayed, true);
      assert.deepEqual(replayFirst.json, restored.json);
      const afterReplay = await api(app.base, owner.jar, 'GET', '/api/cards');
      assert.equal(afterReplay.json.items.length, 2);
      const replayReview = await api(
        app.base,
        owner.jar,
        'POST',
        `/api/cards/${keelId}/reviews`,
        { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 },
        { csrf: 'session', idempotencyKey: reviewKey },
      );
      assert.equal(replayReview.status, 201);
      assert.equal(replayReview.replayed, true);
      const eventsAfterReplay = await api(app.base, owner.jar, 'GET', `/api/cards/${keelId}/events`);
      assert.equal(eventsAfterReplay.json.events.length, 1);

      const extraKey = randomUUID();
      const bilge = await api(app.base, owner.jar, 'POST', '/api/cards', sampleCard('bilge', 'The bilge was added after both snapshots.'), {
        csrf: 'session',
        idempotencyKey: extraKey,
      });
      assert.equal(bilge.status, 201);
      const wipe = await api(
        app.base,
        owner.jar,
        'POST',
        '/api/backup/restore',
        { mode: 'replace', confirm: 'replace', document: firstBackup.json },
        { csrf: 'session', idempotencyKey: randomUUID() },
      );
      assert.equal(wipe.status, 200);
      const replayCreate = await api(app.base, owner.jar, 'POST', '/api/cards', sampleCard('bilge', 'The bilge was added after both snapshots.'), {
        csrf: 'session',
        idempotencyKey: extraKey,
      });
      assert.equal(replayCreate.status, 201);
      assert.equal(replayCreate.replayed, true);
      const replayWake = await api(app.base, owner.jar, 'POST', '/api/cards', sampleCard('wake', 'The wake arrived after the first snapshot.'), {
        csrf: 'session',
        idempotencyKey: createKey,
      });
      assert.equal(replayWake.status, 201);
      assert.equal(replayWake.replayed, true);
      const replayReviewAgain = await api(
        app.base,
        owner.jar,
        'POST',
        `/api/cards/${keelId}/reviews`,
        { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 },
        { csrf: 'session', idempotencyKey: reviewKey },
      );
      assert.equal(replayReviewAgain.status, 201);
      assert.equal(replayReviewAgain.replayed, true);
      const finalCards = await api(app.base, owner.jar, 'GET', '/api/cards');
      assert.equal(finalCards.json.items.length, 1);
      assert.equal(finalCards.json.items[0].card.id, keelId);
      const finalEvents = await api(app.base, owner.jar, 'GET', `/api/cards/${keelId}/events`);
      assert.equal(finalEvents.json.events.length, 0);
      const otherStill = await api(app.base, other.jar, 'GET', '/api/auth/me');
      assert.equal(otherStill.json.user.progressRevision, otherBefore.json.user.progressRevision);
    } finally {
      await app.close();
    }
  });

  it('returns one owner-tagged library snapshot and rejects a different owner', async () => {
    const app = await startApp();
    try {
      const owner = await register(app.base, uniqueEmail('library'), password);
      const other = await register(app.base, uniqueEmail('library-other'), password);
      const created = await api(app.base, owner.jar, 'POST', '/api/cards', sampleCard('harbor', 'The harbor light was a thin line.'), {
        csrf: 'session',
        idempotencyKey: randomUUID(),
      });
      assert.equal(created.status, 201);
      await api(app.base, other.jar, 'POST', '/api/cards', sampleCard('lumen', 'A lumen marked the other account.'), {
        csrf: 'session',
        idempotencyKey: randomUUID(),
      });
      const snapshot = await api(app.base, owner.jar, 'GET', '/api/library');
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.json.user.id, owner.body.user.id);
      assert.equal(snapshot.json.items.length, 1);
      assert.equal(snapshot.json.items[0].sense.lemma, 'harbor');
      assert.equal(snapshot.json.queue.length, 1);
      assert.equal(snapshot.json.senses.length, 1);
      assert.deepEqual(snapshot.json.events, []);
      assert.equal(
        snapshot.json.items.some((item: { sense: { lemma: string } }) => item.sense.lemma === 'lumen'),
        false,
      );
      const mismatched = await api(app.base, other.jar, 'GET', '/api/library', undefined, { ownerId: owner.body.user.id });
      assert.equal(mismatched.status, 409);
      assert.equal(mismatched.json.error.code, 'OWNER_MISMATCH');
      assert.equal(mismatched.json.items, undefined);
      const missing = await api(app.base, owner.jar, 'GET', '/api/library', undefined, { ownerId: null });
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error.code, 'VALIDATION');
      const otherLibrary = await api(app.base, other.jar, 'GET', '/api/library');
      assert.equal(otherLibrary.json.items.length, 1);
      assert.equal(otherLibrary.json.items[0].sense.lemma, 'lumen');
    } finally {
      await app.close();
    }
  });

  it('rejects an uncommitted review after replace restores an earlier schedule revision', async () => {
    const app = await startApp();
    try {
      const jar = (await register(app.base, uniqueEmail('aba'), password)).jar;
      const created = await api(app.base, jar, 'POST', '/api/cards', sampleCard('keel', 'The keel held the first snapshot.'), {
        csrf: 'session',
        idempotencyKey: randomUUID(),
      });
      assert.equal(created.status, 201);
      const cardId = created.json.item.card.id as string;
      const backup = await api(app.base, jar, 'GET', '/api/backup');
      assert.equal(backup.json.schedules[0].revision, 1);
      const reviewed = await api(
        app.base,
        jar,
        'POST',
        `/api/cards/${cardId}/reviews`,
        { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 },
        { csrf: 'session', idempotencyKey: randomUUID() },
      );
      assert.equal(reviewed.status, 201);
      assert.equal(reviewed.json.schedule.revision, 2);
      const live = await api(app.base, jar, 'GET', '/api/cards');
      const liveRevision = live.json.items[0].schedule.revision as number;
      const restored = await api(
        app.base,
        jar,
        'POST',
        '/api/backup/restore',
        { mode: 'replace', confirm: 'replace', document: backup.json },
        { csrf: 'session', idempotencyKey: randomUUID() },
      );
      assert.equal(restored.status, 200);
      const after = await api(app.base, jar, 'GET', '/api/cards');
      const schedule = after.json.items[0].schedule;
      assert.equal(schedule.due, backup.json.schedules[0].due);
      assert.equal(schedule.stability, backup.json.schedules[0].stability);
      assert.equal(schedule.difficulty, backup.json.schedules[0].difficulty);
      assert.equal(schedule.state, backup.json.schedules[0].state);
      assert.equal(schedule.revision, Math.max(liveRevision, backup.json.schedules[0].revision) + 1);
      assert.ok(schedule.revision > 1);
      const staleKey = randomUUID();
      const stale = await api(
        app.base,
        jar,
        'POST',
        `/api/cards/${cardId}/reviews`,
        { grade: 'again', affectsSchedule: true, expectedScheduleRevision: 1 },
        { csrf: 'session', idempotencyKey: staleKey },
      );
      assert.equal(stale.status, 409);
      assert.equal(stale.json.error.code, 'REVISION_CONFLICT');
      assert.equal(stale.replayed, false);
      const events = await api(app.base, jar, 'GET', `/api/cards/${cardId}/events`);
      assert.equal(events.json.events.length, 0);
      const staleAgain = await api(
        app.base,
        jar,
        'POST',
        `/api/cards/${cardId}/reviews`,
        { grade: 'again', affectsSchedule: true, expectedScheduleRevision: 1 },
        { csrf: 'session', idempotencyKey: staleKey },
      );
      assert.equal(staleAgain.status, 409);
      assert.equal(staleAgain.replayed, false);
      const fresh = await api(
        app.base,
        jar,
        'POST',
        `/api/cards/${cardId}/reviews`,
        { grade: 'good', affectsSchedule: true, expectedScheduleRevision: schedule.revision },
        { csrf: 'session', idempotencyKey: randomUUID() },
      );
      assert.equal(fresh.status, 201);
      const afterFresh = await api(app.base, jar, 'GET', `/api/cards/${cardId}/events`);
      assert.equal(afterFresh.json.events.length, 1);
    } finally {
      await app.close();
    }
  });

  it('rejects a queued review after a deleted schedule is restored from an earlier snapshot', async () => {
    const app = await startApp();
    try {
      const jar = (await register(app.base, uniqueEmail('aba-delete'), password)).jar;
      const created = await api(app.base, jar, 'POST', '/api/cards', sampleCard('keel', 'The keel held the first snapshot.'), {
        csrf: 'session',
        idempotencyKey: randomUUID(),
      });
      assert.equal(created.status, 201);
      const cardId = created.json.item.card.id as string;
      const backup = await api(app.base, jar, 'GET', '/api/backup');
      assert.equal(backup.json.schedules[0].revision, 1);
      const reviewed = await api(
        app.base,
        jar,
        'POST',
        `/api/cards/${cardId}/reviews`,
        { grade: 'good', affectsSchedule: true, expectedScheduleRevision: 1 },
        { csrf: 'session', idempotencyKey: randomUUID() },
      );
      assert.equal(reviewed.status, 201);
      assert.equal(reviewed.json.schedule.revision, 2);
      const empty = {
        schemaVersion: backup.json.schemaVersion,
        exportedAt: backup.json.exportedAt,
        progressRevision: backup.json.progressRevision,
        senses: [],
        occurrences: [],
        cards: [],
        schedules: [],
        reviewEvents: [],
      };
      const wiped = await api(app.base, jar, 'POST', '/api/backup/restore', { mode: 'replace', confirm: 'replace', document: empty }, {
        csrf: 'session',
        idempotencyKey: randomUUID(),
      });
      assert.equal(wiped.status, 200);
      const gone = await api(app.base, jar, 'GET', '/api/cards');
      assert.equal(gone.json.items.length, 0);
      const restored = await api(
        app.base,
        jar,
        'POST',
        '/api/backup/restore',
        { mode: 'replace', confirm: 'replace', document: backup.json },
        { csrf: 'session', idempotencyKey: randomUUID() },
      );
      assert.equal(restored.status, 200);
      const after = await api(app.base, jar, 'GET', '/api/cards');
      assert.equal(after.json.items.length, 1);
      const schedule = after.json.items[0].schedule;
      assert.equal(schedule.due, backup.json.schedules[0].due);
      assert.equal(schedule.stability, backup.json.schedules[0].stability);
      assert.equal(schedule.difficulty, backup.json.schedules[0].difficulty);
      assert.equal(schedule.state, backup.json.schedules[0].state);
      assert.ok(schedule.revision > 2);
      const staleKey = randomUUID();
      const stale = await api(
        app.base,
        jar,
        'POST',
        `/api/cards/${cardId}/reviews`,
        { grade: 'again', affectsSchedule: true, expectedScheduleRevision: 2 },
        { csrf: 'session', idempotencyKey: staleKey },
      );
      assert.equal(stale.status, 409);
      assert.equal(stale.json.error.code, 'REVISION_CONFLICT');
      assert.equal(stale.replayed, false);
      const events = await api(app.base, jar, 'GET', `/api/cards/${cardId}/events`);
      assert.equal(events.json.events.length, 0);
      const staleAgain = await api(
        app.base,
        jar,
        'POST',
        `/api/cards/${cardId}/reviews`,
        { grade: 'again', affectsSchedule: true, expectedScheduleRevision: 2 },
        { csrf: 'session', idempotencyKey: staleKey },
      );
      assert.equal(staleAgain.status, 409);
      assert.equal(staleAgain.replayed, false);
    } finally {
      await app.close();
    }
  });
});

describe('schema migration', () => {
  it('upgrades a populated version 1 database without changing learning rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wordloom-migrate-'));
    const dbPath = join(dir, 'wordloom.sqlite');
    const before = seedVersion1(dbPath);
    const db = openDatabase(dbPath);
    try {
      assert.equal(schemaVersion(db), 2);
      assert.deepEqual(learningRows(db), before);
      assert.deepEqual(scheduleFloors(db), [
        { card_id: 'card-keel', high_water: 3 },
        { card_id: 'card-wake', high_water: 4 },
      ]);
    } finally {
      db.close();
    }
  });

  it('restarts a partial version 1 upgrade without lowering an existing floor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wordloom-migrate-partial-'));
    const dbPath = join(dir, 'wordloom.sqlite');
    const before = seedVersion1(dbPath, [
      { cardId: 'card-keel', highWater: 5 },
      { cardId: 'card-wake', highWater: 1 },
      { cardId: 'card-removed', highWater: 9 },
    ]);
    const db = openDatabase(dbPath);
    try {
      assert.equal(schemaVersion(db), 2);
      assert.deepEqual(learningRows(db), before);
      assert.deepEqual(scheduleFloors(db), [
        { card_id: 'card-keel', high_water: 5 },
        { card_id: 'card-removed', high_water: 9 },
        { card_id: 'card-wake', high_water: 4 },
      ]);
    } finally {
      db.close();
    }
    const again = openDatabase(dbPath);
    try {
      assert.equal(schemaVersion(again), 2);
      assert.deepEqual(learningRows(again), before);
      assert.deepEqual(scheduleFloors(again), [
        { card_id: 'card-keel', high_water: 5 },
        { card_id: 'card-removed', high_water: 9 },
        { card_id: 'card-wake', high_water: 4 },
      ]);
    } finally {
      again.close();
    }
  });
});

const VERSION_1_SCHEMA = `
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

function seedVersion1(path: string, floors?: Array<{ cardId: string; highWater: number }>): ReturnType<typeof learningRows> {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(VERSION_1_SCHEMA);
  db.exec('CREATE TABLE schema_migrations (version INTEGER NOT NULL)');
  db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
  const createdAt = '2026-04-01T00:00:00.000Z';
  db.prepare('INSERT INTO users (id, email, password_hash, progress_revision, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'user-1',
    'keel@example.com',
    'scrypt$placeholder',
    4,
    createdAt,
  );
  db.prepare('INSERT INTO word_senses (id, user_id, lemma, part_of_speech, meaning, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'sense-1',
    'user-1',
    'keel',
    'noun',
    'a synthetic sense for keel',
    createdAt,
  );
  db.prepare(
    'INSERT INTO source_occurrences (id, user_id, sense_id, sentence, sentence_translation, eqbank_item_id, eqbank_source, eqbank_locator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('occurrence-1', 'user-1', 'sense-1', 'The keel held.', null, null, null, null, createdAt);
  db.prepare('INSERT INTO learner_cards (id, user_id, sense_id, occurrence_id, created_at, revision) VALUES (?, ?, ?, ?, ?, ?)').run(
    'card-keel',
    'user-1',
    'sense-1',
    'occurrence-1',
    createdAt,
    1,
  );
  db.prepare('INSERT INTO learner_cards (id, user_id, sense_id, occurrence_id, created_at, revision) VALUES (?, ?, ?, ?, ?, ?)').run(
    'card-wake',
    'user-1',
    'sense-1',
    'occurrence-1',
    createdAt,
    1,
  );
  insertScheduleRow(db, 'card-keel', 3);
  insertScheduleRow(db, 'card-wake', 4);
  db.prepare(
    `INSERT INTO review_events (
      id, user_id, card_id, grade, affects_schedule, reviewed_at, client_request_id,
      due_before, due_after, state_before, state_after, schedule_revision_before, schedule_revision_after,
      stability_before, stability_after, difficulty_before, difficulty_after,
      scheduled_days_before, scheduled_days_after, reps_after, lapses_after, elapsed_days_after, learning_steps_after,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'event-1',
    'user-1',
    'card-keel',
    'good',
    1,
    createdAt,
    'request-1',
    createdAt,
    createdAt,
    'new',
    'review',
    1,
    2,
    1,
    2,
    5,
    5,
    0,
    1,
    1,
    0,
    0,
    0,
    createdAt,
  );
  db.prepare('INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'user-1',
    'key-1',
    'hash-1',
    201,
    '{}',
    createdAt,
  );
  if (floors) {
    db.exec(`CREATE TABLE schedule_generation (
      user_id TEXT NOT NULL REFERENCES users(id),
      card_id TEXT NOT NULL,
      high_water INTEGER NOT NULL CHECK (high_water >= 1),
      PRIMARY KEY (user_id, card_id)
    )`);
    const insertFloor = db.prepare('INSERT INTO schedule_generation (user_id, card_id, high_water) VALUES (?, ?, ?)');
    for (const floor of floors) {
      insertFloor.run('user-1', floor.cardId, floor.highWater);
    }
  }
  const rows = learningRows(db);
  db.close();
  return rows;
}

function insertScheduleRow(db: DatabaseSync, cardId: string, revision: number): void {
  db.prepare(
    `INSERT INTO schedules (
      card_id, user_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps,
      reps, lapses, state, last_review, revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(cardId, 'user-1', '2026-04-02T00:00:00.000Z', 1.5, 5, 0, 1, 0, 1, 0, 1, '2026-04-01T00:00:00.000Z', revision, '2026-04-01T00:00:00.000Z');
}

function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT version FROM schema_migrations').get() as { version: number | bigint };
  return Number(row.version);
}

function scheduleFloors(db: DatabaseSync): Array<{ card_id: string; high_water: number }> {
  const rows = db.prepare('SELECT card_id, high_water FROM schedule_generation ORDER BY card_id').all() as Array<{
    card_id: string;
    high_water: number | bigint;
  }>;
  return rows.map((row) => ({ card_id: row.card_id, high_water: Number(row.high_water) }));
}

function learningRows(db: DatabaseSync): unknown {
  const read = (sql: string) => db.prepare(sql).all();
  return normalizeSql([
    read('SELECT id, email, progress_revision FROM users ORDER BY id'),
    read('SELECT id, lemma, meaning FROM word_senses ORDER BY id'),
    read('SELECT id, sentence FROM source_occurrences ORDER BY id'),
    read('SELECT id, revision FROM learner_cards ORDER BY id'),
    read('SELECT card_id, revision, due, stability, state FROM schedules ORDER BY card_id'),
    read('SELECT id, grade, client_request_id FROM review_events ORDER BY id'),
    read('SELECT key, status_code FROM idempotency_keys ORDER BY key'),
  ]);
}

function normalizeSql(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? Number(item) : item)));
}

function sampleCard(lemma: string, sentence: string): Record<string, string> {
  return {
    lemma,
    partOfSpeech: 'noun',
    meaning: `a synthetic sense for ${lemma}`,
    sentence,
  };
}

function idempotencyCount(dbPath: string, userId: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE user_id = ?').get(userId) as { n: number | bigint };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function envFromCommand(command: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const part of command.split(' ')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      break;
    }
    env[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return env;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

async function rawRegisterCookies(base: string, takenEmail: string): Promise<string[]> {
  const jar = { cookies: new Map<string, string>(), setup: '', csrf: '' };
  await api(base, jar, 'GET', '/api/csrf');
  const response = await api(
    base,
    jar,
    'POST',
    '/api/auth/register',
    { email: takenEmail, password },
    { csrf: 'setup' },
  );
  assert.equal(response.status, 409);
  return response.setCookie;
}
