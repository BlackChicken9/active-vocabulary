import type { Explanation, Feedback, Word } from '../../types';
import { splitSentences } from './passage';

const STORAGE_KEY = 'tianchi.saved';
const MAX_SAVED = 50;
// 讲解快照按条数封顶：50 篇全存满也不该把 localStorage 顶到写不进去。
const MAX_SNAPSHOT_SENTENCES = 12;
const MAX_SNAPSHOT_PARTS = 8;
const MAX_SNAPSHOT_GLOSS = 60;

export type SavedKind = 'model' | 'mine';

export interface SavedUsage {
  headword: string;
  tag: string;
  note: string;
}

/** 存这篇时的目标词快照：补分析要按它们对齐释义，词卡后来被删也不影响。 */
export interface SavedTarget {
  headword: string;
  meaningZh: string;
}

export interface SavedPassage {
  id: string;
  kind: SavedKind;
  lengthLabel: string;
  text: string;
  /** 示范带的整段译文；自己写的那篇没有。 */
  zh: string;
  accuracy: number | null;
  overall: string;
  usages: SavedUsage[];
  terms: SavedTarget[];
  /** 已生成的逐句讲解快照；null 表示存的时候还没讲过，习作集里给「补分析」。 */
  explanation: Explanation | null;
  savedAt: string;
}

/** 旧数据没有 terms/explanation 字段，读的时候补上默认值，别让某一篇把整屏打崩。 */
function normalize(item: SavedPassage): SavedPassage {
  return { ...item, terms: item.terms ?? [], explanation: item.explanation ?? null };
}

/** 讲解快照只留读得完的量：句数、成分数与生词数各封一道顶。 */
function shrink(explanation: Explanation | null): Explanation | null {
  if (!explanation) return null;
  const sentences = explanation.sentences
    .slice(0, MAX_SNAPSHOT_SENTENCES)
    .map((note) => ({ ...note, parts: note.parts.slice(0, MAX_SNAPSHOT_PARTS) }));
  return { sentences, glossary: explanation.glossary.slice(0, MAX_SNAPSHOT_GLOSS) };
}

export function loadSaved(): SavedPassage[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  return (JSON.parse(raw) as SavedPassage[]).map(normalize);
}

function write(items: SavedPassage[]): SavedPassage[] {
  const cut = items.slice(0, MAX_SAVED);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cut));
  return cut;
}

/** 正文相同就不算新篇：改完篇幅重新生成、连点两次「保存这篇」，不该攒出两条。 */
export function addSaved(
  item: Omit<SavedPassage, 'id' | 'savedAt' | 'explanation'> & { explanation?: Explanation | null },
): { added: boolean; items: SavedPassage[] } {
  const items = loadSaved();
  if (items.some((saved) => saved.kind === item.kind && saved.text === item.text)) {
    return { added: false, items };
  }
  const next: SavedPassage = {
    ...item,
    explanation: shrink(item.explanation ?? null),
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
  };
  return { added: true, items: write([next, ...items]) };
}

/** 补分析成功才回写：失败保留原样，下一次还能再点。 */
export function setSavedExplanation(id: string, explanation: Explanation): SavedPassage[] {
  return write(
    loadSaved().map((saved) => (saved.id === id ? { ...saved, explanation: shrink(explanation) } : saved)),
  );
}

export function removeSaved(id: string): SavedPassage[] {
  return write(loadSaved().filter((saved) => saved.id !== id));
}

export function hasSaved(kind: SavedKind, text: string): boolean {
  return loadSaved().some((saved) => saved.kind === kind && saved.text === text);
}

/** 名字不另存一份：直接从正文开头取，正文没变名字就不会跟内容对不上，旧数据也一并有标题。 */
const NAME_WORDS = 7;
const NAME_CHARS = 56;

export function passageName(item: SavedPassage): string {
  const first = splitSentences(item.text)[0] ?? '';
  const words = first.split(' ');
  // 取满一截才去掉结尾标点，整句能装下的就照原样留着。
  const cut = words.length > NAME_WORDS;
  const head = cut ? `${words.slice(0, NAME_WORDS).join(' ').replace(/[,;:.\s]+$/, '')}…` : first;
  return head.length > NAME_CHARS ? `${head.slice(0, NAME_CHARS).trimEnd()}…` : head;
}

/** 复制出去的要能直接贴进笔记：示范带译文与逐句讲解，习作带得分与逐词判定。 */
export function savedClip(item: SavedPassage): string {
  if (item.kind === 'model') {
    const notes = item.explanation
      ? item.explanation.sentences
          .map((note, index) => {
            const lines = [`${index + 1}. ${note.en}`];
            if (note.zh) lines.push(`   译文：${note.zh}`);
            if (note.structure) lines.push(`   结构：${note.structure}`);
            return lines.join('\n');
          })
          .join('\n')
      : '';
    return [passageName(item), item.text, item.zh, notes].filter(Boolean).join('\n\n');
  }
  const usages = item.usages.map((u) => `- ${u.headword}（${u.tag}）：${u.note}`).join('\n');
  return [
    passageName(item),
    item.text,
    `用词得分 ${item.accuracy ?? 0}/100 · ${item.overall}`,
    usages,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function savedFeedback(
  feedback: Feedback,
  words: Word[],
): { accuracy: number; overall: string; usages: SavedUsage[] } {
  return {
    accuracy: feedback.accuracy,
    overall: feedback.overall,
    usages: feedback.usages.map((usage) => ({
      // 词卡后来被删也要能复现当时的判定，存的是那一刻的词头。
      headword: words.find((word) => word.id === usage.wordId)?.headword ?? usage.wordId,
      tag: usage.used && usage.natural ? '用出且地道' : usage.used ? '用出但生硬' : '没用到',
      note: usage.note,
    })),
  };
}

/** 保存这篇时顺手记下目标词，之后补分析不必再回词本找。 */
export function savedTerms(words: Word[], ids: string[]): SavedTarget[] {
  return words
    .filter((word) => ids.includes(word.id))
    .map((word) => ({ headword: word.headword, meaningZh: word.meaningZh.trim() }));
}

/** 早期存下的那几篇没有 terms，退一步用逐词判定的词头，列表里至少看得见当时选了哪些词。 */
export function savedWords(item: SavedPassage): SavedTarget[] {
  return item.terms.length
    ? item.terms
    : item.usages.map((usage) => ({ headword: usage.headword, meaningZh: '' }));
}
