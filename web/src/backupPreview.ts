import { HttpError } from '../../src/errors.js';
import type { BackupDocument } from '../../src/types.js';
import { parseBackupDocument } from '../../src/validate.js';

export type RowCount = { fresh: number; same: number; conflict: number };

export type BackupPreview = {
  ok: boolean;
  message: string;
  document: BackupDocument | null;
  senses: RowCount;
  occurrences: RowCount;
  cards: RowCount;
  schedules: RowCount;
  reviewEvents: RowCount;
  sameSentence: number;
};

const emptyCount = { fresh: 0, same: 0, conflict: 0 };

export function previewBackup(raw: string, current: BackupDocument): BackupPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return blank('文件不是 JSON。');
  }
  try {
    const document = parseBackupDocument(parsed);
    return {
      ok: true,
      message: '校验通过。还没有写入账户。',
      document,
      senses: tally(current.senses, document.senses, (row) => row.id),
      occurrences: tally(current.occurrences, document.occurrences, (row) => row.id),
      cards: tally(current.cards, document.cards, (row) => row.id),
      schedules: tally(current.schedules, document.schedules, (row) => row.cardId),
      reviewEvents: tally(current.reviewEvents, document.reviewEvents, (row) => row.id),
      sameSentence: countSameSentence(current, document),
    };
  } catch (error) {
    if (error instanceof HttpError) {
      return blank(`${error.message}（${error.code}）`);
    }
    return blank('校验没有通过。');
  }
}

function blank(message: string): BackupPreview {
  return {
    ok: false,
    message,
    document: null,
    senses: emptyCount,
    occurrences: emptyCount,
    cards: emptyCount,
    schedules: emptyCount,
    reviewEvents: emptyCount,
    sameSentence: 0,
  };
}

function tally<T>(current: T[], incoming: T[], idOf: (row: T) => string): RowCount {
  const map = new Map(current.map((row) => [idOf(row), stable(row)]));
  const count = { fresh: 0, same: 0, conflict: 0 };
  for (const row of incoming) {
    const previous = map.get(idOf(row));
    if (previous === undefined) {
      count.fresh += 1;
    } else if (previous === stable(row)) {
      count.same += 1;
    } else {
      count.conflict += 1;
    }
  }
  return count;
}

function countSameSentence(current: BackupDocument, incoming: BackupDocument): number {
  let count = 0;
  for (const occurrence of incoming.occurrences) {
    const sense = incoming.senses.find((item) => item.id === occurrence.senseId);
    if (!sense) {
      continue;
    }
    const matched = current.occurrences.some((item) => {
      if (item.id === occurrence.id) {
        return false;
      }
      const existing = current.senses.find((candidate) => candidate.id === item.senseId);
      return existing?.lemma === sense.lemma && existing.meaning === sense.meaning && item.sentence === occurrence.sentence;
    });
    if (matched) {
      count += 1;
    }
  }
  return count;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stable(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}
