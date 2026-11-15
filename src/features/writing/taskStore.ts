import type { LengthChoice, PassageLength, Word, WritingTask } from '../../types';
import { lengthLine, passageSpec } from './passageLength';

const STORAGE_KEY = 'tianchi.tasks';

export const MIN_TARGET_WORDS = 2;
export const MAX_TARGET_WORDS = 8;

function lengthPrompt(count: number, spec: PassageLength): string {
  return `篇幅：写 ${lengthLine(spec)}，${count} 个目标词都要用出来。`;
}

/** 主题 = source 里「·」后面的部分（「Day 1 · 海洋与环境」「粘贴导入 · 科技与社会」）；没有「·」就说明这批词没主题，别把整串来源当主题用。 */
function themeOf(word: Word): string | null {
  const source = word.source?.trim();
  if (!source) return null;
  const at = source.lastIndexOf('·');
  if (at < 0) return null;
  const theme = source.slice(at + 1).trim();
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

export function createTask(words: Word[], targetWordIds: string[], choice: LengthChoice = 'auto'): WritingTask {
  const existing = loadTasks();
  const targets = targetWordIds
    .map((id) => words.find((w) => w.id === id))
    .filter((w): w is Word => w !== undefined);
  const themes = [...new Set(targets.map(themeOf).filter((theme): theme is string => !!theme))];
  const length = passageSpec(choice, targets.length);
  const task: WritingTask = {
    id: crypto.randomUUID(),
    title: themes.length === 1 ? `限定写作：${themes[0]}` : '限定写作：自选场景',
    prompt: `${scenario(themes)}\n\n${lengthPrompt(targets.length, length)}`,
    targetWordIds: targets.map((w) => w.id),
    status: 'drafting',
    length,
  };
  saveTasks([...existing, task]);
  return task;
}

/** 任务进行中改篇幅：题干里的篇幅行跟着换；已生成的示范与点评由调用方保留，只影响下一次生成。 */
export function applyLength(task: WritingTask, choice: LengthChoice): WritingTask {
  const length = passageSpec(choice, task.targetWordIds.length);
  const next: WritingTask = {
    ...task,
    length,
    prompt: task.prompt.replace(/篇幅：[^\n]*/, lengthPrompt(task.targetWordIds.length, length)),
  };
  saveTasks(loadTasks().map((t) => (t.id === next.id ? next : t)));
  return next;
}

export function setStatus(id: string, status: WritingTask['status']): WritingTask[] {
  const tasks = loadTasks().map((t) => (t.id === id ? { ...t, status } : t));
  saveTasks(tasks);
  return tasks;
}
