import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite';
import { applySenseRecognition } from './migrateSense.js';

const SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  progress_revision INTEGER NOT NULL DEFAULT 0 CHECK (progress_revision >= 0),
  created_at TEXT NOT NULL
);

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
  task_id TEXT,
  occurrence_id TEXT,
  UNIQUE (user_id, client_request_id)
);

CREATE TRIGGER review_events_no_update
BEFORE UPDATE ON review_events
BEGIN
  SELECT RAISE(ABORT, 'review_events are append-only');
END;

CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE schedule_generation (
  user_id TEXT NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL,
  high_water INTEGER NOT NULL CHECK (high_water >= 1),
  PRIMARY KEY (user_id, card_id)
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_senses_user ON word_senses(user_id, created_at);
CREATE INDEX idx_occurrences_sense ON source_occurrences(user_id, sense_id);
CREATE INDEX idx_cards_user ON learner_cards(user_id, created_at);
CREATE INDEX idx_schedules_due ON schedules(user_id, due);
CREATE INDEX idx_events_card ON review_events(user_id, card_id, created_at);

CREATE TABLE schedule_archives (
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

CREATE TABLE learning_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  sense_id TEXT NOT NULL REFERENCES word_senses(id),
  task_type TEXT NOT NULL CHECK (task_type = 'recognition'),
  policy TEXT NOT NULL,
  donor_card_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, sense_id, task_type)
);

CREATE TABLE task_members (
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL REFERENCES learning_tasks(id),
  card_id TEXT NOT NULL REFERENCES learner_cards(id),
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE task_schedules (
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

CREATE TABLE task_rotation (
  task_id TEXT PRIMARY KEY REFERENCES learning_tasks(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  occurrence_id TEXT NOT NULL,
  UNIQUE (user_id, task_id)
);

CREATE TABLE task_generation (
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL,
  high_water INTEGER NOT NULL CHECK (high_water >= 1),
  PRIMARY KEY (user_id, task_id)
);

CREATE TABLE alias_tombstones (
  user_id TEXT NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (user_id, card_id)
);

CREATE INDEX idx_task_members_task ON task_members(user_id, task_id);
CREATE INDEX idx_task_schedules_due ON task_schedules(user_id, due);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL)');
  // Version is read inside the write lock so a second opener cannot repeat a partial backfill.
  transaction(db, () => {
    const row = db.prepare('SELECT version FROM schema_migrations').get() as { version: number | bigint } | undefined;
    const version = row ? Number(row.version) : 0;
    if (version === 0) {
      db.exec(SCHEMA);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (3)').run();
      return;
    }
    if (version === 1) {
      db.exec(`CREATE TABLE IF NOT EXISTS schedule_generation (
        user_id TEXT NOT NULL REFERENCES users(id),
        card_id TEXT NOT NULL,
        high_water INTEGER NOT NULL CHECK (high_water >= 1),
        PRIMARY KEY (user_id, card_id)
      )`);
      // WHERE keeps SQLite from reading ON CONFLICT as a join against schedules.
      db.exec(`INSERT INTO schedule_generation (user_id, card_id, high_water)
        SELECT user_id, card_id, revision FROM schedules WHERE true
        ON CONFLICT(user_id, card_id) DO UPDATE SET
          high_water = max(schedule_generation.high_water, excluded.high_water)`);
    }
    if (version === 1 || version === 2) {
      applySenseRecognition(db);
      db.prepare('UPDATE schema_migrations SET version = 3').run();
      return;
    }
    if (version !== 3) {
      throw new Error(`Unsupported wordloom schema version ${version}.`);
    }
  });
}

export function changesOf(result: StatementResultingChanges): number {
  return Number(result.changes);
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The statement that failed may already have rolled the transaction back.
    }
    throw error;
  }
}
