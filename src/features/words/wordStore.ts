import type { MasteryStatus, Word } from '../../types';

const STORAGE_KEY = 'tianchi.words';

/** 词库不预设内容：首屏是空的，词全部来自用户自己粘贴导入。 */
export function loadWords(): Word[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Word[]) : [];
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

/** 词卡页补搭配和例句用的局部改写，不动词头和掌握度。 */
export function editWord(
  id: string,
  patch: Partial<Pick<Word, 'examples' | 'collocations'>>,
): Word[] {
  const words = loadWords().map((w) =>
    w.id === id ? { ...w, ...patch, updatedAt: new Date().toISOString() } : w,
  );
  saveWords(words);
  return words;
}
