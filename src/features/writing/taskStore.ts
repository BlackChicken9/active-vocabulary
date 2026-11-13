import type { Word, WritingTask } from '../../types';

const STORAGE_KEY = 'tianchi.tasks';

export const MIN_TARGET_WORDS = 2;
export const MAX_TARGET_WORDS = 5;

interface Topic {
  title: string;
  scenario: string;
}

const topics: Topic[] = [
  {
    title: '周记：如何应对压力',
    scenario: '向朋友说明你在考试周缓解压力的做法，以及这些做法为什么有效。',
  },
  {
    title: '观点短文：团队里的分歧',
    scenario: '描述一次和队友意见不合的经历，说明你最后怎么处理、结果如何。',
  },
  {
    title: '申请信：为什么参加这个比赛',
    scenario: '写一段英文申请理由，说明你的动机、能投入的时间以及你想验证的东西。',
  },
  {
    title: '邮件：向老师申请延期',
    scenario: '礼貌地说明遇到的情况，给出补救方案，并请求一个新的提交时间。',
  },
  {
    title: '读书笔记：一句话评论',
    scenario: '介绍最近读到的一个观点，解释它为什么值得记住以及你打算怎么用。',
  },
];

/** 句子量随目标词数走：3 个词以内 1~2 句，避免退化成小作文。 */
export function sentenceTarget(count: number): string {
  return count > 3 ? '1~3 句' : '1~2 句';
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
  const topic = topics[existing.length % topics.length];
  const task: WritingTask = {
    id: crypto.randomUUID(),
    title: topic.title,
    prompt: `${topic.scenario}\n\n限定写作：写 ${sentenceTarget(targets.length)}，把勾选的 ${targets.length} 个目标词全部用出来。`,
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
