export type MasteryStatus = 'passive' | 'training' | 'active';

export interface Collocation {
  phrase: string;
  gloss: string;
}

export interface Word {
  id: string;
  headword: string;
  pos?: string;
  meaningZh: string;
  examples: string[];
  collocations: Collocation[];
  mastery: MasteryStatus;
  source?: string;
  updatedAt: string;
}

export type LengthChoice = 'auto' | 'short' | 'medium' | 'long';

/** 示范短文与自写共用同一篇幅区间：句数和词数都要落在里面。 */
export interface PassageLength {
  minSentences: number;
  maxSentences: number;
  minWords: number;
  maxWords: number;
}

/** 句子里的一个成分：text 必须是原句里连续的一段，前端据此上色。 */
export interface SentencePart {
  text: string;
  role: string;
}

export interface SentenceNote {
  en: string;
  zh: string;
  structure: string;
  parts: SentencePart[];
}

/** 示范短文里的一个词：term 用原文形态，点词时按它查释义。 */
export interface GlossEntry {
  term: string;
  pos: string;
  meaningZh: string;
}

export interface Explanation {
  sentences: SentenceNote[];
  glossary: GlossEntry[];
}

export interface WritingTask {
  id: string;
  title: string;
  prompt: string;
  targetWordIds: string[];
  status: 'drafting' | 'submitted' | 'reviewed';
  /** 旧版本存下的任务没有这个字段，读取一律走 taskLength() 兜底。 */
  length?: PassageLength;
}

export interface Submission {
  id: string;
  taskId: string;
  text: string;
  wordIdsUsed: string[];
}

export interface WordUsage {
  wordId: string;
  used: boolean;
  natural: boolean;
  note: string;
}

export interface Feedback {
  taskId: string;
  submittedText: string;
  usages: WordUsage[];
  accuracy: number;
  overall: string;
  updatedAt: string;
}
