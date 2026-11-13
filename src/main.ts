import './style.css';
import type { MasteryStatus } from './types';
import { escapeHtml } from './escapeHtml';
import { loadWords } from './features/words/wordStore';
import { mountWritingPanel } from './features/writing/writingPanel';

const app = document.querySelector<HTMLDivElement>('#app')!;

const masteryZh: Record<MasteryStatus, string> = {
  passive: '认识',
  training: '练用中',
  active: '会用',
};

app.innerHTML = `
  <main class="layout">
    <section class="panel" id="wordbook"></section>
    <div class="stack" id="writing"></div>
  </main>`;

function renderWordbook(): void {
  const words = loadWords();
  document.querySelector<HTMLElement>('#wordbook')!.innerHTML = `
    <h1>主动词库</h1>
    <p class="sub">把「认识」的词练成「会用」的词 · 词卡学习页与收词表单是队友 B 的任务位</p>
    ${
      words.length
        ? `<ul class="words">
      ${words
        .map(
          (w) => `
        <li class="word ${w.mastery}">
          <span class="hw">${escapeHtml(w.headword)}</span>
          <span class="zh">${escapeHtml(w.meaningZh)}</span>
          <span class="badge">${masteryZh[w.mastery]}</span>
        </li>`,
        )
        .join('')}
    </ul>`
        : '<p class="hint">词库还是空的：在右边把你正在背的词粘进来，这里会显示每个词的掌握度。</p>'
    }`;
}

renderWordbook();
mountWritingPanel(document.querySelector<HTMLElement>('#writing')!, renderWordbook);
