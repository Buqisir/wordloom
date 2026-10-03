export const BACKUP_SCHEMA_VERSION = 1;

export const STATE_NAMES = ['new', 'learning', 'review', 'relearning'] as const;
export type StateName = (typeof STATE_NAMES)[number];

export const GRADE_NAMES = ['again', 'hard', 'good', 'easy'] as const;
export type GradeName = (typeof GRADE_NAMES)[number];

export type EqbankMeta = {
  itemId: string | null;
  source: string | null;
  locator: string | null;
};

export type SenseJson = {
  id: string;
  lemma: string;
  partOfSpeech: string;
  meaning: string;
  createdAt: string;
};

export type OccurrenceJson = {
  id: string;
  senseId: string;
  sentence: string;
  sentenceTranslation: string | null;
  eqbank: EqbankMeta | null;
  createdAt: string;
};

export type CardJson = {
  id: string;
  senseId: string;
  occurrenceId: string;
  createdAt: string;
  revision: number;
};

export type ScheduleJson = {
  cardId: string;
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: StateName;
  lastReview: string | null;
  revision: number;
  updatedAt: string;
};

export type ReviewEventJson = {
  id: string;
  cardId: string;
  grade: GradeName;
  affectsSchedule: boolean;
  reviewedAt: string;
  clientRequestId: string;
  dueBefore: string;
  dueAfter: string;
  stateBefore: StateName;
  stateAfter: StateName;
  scheduleRevisionBefore: number;
  scheduleRevisionAfter: number;
  stabilityBefore: number;
  stabilityAfter: number;
  difficultyBefore: number;
  difficultyAfter: number;
  scheduledDaysBefore: number;
  scheduledDaysAfter: number;
  repsAfter: number;
  lapsesAfter: number;
  elapsedDaysAfter: number;
  learningStepsAfter: number;
  createdAt: string;
};

export type ItemJson = {
  card: CardJson;
  sense: SenseJson;
  occurrence: OccurrenceJson;
  schedule: ScheduleJson;
};

export type BackupDocument = {
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  exportedAt: string;
  progressRevision: number;
  senses: SenseJson[];
  occurrences: OccurrenceJson[];
  cards: CardJson[];
  schedules: ScheduleJson[];
  reviewEvents: ReviewEventJson[];
};

export type ApiResult = {
  status: number;
  body: unknown;
  replayed: boolean;
};

export type UserJson = {
  id: string;
  email: string;
  progressRevision: number;
};

export type SessionRecord = {
  id: string;
  userId: string;
  csrfTokenHash: string;
  expiresAt: string;
};
