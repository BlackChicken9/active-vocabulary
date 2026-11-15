import type { Explanation } from '../../types';
import { splitSentences } from './passage';

export interface ModelText {
  text: string;
  wordIds: string[];
}

/** 网关不可用时的讲解兜底：句子照样切出来，但绝不编造译文和结构，缺的部分如实留空。 */
export function generateExplanation(text: string): Explanation {
  return {
    sentences: splitSentences(text).map((en) => ({ en, zh: '', structure: '', parts: [] })),
    glossary: [],
  };
}
