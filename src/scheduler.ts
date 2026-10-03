import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs';
import { HttpError } from './errors.js';
import { GRADE_NAMES, STATE_NAMES, type GradeName, type ScheduleJson, type StateName } from './types.js';

const scheduler = fsrs({ enable_fuzz: false });

const GRADE_TO_RATING: Record<GradeName, Grade> = {
  again: Rating.Again as Grade,
  hard: Rating.Hard as Grade,
  good: Rating.Good as Grade,
  easy: Rating.Easy as Grade,
};

export function isGradeName(value: string): value is GradeName {
  return (GRADE_NAMES as readonly string[]).includes(value);
}

export function isStateName(value: string): value is StateName {
  return (STATE_NAMES as readonly string[]).includes(value);
}

export function stateName(value: number): StateName {
  const name = STATE_NAMES[value];
  if (!name) {
    throw new HttpError(500, 'BAD_SCHEDULE', 'Stored schedule state is invalid.');
  }
  return name;
}

export function stateValue(name: StateName): State {
  return STATE_NAMES.indexOf(name) as State;
}

export type StoredSchedule = {
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
};

export function emptySchedule(now: Date): StoredSchedule {
  return fromCard(createEmptyCard(now));
}

export function scheduleAfterGrade(current: StoredSchedule, grade: GradeName, now: Date): StoredSchedule {
  const card = toCard(current);
  const next = scheduler.next(cloneCard(card), now, GRADE_TO_RATING[grade]);
  return fromCard(next.card);
}

export function toScheduleJson(cardId: string, schedule: StoredSchedule, revision: number, updatedAt: string): ScheduleJson {
  return {
    cardId,
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
    revision,
    updatedAt,
  };
}

function cloneCard(card: Card): Card {
  return {
    ...card,
    due: new Date(card.due.getTime()),
    last_review: card.last_review ? new Date(card.last_review.getTime()) : undefined,
  };
}

function toCard(schedule: StoredSchedule): Card {
  return {
    due: new Date(schedule.due),
    stability: schedule.stability,
    difficulty: schedule.difficulty,
    elapsed_days: schedule.elapsedDays,
    scheduled_days: schedule.scheduledDays,
    learning_steps: schedule.learningSteps,
    reps: schedule.reps,
    lapses: schedule.lapses,
    state: stateValue(schedule.state),
    last_review: schedule.lastReview ? new Date(schedule.lastReview) : undefined,
  };
}

function fromCard(card: Card): StoredSchedule {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: stateName(card.state),
    lastReview: card.last_review ? card.last_review.toISOString() : null,
  };
}
