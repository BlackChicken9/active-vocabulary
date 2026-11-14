import './style.css';
import type { Submission, WritingTask } from './types';
import { loadWords } from './features/words/wordStore';
import { mountWordsPanel } from './features/words/wordsPanel';
import { generateMockFeedback } from './features/writing/mockFeedback';

const app = document.querySelector<HTMLDivElement>('#app')!;
const words = loadWords();

const task: WritingTask = {
  id: 't-demo',
  title: '周记：如何应对压力',
  prompt: '用 3~5 句英文写下你缓解压力的方式，尽量用出左栏全部目标词。',
  targetWordIds: words.slice(0, 2).map((w) => w.id),
  status: 'drafting',
};

function render(): void {
  app.innerHTML = `
    <main class="layout">
      <section class="panel" id="words-panel"></section>
      <section class="panel">
        <h2>${task.title}</h2>
        <p class="sub">${task.prompt}</p>
        <textarea id="draft" rows="6" placeholder="在这里写你的英文段落…"></textarea>
        <button id="submit" type="button">提交并获取反馈</button>
        <div id="result"></div>
      </section>
    </main>`;
  mountWordsPanel(app.querySelector<HTMLElement>('#words-panel')!);
  app.querySelector<HTMLButtonElement>('#submit')!.addEventListener('click', onSubmit);
}

function onSubmit(): void {
  const text = app.querySelector<HTMLTextAreaElement>('#draft')!.value;
  const submission: Submission = {
    id: crypto.randomUUID(),
    taskId: task.id,
    text,
    wordIdsUsed: [],
  };
  const feedback = generateMockFeedback(task, submission, words);
  submission.wordIdsUsed = feedback.usages.filter((u) => u.used).map((u) => u.wordId);
  task.status = 'submitted';

  document.querySelector<HTMLElement>('#result')!.innerHTML = `
    <div class="feedback">
      <p class="score">用词得分 ${feedback.accuracy} · ${feedback.overall}</p>
      <ul>
        ${feedback.usages
          .map((u) => `<li class="${u.used && u.natural ? 'ok' : u.used ? 'warn' : 'miss'}">${u.note}</li>`)
          .join('')}
      </ul>
    </div>`;
}

render();
