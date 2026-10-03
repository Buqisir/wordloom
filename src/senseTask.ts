import type { ScheduleJson, StateName } from './types.js';
import { TASK_POLICY } from './types.js';

export const RECOGNITION = 'recognition' as const;

export type ScheduleTuple = {
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

export type PlanCard = {
  cardId: string;
  senseId: string;
  occurrenceId: string;
  occurrenceCreatedAt: string;
  schedule: ScheduleTuple;
};

export type PlanOccurrence = {
  id: string;
  senseId: string;
  createdAt: string;
};

export type SenseTaskPlan = {
  taskId: string;
  senseId: string;
  taskType: typeof RECOGNITION;
  policy: typeof TASK_POLICY;
  donorCardId: string;
  createdAt: string;
  memberCardIds: string[];
  legacy: ScheduleJson[];
  active: ScheduleJson;
  rotationOccurrenceId: string;
};

export function recognitionTaskId(senseId: string): string {
  return `${RECOGNITION}:${senseId}`;
}

export function isRecognitionTaskId(value: string, senseId: string): boolean {
  return value === recognitionTaskId(senseId);
}

export function planRecognitionTasks(input: {
  cards: PlanCard[];
  occurrences: PlanOccurrence[];
  floors: Array<{ cardId: string; highWater: number }>;
  events: Array<{ cardId: string; scheduleRevisionBefore: number; scheduleRevisionAfter: number }>;
  senseCreatedAt: ReadonlyMap<string, string>;
}): SenseTaskPlan[] {
  const floors = new Map(input.floors.map((floor) => [floor.cardId, floor.highWater]));
  const bySense = new Map<string, PlanCard[]>();
  for (const card of input.cards) {
    const group = bySense.get(card.senseId);
    if (group) {
      group.push(card);
    } else {
      bySense.set(card.senseId, [card]);
    }
  }
  const senseIds = [...bySense.keys()].sort();
  return senseIds.map((senseId) => {
    const cards = bySense.get(senseId) ?? [];
    const donor = [...cards].sort(compareDonor)[0];
    if (!donor) {
      throw new Error(`Sense ${senseId} has no schedule to seed.`);
    }
    const memberIds = new Set(cards.map((card) => card.cardId));
    let historical = 0;
    for (const card of cards) {
      historical = Math.max(historical, card.schedule.revision, floors.get(card.cardId) ?? 0);
    }
    for (const event of input.events) {
      if (!memberIds.has(event.cardId)) {
        continue;
      }
      historical = Math.max(historical, event.scheduleRevisionBefore, event.scheduleRevisionAfter);
    }
    const createdAtByOccurrence = new Map(
      input.occurrences.filter((occurrence) => occurrence.senseId === senseId).map((occurrence) => [occurrence.id, occurrence.createdAt]),
    );
    const backed = new Map<string, string>();
    for (const card of cards) {
      if (!backed.has(card.occurrenceId)) {
        backed.set(card.occurrenceId, createdAtByOccurrence.get(card.occurrenceId) ?? card.occurrenceCreatedAt);
      }
    }
    const contexts = [...backed.entries()].map(([id, createdAt]) => ({ id, createdAt })).sort(compareContext);
    const rotation = contexts[0];
    if (!rotation) {
      throw new Error(`Sense ${senseId} has no card-backed source sentence.`);
    }
    const createdAt = input.senseCreatedAt.get(senseId);
    if (!createdAt) {
      throw new Error(`Sense ${senseId} has no created time.`);
    }
    return {
      taskId: recognitionTaskId(senseId),
      senseId,
      taskType: RECOGNITION,
      policy: TASK_POLICY,
      donorCardId: donor.cardId,
      createdAt,
      memberCardIds: [...memberIds].sort(),
      legacy: cards.map((card) => toScheduleJson(card)).sort((left, right) => left.cardId.localeCompare(right.cardId)),
      active: {
        ...toScheduleJson(donor),
        revision: historical + 1,
      },
      rotationOccurrenceId: rotation.id,
    };
  });
}

export function nextContextId(contexts: Array<{ id: string; createdAt: string }>, currentId: string): string {
  const ordered = [...contexts].sort(compareContext);
  if (ordered.length === 0) {
    throw new Error('A recognition task has no source sentence.');
  }
  const index = ordered.findIndex((context) => context.id === currentId);
  const next = index === -1 ? 0 : (index + 1) % ordered.length;
  return ordered[next]?.id ?? ordered[0].id;
}

export function installedRevision(mode: 'recognition-v1' | 'explicit-v2', planned: number, serverFloor: number): number {
  if (mode === 'recognition-v1') {
    return serverFloor > 0 ? Math.max(planned, serverFloor + 1) : planned;
  }
  return Math.max(planned, serverFloor) + 1;
}

function toScheduleJson(card: PlanCard): ScheduleJson {
  return {
    cardId: card.cardId,
    due: card.schedule.due,
    stability: card.schedule.stability,
    difficulty: card.schedule.difficulty,
    elapsedDays: card.schedule.elapsedDays,
    scheduledDays: card.schedule.scheduledDays,
    learningSteps: card.schedule.learningSteps,
    reps: card.schedule.reps,
    lapses: card.schedule.lapses,
    state: card.schedule.state,
    lastReview: card.schedule.lastReview,
    revision: card.schedule.revision,
    updatedAt: card.schedule.updatedAt,
  };
}

function compareDonor(left: PlanCard, right: PlanCard): number {
  if (left.schedule.due < right.schedule.due) {
    return -1;
  }
  if (left.schedule.due > right.schedule.due) {
    return 1;
  }
  return left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0;
}

function compareContext(left: { id: string; createdAt: string }, right: { id: string; createdAt: string }): number {
  if (left.createdAt < right.createdAt) {
    return -1;
  }
  if (left.createdAt > right.createdAt) {
    return 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
