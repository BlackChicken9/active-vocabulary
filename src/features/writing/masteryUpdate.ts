import type { Feedback, MasteryStatus } from '../../types';
import { loadWords, setMastery } from '../words/wordStore';

export interface MasteryChange {
  headword: string;
  from: MasteryStatus;
  to: MasteryStatus;
}

const ladder: MasteryStatus[] = ['passive', 'training', 'active'];

/** 反馈 → 词本掌握度回写：只升不降，用出且搭配地道才推进到「会用」。 */
export function advanceMastery(feedback: Feedback): MasteryChange[] {
  const words = loadWords();
  const changes: MasteryChange[] = [];
  for (const usage of feedback.usages) {
    const word = words.find((w) => w.id === usage.wordId);
    if (!word || !usage.used) continue;
    const to: MasteryStatus = usage.natural ? 'active' : 'training';
    if (ladder.indexOf(to) <= ladder.indexOf(word.mastery)) continue;
    setMastery(word.id, to);
    changes.push({ headword: word.headword, from: word.mastery, to });
  }
  return changes;
}
