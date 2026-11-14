import type { Word, WritingTask } from '../../types';
import { taskLength } from './passageLength';

export interface ModelText {
  text: string;
  wordIds: string[];
}

function chunkOf(word: Word): string {
  return word.collocations[0]?.phrase ?? word.headword;
}

/** 兜底帧把词块整块引起来：词性不明时也不会造出 "I ubiquitous" 这种病句。 */
const FRAMES: ((chunk: string) => string)[] = [
  (chunk) => `I kept a small card for "${chunk}" and reread it twice before starting today's draft in class.`,
  (chunk) => `Today my draft finally uses "${chunk}" in the exact place where it actually belongs.`,
  (chunk) => `Using "${chunk}" inside a real sentence feels much easier now than it did last week.`,
  (chunk) => `My study partner circled "${chunk}" and said the collocation now sounds completely natural to her.`,
  (chunk) => `Once "${chunk}" appears naturally in the opening line, the whole paragraph holds together much better.`,
  (chunk) => `I plan to reuse "${chunk}" in tomorrow's journal entry so that it stays active for longer.`,
];

function sentenceFor(index: number, word: Word): string {
  return word.examples.length
    ? word.examples[index % word.examples.length]
    : FRAMES[index % FRAMES.length](chunkOf(word));
}

/** mock 版示范短文：按任务篇幅拼句，优先用词卡例句；A2 换成 LLM 按题干现写。 */
export function generateModelText(task: WritingTask, words: Word[]): ModelText {
  const targets = task.targetWordIds
    .map((id) => words.find((w) => w.id === id))
    .filter((word): word is Word => word !== undefined);
  if (!targets.length) return { text: '', wordIds: [] };
  const spec = taskLength(task);
  const sentences = targets.map((word, index) => sentenceFor(index, word));
  while (sentences.length < spec.minSentences) {
    const word = targets[sentences.length % targets.length];
    sentences.push(FRAMES[sentences.length % FRAMES.length](chunkOf(word)));
  }
  while (sentences.length > spec.maxSentences) {
    const last = sentences.pop()!;
    const prev = sentences.pop()!;
    sentences.push(`${prev.replace(/[.!?]$/, '')}, and ${last.charAt(0).toLowerCase()}${last.slice(1)}`);
  }
  return { text: sentences.join(' '), wordIds: targets.map((word) => word.id) };
}
