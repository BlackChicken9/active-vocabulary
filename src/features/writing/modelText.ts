import type { Word, WritingTask } from '../../types';

export interface ModelText {
  text: string;
  wordIds: string[];
}

/** mock 版示范短文：把每个目标词的例句串成一段。A2 换成 LLM 按题干现写。 */
export function generateModelText(task: WritingTask, words: Word[]): ModelText {
  const targets = task.targetWordIds
    .map((id) => words.find((w) => w.id === id))
    .filter((word): word is Word => word !== undefined);
  const sentences = targets.map(
    (word) =>
      word.examples[0] ??
      `I can reuse the whole chunk "${word.collocations[0]?.phrase ?? word.headword}".`,
  );
  return {
    text: [
      `A model answer for “${task.title}”:`,
      ...sentences,
      '[mock] 接入真实 LLM 后这段会按题干现写，并把你的目标词嵌进去。',
    ].join(' '),
    wordIds: targets.map((word) => word.id),
  };
}
