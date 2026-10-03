import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { lockedOwner } from './auth.js';
import { isDue } from './clientSync.js';
import { canonicalJson } from './crypto.js';
import { changesOf, transaction } from './db.js';
import { HttpError } from './errors.js';
import { emptySchedule, scheduleAfterGrade, stateName, stateValue, toScheduleJson, type StoredSchedule } from './scheduler.js';
import type {
  ApiResult,
  EqbankMeta,
  GradeName,
  ItemJson,
  OccurrenceJson,
  ReviewEventJson,
  ScheduleJson,
  SenseJson,
  StateName,
} from './types.js';
import { parseManualAdd, parseReview } from './validate.js';

type IdempotencyRow = { request_hash: string; status_code: number; response_json: string };

type ScheduleRow = {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
  revision: number;
  updated_at: string;
};

type EventRow = {
  id: string;
  card_id: string;
  grade: GradeName;
  affects_schedule: number;
  reviewed_at: string;
  client_request_id: string;
  due_before: string;
  due_after: string;
  state_before: StateName;
  state_after: StateName;
  schedule_revision_before: number;
  schedule_revision_after: number;
  stability_before: number;
  stability_after: number;
  difficulty_before: number;
  difficulty_after: number;
  scheduled_days_before: number;
  scheduled_days_after: number;
  reps_after: number;
  lapses_after: number;
  elapsed_days_after: number;
  learning_steps_after: number;
  created_at: string;
};

const ITEM_SQL = `
SELECT
  c.id AS card_id,
  c.sense_id AS sense_id,
  c.occurrence_id AS occurrence_id,
  c.created_at AS card_created_at,
  c.revision AS card_revision,
  s.lemma AS lemma,
  s.part_of_speech AS part_of_speech,
  s.meaning AS meaning,
  s.created_at AS sense_created_at,
  o.sentence AS sentence,
  o.sentence_translation AS sentence_translation,
  o.eqbank_item_id AS eqbank_item_id,
  o.eqbank_source AS eqbank_source,
  o.eqbank_locator AS eqbank_locator,
  o.created_at AS occurrence_created_at,
  sch.due AS due,
  sch.stability AS stability,
  sch.difficulty AS difficulty,
  sch.elapsed_days AS elapsed_days,
  sch.scheduled_days AS scheduled_days,
  sch.learning_steps AS learning_steps,
  sch.reps AS reps,
  sch.lapses AS lapses,
  sch.state AS state,
  sch.last_review AS last_review,
  sch.revision AS schedule_revision,
  sch.updated_at AS schedule_updated_at
FROM learner_cards c
JOIN word_senses s ON s.id = c.sense_id AND s.user_id = c.user_id
JOIN source_occurrences o ON o.id = c.occurrence_id AND o.user_id = c.user_id AND o.sense_id = c.sense_id
JOIN schedules sch ON sch.card_id = c.id AND sch.user_id = c.user_id
`;

export function createCard(
  db: DatabaseSync,
  now: () => Date,
  sessionId: string,
  expectedOwner: string | undefined,
  body: Record<string, unknown>,
  key: string,
  requestHash: string,
): ApiResult {
  return runOwnedMutation(db, now, sessionId, expectedOwner, key, requestHash, (userId) => {
    const input = parseManualAdd(body);
    const instantDate = now();
    const instant = instantDate.toISOString();
    const senseId = input.kind === 'new-sense' ? randomUUID() : input.senseId;
    if (input.kind === 'new-sense') {
      db.prepare(
        'INSERT INTO word_senses (id, user_id, lemma, part_of_speech, meaning, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(senseId, userId, input.lemma, input.partOfSpeech, input.meaning, instant);
    } else if (!db.prepare('SELECT id FROM word_senses WHERE id = ? AND user_id = ?').get(senseId, userId)) {
      throw new HttpError(404, 'NOT_FOUND', 'Sense not found.');
    }
    const occurrenceId = randomUUID();
    const cardId = randomUUID();
    const schedule = emptySchedule(instantDate);
    db.prepare(
      `INSERT INTO source_occurrences (
        id, user_id, sense_id, sentence, sentence_translation, eqbank_item_id, eqbank_source, eqbank_locator, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      occurrenceId,
      userId,
      senseId,
      input.sentence,
      input.sentenceTranslation,
      input.eqbank?.itemId ?? null,
      input.eqbank?.source ?? null,
      input.eqbank?.locator ?? null,
      instant,
    );
    db.prepare(
      'INSERT INTO learner_cards (id, user_id, sense_id, occurrence_id, created_at, revision) VALUES (?, ?, ?, ?, ?, 1)',
    ).run(cardId, userId, senseId, occurrenceId, instant);
    insertSchedule(db, userId, cardId, schedule, 1, instant);
    raiseScheduleFloor(db, userId, cardId, 1);
    const progressRevision = bumpProgress(db, userId);
    const response = { item: requireItem(db, userId, cardId), progressRevision };
    saveIdempotent(db, userId, key, requestHash, 201, response, instant);
    return { status: 201, body: response, replayed: false };
  });
}

export function listItems(db: DatabaseSync, userId: string): ItemJson[] {
  const rows = db.prepare(`${ITEM_SQL} WHERE c.user_id = ? ORDER BY c.created_at ASC, c.id ASC`).all(userId);
  return rows.map((row) => toItem(row as Record<string, unknown>));
}

export function getItem(db: DatabaseSync, userId: string, cardId: string): ItemJson {
  return requireItem(db, userId, cardId);
}

export function listQueue(db: DatabaseSync, userId: string, now: Date): ItemJson[] {
  const nowMs = now.getTime();
  return listItems(db, userId)
    .filter((item) => isDue(item.schedule.due, nowMs))
    .sort((left, right) => left.schedule.due.localeCompare(right.schedule.due) || left.card.id.localeCompare(right.card.id));
}

export function listAccountEvents(db: DatabaseSync, userId: string): ReviewEventJson[] {
  const rows = db
    .prepare('SELECT * FROM review_events WHERE user_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(userId) as EventRow[];
  return rows.map(toEvent);
}

export function listEvents(db: DatabaseSync, userId: string, cardId: string): ReviewEventJson[] {
  if (!db.prepare('SELECT id FROM learner_cards WHERE id = ? AND user_id = ?').get(cardId, userId)) {
    throw new HttpError(404, 'NOT_FOUND', 'Card not found.');
  }
  const rows = db
    .prepare(
      'SELECT * FROM review_events WHERE user_id = ? AND card_id = ? ORDER BY created_at ASC, rowid ASC',
    )
    .all(userId, cardId) as EventRow[];
  return rows.map(toEvent);
}

export function listSenses(db: DatabaseSync, userId: string): Array<SenseJson & { occurrences: OccurrenceJson[] }> {
  const senses = db
    .prepare(
      'SELECT id, lemma, part_of_speech, meaning, created_at FROM word_senses WHERE user_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(userId) as Array<{ id: string; lemma: string; part_of_speech: string; meaning: string; created_at: string }>;
  return senses.map((sense) => ({
    ...toSense(sense),
    occurrences: listOccurrences(db, userId, sense.id),
  }));
}

export function reviewCard(
  db: DatabaseSync,
  now: () => Date,
  sessionId: string,
  expectedOwner: string | undefined,
  cardId: string,
  body: Record<string, unknown>,
  key: string,
  requestHash: string,
): ApiResult {
  return runOwnedMutation(db, now, sessionId, expectedOwner, key, requestHash, (userId) => {
    const review = parseReview(body);
    const row = db.prepare('SELECT * FROM schedules WHERE card_id = ? AND user_id = ?').get(cardId, userId) as ScheduleRow | undefined;
    if (!row || !db.prepare('SELECT id FROM learner_cards WHERE id = ? AND user_id = ?').get(cardId, userId)) {
      throw new HttpError(404, 'NOT_FOUND', 'Card not found.');
    }
    const revision = asNumber(row.revision);
    if (revision !== review.expectedScheduleRevision) {
      throw new HttpError(409, 'REVISION_CONFLICT', 'Schedule was updated by another session.', {
        scheduleRevision: revision,
      });
    }
    const instant = now();
    const reviewedAt = instant.toISOString();
    const before = storedFromRow(row);
    const after = review.affectsSchedule ? scheduleAfterGrade(before, review.grade, instant) : before;
    let revisionAfter = revision;
    let updatedAt = row.updated_at;
    if (review.affectsSchedule) {
      const result = db
        .prepare(
          `UPDATE schedules SET
            due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, learning_steps = ?,
            reps = ?, lapses = ?, state = ?, last_review = ?, revision = revision + 1, updated_at = ?
          WHERE card_id = ? AND user_id = ? AND revision = ?`,
        )
        .run(
          after.due,
          after.stability,
          after.difficulty,
          after.elapsedDays,
          after.scheduledDays,
          after.learningSteps,
          after.reps,
          after.lapses,
          stateValue(after.state),
          after.lastReview,
          reviewedAt,
          cardId,
          userId,
          revision,
        );
      if (changesOf(result) !== 1) {
        throw new HttpError(409, 'REVISION_CONFLICT', 'Schedule was updated by another session.', {
          scheduleRevision: revision,
        });
      }
      revisionAfter = revision + 1;
      updatedAt = reviewedAt;
      raiseScheduleFloor(db, userId, cardId, revisionAfter);
    }
    const eventId = randomUUID();
    db.prepare(
      `INSERT INTO review_events (
        id, user_id, card_id, grade, affects_schedule, reviewed_at, client_request_id,
        due_before, due_after, state_before, state_after, schedule_revision_before, schedule_revision_after,
        stability_before, stability_after, difficulty_before, difficulty_after,
        scheduled_days_before, scheduled_days_after, reps_after, lapses_after, elapsed_days_after, learning_steps_after,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      userId,
      cardId,
      review.grade,
      review.affectsSchedule ? 1 : 0,
      reviewedAt,
      key,
      before.due,
      after.due,
      before.state,
      after.state,
      revision,
      revisionAfter,
      before.stability,
      after.stability,
      before.difficulty,
      after.difficulty,
      before.scheduledDays,
      after.scheduledDays,
      after.reps,
      after.lapses,
      after.elapsedDays,
      after.learningSteps,
      reviewedAt,
    );
    const progressRevision = bumpProgress(db, userId);
    const response = {
      event: requireEvent(db, userId, eventId),
      schedule: toScheduleJson(cardId, after, revisionAfter, updatedAt),
      progressRevision,
    };
    saveIdempotent(db, userId, key, requestHash, 201, response, reviewedAt);
    return { status: 201, body: response, replayed: false };
  });
}

export function runOwnedMutation(
  db: DatabaseSync,
  now: () => Date,
  sessionId: string,
  expectedOwner: string | undefined,
  key: string,
  requestHash: string,
  mutate: (userId: string) => ApiResult,
): ApiResult {
  let ownerId = '';
  try {
    return transaction(db, () => {
      const userId = lockedOwner(db, sessionId, expectedOwner, now());
      ownerId = userId;
      const replay = takeIdempotent(db, userId, key, requestHash);
      if (replay) {
        return replay;
      }
      return mutate(userId);
    });
  } catch (error) {
    if (!ownerId || !isIdempotencyRace(error)) {
      throw error;
    }
    const replay = takeIdempotent(db, ownerId, key, requestHash);
    if (replay) {
      return replay;
    }
    throw error;
  }
}

function isIdempotencyRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('idempotency_keys') || error.message.includes('client_request_id'))
  );
}

export function takeIdempotent(db: DatabaseSync, userId: string, key: string, requestHash: string): ApiResult | undefined {
  const row = db
    .prepare('SELECT request_hash, status_code, response_json FROM idempotency_keys WHERE user_id = ? AND key = ?')
    .get(userId, key) as IdempotencyRow | undefined;
  if (!row) {
    return undefined;
  }
  if (row.request_hash !== requestHash) {
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different request.');
  }
  return { status: Number(row.status_code), body: JSON.parse(row.response_json) as unknown, replayed: true };
}

export function saveIdempotent(
  db: DatabaseSync,
  userId: string,
  key: string,
  requestHash: string,
  status: number,
  body: unknown,
  createdAt: string,
): void {
  db.prepare(
    'INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(userId, key, requestHash, status, JSON.stringify(body), createdAt);
}

export function bumpProgress(db: DatabaseSync, userId: string): number {
  db.prepare('UPDATE users SET progress_revision = progress_revision + 1 WHERE id = ?').run(userId);
  const row = db.prepare('SELECT progress_revision FROM users WHERE id = ?').get(userId) as { progress_revision: number | bigint };
  return asNumber(row.progress_revision);
}

export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function requireItem(db: DatabaseSync, userId: string, cardId: string): ItemJson {
  const row = db.prepare(`${ITEM_SQL} WHERE c.user_id = ? AND c.id = ?`).get(userId, cardId);
  if (!row) {
    throw new HttpError(404, 'NOT_FOUND', 'Card not found.');
  }
  return toItem(row as Record<string, unknown>);
}

function requireEvent(db: DatabaseSync, userId: string, eventId: string): ReviewEventJson {
  const row = db.prepare('SELECT * FROM review_events WHERE user_id = ? AND id = ?').get(userId, eventId) as EventRow | undefined;
  if (!row) {
    throw new HttpError(500, 'INTERNAL', 'Review event was not stored.');
  }
  return toEvent(row);
}

export function raiseScheduleFloor(db: DatabaseSync, userId: string, cardId: string, revision: number): void {
  db.prepare(
    `INSERT INTO schedule_generation (user_id, card_id, high_water) VALUES (?, ?, ?)
     ON CONFLICT(user_id, card_id) DO UPDATE SET high_water = max(high_water, excluded.high_water)`,
  ).run(userId, cardId, revision);
}

export function scheduleFloor(db: DatabaseSync, userId: string, cardId: string): number {
  const row = db.prepare('SELECT high_water FROM schedule_generation WHERE user_id = ? AND card_id = ?').get(userId, cardId) as
    | { high_water: number | bigint }
    | undefined;
  return row ? asNumber(row.high_water) : 0;
}

function insertSchedule(db: DatabaseSync, userId: string, cardId: string, schedule: StoredSchedule, revision: number, updatedAt: string): void {
  db.prepare(
    `INSERT INTO schedules (
      card_id, user_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps,
      reps, lapses, state, last_review, revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cardId,
    userId,
    schedule.due,
    schedule.stability,
    schedule.difficulty,
    schedule.elapsedDays,
    schedule.scheduledDays,
    schedule.learningSteps,
    schedule.reps,
    schedule.lapses,
    stateValue(schedule.state),
    schedule.lastReview,
    revision,
    updatedAt,
  );
}

function storedFromRow(row: ScheduleRow): StoredSchedule {
  return {
    due: row.due,
    stability: asNumber(row.stability),
    difficulty: asNumber(row.difficulty),
    elapsedDays: asNumber(row.elapsed_days),
    scheduledDays: asNumber(row.scheduled_days),
    learningSteps: asNumber(row.learning_steps),
    reps: asNumber(row.reps),
    lapses: asNumber(row.lapses),
    state: stateName(asNumber(row.state)),
    lastReview: row.last_review,
  };
}

function listOccurrences(db: DatabaseSync, userId: string, senseId: string): OccurrenceJson[] {
  const rows = db
    .prepare(
      `SELECT id, sense_id, sentence, sentence_translation, eqbank_item_id, eqbank_source, eqbank_locator, created_at
       FROM source_occurrences WHERE user_id = ? AND sense_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(userId, senseId) as Array<Record<string, string | null>>;
  return rows.map((row) => ({
    id: String(row.id),
    senseId: String(row.sense_id),
    sentence: String(row.sentence),
    sentenceTranslation: (row.sentence_translation as string | null) ?? null,
    eqbank: eqbankFrom(row.eqbank_item_id, row.eqbank_source, row.eqbank_locator),
    createdAt: String(row.created_at),
  }));
}

function toSense(row: { id: string; lemma: string; part_of_speech: string; meaning: string; created_at: string }): SenseJson {
  return {
    id: row.id,
    lemma: row.lemma,
    partOfSpeech: row.part_of_speech,
    meaning: row.meaning,
    createdAt: row.created_at,
  };
}

function toItem(row: Record<string, unknown>): ItemJson {
  const schedule: ScheduleJson = {
    cardId: stringField(row, 'card_id'),
    due: stringField(row, 'due'),
    stability: numberField(row, 'stability'),
    difficulty: numberField(row, 'difficulty'),
    elapsedDays: numberField(row, 'elapsed_days'),
    scheduledDays: numberField(row, 'scheduled_days'),
    learningSteps: numberField(row, 'learning_steps'),
    reps: numberField(row, 'reps'),
    lapses: numberField(row, 'lapses'),
    state: stateName(numberField(row, 'state')),
    lastReview: nullableString(row, 'last_review'),
    revision: numberField(row, 'schedule_revision'),
    updatedAt: stringField(row, 'schedule_updated_at'),
  };
  return {
    card: {
      id: stringField(row, 'card_id'),
      senseId: stringField(row, 'sense_id'),
      occurrenceId: stringField(row, 'occurrence_id'),
      createdAt: stringField(row, 'card_created_at'),
      revision: numberField(row, 'card_revision'),
    },
    sense: {
      id: stringField(row, 'sense_id'),
      lemma: stringField(row, 'lemma'),
      partOfSpeech: stringField(row, 'part_of_speech'),
      meaning: stringField(row, 'meaning'),
      createdAt: stringField(row, 'sense_created_at'),
    },
    occurrence: {
      id: stringField(row, 'occurrence_id'),
      senseId: stringField(row, 'sense_id'),
      sentence: stringField(row, 'sentence'),
      sentenceTranslation: nullableString(row, 'sentence_translation'),
      eqbank: eqbankFrom(row.eqbank_item_id, row.eqbank_source, row.eqbank_locator),
      createdAt: stringField(row, 'occurrence_created_at'),
    },
    schedule,
  };
}

function toEvent(row: EventRow): ReviewEventJson {
  return {
    id: row.id,
    cardId: row.card_id,
    grade: row.grade,
    affectsSchedule: asNumber(row.affects_schedule) === 1,
    reviewedAt: row.reviewed_at,
    clientRequestId: row.client_request_id,
    dueBefore: row.due_before,
    dueAfter: row.due_after,
    stateBefore: row.state_before,
    stateAfter: row.state_after,
    scheduleRevisionBefore: asNumber(row.schedule_revision_before),
    scheduleRevisionAfter: asNumber(row.schedule_revision_after),
    stabilityBefore: asNumber(row.stability_before),
    stabilityAfter: asNumber(row.stability_after),
    difficultyBefore: asNumber(row.difficulty_before),
    difficultyAfter: asNumber(row.difficulty_after),
    scheduledDaysBefore: asNumber(row.scheduled_days_before),
    scheduledDaysAfter: asNumber(row.scheduled_days_after),
    repsAfter: asNumber(row.reps_after),
    lapsesAfter: asNumber(row.lapses_after),
    elapsedDaysAfter: asNumber(row.elapsed_days_after),
    learningStepsAfter: asNumber(row.learning_steps_after),
    createdAt: row.created_at,
  };
}

function eqbankFrom(itemId: unknown, source: unknown, locator: unknown): EqbankMeta | null {
  const meta = {
    itemId: itemId === null || itemId === undefined ? null : String(itemId),
    source: source === null || source === undefined ? null : String(source),
    locator: locator === null || locator === undefined ? null : String(locator),
  };
  if (meta.itemId === null && meta.source === null && meta.locator === null) {
    return null;
  }
  return meta;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new HttpError(500, 'BAD_ROW', `Expected text in ${key}.`);
  }
  return value;
}

function numberField(row: Record<string, unknown>, key: string): number {
  return asNumber(row[key]);
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  throw new HttpError(500, 'BAD_ROW', 'Expected a number.');
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new HttpError(500, 'BAD_ROW', `Expected text in ${key}.`);
  }
  return value;
}
