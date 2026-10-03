import type { DatabaseSync } from 'node:sqlite';
import { readUser } from './auth.js';
import { transaction } from './db.js';
import { HttpError } from './errors.js';
import {
  bumpProgress,
  listItems,
  listSenses,
  sameJson,
  saveIdempotent,
  takeIdempotent,
  finishIdempotent,
} from './learning.js';
import { stateValue } from './scheduler.js';
import type { ApiResult, BackupDocument, CardJson, OccurrenceJson, ReviewEventJson, ScheduleJson, SenseJson } from './types.js';
import { isRecord, parseBackupDocument, rejectUnknown } from './validate.js';

type OwnerSql = { sql: string; label: string };

const OWNERS: Record<'sense' | 'occurrence' | 'card' | 'event' | 'schedule', OwnerSql> = {
  sense: { sql: 'SELECT user_id FROM word_senses WHERE id = ?', label: 'Sense' },
  occurrence: { sql: 'SELECT user_id FROM source_occurrences WHERE id = ?', label: 'Sentence' },
  card: { sql: 'SELECT user_id FROM learner_cards WHERE id = ?', label: 'Card' },
  event: { sql: 'SELECT user_id FROM review_events WHERE id = ?', label: 'Review event' },
  schedule: { sql: 'SELECT user_id FROM schedules WHERE card_id = ?', label: 'Schedule' },
};

export function exportBackup(db: DatabaseSync, userId: string, now: Date): BackupDocument {
  const user = readUser(db, userId);
  const senses = listSenses(db, userId);
  const items = listItems(db, userId);
  const events = db
    .prepare('SELECT * FROM review_events WHERE user_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(userId) as Array<Record<string, unknown>>;
  return {
    schemaVersion: 1,
    exportedAt: now.toISOString(),
    progressRevision: user.progressRevision,
    senses: senses.map(({ occurrences: _occurrences, ...sense }) => sense),
    occurrences: senses.flatMap((sense) => sense.occurrences),
    cards: items.map((item) => item.card),
    schedules: items.map((item) => item.schedule),
    reviewEvents: events.map(eventFromRow),
  };
}

export function restoreBackup(
  db: DatabaseSync,
  now: () => Date,
  userId: string,
  body: Record<string, unknown>,
  key: string,
  requestHash: string,
): ApiResult {
  return finishIdempotent(db, userId, key, requestHash, () => transaction(db, () => {
    const replay = takeIdempotent(db, userId, key, requestHash);
    if (replay) {
      return replay;
    }
    rejectUnknown(body, ['mode', 'confirm', 'document'], 'restore');
    if (body.mode !== 'replace' && body.mode !== 'merge') {
      throw new HttpError(400, 'VALIDATION', 'mode must be replace or merge.');
    }
    if (!isRecord(body.document)) {
      throw new HttpError(400, 'VALIDATION', 'document must be an object.');
    }
    const document = parseBackupDocument(body.document);
    let progressRevision: number;
    if (body.mode === 'replace') {
      if (body.confirm !== 'replace') {
        throw new HttpError(400, 'VALIDATION', 'Replace restore requires confirm set to replace.');
      }
      assertSnapshotAssignable(db, userId, document);
      deleteLearning(db, userId);
      insertSnapshot(db, userId, document);
      db.prepare('UPDATE users SET progress_revision = ? WHERE id = ?').run(document.progressRevision, userId);
      progressRevision = document.progressRevision;
    } else {
      const inserted = mergeSnapshot(db, userId, document);
      progressRevision = inserted ? bumpProgress(db, userId) : readUser(db, userId).progressRevision;
    }
    const response = {
      mode: body.mode,
      progressRevision,
      counts: {
        senses: document.senses.length,
        occurrences: document.occurrences.length,
        cards: document.cards.length,
        schedules: document.schedules.length,
        reviewEvents: document.reviewEvents.length,
      },
    };
    saveIdempotent(db, userId, key, requestHash, 200, response, now().toISOString());
    return { status: 200, body: response, replayed: false };
  }));
}

function assertSnapshotAssignable(db: DatabaseSync, userId: string, document: BackupDocument): void {
  for (const sense of document.senses) {
    claim(db, 'sense', sense.id, userId);
  }
  for (const occurrence of document.occurrences) {
    claim(db, 'occurrence', occurrence.id, userId);
  }
  for (const card of document.cards) {
    claim(db, 'card', card.id, userId);
  }
  for (const schedule of document.schedules) {
    claim(db, 'schedule', schedule.cardId, userId);
  }
  for (const event of document.reviewEvents) {
    claim(db, 'event', event.id, userId);
  }
}

function claim(db: DatabaseSync, kind: keyof typeof OWNERS, id: string, userId: string): void {
  const owner = OWNERS[kind];
  const row = db.prepare(owner.sql).get(id) as { user_id: string } | undefined;
  if (row && row.user_id !== userId) {
    throw new HttpError(409, 'CONFLICT', `${owner.label} belongs to another account.`);
  }
}

function deleteLearning(db: DatabaseSync, userId: string): void {
  db.prepare('DELETE FROM review_events WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM schedules WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM learner_cards WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM source_occurrences WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM word_senses WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM idempotency_keys WHERE user_id = ?').run(userId);
}

function insertSnapshot(db: DatabaseSync, userId: string, document: BackupDocument): void {
  for (const sense of document.senses) {
    insertSense(db, userId, sense);
  }
  for (const occurrence of document.occurrences) {
    insertOccurrence(db, userId, occurrence);
  }
  for (const card of document.cards) {
    insertCard(db, userId, card);
  }
  for (const schedule of document.schedules) {
    insertSchedule(db, userId, schedule);
  }
  for (const event of document.reviewEvents) {
    insertEvent(db, userId, event);
  }
}

function mergeSnapshot(db: DatabaseSync, userId: string, document: BackupDocument): boolean {
  let inserted = false;
  for (const sense of document.senses) {
    inserted = mergeRow(db, userId, 'sense', sense.id, sense, () => insertSense(db, userId, sense), () => storedSense(db, userId, sense.id)) || inserted;
  }
  for (const occurrence of document.occurrences) {
    inserted =
      mergeRow(
        db,
        userId,
        'occurrence',
        occurrence.id,
        occurrence,
        () => insertOccurrence(db, userId, occurrence),
        () => storedOccurrence(db, userId, occurrence.id),
      ) || inserted;
  }
  for (const card of document.cards) {
    inserted = mergeRow(db, userId, 'card', card.id, card, () => insertCard(db, userId, card), () => storedCard(db, userId, card.id)) || inserted;
  }
  for (const schedule of document.schedules) {
    inserted =
      mergeRow(
        db,
        userId,
        'schedule',
        schedule.cardId,
        schedule,
        () => insertSchedule(db, userId, schedule),
        () => storedSchedule(db, userId, schedule.cardId),
      ) || inserted;
  }
  for (const event of document.reviewEvents) {
    inserted = mergeRow(db, userId, 'event', event.id, event, () => insertEvent(db, userId, event), () => storedEvent(db, userId, event.id)) || inserted;
  }
  return inserted;
}

function mergeRow(
  db: DatabaseSync,
  userId: string,
  kind: keyof typeof OWNERS,
  id: string,
  incoming: unknown,
  insert: () => void,
  load: () => unknown,
): boolean {
  const owner = OWNERS[kind];
  const row = db.prepare(owner.sql).get(id) as { user_id: string } | undefined;
  if (!row) {
    insert();
    return true;
  }
  if (row.user_id !== userId) {
    throw new HttpError(409, 'CONFLICT', `${owner.label} belongs to another account.`);
  }
  if (!sameJson(load(), incoming)) {
    throw new HttpError(409, 'SNAPSHOT_CONFLICT', `${owner.label} does not match the stored record.`);
  }
  return false;
}

function insertSense(db: DatabaseSync, userId: string, sense: SenseJson): void {
  db.prepare('INSERT INTO word_senses (id, user_id, lemma, part_of_speech, meaning, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    sense.id,
    userId,
    sense.lemma,
    sense.partOfSpeech,
    sense.meaning,
    sense.createdAt,
  );
}

function insertOccurrence(db: DatabaseSync, userId: string, occurrence: OccurrenceJson): void {
  db.prepare(
    `INSERT INTO source_occurrences (
      id, user_id, sense_id, sentence, sentence_translation, eqbank_item_id, eqbank_source, eqbank_locator, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    occurrence.id,
    userId,
    occurrence.senseId,
    occurrence.sentence,
    occurrence.sentenceTranslation,
    occurrence.eqbank?.itemId ?? null,
    occurrence.eqbank?.source ?? null,
    occurrence.eqbank?.locator ?? null,
    occurrence.createdAt,
  );
}

function insertCard(db: DatabaseSync, userId: string, card: CardJson): void {
  db.prepare('INSERT INTO learner_cards (id, user_id, sense_id, occurrence_id, created_at, revision) VALUES (?, ?, ?, ?, ?, ?)').run(
    card.id,
    userId,
    card.senseId,
    card.occurrenceId,
    card.createdAt,
    card.revision,
  );
}

function insertSchedule(db: DatabaseSync, userId: string, schedule: ScheduleJson): void {
  db.prepare(
    `INSERT INTO schedules (
      card_id, user_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps,
      reps, lapses, state, last_review, revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    schedule.cardId,
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
    schedule.revision,
    schedule.updatedAt,
  );
}

function insertEvent(db: DatabaseSync, userId: string, event: ReviewEventJson): void {
  db.prepare(
    `INSERT INTO review_events (
      id, user_id, card_id, grade, affects_schedule, reviewed_at, client_request_id,
      due_before, due_after, state_before, state_after, schedule_revision_before, schedule_revision_after,
      stability_before, stability_after, difficulty_before, difficulty_after,
      scheduled_days_before, scheduled_days_after, reps_after, lapses_after, elapsed_days_after, learning_steps_after,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    userId,
    event.cardId,
    event.grade,
    event.affectsSchedule ? 1 : 0,
    event.reviewedAt,
    event.clientRequestId,
    event.dueBefore,
    event.dueAfter,
    event.stateBefore,
    event.stateAfter,
    event.scheduleRevisionBefore,
    event.scheduleRevisionAfter,
    event.stabilityBefore,
    event.stabilityAfter,
    event.difficultyBefore,
    event.difficultyAfter,
    event.scheduledDaysBefore,
    event.scheduledDaysAfter,
    event.repsAfter,
    event.lapsesAfter,
    event.elapsedDaysAfter,
    event.learningStepsAfter,
    event.createdAt,
  );
}

function storedSense(db: DatabaseSync, userId: string, id: string): SenseJson {
  const row = db.prepare('SELECT id, lemma, part_of_speech, meaning, created_at FROM word_senses WHERE id = ? AND user_id = ?').get(id, userId) as
    | { id: string; lemma: string; part_of_speech: string; meaning: string; created_at: string }
    | undefined;
  if (!row) {
    throw new HttpError(500, 'INTERNAL', 'Sense disappeared during restore.');
  }
  return { id: row.id, lemma: row.lemma, partOfSpeech: row.part_of_speech, meaning: row.meaning, createdAt: row.created_at };
}

function storedOccurrence(db: DatabaseSync, userId: string, id: string): OccurrenceJson {
  const row = db
    .prepare(
      'SELECT id, sense_id, sentence, sentence_translation, eqbank_item_id, eqbank_source, eqbank_locator, created_at FROM source_occurrences WHERE id = ? AND user_id = ?',
    )
    .get(id, userId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new HttpError(500, 'INTERNAL', 'Sentence disappeared during restore.');
  }
  const itemId = nullable(row.eqbank_item_id);
  const source = nullable(row.eqbank_source);
  const locator = nullable(row.eqbank_locator);
  return {
    id: String(row.id),
    senseId: String(row.sense_id),
    sentence: String(row.sentence),
    sentenceTranslation: nullable(row.sentence_translation),
    eqbank: itemId === null && source === null && locator === null ? null : { itemId, source, locator },
    createdAt: String(row.created_at),
  };
}

function storedCard(db: DatabaseSync, userId: string, id: string): CardJson {
  const row = db.prepare('SELECT id, sense_id, occurrence_id, created_at, revision FROM learner_cards WHERE id = ? AND user_id = ?').get(id, userId) as
    | { id: string; sense_id: string; occurrence_id: string; created_at: string; revision: number | bigint }
    | undefined;
  if (!row) {
    throw new HttpError(500, 'INTERNAL', 'Card disappeared during restore.');
  }
  return {
    id: row.id,
    senseId: row.sense_id,
    occurrenceId: row.occurrence_id,
    createdAt: row.created_at,
    revision: typeof row.revision === 'bigint' ? Number(row.revision) : row.revision,
  };
}

function storedSchedule(db: DatabaseSync, userId: string, cardId: string): ScheduleJson {
  const match = listItems(db, userId).find((item) => item.card.id === cardId);
  if (!match) {
    throw new HttpError(500, 'INTERNAL', 'Schedule disappeared during restore.');
  }
  return match.schedule;
}

function storedEvent(db: DatabaseSync, userId: string, id: string): ReviewEventJson {
  const row = db.prepare('SELECT * FROM review_events WHERE id = ? AND user_id = ?').get(id, userId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new HttpError(500, 'INTERNAL', 'Review event disappeared during restore.');
  }
  return eventFromRow(row);
}

function eventFromRow(row: Record<string, unknown>): ReviewEventJson {
  return {
    id: String(row.id),
    cardId: String(row.card_id),
    grade: row.grade as ReviewEventJson['grade'],
    affectsSchedule: numberValue(row.affects_schedule) === 1,
    reviewedAt: String(row.reviewed_at),
    clientRequestId: String(row.client_request_id),
    dueBefore: String(row.due_before),
    dueAfter: String(row.due_after),
    stateBefore: row.state_before as ReviewEventJson['stateBefore'],
    stateAfter: row.state_after as ReviewEventJson['stateAfter'],
    scheduleRevisionBefore: numberValue(row.schedule_revision_before),
    scheduleRevisionAfter: numberValue(row.schedule_revision_after),
    stabilityBefore: numberValue(row.stability_before),
    stabilityAfter: numberValue(row.stability_after),
    difficultyBefore: numberValue(row.difficulty_before),
    difficultyAfter: numberValue(row.difficulty_after),
    scheduledDaysBefore: numberValue(row.scheduled_days_before),
    scheduledDaysAfter: numberValue(row.scheduled_days_after),
    repsAfter: numberValue(row.reps_after),
    lapsesAfter: numberValue(row.lapses_after),
    elapsedDaysAfter: numberValue(row.elapsed_days_after),
    learningStepsAfter: numberValue(row.learning_steps_after),
    createdAt: String(row.created_at),
  };
}

function numberValue(value: unknown): number {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return Number(value);
}

function nullable(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}
