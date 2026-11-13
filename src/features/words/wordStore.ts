import type { MasteryStatus, Word } from '../../types';
import { day1Words } from './seedDay1';

const STORAGE_KEY = 'tianchi.words';

const seedWords: Word[] = day1Words;

export function loadWords(): Word[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seedWords));
    return [...seedWords];
  }
  return JSON.parse(raw) as Word[];
}

export function saveWords(words: Word[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
}

export function addWord(input: { headword: string; meaningZh: string; source?: string }): Word {
  const word: Word = {
    id: crypto.randomUUID(),
    headword: input.headword,
    meaningZh: input.meaningZh,
    examples: [],
    collocations: [],
    mastery: 'passive',
    source: input.source,
    updatedAt: new Date().toISOString(),
  };
  saveWords([...loadWords(), word]);
  return word;
}

export function setMastery(id: string, mastery: MasteryStatus): Word[] {
  const words = loadWords().map((w) =>
    w.id === id ? { ...w, mastery, updatedAt: new Date().toISOString() } : w,
  );
  saveWords(words);
  return words;
}
