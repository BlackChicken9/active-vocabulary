import type { LengthChoice, PassageLength, WritingTask } from '../../types';
import { splitSentences } from './passage';

export const LENGTH_OPTIONS: { id: LengthChoice; label: string; hint: string }[] = [
  { id: 'auto', label: '自动', hint: '按词数' },
  { id: 'short', label: '简短', hint: '2~3 句' },
  { id: 'medium', label: '适中', hint: '4~6 句' },
  { id: 'long', label: '详尽', hint: '7~10 句' },
];

const PRESETS: Record<Exclude<LengthChoice, 'auto'>, PassageLength> = {
  short: { minSentences: 2, maxSentences: 3, minWords: 30, maxWords: 60 },
  medium: { minSentences: 4, maxSentences: 6, minWords: 60, maxWords: 110 },
  long: { minSentences: 7, maxSentences: 10, minWords: 100, maxWords: 180 },
};

/** 自动档：一个词至少摊到一句，最多多一句把场景收尾；每句按 12~16 词估，别让两段词写成小作文。 */
export function passageSpec(choice: LengthChoice, wordCount: number): PassageLength {
  if (choice !== 'auto') return PRESETS[choice];
  const minSentences = Math.min(8, Math.max(2, wordCount));
  const maxSentences = minSentences + 1;
  return {
    minSentences,
    maxSentences,
    minWords: minSentences * 12,
    maxWords: maxSentences * 16,
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
