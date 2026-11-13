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

export interface WritingTask {
  id: string;
  title: string;
  prompt: string;
  targetWordIds: string[];
  status: 'drafting' | 'submitted' | 'reviewed';
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
