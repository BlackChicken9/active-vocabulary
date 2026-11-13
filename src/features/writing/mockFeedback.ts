import type { Feedback, Submission, Word, WordUsage, WritingTask } from '../../types';

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'one',
  'some',
  'sth',
  'sb',
  'of',
  'to',
  'be',
  'do',
  'in',
  'on',
  'at',
  'with',
  'and',
  'or',
  'for',
  'as',
  'by',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stem(word: Word): string {
  return word.headword.length > 5 ? word.headword.slice(0, 5) : word.headword;
}

function isUsed(word: Word, text: string): boolean {
  return new RegExp(`\\b${escapeRegExp(stem(word))}\\w*`, 'i').test(text);
}

/** 词干后允许词形变化、标点，以及最多一个插入词：alleviate (daily) stress 命中，alleviate a lot of stress 不命中。 */
const GAP = String.raw`\w*\W+(?:\w+\W+)?`;

/** 搭配命中 = 词干 + 搭配实义词紧挨着出现，用于 mock 阶段的「地道」判定。 */
function isCollocated(word: Word, text: string): boolean {
  const headword = word.headword.toLowerCase();
  return word.collocations.some((collocation) =>
    collocation.phrase
      .split(/[/;]/)
      .some((variant) => {
        const tokens = variant
          .toLowerCase()
          .split(/[^a-z]+/)
          .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
        const phrase = tokens.includes(headword) ? tokens : [headword, ...tokens];
        if (phrase.length < 2) return false;
        const pattern = phrase
          .map((token) => (token === headword ? stem(word) : token))
          .map(escapeRegExp)
          .join(GAP);
        return new RegExp(`\\b${pattern}\\w*`, 'i').test(text);
      }),
  );
}

export function generateMockFeedback(
  task: WritingTask,
  submission: Submission,
  words: Word[],
): Feedback {
  const targetWords = words.filter((w) => task.targetWordIds.includes(w.id));
  const usages: WordUsage[] = targetWords.map((word) => {
    const used = isUsed(word, submission.text);
    const natural = used && isCollocated(word, submission.text);
    const collocation = word.collocations[0]?.phrase;
    const note = !used
      ? `本篇未用到「${word.headword}」。下一步：先用它造一句独立的话，再嵌进段落。`
      : natural
        ? `已用出「${word.headword}」，且命中搭配「${collocation}」，本篇计入会用。`
        : `已用出「${word.headword}」，但没出现搭配「${collocation ?? word.headword}」，先记为练用中。`;
    return { wordId: word.id, used, natural, note };
  });
  const usedCount = usages.filter((u) => u.used).length;
  const naturalCount = usages.filter((u) => u.natural).length;
  const accuracy =
    usages.length === 0 ? 0 : Math.round(((usedCount + naturalCount) / (2 * usages.length)) * 100);
  return {
    taskId: task.id,
    submittedText: submission.text,
    usages,
    accuracy,
    overall: `[mock] ${usedCount}/${usages.length} 个目标词被主动用出，其中 ${naturalCount} 个用对了搭配。接入真实 LLM 后此文案为作文点评。`,
    updatedAt: new Date().toISOString(),
  };
}
