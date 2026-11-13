import type { MasteryStatus, Word } from '../../types';

const STORAGE_KEY = 'tianchi.words';

const seedWords: Word[] = [
  {
    id: 'alleviate',
    headword: 'alleviate',
    pos: 'v.',
    meaningZh: '减轻，缓解（痛苦、问题）',
    examples: ['Regular exercise can help alleviate daily stress.'],
    collocations: [
      { phrase: 'alleviate stress / pressure', gloss: '缓解压力' },
      { phrase: 'alleviate poverty', gloss: '缓解贫困' },
    ],
    mastery: 'passive',
    source: 'CET-6 词表',
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'reluctant',
    headword: 'reluctant',
    pos: 'adj.',
    meaningZh: '不情愿的，勉强的',
    examples: ['He was reluctant to ask his teammates for help.'],
    collocations: [{ phrase: 'be reluctant to do sth.', gloss: '不愿做某事' }],
    mastery: 'training',
    source: 'CET-6 词表',
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'accumulate',
    headword: 'accumulate',
    pos: 'v.',
    meaningZh: '积累，积聚',
    examples: ['Reading a little every day helps you accumulate a large vocabulary.'],
    collocations: [{ phrase: 'accumulate knowledge / experience', gloss: '积累知识/经验' }],
    mastery: 'passive',
    source: '阅读摘录',
    updatedAt: new Date().toISOString(),
  },
];

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
