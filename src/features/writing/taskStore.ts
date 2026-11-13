import type { Word, WritingTask } from '../../types';

const STORAGE_KEY = 'tianchi.tasks';

export const MIN_TARGET_WORDS = 2;
export const MAX_TARGET_WORDS = 5;

/** 句子量随目标词数走：3 个词以内 1~2 句，避免退化成小作文。 */
export function sentenceTarget(count: number): string {
  return count > 3 ? '1~3 句' : '1~2 句';
}

/** 词卡 source 形如「Day 1 · 海洋与环境」，取「·」后的主题名，题干跟着词走。 */
function themeOf(word: Word): string | null {
  const source = word.source?.trim();
  if (!source) return null;
  const parts = source.split('·');
  const theme = (parts.length > 1 ? parts[parts.length - 1] : parts[0]).trim();
  return theme || null;
}

function scenario(themes: string[]): string {
  if (themes.length === 1) {
    return `围绕「${themes[0]}」写一小段：说清一件具体的事或一个明确的观点，把勾选的词自然用进去。`;
  }
  if (themes.length > 1) {
    return `这几个词分属「${themes.join('」「')}」，自选一个能同时容纳它们的场景，把词自然用进去。`;
  }
  return '自选一个生活、学习或工作场景，说清一件具体的事或一个明确的观点，把勾选的词自然用进去。';
}

export function loadTasks(): WritingTask[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as WritingTask[]) : [];
}

export function saveTasks(tasks: WritingTask[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

export function createTask(words: Word[], targetWordIds: string[]): WritingTask {
  const existing = loadTasks();
  const targets = targetWordIds
    .map((id) => words.find((w) => w.id === id))
    .filter((w): w is Word => w !== undefined);
  const themes = [...new Set(targets.map(themeOf).filter((theme): theme is string => !!theme))];
  const task: WritingTask = {
    id: crypto.randomUUID(),
    title: themes.length === 1 ? `限定写作：${themes[0]}` : '限定写作：自选场景',
    prompt: `${scenario(themes)}\n\n篇幅：写 ${sentenceTarget(targets.length)}，${targets.length} 个目标词都要用出来。`,
    targetWordIds: targets.map((w) => w.id),
    status: 'drafting',
  };
  saveTasks([...existing, task]);
  return task;
}

export function setStatus(id: string, status: WritingTask['status']): WritingTask[] {
  const tasks = loadTasks().map((t) => (t.id === id ? { ...t, status } : t));
  saveTasks(tasks);
  return tasks;
}
