import type { Feedback, Word } from '../../types';

const STORAGE_KEY = 'tianchi.saved';
const MAX_SAVED = 50;

export type SavedKind = 'model' | 'mine';

export interface SavedUsage {
  headword: string;
  tag: string;
  note: string;
}

export interface SavedPassage {
  id: string;
  kind: SavedKind;
  title: string;
  lengthLabel: string;
  text: string;
  /** 示范带的整段译文；自己写的那篇没有。 */
  zh: string;
  accuracy: number | null;
  overall: string;
  usages: SavedUsage[];
  savedAt: string;
}

export function loadSaved(): SavedPassage[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as SavedPassage[]) : [];
}

function write(items: SavedPassage[]): SavedPassage[] {
  const cut = items.slice(0, MAX_SAVED);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cut));
  return cut;
}

/** 正文相同就不算新篇：改完篇幅重新生成、连点两次「保存这篇」，不该攒出两条。 */
export function addSaved(
  item: Omit<SavedPassage, 'id' | 'savedAt'>,
): { added: boolean; items: SavedPassage[] } {
  const items = loadSaved();
  if (items.some((saved) => saved.kind === item.kind && saved.text === item.text)) {
    return { added: false, items };
  }
  const next: SavedPassage = { ...item, id: crypto.randomUUID(), savedAt: new Date().toISOString() };
  return { added: true, items: write([next, ...items]) };
}

export function removeSaved(id: string): SavedPassage[] {
  return write(loadSaved().filter((saved) => saved.id !== id));
}

export function hasSaved(kind: SavedKind, text: string): boolean {
  return loadSaved().some((saved) => saved.kind === kind && saved.text === text);
}

/** 复制出去的要能直接贴进笔记：示范带译文，习作带得分与逐词判定。 */
export function savedClip(item: SavedPassage): string {
  if (item.kind === 'model') {
    return [item.title, item.text, item.zh].filter(Boolean).join('\n\n');
  }
  const usages = item.usages.map((u) => `- ${u.headword}（${u.tag}）：${u.note}`).join('\n');
  return [
    item.title,
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
