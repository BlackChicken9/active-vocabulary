import './style.css';
import type { MasteryStatus } from './types';
import { loadWords } from './features/words/wordStore';
import { mountWritingPanel } from './features/writing/writingPanel';

const app = document.querySelector<HTMLDivElement>('#app')!;

const masteryZh: Record<MasteryStatus, string> = {
  passive: '认识',
  training: '练用中',
  active: '会用',
};

const LADDER: MasteryStatus[] = ['passive', 'training', 'active'];

app.innerHTML = `
  <a class="skip-link" href="#desk">跳到写作区</a>
  <header class="topbar">
    <div class="topbar__in">
      <div class="brand">
        <span class="mark" aria-hidden="true"></span>
        <h1 class="brand__name">主动词库</h1>
        <span class="brand__line">把认识的词练成会用的词</span>
      </div>
      <div class="tally" id="tally" aria-live="polite" aria-label="词库掌握度统计"></div>
    </div>
  </header>
  <main class="layout">
    <aside class="card bank m-nolift" id="bank" aria-labelledby="bank-h"></aside>
    <section class="desk" id="desk" aria-labelledby="desk-h" tabindex="-1"></section>
  </main>
  <footer class="foot">
    <div class="foot__in">
      <span>词库与草稿只存在这台设备的浏览器里。</span>
      <span>示范与点评走站点 Function，用你自己的模型密钥。</span>
    </div>
  </footer>`;

const tally = document.querySelector<HTMLElement>('#tally')!;

tally.innerHTML = `
  <div class="tally__bar" aria-hidden="true">
    ${LADDER.map((status) => `<span class="tally__seg ${status}" data-seg="${status}"></span>`).join('')}
  </div>
  <div class="tally__legend">
    ${LADDER.map(
      (status) => `<span class="tally__item" data-item="${status}">
        <i class="dot ${status}" aria-hidden="true"></i><b data-n="${status}">0</b><span>${masteryZh[status]}</span>
      </span>`,
    ).join('')}
  </div>`;

/** 词条换档时只改宽度与数字，色带才能把「认识 → 练用中 → 会用」的挪动画出来。 */
function renderTally(): void {
  const words = loadWords();
  for (const status of LADDER) {
    const n = words.filter((w) => w.mastery === status).length;
    tally.querySelector<HTMLElement>(`[data-seg="${status}"]`)!.style.width = words.length
      ? `${(n / words.length) * 100}%`
      : '0%';
    tally.querySelector<HTMLElement>(`[data-n="${status}"]`)!.textContent = String(n);
    tally
      .querySelector<HTMLElement>(`[data-item="${status}"]`)!
      .setAttribute('aria-label', `${masteryZh[status]} ${n} 个词`);
  }
}

renderTally();
mountWritingPanel(
  document.querySelector<HTMLElement>('#bank')!,
  document.querySelector<HTMLElement>('#desk')!,
  renderTally,
);