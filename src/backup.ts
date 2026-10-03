import type { DatabaseSync } from 'node:sqlite';
import { readUser } from './auth.js';
import { transaction } from './db.js';
import { nextProgressRevision } from './clientSync.js';
import { HttpError } from './errors.js';
import {
  bumpProgress,
  listAccountEvents,
  listSenses,
  raiseScheduleFloor,
  raiseTaskFloor,
  runOwnedMutation,
  sameJson,
  saveIdempotent,
  scheduleFloor,
  taskFloor,
} from './learning.js';
import { stateName, stateValue } from './scheduler.js';
import { installedRevision, planRecognitionTasks, type ScheduleTuple } from './senseTask.js';
import type {
  ApiResult,
  BackupDocument,
  BackupDocumentV1,
  BackupDocumentV2,
  CardJson,
  MemberJson,
  OccurrenceJson,
  ReviewEventJson,
  RotationJson,
  ScheduleJson,
  SenseJson,
  TaskJson,
} from './types.js';
import { BACKUP_SCHEMA_VERSION, TASK_POLICY } from './types.js';
import { isRecord, parseBackupDocument, rejectUnknown } from './validate.js';

type OwnerSql = { sql: string; label: string };
type Writing = 'replace' | 'merge';
type InstallMode = 'recognition-v1' | 'explicit-v2';

type Graph = {
  mode: InstallMode;
  senses: SenseJson[];
  occurrences: OccurrenceJson[];
  cards: CardJson[];
  events: ReviewEventJson[];
  tasks: TaskJson[];
  members: MemberJson[];
  rotations: RotationJson[];
  active: ScheduleJson[];
  legacy: ScheduleJson[];
};

const OWNERS: Record<'sense' | 'occurrence' | 'card' | 'event' | 'schedule' | 'task' | 'archive', OwnerSql> = {
  sense: { sql: 'SELECT user_id FROM word_senses WHERE id = ?', label: 'Sense' },
  occurrence: { sql: 'SELECT user_id FROM source_occurrences WHERE id = ?', label: 'Sentence' },
  card: { sql: 'SELECT user_id FROM learner_cards WHERE id = ?', label: 'Card' },
  event: { sql: 'SELECT user_id FROM review_events WHERE id = ?', label: 'Review event' },
  schedule: { sql: 'SELECT user_id FROM schedules WHERE card_id = ?', label: 'Schedule' },
  task: { sql: 'SELECT user_id FROM learning_tasks WHERE id = ?', label: 'Recognition task' },
  archive: { sql: 'SELECT user_id FROM schedule_archives WHERE card_id = ?', label: 'Archived schedule' },
};

export function exportBackup(db: DatabaseSync, userId: string, now: Date): BackupDocumentV2 {
  return transaction(db, () => {
    const user = readUser(db, userId);
    const senses = listSenses(db, userId);
    return {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: now.toISOString(),
      progressRevision: user.progressRevision,
      senses: senses.map(({ occurrences: _occurrences, ...sense }) => sense),
      occurrences: senses.flatMap((sense) => sense.occurrences),
      cards: readCards(db, userId),
      schedules: readActiveSchedules(db, userId),
      reviewEvents: listAccountEvents(db, userId),
      tasks: readTasks(db, userId),
      members: readMembers(db, userId),
      legacySchedules: readLegacySchedules(db, userId),
      rotations: readRotations(db, userId),
    };
  });
}

export function restoreBackup(
  db: DatabaseSync,
  now: () => Date,
  sessionId: string,
  expectedOwner: string | undefined,
  body: Record<string, unknown>,
  key: string,
  requestHash: string,
): ApiResult {
  return runOwnedMutation(db, now, sessionId, expectedOwner, key, requestHash, (userId) => {
    rejectUnknown(body, ['mode', 'confirm', 'document'], 'restore');
    if (body.mode !== 'replace' && body.mode !== 'merge') {
      throw new HttpError(400, 'VALIDATION', 'mode must be replace or merge.');
    }
    if (!isRecord(body.document)) {
      throw new HttpError(400, 'VALIDATION', 'document must be an object.');
    }
    const document = parseBackupDocument(body.document);
    const graph = graphFromDocument(document);
    let progressRevision: number;
    if (body.mode === 'replace') {
      if (body.confirm !== 'replace') {
        throw new HttpError(400, 'VALIDATION', 'Replace restore requires confirm set to replace.');
      }
      assertSnapshotAssignable(db, userId, document, graph);
      const liveRevision = readUser(db, userId).progressRevision;
      retainLineage(db, userId);
      deleteLearning(db, userId);
      insertGraph(db, userId, graph, 'replace');
      progressRevision = nextProgressRevision(liveRevision, document.progressRevision);
      db.prepare('UPDATE users SET progress_revision = ? WHERE id = ?').run(progressRevision, userId);
    } else {
      const inserted = mergeGraph(db, userId, graph);
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
  });
}

function graphFromDocument(document: BackupDocument): Graph {
  if (document.schemaVersion === BACKUP_SCHEMA_VERSION) {
    return explicitGraph(document);
  }
  return normalizedGraph(document);
}

function explicitGraph(document: BackupDocumentV2): Graph {
  return {
    mode: 'explicit-v2',
    senses: document.senses,
    occurrences: document.occurrences,
    cards: document.cards,
    events: document.reviewEvents,
    tasks: document.tasks,
    members: document.members,
    rotations: document.rotations,
    active: document.schedules,
    legacy: document.legacySchedules,
  };
}

function normalizedGraph(document: BackupDocumentV1): Graph {
  const scheduleByCard = new Map(document.schedules.map((schedule) => [schedule.cardId, schedule]));
  const occurrenceById = new Map(document.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const plans = planRecognitionTasks({
    cards: document.cards.map((card) => {
      const schedule = scheduleByCard.get(card.id);
      const occurrence = occurrenceById.get(card.occurrenceId);
      if (!schedule || !occurrence) {
        throw new HttpError(500, 'INTERNAL', 'Backup card is missing its sentence or schedule.');
      }
      return {
        cardId: card.id,
        senseId: card.senseId,
        occurrenceId: card.occurrenceId,
        occurrenceCreatedAt: occurrence.createdAt,
        schedule: tupleOf(schedule),
      };
    }),
    occurrences: document.occurrences.map((occurrence) => ({
      id: occurrence.id,
      senseId: occurrence.senseId,
      createdAt: occurrence.createdAt,
    })),
    floors: [],
    events: document.reviewEvents.map((event) => ({
      cardId: event.cardId,
      scheduleRevisionBefore: event.scheduleRevisionBefore,
      scheduleRevisionAfter: event.scheduleRevisionAfter,
    })),
    senseCreatedAt: new Map(document.senses.map((sense) => [sense.id, sense.createdAt])),
  });
  return {
    mode: 'recognition-v1',
    senses: document.senses,
    occurrences: document.occurrences,
    cards: document.cards,
    events: document.reviewEvents,
    tasks: plans.map((plan) => ({
      id: plan.taskId,
      senseId: plan.senseId,
      taskType: plan.taskType,
      policy: plan.policy,
      donorCardId: plan.donorCardId,
      createdAt: plan.createdAt,
    })),
    members: plans.flatMap((plan) => plan.memberCardIds.map((cardId) => ({ taskId: plan.taskId, cardId }))),
    rotations: plans.map((plan) => ({ taskId: plan.taskId, occurrenceId: plan.rotationOccurrenceId })),
    active: plans.map((plan) => plan.active),
    legacy: plans.flatMap((plan) => plan.legacy),
  };
}

function assertSnapshotAssignable(db: DatabaseSync, userId: string, document: BackupDocument, graph: Graph): void {
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
    const active = db.prepare('SELECT user_id FROM task_schedules WHERE donor_card_id = ?').get(schedule.cardId) as
      | { user_id: string }
      | undefined;
    if (active && active.user_id !== userId) {
      throw new HttpError(409, 'CONFLICT', 'Schedule belongs to another account.');
    }
  }
  for (const event of document.reviewEvents) {
    claim(db, 'event', event.id, userId);
  }
  for (const task of graph.tasks) {
    claim(db, 'task', task.id, userId);
  }
  for (const legacy of graph.legacy) {
    claim(db, 'archive', legacy.cardId, userId);
  }
}

function claim(db: DatabaseSync, kind: keyof typeof OWNERS, id: string, userId: string): void {
  const owner = OWNERS[kind];
  const row = db.prepare(owner.sql).get(id) as { user_id: string } | undefined;
  if (row && row.user_id !== userId) {
    throw new HttpError(409, 'CONFLICT', `${owner.label} belongs to another account.`);
  }
}

function retainLineage(db: DatabaseSync, userId: string): void {
  const rows = db
    .prepare(
      `SELECT task_members.card_id AS card_id, task_members.task_id AS task_id, task_schedules.revision AS revision
       FROM task_members
       JOIN task_schedules ON task_schedules.task_id = task_members.task_id AND task_schedules.user_id = task_members.user_id
       WHERE task_members.user_id = ?`,
    )
    .all(userId) as Array<{ card_id: string; task_id: string; revision: number | bigint }>;
  const tombstone = db.prepare(
    `INSERT INTO alias_tombstones (user_id, card_id, task_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, card_id) DO NOTHING`,
  );
  for (const row of rows) {
    const revision = numberValue(row.revision);
    raiseScheduleFloor(db, userId, row.card_id, revision);
    raiseTaskFloor(db, userId, row.task_id, revision);
    tombstone.run(userId, row.card_id, row.task_id);
  }
}

function deleteLearning(db: DatabaseSync, userId: string): void {
  db.prepare('DELETE FROM review_events WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM task_rotation WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM task_schedules WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM task_members WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM learning_tasks WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM schedule_archives WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM schedules WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM learner_cards WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM source_occurrences WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM word_senses WHERE user_id = ?').run(userId);
}

function insertGraph(db: DatabaseSync, userId: string, graph: Graph, writing: Writing): void {
  for (const sense of graph.senses) {
    insertSense(db, userId, sense);
  }
  for (const occurrence of graph.occurrences) {
    insertOccurrence(db, userId, occurrence);
  }
  for (const card of graph.cards) {
    insertCard(db, userId, card);
  }
  for (const task of graph.tasks) {
    insertTask(db, userId, task);
  }
  for (const member of graph.members) {
    assertReusableAlias(db, userId, member.cardId, member.taskId);
    insertMember(db, userId, member);
  }
  for (const legacy of graph.legacy) {
    insertLegacy(db, userId, legacy);
  }
  for (const schedule of graph.active) {
    const task = graph.tasks.find((item) => item.donorCardId === schedule.cardId);
    if (!task) {
      throw new HttpError(500, 'INTERNAL', 'Active schedule is missing its recognition task.');
    }
    insertActive(db, userId, task, schedule, graph, writing);
  }
  for (const rotation of graph.rotations) {
    insertRotation(db, userId, rotation);
  }
  for (const event of graph.events) {
    insertEvent(db, userId, event);
  }
}

type TaskSnapshot = {
  task: TaskJson;
  sense: SenseJson;
  occurrences: OccurrenceJson[];
  cards: CardJson[];
  members: MemberJson[];
  legacy: ScheduleJson[];
  active: ScheduleJson;
  rotation: RotationJson;
  events: ReviewEventJson[];
};

function mergeGraph(db: DatabaseSync, userId: string, graph: Graph): boolean {
  const incomingTasks = graph.tasks.map((task) => ({
    task,
    snapshot: sliceIncomingTask(graph, task),
    live: loadLiveTask(db, userId, task.id),
  }));
  for (const item of incomingTasks) {
    if (item.live && !sameTaskSnapshot(item.live, item.snapshot)) {
      throw new HttpError(409, 'SNAPSHOT_CONFLICT', 'Recognition task does not match the stored record.');
    }
  }
  for (const sense of graph.senses) {
    if (graph.tasks.some((task) => task.senseId === sense.id)) {
      continue;
    }
    const live = db.prepare('SELECT user_id FROM learning_tasks WHERE sense_id = ? AND task_type = ?').get(sense.id, 'recognition') as
      | { user_id: string }
      | undefined;
    if (live && live.user_id !== userId) {
      throw new HttpError(409, 'CONFLICT', 'Recognition task belongs to another account.');
    }
    if (live) {
      throw new HttpError(409, 'SNAPSHOT_CONFLICT', 'Recognition task does not match the stored record.');
    }
  }
  let inserted = false;
  for (const item of incomingTasks) {
    if (!item.live) {
      assertNoLeftoverSense(db, userId, item.snapshot);
      insertDisjointTask(db, userId, graph, item.snapshot);
      inserted = true;
    }
  }
  for (const sense of graph.senses) {
    if (graph.tasks.some((task) => task.senseId === sense.id)) {
      continue;
    }
    inserted =
      mergeRow(db, userId, 'sense', sense.id, sense, () => insertSense(db, userId, sense), () => storedSense(db, userId, sense.id)) || inserted;
    for (const occurrence of graph.occurrences.filter((item) => item.senseId === sense.id)) {
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
  }
  return inserted;
}

function assertNoLeftoverSense(db: DatabaseSync, userId: string, snapshot: TaskSnapshot): void {
  const sense = db.prepare('SELECT id FROM word_senses WHERE id = ? AND user_id = ?').get(snapshot.sense.id, userId);
  if (!sense) {
    return;
  }
  const occurrenceIds = new Set(snapshot.occurrences.map((occurrence) => occurrence.id));
  const cardIds = new Set(snapshot.cards.map((card) => card.id));
  const eventIds = new Set(snapshot.events.map((event) => event.id));
  const occurrences = db.prepare('SELECT id FROM source_occurrences WHERE user_id = ? AND sense_id = ?').all(userId, snapshot.sense.id) as Array<{
    id: string;
  }>;
  const cards = db.prepare('SELECT id FROM learner_cards WHERE user_id = ? AND sense_id = ?').all(userId, snapshot.sense.id) as Array<{ id: string }>;
  const events = db
    .prepare(
      `SELECT review_events.id AS id
       FROM review_events
       JOIN learner_cards ON learner_cards.id = review_events.card_id AND learner_cards.user_id = review_events.user_id
       WHERE review_events.user_id = ? AND learner_cards.sense_id = ?`,
    )
    .all(userId, snapshot.sense.id) as Array<{ id: string }>;
  if (occurrences.some((row) => !occurrenceIds.has(row.id)) || cards.some((row) => !cardIds.has(row.id)) || events.some((row) => !eventIds.has(row.id))) {
    throw new HttpError(409, 'SNAPSHOT_CONFLICT', 'Recognition task does not match the stored record.');
  }
}

function sliceIncomingTask(graph: Graph, task: TaskJson): TaskSnapshot {
  const sense = graph.senses.find((item) => item.id === task.senseId);
  const members = graph.members.filter((member) => member.taskId === task.id).sort((left, right) => left.cardId.localeCompare(right.cardId));
  const cardIds = new Set(members.map((member) => member.cardId));
  const active = graph.active.find((schedule) => schedule.cardId === task.donorCardId);
  const rotation = graph.rotations.find((item) => item.taskId === task.id);
  if (!sense || !active || !rotation) {
    throw new HttpError(500, 'INTERNAL', 'Active schedule is missing its recognition task.');
  }
  return {
    task,
    sense,
    occurrences: graph.occurrences.filter((item) => item.senseId === task.senseId).sort((left, right) => left.id.localeCompare(right.id)),
    cards: graph.cards.filter((card) => cardIds.has(card.id)).sort((left, right) => left.id.localeCompare(right.id)),
    members,
    legacy: graph.legacy.filter((schedule) => cardIds.has(schedule.cardId)).sort((left, right) => left.cardId.localeCompare(right.cardId)),
    active,
    rotation,
    events: graph.events
      .filter((event) => event.taskId === task.id || cardIds.has(event.cardId))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function loadLiveTask(db: DatabaseSync, userId: string, taskId: string): TaskSnapshot | undefined {
  const owner = db.prepare('SELECT user_id FROM learning_tasks WHERE id = ?').get(taskId) as { user_id: string } | undefined;
  if (!owner) {
    return undefined;
  }
  if (owner.user_id !== userId) {
    throw new HttpError(409, 'CONFLICT', 'Recognition task belongs to another account.');
  }
  const task = storedTask(db, userId, taskId);
  const members = readMembers(db, userId)
    .filter((member) => member.taskId === taskId)
    .sort((left, right) => left.cardId.localeCompare(right.cardId));
  const cardIds = new Set(members.map((member) => member.cardId));
  const occurrenceIds = db.prepare('SELECT id FROM source_occurrences WHERE user_id = ? AND sense_id = ? ORDER BY id ASC').all(userId, task.senseId) as Array<{
    id: string;
  }>;
  const legacy = [...cardIds]
    .filter((cardId) => db.prepare('SELECT card_id FROM schedule_archives WHERE user_id = ? AND card_id = ?').get(userId, cardId))
    .sort()
    .map((cardId) => storedLegacy(db, userId, cardId));
  const rotation = storedRotation(db, userId, taskId);
  const active = storedActive(db, userId, task.donorCardId);
  const events = readStoredEvents(db, userId)
    .filter((event) => event.taskId === taskId || cardIds.has(event.cardId))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    task,
    sense: storedSense(db, userId, task.senseId),
    occurrences: occurrenceIds.map((row) => storedOccurrence(db, userId, row.id)),
    cards: [...cardIds].sort().map((cardId) => storedCard(db, userId, cardId)),
    members,
    legacy,
    active,
    rotation,
    events,
  };
}

function sameTaskSnapshot(live: TaskSnapshot, incoming: TaskSnapshot): boolean {
  return sameJson(taskSnapshotIdentity(live), taskSnapshotIdentity(incoming));
}

function taskSnapshotIdentity(snapshot: TaskSnapshot): unknown {
  return {
    task: snapshot.task,
    sense: snapshot.sense,
    occurrences: snapshot.occurrences,
    cards: snapshot.cards,
    members: snapshot.members,
    legacy: snapshot.legacy,
    active: withoutRevision(snapshot.active),
    rotation: snapshot.rotation,
    events: snapshot.events,
  };
}

function insertDisjointTask(db: DatabaseSync, userId: string, graph: Graph, snapshot: TaskSnapshot): void {
  mergeRow(db, userId, 'sense', snapshot.sense.id, snapshot.sense, () => insertSense(db, userId, snapshot.sense), () => storedSense(db, userId, snapshot.sense.id));
  for (const occurrence of snapshot.occurrences) {
    mergeRow(
      db,
      userId,
      'occurrence',
      occurrence.id,
      occurrence,
      () => insertOccurrence(db, userId, occurrence),
      () => storedOccurrence(db, userId, occurrence.id),
    );
  }
  for (const card of snapshot.cards) {
    const member = db.prepare('SELECT user_id, task_id FROM task_members WHERE card_id = ?').get(card.id) as
      | { user_id: string; task_id: string }
      | undefined;
    if (member && (member.user_id !== userId || member.task_id !== snapshot.task.id)) {
      throw new HttpError(409, 'SNAPSHOT_CONFLICT', 'Task member does not match the stored record.');
    }
    mergeRow(db, userId, 'card', card.id, card, () => insertCard(db, userId, card), () => storedCard(db, userId, card.id));
  }
  mergeRow(db, userId, 'task', snapshot.task.id, snapshot.task, () => insertTask(db, userId, snapshot.task), () => storedTask(db, userId, snapshot.task.id));
  for (const member of snapshot.members) {
    assertReusableAlias(db, userId, member.cardId, member.taskId);
    const existing = db.prepare('SELECT user_id, task_id FROM task_members WHERE card_id = ?').get(member.cardId) as
      | { user_id: string; task_id: string }
      | undefined;
    if (!existing) {
      insertMember(db, userId, member);
      continue;
    }
    if (existing.user_id !== userId || existing.task_id !== member.taskId) {
      throw new HttpError(409, 'SNAPSHOT_CONFLICT', 'Task member does not match the stored record.');
    }
  }
  for (const legacy of snapshot.legacy) {
    mergeRow(db, userId, 'archive', legacy.cardId, legacy, () => insertLegacy(db, userId, legacy), () => storedLegacy(db, userId, legacy.cardId));
  }
  if (db.prepare('SELECT task_id FROM task_schedules WHERE task_id = ?').get(snapshot.task.id)) {
    throw new HttpError(409, 'SNAPSHOT_CONFLICT', 'Schedule does not match the stored record.');
  }
  insertActive(db, userId, snapshot.task, snapshot.active, graph, 'merge');
  if (db.prepare('SELECT task_id FROM task_rotation WHERE task_id = ?').get(snapshot.task.id)) {
    throw new HttpError(409, 'SNAPSHOT_CONFLICT', 'Rotation does not match the stored record.');
  }
  insertRotation(db, userId, snapshot.rotation);
  for (const event of snapshot.events) {
    mergeRow(db, userId, 'event', event.id, event, () => insertEvent(db, userId, event), () => storedEvent(db, userId, event.id));
  }
}

function mergeRow(
  db: DatabaseSync,
  userId: string,
  kind: keyof typeof OWNERS,
  id: string,
  incoming: unknown,
  insert: () => void,
  load: () => unknown,
  same: (stored: unknown, incoming: unknown) => boolean = sameJson,
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
  if (!same(load(), incoming)) {
    throw new HttpError(409, 'SNAPSHOT_CONFLICT', `${owner.label} does not match the stored record.`);
  }
  return false;
}

function insertActive(
  db: DatabaseSync,
  userId: string,
  task: TaskJson,
  schedule: ScheduleJson,
  graph: Graph,
  writing: Writing,
): void {
  const members = graph.members.filter((member) => member.taskId === task.id).map((member) => member.cardId);
  const floor = lineageFloor(db, userId, task.id, members);
  const historical = graph.mode === 'explicit-v2' ? explicitHistorical(graph, new Set(members)) : 0;
  const revision = chooseRevision(graph.mode, schedule.revision, floor, historical, writing);
  db.prepare(
    `INSERT INTO task_schedules (
      task_id, user_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps,
      reps, lapses, state, last_review, revision, updated_at, donor_card_id, policy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
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
    schedule.updatedAt,
    task.donorCardId,
    task.policy,
  );
  raiseTaskFloor(db, userId, task.id, revision);
  for (const cardId of members) {
    raiseScheduleFloor(db, userId, cardId, revision);
  }
}

function chooseRevision(mode: InstallMode, planned: number, floor: number, historical: number, writing: Writing): number {
  if (mode === 'recognition-v1') {
    return installedRevision('recognition-v1', planned, floor);
  }
  const base = Math.max(planned, historical);
  if (writing === 'merge' && floor === 0) {
    return historical > planned ? historical + 1 : planned;
  }
  return Math.max(base, floor) + 1;
}

function explicitHistorical(graph: Graph, memberIds: Set<string>): number {
  let high = 0;
  for (const legacy of graph.legacy) {
    if (memberIds.has(legacy.cardId)) {
      high = Math.max(high, legacy.revision);
    }
  }
  for (const event of graph.events) {
    if (memberIds.has(event.cardId)) {
      high = Math.max(high, event.scheduleRevisionBefore, event.scheduleRevisionAfter);
    }
  }
  return high;
}

function lineageFloor(db: DatabaseSync, userId: string, taskId: string, cardIds: string[]): number {
  let floor = taskFloor(db, userId, taskId);
  for (const cardId of cardIds) {
    floor = Math.max(floor, scheduleFloor(db, userId, cardId));
  }
  return floor;
}

function assertReusableAlias(db: DatabaseSync, userId: string, cardId: string, taskId: string): void {
  const row = db.prepare('SELECT task_id FROM alias_tombstones WHERE user_id = ? AND card_id = ?').get(userId, cardId) as
    | { task_id: string }
    | undefined;
  if (row && row.task_id !== taskId) {
    throw new HttpError(409, 'CONFLICT', 'This card already belonged to another recognition task.');
  }
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

function insertTask(db: DatabaseSync, userId: string, task: TaskJson): void {
  db.prepare(
    `INSERT INTO learning_tasks (id, user_id, sense_id, task_type, policy, donor_card_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(task.id, userId, task.senseId, task.taskType, task.policy, task.donorCardId, task.createdAt);
}

function insertMember(db: DatabaseSync, userId: string, member: MemberJson): void {
  db.prepare('INSERT INTO task_members (user_id, task_id, card_id) VALUES (?, ?, ?)').run(userId, member.taskId, member.cardId);
}

function insertLegacy(db: DatabaseSync, userId: string, schedule: ScheduleJson): void {
  db.prepare(
    `INSERT INTO schedule_archives (
      user_id, card_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps,
      reps, lapses, state, last_review, revision, updated_at, policy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    schedule.cardId,
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
    TASK_POLICY,
  );
}

function insertRotation(db: DatabaseSync, userId: string, rotation: RotationJson): void {
  db.prepare('INSERT INTO task_rotation (task_id, user_id, occurrence_id) VALUES (?, ?, ?)').run(rotation.taskId, userId, rotation.occurrenceId);
}

function insertEvent(db: DatabaseSync, userId: string, event: ReviewEventJson): void {
  const existing = db.prepare('SELECT id FROM review_events WHERE user_id = ? AND client_request_id = ?').get(userId, event.clientRequestId) as
    | { id: string }
    | undefined;
  if (existing && existing.id !== event.id) {
    throw new HttpError(409, 'SNAPSHOT_CONFLICT', 'Review event does not match the stored record.');
  }
  db.prepare(
    `INSERT INTO review_events (
      id, user_id, card_id, grade, affects_schedule, reviewed_at, client_request_id,
      due_before, due_after, state_before, state_after, schedule_revision_before, schedule_revision_after,
      stability_before, stability_after, difficulty_before, difficulty_after,
      scheduled_days_before, scheduled_days_after, reps_after, lapses_after, elapsed_days_after, learning_steps_after,
      created_at, task_id, occurrence_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    event.taskId,
    event.occurrenceId,
  );
}

function withoutRevision(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const { revision: _revision, ...rest } = value;
  return rest;
}

function tupleOf(schedule: ScheduleJson): ScheduleTuple {
  return {
    due: schedule.due,
    stability: schedule.stability,
    difficulty: schedule.difficulty,
    elapsedDays: schedule.elapsedDays,
    scheduledDays: schedule.scheduledDays,
    learningSteps: schedule.learningSteps,
    reps: schedule.reps,
    lapses: schedule.lapses,
    state: schedule.state,
    lastReview: schedule.lastReview,
    revision: schedule.revision,
    updatedAt: schedule.updatedAt,
  };
}

function readCards(db: DatabaseSync, userId: string): CardJson[] {
  const rows = db
    .prepare(
      'SELECT id, sense_id, occurrence_id, created_at, revision FROM learner_cards WHERE user_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(userId) as Array<{ id: string; sense_id: string; occurrence_id: string; created_at: string; revision: number | bigint }>;
  return rows.map((row) => ({
    id: row.id,
    senseId: row.sense_id,
    occurrenceId: row.occurrence_id,
    createdAt: row.created_at,
    revision: numberValue(row.revision),
  }));
}

function readTasks(db: DatabaseSync, userId: string): TaskJson[] {
  const rows = db
    .prepare(
      `SELECT id, sense_id, task_type, policy, donor_card_id, created_at
       FROM learning_tasks WHERE user_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(userId) as Array<{ id: string; sense_id: string; task_type: string; policy: string; donor_card_id: string; created_at: string }>;
  return rows.map((row) => {
    if (row.task_type !== 'recognition' || row.policy !== TASK_POLICY) {
      throw new HttpError(500, 'INTERNAL', 'Stored recognition task is not the supported policy.');
    }
    return {
      id: row.id,
      senseId: row.sense_id,
      taskType: 'recognition' as const,
      policy: TASK_POLICY,
      donorCardId: row.donor_card_id,
      createdAt: row.created_at,
    };
  });
}

function readMembers(db: DatabaseSync, userId: string): MemberJson[] {
  const rows = db.prepare('SELECT task_id, card_id FROM task_members WHERE user_id = ? ORDER BY card_id ASC').all(userId) as Array<{
    task_id: string;
    card_id: string;
  }>;
  return rows.map((row) => ({ taskId: row.task_id, cardId: row.card_id }));
}

function readRotations(db: DatabaseSync, userId: string): RotationJson[] {
  const rows = db.prepare('SELECT task_id, occurrence_id FROM task_rotation WHERE user_id = ? ORDER BY task_id ASC').all(userId) as Array<{
    task_id: string;
    occurrence_id: string;
  }>;
  return rows.map((row) => ({ taskId: row.task_id, occurrenceId: row.occurrence_id }));
}

function readActiveSchedules(db: DatabaseSync, userId: string): ScheduleJson[] {
  const rows = db.prepare('SELECT * FROM task_schedules WHERE user_id = ? ORDER BY donor_card_id ASC').all(userId) as Array<Record<string, unknown>>;
  return rows.map((row) => scheduleFromRow(String(row.donor_card_id), row));
}

function readLegacySchedules(db: DatabaseSync, userId: string): ScheduleJson[] {
  const rows = db.prepare('SELECT * FROM schedule_archives WHERE user_id = ? ORDER BY card_id ASC').all(userId) as Array<Record<string, unknown>>;
  return rows.map((row) => scheduleFromRow(String(row.card_id), row));
}

function scheduleFromRow(cardId: string, row: Record<string, unknown>): ScheduleJson {
  return {
    cardId,
    due: String(row.due),
    stability: numberValue(row.stability),
    difficulty: numberValue(row.difficulty),
    elapsedDays: numberValue(row.elapsed_days),
    scheduledDays: numberValue(row.scheduled_days),
    learningSteps: numberValue(row.learning_steps),
    reps: numberValue(row.reps),
    lapses: numberValue(row.lapses),
    state: stateName(numberValue(row.state)),
    lastReview: row.last_review === null || row.last_review === undefined ? null : String(row.last_review),
    revision: numberValue(row.revision),
    updatedAt: String(row.updated_at),
  };
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
    revision: numberValue(row.revision),
  };
}

function storedTask(db: DatabaseSync, userId: string, id: string): TaskJson {
  const row = db
    .prepare('SELECT id, sense_id, policy, donor_card_id, created_at FROM learning_tasks WHERE id = ? AND user_id = ?')
    .get(id, userId) as { id: string; sense_id: string; policy: string; donor_card_id: string; created_at: string } | undefined;
  if (!row || row.policy !== TASK_POLICY) {
    throw new HttpError(500, 'INTERNAL', 'Recognition task disappeared during restore.');
  }
  return {
    id: row.id,
    senseId: row.sense_id,
    taskType: 'recognition',
    policy: TASK_POLICY,
    donorCardId: row.donor_card_id,
    createdAt: row.created_at,
  };
}

function storedMember(db: DatabaseSync, userId: string, cardId: string): MemberJson {
  const row = db.prepare('SELECT task_id, card_id FROM task_members WHERE user_id = ? AND card_id = ?').get(userId, cardId) as
    | { task_id: string; card_id: string }
    | undefined;
  if (!row) {
    throw new HttpError(500, 'INTERNAL', 'Task member disappeared during restore.');
  }
  return { taskId: row.task_id, cardId: row.card_id };
}

function storedLegacy(db: DatabaseSync, userId: string, cardId: string): ScheduleJson {
  const row = db.prepare('SELECT * FROM schedule_archives WHERE user_id = ? AND card_id = ?').get(userId, cardId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new HttpError(500, 'INTERNAL', 'Archived schedule disappeared during restore.');
  }
  return scheduleFromRow(cardId, row);
}

function storedActive(db: DatabaseSync, userId: string, cardId: string): ScheduleJson {
  const row = db.prepare('SELECT * FROM task_schedules WHERE user_id = ? AND donor_card_id = ?').get(userId, cardId) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    throw new HttpError(500, 'INTERNAL', 'Schedule disappeared during restore.');
  }
  return scheduleFromRow(cardId, row);
}

function storedRotation(db: DatabaseSync, userId: string, taskId: string): RotationJson {
  const row = db.prepare('SELECT task_id, occurrence_id FROM task_rotation WHERE user_id = ? AND task_id = ?').get(userId, taskId) as
    | { task_id: string; occurrence_id: string }
    | undefined;
  if (!row) {
    throw new HttpError(500, 'INTERNAL', 'Rotation disappeared during restore.');
  }
  return { taskId: row.task_id, occurrenceId: row.occurrence_id };
}

function readStoredEvents(db: DatabaseSync, userId: string): ReviewEventJson[] {
  const rows = db.prepare('SELECT * FROM review_events WHERE user_id = ? ORDER BY id ASC').all(userId) as Array<Record<string, unknown>>;
  return rows.map((row) => eventJson(row));
}

function storedEvent(db: DatabaseSync, userId: string, id: string): ReviewEventJson {
  const row = db.prepare('SELECT * FROM review_events WHERE id = ? AND user_id = ?').get(id, userId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new HttpError(500, 'INTERNAL', 'Review event disappeared during restore.');
  }
  return eventJson(row);
}

function eventJson(row: Record<string, unknown>): ReviewEventJson {
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
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    occurrenceId: row.occurrence_id === null || row.occurrence_id === undefined ? null : String(row.occurrence_id),
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
