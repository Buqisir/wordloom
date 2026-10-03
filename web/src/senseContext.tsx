import type { ItemJson } from '../../src/types.js';

export function ReviewContextNotes({ item, revealed }: { item: ItemJson; revealed: boolean }) {
  const contexts = item.contexts ?? [];
  const total = Math.max(item.contextCount || contexts.length, 1);
  const index = contexts.findIndex((context) => context.id === item.occurrence.id);
  const position = index >= 0 ? index + 1 : 1;
  const others = contexts.filter((context) => context.id !== item.occurrence.id);
  return (
    <div className="context-notes">
      <p className="meta">原句 {position}/{total}</p>
      {revealed
        ? others.map((context) => (
            <div key={context.id}>
              <p className="sentence">{context.sentence}</p>
              {context.sentenceTranslation ? <p className="meta">译文：{context.sentenceTranslation}</p> : null}
            </div>
          ))
        : null}
    </div>
  );
}
