import type { LengthChoice, PassageLength, WritingTask } from '../../types';
import { splitSentences } from './passage';

export const LENGTH_OPTIONS: { id: LengthChoice; label: string; hint: string }[] = [
  { id: 'auto', label: '自动', hint: '按词数' },
  { id: 'short', label: '短', hint: '3~4 句' },
  { id: 'medium', label: '中', hint: '5~7 句' },
  { id: 'long', label: '长', hint: '8~12 句' },
];

const PRESETS: Record<Exclude<LengthChoice, 'auto'>, PassageLength> = {
  short: { minSentences: 3, maxSentences: 4, minWords: 50, maxWords: 90 },
  medium: { minSentences: 5, maxSentences: 7, minWords: 90, maxWords: 160 },
  long: { minSentences: 8, maxSentences: 12, minWords: 130, maxWords: 260 },
};

/** 自动档：一个词至少摊到一句，再多一句收尾；每句按 15~22 词估——句子长一点，逻辑推进才有地方放。 */
export function passageSpec(choice: LengthChoice, wordCount: number): PassageLength {
  if (choice !== 'auto') return PRESETS[choice];
  const minSentences = Math.min(9, Math.max(3, wordCount + 1));
  const maxSentences = minSentences + 1;
  return {
    minSentences,
    maxSentences,
    minWords: minSentences * 15,
    maxWords: maxSentences * 22,
  };
}

export function taskLength(task: WritingTask): PassageLength {
  return task.length ?? passageSpec('auto', task.targetWordIds.length);
}

export function lengthLine(spec: PassageLength): string {
  return `${spec.minSentences}~${spec.maxSentences} 句 · 约 ${spec.minWords}~${spec.maxWords} 词`;
}

export function sameSpec(a: PassageLength, b: PassageLength): boolean {
  return (
    a.minSentences === b.minSentences &&
    a.maxSentences === b.maxSentences &&
    a.minWords === b.minWords &&
    a.maxWords === b.maxWords
  );
}

export function countSentences(text: string): number {
  return splitSentences(text).length;
}

export type LengthState = 'short' | 'ok' | 'over';

export function lengthState(spec: PassageLength, sentences: number, words: number): LengthState {
  if (sentences < spec.minSentences || words < spec.minWords) return 'short';
  if (sentences > spec.maxSentences || words > spec.maxWords) return 'over';
  return 'ok';
}

export const LENGTH_STATE_ZH: Record<LengthState, string> = {
  short: '偏短',
  ok: '篇幅达标',
  over: '偏长',
};
