import type { Feedback, MasteryStatus } from '../../types';
import { loadWords, setMastery } from '../words/wordStore';

export interface MasteryChange {
  headword: string;
  from: MasteryStatus;
  to: MasteryStatus;
}

const ladder: MasteryStatus[] = ['passive', 'training', 'active'];

function upgrade(wordId: string, to: MasteryStatus): MasteryChange | null {
  const word = loadWords().find((w) => w.id === wordId);
  if (!word || ladder.indexOf(to) <= ladder.indexOf(word.mastery)) return null;
  setMastery(word.id, to);
  return { headword: word.headword, from: word.mastery, to };
}

/** 反馈 → 词本掌握度回写：只升不降，用出且搭配地道才推进到「会用」。 */
export function advanceMastery(feedback: Feedback): MasteryChange[] {
  const changes: MasteryChange[] = [];
  for (const usage of feedback.usages) {
    if (!usage.used) continue;
    const change = upgrade(usage.wordId, usage.natural ? 'active' : 'training');
    if (change) changes.push(change);
  }
  return changes;
}

/** 读完 AI 示范 → 最多推到「练用中」：没亲手写出来不算「会用」。 */
export function markTraining(wordIds: string[]): MasteryChange[] {
  const changes: MasteryChange[] = [];
  for (const id of wordIds) {
    const change = upgrade(id, 'training');
    if (change) changes.push(change);
  }
  return changes;
}
