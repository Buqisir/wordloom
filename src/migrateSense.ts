import type { DatabaseSync } from 'node:sqlite';
import { stateName } from './scheduler.js';
import { planRecognitionTasks, type PlanCard, type ScheduleTuple } from './senseTask.js';
import { TASK_POLICY, type StateName } from './types.js';

const V3_TABLES = `
CREATE TABLE IF NOT EXISTS schedule_archives (
  user_id TEXT NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL,
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
  updated_at TEXT NOT NULL,
  policy TEXT NOT NULL,
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE IF NOT EXISTS learning_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  sense_id TEXT NOT NULL REFERENCES word_senses(id),
  task_type TEXT NOT NULL CHECK (task_type = 'recognition'),
  policy TEXT NOT NULL,
  donor_card_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, sense_id, task_type)
);

CREATE TABLE IF NOT EXISTS task_members (
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL REFERENCES learning_tasks(id),
  card_id TEXT NOT NULL REFERENCES learner_cards(id),
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE IF NOT EXISTS task_schedules (
  task_id TEXT PRIMARY KEY REFERENCES learning_tasks(id),
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
  updated_at TEXT NOT NULL,
  donor_card_id TEXT NOT NULL,
  policy TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_rotation (
  task_id TEXT PRIMARY KEY REFERENCES learning_tasks(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  occurrence_id TEXT NOT NULL,
  UNIQUE (user_id, task_id)
);

CREATE TABLE IF NOT EXISTS task_generation (
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL,
  high_water INTEGER NOT NULL CHECK (high_water >= 1),
  PRIMARY KEY (user_id, task_id)
);

CREATE TABLE IF NOT EXISTS alias_tombstones (
  user_id TEXT NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (user_id, card_id)
);

CREATE INDEX IF NOT EXISTS idx_task_members_task ON task_members(user_id, task_id);
CREATE INDEX IF NOT EXISTS idx_task_schedules_due ON task_schedules(user_id, due);
`;

type ScheduleSql = {
  card_id: string;
  user_id: string;
  due: string;
  stability: number | bigint;
  difficulty: number | bigint;
  elapsed_days: number | bigint;
  scheduled_days: number | bigint;
  learning_steps: number | bigint;
  reps: number | bigint;
  lapses: number | bigint;
  state: number | bigint;
  last_review: string | null;
  revision: number | bigint;
  updated_at: string;
};

export function applySenseRecognition(db: DatabaseSync): void {
  db.exec(V3_TABLES);
  ensureEventColumns(db);
  const orphans = db
    .prepare(
      `SELECT schedules.card_id AS card_id
       FROM schedules
       LEFT JOIN learner_cards ON learner_cards.id = schedules.card_id
       WHERE learner_cards.id IS NULL`,
    )
    .all() as Array<{ card_id: string }>;
  if (orphans.length > 0) {
    throw new Error('Schedule has no learner card.');
  }
  db.prepare(
    `INSERT INTO schedule_archives (
      user_id, card_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps,
      reps, lapses, state, last_review, revision, updated_at, policy
    )
    SELECT user_id, card_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps,
      reps, lapses, state, last_review, revision, updated_at, ?
    FROM schedules`,
  ).run(TASK_POLICY);

  const senseRows = db.prepare('SELECT id, user_id, created_at FROM word_senses').all() as Array<{
    id: string;
    user_id: string;
    created_at: string;
  }>;
  const users = [...new Set(senseRows.map((row) => row.user_id))];
  for (const userId of users) {
    seedUser(db, userId, senseRows.filter((row) => row.user_id === userId));
  }
  db.prepare(
    `UPDATE users SET progress_revision = progress_revision + 1
     WHERE id IN (SELECT DISTINCT user_id FROM learner_cards)`,
  ).run();
}

function seedUser(db: DatabaseSync, userId: string, senses: Array<{ id: string; created_at: string }>): void {
  const cards = db
    .prepare(
      `SELECT learner_cards.id AS card_id, learner_cards.sense_id AS sense_id, learner_cards.occurrence_id AS occurrence_id,
              source_occurrences.created_at AS occurrence_created_at
       FROM learner_cards
       JOIN source_occurrences ON source_occurrences.id = learner_cards.occurrence_id AND source_occurrences.user_id = learner_cards.user_id
       WHERE learner_cards.user_id = ?`,
    )
    .all(userId) as Array<{ card_id: string; sense_id: string; occurrence_id: string; occurrence_created_at: string }>;
  if (cards.length === 0) {
    return;
  }
  const scheduleRows = db.prepare('SELECT * FROM schedules WHERE user_id = ?').all(userId) as ScheduleSql[];
  const schedules = new Map(scheduleRows.map((row) => [row.card_id, tupleFrom(row)]));
  const planCards: PlanCard[] = [];
  for (const card of cards) {
    const schedule = schedules.get(card.card_id);
    if (!schedule) {
      throw new Error(`Learner card ${card.card_id} has no schedule.`);
    }
    planCards.push({
      cardId: card.card_id,
      senseId: card.sense_id,
      occurrenceId: card.occurrence_id,
      occurrenceCreatedAt: card.occurrence_created_at,
      schedule,
    });
  }
  const floors = db.prepare('SELECT card_id, high_water FROM schedule_generation WHERE user_id = ?').all(userId) as Array<{
    card_id: string;
    high_water: number | bigint;
  }>;
  const events = db
    .prepare('SELECT card_id, schedule_revision_before, schedule_revision_after FROM review_events WHERE user_id = ?')
    .all(userId) as Array<{ card_id: string; schedule_revision_before: number | bigint; schedule_revision_after: number | bigint }>;
  const occurrences = db.prepare('SELECT id, sense_id, created_at FROM source_occurrences WHERE user_id = ?').all(userId) as Array<{
    id: string;
    sense_id: string;
    created_at: string;
  }>;
  const plans = planRecognitionTasks({
    cards: planCards,
    occurrences: occurrences.map((row) => ({ id: row.id, senseId: row.sense_id, createdAt: row.created_at })),
    floors: floors.map((row) => ({ cardId: row.card_id, highWater: numberValue(row.high_water) })),
    events: events.map((row) => ({
      cardId: row.card_id,
      scheduleRevisionBefore: numberValue(row.schedule_revision_before),
      scheduleRevisionAfter: numberValue(row.schedule_revision_after),
    })),
    senseCreatedAt: new Map(senses.map((sense) => [sense.id, sense.created_at])),
  });
  const insertTask = db.prepare(
    `INSERT INTO learning_tasks (id, user_id, sense_id, task_type, policy, donor_card_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMember = db.prepare('INSERT INTO task_members (user_id, task_id, card_id) VALUES (?, ?, ?)');
  const insertActive = db.prepare(
    `INSERT INTO task_schedules (
      task_id, user_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps,
      reps, lapses, state, last_review, revision, updated_at, donor_card_id, policy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRotation = db.prepare('INSERT INTO task_rotation (task_id, user_id, occurrence_id) VALUES (?, ?, ?)');
  const raiseCard = db.prepare(
    `INSERT INTO schedule_generation (user_id, card_id, high_water) VALUES (?, ?, ?)
     ON CONFLICT(user_id, card_id) DO UPDATE SET high_water = max(high_water, excluded.high_water)`,
  );
  const raiseTask = db.prepare(
    `INSERT INTO task_generation (user_id, task_id, high_water) VALUES (?, ?, ?)
     ON CONFLICT(user_id, task_id) DO UPDATE SET high_water = max(high_water, excluded.high_water)`,
  );
  for (const plan of plans) {
    insertTask.run(plan.taskId, userId, plan.senseId, plan.taskType, plan.policy, plan.donorCardId, plan.createdAt);
    for (const cardId of plan.memberCardIds) {
      insertMember.run(userId, plan.taskId, cardId);
      raiseCard.run(userId, cardId, plan.active.revision);
    }
    insertActive.run(
      plan.taskId,
      userId,
      plan.active.due,
      plan.active.stability,
      plan.active.difficulty,
      plan.active.elapsedDays,
      plan.active.scheduledDays,
      plan.active.learningSteps,
      plan.active.reps,
      plan.active.lapses,
      stateNumber(plan.active.state),
      plan.active.lastReview,
      plan.active.revision,
      plan.active.updatedAt,
      plan.donorCardId,
      plan.policy,
    );
    insertRotation.run(plan.taskId, userId, plan.rotationOccurrenceId);
    raiseTask.run(userId, plan.taskId, plan.active.revision);
  }
}

function ensureEventColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(review_events)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has('task_id')) {
    db.exec('ALTER TABLE review_events ADD COLUMN task_id TEXT');
  }
  if (!columns.has('occurrence_id')) {
    db.exec('ALTER TABLE review_events ADD COLUMN occurrence_id TEXT');
  }
}

function tupleFrom(row: ScheduleSql): ScheduleTuple {
  return {
    due: row.due,
    stability: numberValue(row.stability),
    difficulty: numberValue(row.difficulty),
    elapsedDays: numberValue(row.elapsed_days),
    scheduledDays: numberValue(row.scheduled_days),
    learningSteps: numberValue(row.learning_steps),
    reps: numberValue(row.reps),
    lapses: numberValue(row.lapses),
    state: stateName(numberValue(row.state)),
    lastReview: row.last_review,
    revision: numberValue(row.revision),
    updatedAt: row.updated_at,
  };
}

function stateNumber(state: StateName): number {
  return ['new', 'learning', 'review', 'relearning'].indexOf(state);
}

function numberValue(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}
