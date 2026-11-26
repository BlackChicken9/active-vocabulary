import type { Word } from '../../types';
import { loadWords, saveWords } from './wordStore';
import { requestIntake, type IntakeCard } from '../writing/aiClient';

export interface IntakeOutcome {
  added: Word[];
  /** 词库里已有的词头，不重复入库，但要告诉用户跳过了哪些。 */
  skipped: string[];
  degraded: string | null;
}

function toWord(card: IntakeCard): Word {
  return {
    id: crypto.randomUUID(),
    headword: card.headword,
    pos: card.pos || undefined,
    phonetic: card.phonetic || undefined,
    meaningZh: card.meaningZh,
    examples: card.examples,
    collocations: card.collocations,
    mastery: 'passive',
    source: card.theme ? `粘贴导入 · ${card.theme}` : '粘贴导入',
    updatedAt: new Date().toISOString(),
  };
}

export async function importWords(raw: string): Promise<IntakeOutcome> {
  const { data, degraded } = await requestIntake(raw);
  const existing = loadWords();
  const seen = new Set(existing.map((word) => word.headword.toLowerCase()));
  const added: Word[] = [];
  const skipped: string[] = [];
  for (const card of data) {
    const key = card.headword.toLowerCase();
    if (seen.has(key)) {
      skipped.push(card.headword);
      continue;
    }
    seen.add(key);
    added.push(toWord(card));
  }
  if (added.length) saveWords([...existing, ...added]);
  return { added, skipped, degraded };
}
