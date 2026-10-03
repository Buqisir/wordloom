import { HttpError } from './errors.js';
import { isGradeName, isStateName } from './scheduler.js';
import { recognitionTaskId } from './senseTask.js';
import {
  BACKUP_SCHEMA_VERSION,
  LEGACY_BACKUP_SCHEMA_VERSION,
  TASK_POLICY,
  type BackupDocument,
  type BackupDocumentV1,
  type BackupDocumentV2,
  type CardJson,
  type EqbankMeta,
  type GradeName,
  type MemberJson,
  type OccurrenceJson,
  type ReviewEventJson,
  type RotationJson,
  type ScheduleJson,
  type SenseJson,
  type StateName,
  type TaskJson,
} from './types.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,80}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rejectUnknown(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new HttpError(400, 'VALIDATION', `${label} has unknown field ${key}.`);
    }
  }
}

export function assertOnlyKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  rejectUnknown(record, keys, label);
  for (const key of keys) {
    if (!(key in record)) {
      throw new HttpError(400, 'VALIDATION', `${label} is missing ${key}.`);
    }
  }
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'VALIDATION', 'Email is required.');
  }
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'VALIDATION', 'Email is invalid.');
  }
  return email;
}

export function assertIso(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, 'VALIDATION', `${field} must be an ISO-8601 UTC timestamp.`);
  }
  return value;
}

export function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new HttpError(400, 'VALIDATION', `${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

export function assertIdempotencyKey(value: string | undefined): string {
  if (!value || !IDEMPOTENCY.test(value)) {
    throw new HttpError(400, 'VALIDATION', 'Idempotency-Key must be 8 to 80 letters, numbers, underscores, or hyphens.');
  }
  return value;
}

export function assertText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'VALIDATION', `${field} is required.`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > max) {
    throw new HttpError(400, 'VALIDATION', `${field} must be 1 to ${max} characters.`);
  }
  return text;
}

export function assertOptionalText(value: unknown, field: string, max: number): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, 'VALIDATION', `${field} must be a string or null.`);
  }
  const text = value.trim();
  if (text.length === 0) {
    return null;
  }
  if (text.length > max) {
    throw new HttpError(400, 'VALIDATION', `${field} must be at most ${max} characters.`);
  }
  return text;
}

export function assertInteger(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new HttpError(400, 'VALIDATION', `${field} must be an integer of at least ${min}.`);
  }
  return value;
}

export function assertFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, 'VALIDATION', `${field} must be a finite number.`);
  }
  return value;
}

export function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpError(400, 'VALIDATION', `${field} must be a boolean.`);
  }
  return value;
}

export function parseEqbank(value: unknown, label: string): EqbankMeta | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new HttpError(400, 'VALIDATION', `${label} must be an object or null.`);
  }
  assertOnlyKeys(value, ['itemId', 'source', 'locator'], label);
  const itemId = assertOptionalText(value.itemId, `${label}.itemId`, 200);
  const source = assertOptionalText(value.source, `${label}.source`, 200);
  const locator = assertOptionalText(value.locator, `${label}.locator`, 200);
  if (itemId === null && source === null && locator === null) {
    return null;
  }
  return { itemId, source, locator };
}

export type ManualAdd =
  | {
      kind: 'new-sense';
      lemma: string;
      partOfSpeech: string;
      meaning: string;
      sentence: string;
      sentenceTranslation: string | null;
      eqbank: EqbankMeta | null;
    }
  | {
      kind: 'existing-sense';
      senseId: string;
      sentence: string;
      sentenceTranslation: string | null;
      eqbank: EqbankMeta | null;
    };

export function parseManualAdd(body: Record<string, unknown>): ManualAdd {
  if ('senseId' in body) {
    rejectUnknown(body, ['senseId', 'sentence', 'sentenceTranslation', 'eqbank'], 'card');
    return {
      kind: 'existing-sense',
      senseId: assertUuid(body.senseId, 'senseId'),
      sentence: assertText(body.sentence, 'sentence', 4000),
      sentenceTranslation:
        body.sentenceTranslation === undefined
          ? null
          : assertOptionalText(body.sentenceTranslation, 'sentenceTranslation', 4000),
      eqbank: body.eqbank === undefined ? null : parseEqbank(body.eqbank, 'eqbank'),
    };
  }
  rejectUnknown(body, ['lemma', 'partOfSpeech', 'meaning', 'sentence', 'sentenceTranslation', 'eqbank'], 'card');
  return {
    kind: 'new-sense',
    lemma: assertText(body.lemma, 'lemma', 200),
    partOfSpeech: assertText(body.partOfSpeech, 'partOfSpeech', 64),
    meaning: assertText(body.meaning, 'meaning', 2000),
    sentence: assertText(body.sentence, 'sentence', 4000),
    sentenceTranslation:
      body.sentenceTranslation === undefined ? null : assertOptionalText(body.sentenceTranslation, 'sentenceTranslation', 4000),
    eqbank: body.eqbank === undefined ? null : parseEqbank(body.eqbank, 'eqbank'),
  };
}

export type ReviewRequest = {
  grade: GradeName;
  affectsSchedule: boolean;
  expectedScheduleRevision: number;
  occurrenceId?: string;
};

export function parseReview(body: Record<string, unknown>): ReviewRequest {
  rejectUnknown(body, ['grade', 'affectsSchedule', 'expectedScheduleRevision', 'occurrenceId'], 'review');
  for (const key of ['grade', 'affectsSchedule', 'expectedScheduleRevision']) {
    if (!(key in body)) {
      throw new HttpError(400, 'VALIDATION', `review is missing ${key}.`);
    }
  }
  if (typeof body.grade !== 'string' || !isGradeName(body.grade)) {
    throw new HttpError(400, 'VALIDATION', 'grade must be again, hard, good, or easy.');
  }
  const review: ReviewRequest = {
    grade: body.grade,
    affectsSchedule: assertBoolean(body.affectsSchedule, 'affectsSchedule'),
    expectedScheduleRevision: assertInteger(body.expectedScheduleRevision, 'expectedScheduleRevision', 1),
  };
  if (body.occurrenceId !== undefined) {
    review.occurrenceId = assertUuid(body.occurrenceId, 'occurrenceId');
  }
  return review;
}

export function parseBackupDocument(value: unknown): BackupDocument {
  if (!isRecord(value)) {
    throw new HttpError(400, 'VALIDATION', 'document must be an object.');
  }
  if (value.schemaVersion === LEGACY_BACKUP_SCHEMA_VERSION) {
    return parseBackupV1(value);
  }
  if (value.schemaVersion === BACKUP_SCHEMA_VERSION) {
    return parseBackupV2(value);
  }
  throw new HttpError(400, 'SCHEMA_UNSUPPORTED', `Backup schemaVersion must be ${LEGACY_BACKUP_SCHEMA_VERSION} or ${BACKUP_SCHEMA_VERSION}.`);
}

function parseBackupV1(value: Record<string, unknown>): BackupDocumentV1 {
  assertOnlyKeys(
    value,
    ['schemaVersion', 'exportedAt', 'progressRevision', 'senses', 'occurrences', 'cards', 'schedules', 'reviewEvents'],
    'document',
  );
  const senses = parseArray(value.senses, 'senses', parseSense);
  const occurrences = parseArray(value.occurrences, 'occurrences', parseOccurrence);
  const cards = parseArray(value.cards, 'cards', parseCard);
  const schedules = parseArray(value.schedules, 'schedules', (entry, index) => parseSchedule(entry, index));
  const reviewEvents = parseArray(value.reviewEvents, 'reviewEvents', (entry, index) => parseEvent(entry, index, false)).map((event) => ({
    ...event,
    taskId: null,
    occurrenceId: null,
  }));
  assertLearningGraph(senses, occurrences, cards, reviewEvents);
  assertUnique(schedules.map((schedule) => schedule.cardId), 'schedule cardId');
  const scheduled = new Set(schedules.map((schedule) => schedule.cardId));
  const cardIds = new Set(cards.map((card) => card.id));
  if (scheduled.size !== cardIds.size || [...cardIds].some((id) => !scheduled.has(id))) {
    throw new HttpError(400, 'VALIDATION', 'Every card needs exactly one schedule.');
  }
  return {
    schemaVersion: LEGACY_BACKUP_SCHEMA_VERSION,
    exportedAt: assertIso(value.exportedAt, 'exportedAt'),
    progressRevision: assertInteger(value.progressRevision, 'progressRevision', 0),
    senses,
    occurrences,
    cards,
    schedules,
    reviewEvents,
  };
}

function parseBackupV2(value: Record<string, unknown>): BackupDocumentV2 {
  assertOnlyKeys(
    value,
    [
      'schemaVersion',
      'exportedAt',
      'progressRevision',
      'senses',
      'occurrences',
      'cards',
      'schedules',
      'reviewEvents',
      'tasks',
      'members',
      'legacySchedules',
      'rotations',
    ],
    'document',
  );
  const senses = parseArray(value.senses, 'senses', parseSense);
  const occurrences = parseArray(value.occurrences, 'occurrences', parseOccurrence);
  const cards = parseArray(value.cards, 'cards', parseCard);
  const schedules = parseArray(value.schedules, 'schedules', (entry, index) => parseSchedule(entry, index));
  const reviewEvents = parseArray(value.reviewEvents, 'reviewEvents', (entry, index) => parseEvent(entry, index, true));
  const tasks = parseArray(value.tasks, 'tasks', parseTask);
  const members = parseArray(value.members, 'members', parseMember);
  const legacySchedules = parseArray(value.legacySchedules, 'legacySchedules', (entry, index) => parseSchedule(entry, index, 'legacySchedules'));
  const rotations = parseArray(value.rotations, 'rotations', parseRotation);
  assertLearningGraph(senses, occurrences, cards, reviewEvents);
  assertRecognitionGraph(senses, occurrences, cards, schedules, reviewEvents, tasks, members, legacySchedules, rotations);
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: assertIso(value.exportedAt, 'exportedAt'),
    progressRevision: assertInteger(value.progressRevision, 'progressRevision', 0),
    senses,
    occurrences,
    cards,
    schedules,
    reviewEvents,
    tasks,
    members,
    legacySchedules,
    rotations,
  };
}

function assertLearningGraph(
  senses: SenseJson[],
  occurrences: OccurrenceJson[],
  cards: CardJson[],
  reviewEvents: ReviewEventJson[],
): void {
  assertUnique(senses.map((sense) => sense.id), 'sense id');
  assertUnique(occurrences.map((occurrence) => occurrence.id), 'occurrence id');
  assertUnique(cards.map((card) => card.id), 'card id');
  assertUnique(reviewEvents.map((event) => event.id), 'review event id');
  assertUnique(reviewEvents.map((event) => event.clientRequestId), 'review clientRequestId');
  const senseIds = new Set(senses.map((sense) => sense.id));
  const occurrencesById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const cardIds = new Set(cards.map((card) => card.id));
  for (const occurrence of occurrences) {
    if (!senseIds.has(occurrence.senseId)) {
      throw new HttpError(400, 'VALIDATION', 'An occurrence points at a missing sense.');
    }
  }
  for (const card of cards) {
    const occurrence = occurrencesById.get(card.occurrenceId);
    if (!senseIds.has(card.senseId) || !occurrence || occurrence.senseId !== card.senseId) {
      throw new HttpError(400, 'VALIDATION', 'A card must point at its own sense and sentence.');
    }
  }
  for (const event of reviewEvents) {
    if (!cardIds.has(event.cardId)) {
      throw new HttpError(400, 'VALIDATION', 'A review event points at a missing card.');
    }
  }
}

function assertRecognitionGraph(
  senses: SenseJson[],
  occurrences: OccurrenceJson[],
  cards: CardJson[],
  schedules: ScheduleJson[],
  reviewEvents: ReviewEventJson[],
  tasks: TaskJson[],
  members: MemberJson[],
  legacySchedules: ScheduleJson[],
  rotations: RotationJson[],
): void {
  assertUnique(tasks.map((task) => task.id), 'task id');
  assertUnique(members.map((member) => member.cardId), 'member card');
  assertUnique(schedules.map((schedule) => schedule.cardId), 'schedule cardId');
  assertUnique(legacySchedules.map((schedule) => schedule.cardId), 'legacy schedule cardId');
  assertUnique(rotations.map((rotation) => rotation.taskId), 'rotation task');
  const senseIds = new Set(senses.map((sense) => sense.id));
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const occurrenceIds = new Set(occurrences.map((occurrence) => occurrence.id));
  if (tasks.length !== schedules.length || tasks.length !== rotations.length) {
    throw new HttpError(400, 'VALIDATION', 'Each recognition task needs one active schedule and one rotation.');
  }
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const activeByDonor = new Map(schedules.map((schedule) => [schedule.cardId, schedule]));
  const rotationByTask = new Map(rotations.map((rotation) => [rotation.taskId, rotation]));
  for (const task of tasks) {
    if (!senseIds.has(task.senseId) || task.id !== recognitionTaskId(task.senseId)) {
      throw new HttpError(400, 'VALIDATION', 'A task must name its own recognition id.');
    }
    const donor = cardsById.get(task.donorCardId);
    if (!donor || donor.senseId !== task.senseId || !activeByDonor.has(task.donorCardId)) {
      throw new HttpError(400, 'VALIDATION', 'A task donor must be one of its cards.');
    }
    const rotation = rotationByTask.get(task.id);
    const occurrence = occurrences.find((item) => item.id === rotation?.occurrenceId);
    if (!rotation || !occurrence || occurrence.senseId !== task.senseId || !occurrenceIds.has(rotation.occurrenceId)) {
      throw new HttpError(400, 'VALIDATION', 'A rotation must name a sentence of its sense.');
    }
    const backed = new Set(
      members
        .filter((member) => member.taskId === task.id)
        .map((member) => cardsById.get(member.cardId)?.occurrenceId)
        .filter((id): id is string => typeof id === 'string'),
    );
    if (!backed.has(rotation.occurrenceId)) {
      throw new HttpError(400, 'VALIDATION', 'A rotation must name a sentence that has a card.');
    }
  }
  if (members.length !== cards.length) {
    throw new HttpError(400, 'VALIDATION', 'Every card belongs to one recognition task.');
  }
  for (const member of members) {
    const card = cardsById.get(member.cardId);
    const task = taskById.get(member.taskId);
    if (!card || !task || task.senseId !== card.senseId) {
      throw new HttpError(400, 'VALIDATION', 'A task member points at a missing card.');
    }
  }
  for (const legacy of legacySchedules) {
    if (!cardsById.has(legacy.cardId)) {
      throw new HttpError(400, 'VALIDATION', 'A legacy schedule points at a missing card.');
    }
  }
  for (const event of reviewEvents) {
    const card = cardsById.get(event.cardId);
    if (!card) {
      continue;
    }
    const taskId = recognitionTaskId(card.senseId);
    if (event.taskId !== null && event.taskId !== taskId) {
      throw new HttpError(400, 'VALIDATION', 'A review event names a different task.');
    }
    if (event.occurrenceId !== null && event.occurrenceId !== card.occurrenceId) {
      throw new HttpError(400, 'VALIDATION', 'A review event names a different sentence.');
    }
  }
}

function parseArray<T>(value: unknown, field: string, parse: (value: unknown, index: number) => T): T[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'VALIDATION', `${field} must be an array.`);
  }
  return value.map((item, index) => parse(item, index));
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new HttpError(400, 'VALIDATION', `Duplicate ${label} in backup.`);
  }
}

function parseSense(value: unknown, index: number): SenseJson {
  const record = objectAt(value, `senses[${index}]`);
  assertOnlyKeys(record, ['id', 'lemma', 'partOfSpeech', 'meaning', 'createdAt'], `senses[${index}]`);
  return {
    id: assertUuid(record.id, `senses[${index}].id`),
    lemma: assertText(record.lemma, `senses[${index}].lemma`, 200),
    partOfSpeech: assertText(record.partOfSpeech, `senses[${index}].partOfSpeech`, 64),
    meaning: assertText(record.meaning, `senses[${index}].meaning`, 2000),
    createdAt: assertIso(record.createdAt, `senses[${index}].createdAt`),
  };
}

function parseOccurrence(value: unknown, index: number): OccurrenceJson {
  const record = objectAt(value, `occurrences[${index}]`);
  assertOnlyKeys(
    record,
    ['id', 'senseId', 'sentence', 'sentenceTranslation', 'eqbank', 'createdAt'],
    `occurrences[${index}]`,
  );
  return {
    id: assertUuid(record.id, `occurrences[${index}].id`),
    senseId: assertUuid(record.senseId, `occurrences[${index}].senseId`),
    sentence: assertText(record.sentence, `occurrences[${index}].sentence`, 4000),
    sentenceTranslation: assertOptionalText(record.sentenceTranslation, `occurrences[${index}].sentenceTranslation`, 4000),
    eqbank: parseEqbank(record.eqbank, `occurrences[${index}].eqbank`),
    createdAt: assertIso(record.createdAt, `occurrences[${index}].createdAt`),
  };
}

function parseCard(value: unknown, index: number): CardJson {
  const record = objectAt(value, `cards[${index}]`);
  assertOnlyKeys(record, ['id', 'senseId', 'occurrenceId', 'createdAt', 'revision'], `cards[${index}]`);
  return {
    id: assertUuid(record.id, `cards[${index}].id`),
    senseId: assertUuid(record.senseId, `cards[${index}].senseId`),
    occurrenceId: assertUuid(record.occurrenceId, `cards[${index}].occurrenceId`),
    createdAt: assertIso(record.createdAt, `cards[${index}].createdAt`),
    revision: assertInteger(record.revision, `cards[${index}].revision`, 1),
  };
}

function parseSchedule(value: unknown, index: number, field = 'schedules'): ScheduleJson {
  const label = `${field}[${index}]`;
  const record = objectAt(value, label);
  assertOnlyKeys(
    record,
    [
      'cardId',
      'due',
      'stability',
      'difficulty',
      'elapsedDays',
      'scheduledDays',
      'learningSteps',
      'reps',
      'lapses',
      'state',
      'lastReview',
      'revision',
      'updatedAt',
    ],
    label,
  );
  if (typeof record.state !== 'string' || !isStateName(record.state)) {
    throw new HttpError(400, 'VALIDATION', `${label}.state is invalid.`);
  }
  return {
    cardId: assertUuid(record.cardId, `${label}.cardId`),
    due: assertIso(record.due, `${label}.due`),
    stability: assertFiniteNumber(record.stability, `${label}.stability`),
    difficulty: assertFiniteNumber(record.difficulty, `${label}.difficulty`),
    elapsedDays: assertInteger(record.elapsedDays, `${label}.elapsedDays`, 0),
    scheduledDays: assertInteger(record.scheduledDays, `${label}.scheduledDays`, 0),
    learningSteps: assertInteger(record.learningSteps, `${label}.learningSteps`, 0),
    reps: assertInteger(record.reps, `${label}.reps`, 0),
    lapses: assertInteger(record.lapses, `${label}.lapses`, 0),
    state: record.state,
    lastReview: record.lastReview === null ? null : assertIso(record.lastReview, `${label}.lastReview`),
    revision: assertInteger(record.revision, `${label}.revision`, 1),
    updatedAt: assertIso(record.updatedAt, `${label}.updatedAt`),
  };
}

function parseTask(value: unknown, index: number): TaskJson {
  const label = `tasks[${index}]`;
  const record = objectAt(value, label);
  assertOnlyKeys(record, ['id', 'senseId', 'taskType', 'policy', 'donorCardId', 'createdAt'], label);
  if (record.taskType !== 'recognition') {
    throw new HttpError(400, 'VALIDATION', `${label}.taskType is not supported.`);
  }
  if (record.policy !== TASK_POLICY) {
    throw new HttpError(400, 'VALIDATION', `${label}.policy is not supported.`);
  }
  const senseId = assertUuid(record.senseId, `${label}.senseId`);
  return {
    id: assertTaskId(record.id, `${label}.id`, senseId),
    senseId,
    taskType: 'recognition',
    policy: TASK_POLICY,
    donorCardId: assertUuid(record.donorCardId, `${label}.donorCardId`),
    createdAt: assertIso(record.createdAt, `${label}.createdAt`),
  };
}

function parseMember(value: unknown, index: number): MemberJson {
  const label = `members[${index}]`;
  const record = objectAt(value, label);
  assertOnlyKeys(record, ['taskId', 'cardId'], label);
  return {
    taskId: assertTaskId(record.taskId, `${label}.taskId`),
    cardId: assertUuid(record.cardId, `${label}.cardId`),
  };
}

function parseRotation(value: unknown, index: number): RotationJson {
  const label = `rotations[${index}]`;
  const record = objectAt(value, label);
  assertOnlyKeys(record, ['taskId', 'occurrenceId'], label);
  return {
    taskId: assertTaskId(record.taskId, `${label}.taskId`),
    occurrenceId: assertUuid(record.occurrenceId, `${label}.occurrenceId`),
  };
}

function assertTaskId(value: unknown, field: string, senseId?: string): string {
  const expected = senseId ? recognitionTaskId(senseId) : '';
  if (typeof value !== 'string' || !value.startsWith('recognition:') || (senseId && value !== expected)) {
    throw new HttpError(400, 'VALIDATION', `${field} is invalid.`);
  }
  const sense = value.slice('recognition:'.length);
  if (!UUID.test(sense)) {
    throw new HttpError(400, 'VALIDATION', `${field} is invalid.`);
  }
  return value;
}

function parseEvent(value: unknown, index: number, linked: boolean): ReviewEventJson {
  const label = `reviewEvents[${index}]`;
  const record = objectAt(value, label);
  assertOnlyKeys(
    record,
    [
      'id',
      'cardId',
      'grade',
      'affectsSchedule',
      'reviewedAt',
      'clientRequestId',
      'dueBefore',
      'dueAfter',
      'stateBefore',
      'stateAfter',
      'scheduleRevisionBefore',
      'scheduleRevisionAfter',
      'stabilityBefore',
      'stabilityAfter',
      'difficultyBefore',
      'difficultyAfter',
      'scheduledDaysBefore',
      'scheduledDaysAfter',
      'repsAfter',
      'lapsesAfter',
      'elapsedDaysAfter',
      'learningStepsAfter',
      'createdAt',
      ...(linked ? (['taskId', 'occurrenceId'] as const) : []),
    ],
    label,
  );
  if (typeof record.grade !== 'string' || !isGradeName(record.grade)) {
    throw new HttpError(400, 'VALIDATION', `${label}.grade is invalid.`);
  }
  const stateBefore = parseStateField(record.stateBefore, `${label}.stateBefore`);
  const stateAfter = parseStateField(record.stateAfter, `${label}.stateAfter`);
  const before = assertInteger(record.scheduleRevisionBefore, `${label}.scheduleRevisionBefore`, 1);
  const after = assertInteger(record.scheduleRevisionAfter, `${label}.scheduleRevisionAfter`, 1);
  const affectsSchedule = assertBoolean(record.affectsSchedule, `${label}.affectsSchedule`);
  if (affectsSchedule && after !== before + 1) {
    throw new HttpError(400, 'VALIDATION', `${label} schedule revision must advance by one when it affects the schedule.`);
  }
  if (!affectsSchedule && after !== before) {
    throw new HttpError(400, 'VALIDATION', `${label} schedule revision must stay put for a practice review.`);
  }
  const clientRequestId = record.clientRequestId;
  if (typeof clientRequestId !== 'string' || !IDEMPOTENCY.test(clientRequestId)) {
    throw new HttpError(400, 'VALIDATION', `${label}.clientRequestId is invalid.`);
  }
  return {
    id: assertUuid(record.id, `${label}.id`),
    cardId: assertUuid(record.cardId, `${label}.cardId`),
    grade: record.grade,
    affectsSchedule,
    reviewedAt: assertIso(record.reviewedAt, `${label}.reviewedAt`),
    clientRequestId,
    dueBefore: assertIso(record.dueBefore, `${label}.dueBefore`),
    dueAfter: assertIso(record.dueAfter, `${label}.dueAfter`),
    stateBefore,
    stateAfter,
    scheduleRevisionBefore: before,
    scheduleRevisionAfter: after,
    stabilityBefore: assertFiniteNumber(record.stabilityBefore, `${label}.stabilityBefore`),
    stabilityAfter: assertFiniteNumber(record.stabilityAfter, `${label}.stabilityAfter`),
    difficultyBefore: assertFiniteNumber(record.difficultyBefore, `${label}.difficultyBefore`),
    difficultyAfter: assertFiniteNumber(record.difficultyAfter, `${label}.difficultyAfter`),
    scheduledDaysBefore: assertInteger(record.scheduledDaysBefore, `${label}.scheduledDaysBefore`, 0),
    scheduledDaysAfter: assertInteger(record.scheduledDaysAfter, `${label}.scheduledDaysAfter`, 0),
    repsAfter: assertInteger(record.repsAfter, `${label}.repsAfter`, 0),
    lapsesAfter: assertInteger(record.lapsesAfter, `${label}.lapsesAfter`, 0),
    elapsedDaysAfter: assertInteger(record.elapsedDaysAfter, `${label}.elapsedDaysAfter`, 0),
    learningStepsAfter: assertInteger(record.learningStepsAfter, `${label}.learningStepsAfter`, 0),
    createdAt: assertIso(record.createdAt, `${label}.createdAt`),
    taskId: linked ? (record.taskId === null ? null : assertTaskId(record.taskId, `${label}.taskId`)) : null,
    occurrenceId: linked ? (record.occurrenceId === null ? null : assertUuid(record.occurrenceId, `${label}.occurrenceId`)) : null,
  };
}

function parseStateField(value: unknown, field: string): StateName {
  if (typeof value !== 'string' || !isStateName(value)) {
    throw new HttpError(400, 'VALIDATION', `${field} is invalid.`);
  }
  return value;
}

function objectAt(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HttpError(400, 'VALIDATION', `${label} must be an object.`);
  }
  return value;
}
