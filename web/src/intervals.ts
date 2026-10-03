import { scheduleAfterGrade, type StoredSchedule } from '../../src/scheduler.js';
import { GRADE_NAMES, type GradeName, type ScheduleJson } from '../../src/types.js';

export const GRADE_LABEL: Record<GradeName, string> = {
  again: '忘记',
  hard: '困难',
  good: '良好',
  easy: '简单',
};

export function formatInterval(from: Date, dueIso: string): string {
  const minutes = Math.round((Date.parse(dueIso) - from.getTime()) / 60000);
  if (minutes <= 1) {
    return '1 分钟';
  }
  if (minutes < 90) {
    return `${minutes} 分钟`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 36) {
    return `${hours} 小时`;
  }
  return `${Math.max(1, Math.round(hours / 24))} 天`;
}

export function gradeChoices(schedule: ScheduleJson, now = new Date()): Array<{ grade: GradeName; label: string; interval: string; due: string }> {
  const current = toStored(schedule);
  return GRADE_NAMES.map((grade) => {
    const next = scheduleAfterGrade(current, grade, now);
    return { grade, label: GRADE_LABEL[grade], interval: formatInterval(now, next.due), due: next.due };
  });
}

function toStored(schedule: ScheduleJson): StoredSchedule {
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
  };
}
