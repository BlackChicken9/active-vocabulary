import type { Feedback, Submission, Word, WordUsage, WritingTask } from '../../types';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isUsed(word: Word, text: string): boolean {
  const stem = word.headword.length > 5 ? word.headword.slice(0, 5) : word.headword;
  return new RegExp(`\\b${escapeRegExp(stem)}\\w*`, 'i').test(text);
}

export function generateMockFeedback(
  task: WritingTask,
  submission: Submission,
  words: Word[],
): Feedback {
  const targetWords = words.filter((w) => task.targetWordIds.includes(w.id));
  const usages: WordUsage[] = targetWords.map((word) => {
    const used = isUsed(word, submission.text);
    const natural = used && word.collocations.length > 0;
    const note = used
      ? `已使用「${word.headword}」${natural ? `，建议继续套进固定搭配「${word.collocations[0].phrase}」` : ''}。`
      : `本篇未用到「${word.headword}」。下一步：先用它造一句独立的话，再嵌入段落。`;
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
    overall: `[mock] ${usedCount}/${usages.length} 个目标词被主动用出。接入真实 LLM 后此文案为作文点评。`,
    updatedAt: new Date().toISOString(),
  };
}
