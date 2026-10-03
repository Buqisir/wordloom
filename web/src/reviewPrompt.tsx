export const reviewIntervalHint =
  '间隔用 FSRS 6 计算，程序包是 ts-fsrs 5.4.2，与服务器相同，模糊已关闭。点下去以后，以服务器保存的到期时间为准。';

export function RevealedTranslation({
  revealed,
  sentenceTranslation,
}: {
  revealed: boolean;
  sentenceTranslation: string | null;
}) {
  if (!revealed || !sentenceTranslation) {
    return null;
  }
  return <p className="meta">译文：{sentenceTranslation}</p>;
}
