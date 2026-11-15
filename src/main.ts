import './style.css';
import type { MasteryStatus } from './types';
import { loadWords } from './features/words/wordStore';
import { loadSaved } from './features/writing/savedStore';
import { clearModelKey, keyTail, loadModelKey, saveModelKey } from './modelKey';
import { mountWordsPanel, type WordsPanel } from './features/words/wordsPanel';
import { mountWritingPanel } from './features/writing/writingPanel';
import { mountSavedPanel, type SavedPanel } from './features/writing/savedPanel';

const app = document.querySelector<HTMLDivElement>('#app')!;

const masteryZh: Record<MasteryStatus, string> = {
  passive: '认识',
  training: '练用中',
  active: '会用',
};

const LADDER: MasteryStatus[] = ['passive', 'training', 'active'];

app.innerHTML = `
  <a class="skip-link" href="#desk" id="skip">跳到写作区</a>
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
  <nav class="viewnav" aria-label="视图切换">
    <div class="viewnav__in seg" role="group" aria-label="写作、词本与习作集">
      <button type="button" class="seg-btn" data-view="write" aria-pressed="true">
        <strong>写作</strong><small>按词出题 · 逐句点评</small>
      </button>
      <button type="button" class="seg-btn" data-view="words" aria-pressed="false">
        <strong>词本</strong><small>粘笔记收词 · 学搭配</small>
      </button>
      <button type="button" class="seg-btn" data-view="saved" aria-pressed="false">
        <strong>习作集</strong><small id="saved-sub">存下的示范与批改</small>
      </button>
    </div>
  </nav>
  <main class="layout layout--view" id="view-write">
    <aside class="card bank m-nolift" id="bank" aria-labelledby="bank-h"></aside>
    <section class="desk" id="desk" aria-labelledby="desk-h" tabindex="-1"></section>
  </main>
  <main class="layout layout--view layout--single" id="view-words" hidden>
    <section class="card wb m-nolift" id="words-panel" tabindex="-1" aria-labelledby="wb-h"></section>
  </main>
  <main class="layout layout--view layout--single" id="view-saved" hidden>
    <section class="card saved m-nolift" id="saved-panel" tabindex="-1" aria-labelledby="saved-h"></section>
  </main>
  <footer class="foot">
    <div class="foot__in">
      <span>词库、任务与习作集只存在这台设备的浏览器里，不上传。</span>
      <div class="keyrow">
        <span class="keyrow__state" id="key-state" role="status"></span>
        <label class="sr-only" for="model-key">DeepSeek 密钥</label>
        <input class="wb-input keyrow__input" id="model-key" type="password" autocomplete="off"
               spellcheck="false" placeholder="粘贴你自己的 DeepSeek 密钥（sk-…）"
               title="DeepSeek 开放平台申请；只存在这台设备的浏览器里，随请求交给本站网关，共享电脑上别用">
        <button type="button" class="btn btn--sm btn--secondary" id="key-save">保存</button>
        <button type="button" class="btn btn--sm btn--secondary" id="key-clear" hidden>清除</button>
      </div>
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
/**
 * DeepSeek 密钥：粘了自己的 key 就走自己的额度，没粘就用站点 Secret。
 * 值只进 localStorage 和请求头，输入框 type=password、保存即清空，界面只留尾号。
 */
function mountKeyRow(): void {
  const input = document.querySelector<HTMLInputElement>('#model-key')!;
  const state = document.querySelector<HTMLElement>('#key-state')!;
  const saveBtn = document.querySelector<HTMLButtonElement>('#key-save')!;
  const clearBtn = document.querySelector<HTMLButtonElement>('#key-clear')!;

  function show(message?: string, warn = false): void {
    const key = loadModelKey();
    state.textContent =
      message ?? (key ? `当前用你的 DeepSeek 密钥（尾号 ${keyTail(key)}）` : '当前用站点 DeepSeek 密钥');
    state.classList.toggle('warn', warn);
    clearBtn.hidden = !key;
  }

  function save(): void {
    if (saveModelKey(input.value)) {
      input.value = '';
      show();
      return;
    }
    show(input.value.trim() ? 'DeepSeek 密钥格式不对，检查有没有多复制空格' : '先粘贴 DeepSeek 密钥再保存', true);
  }

  saveBtn.addEventListener('click', save);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    save();
  });
  clearBtn.addEventListener('click', () => {
    clearModelKey();
    show('已改用站点 DeepSeek 密钥');
  });
  show();
}

mountKeyRow();

type View = 'write' | 'words' | 'saved';

const skip = document.querySelector<HTMLAnchorElement>('#skip')!;
const views: Record<View, HTMLElement> = {
  write: document.querySelector<HTMLElement>('#view-write')!,
  words: document.querySelector<HTMLElement>('#view-words')!,
  saved: document.querySelector<HTMLElement>('#view-saved')!,
};
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.viewnav .seg-btn'));
const wordsRoot = document.querySelector<HTMLElement>('#words-panel')!;
const savedRoot = document.querySelector<HTMLElement>('#saved-panel')!;
const savedSub = document.querySelector<HTMLElement>('#saved-sub')!;

/** 顶栏那档随时告诉用户习作集里现在有几篇——存完不用切过去才知道有没有生效。 */
function renderSavedCount(): void {
  const n = loadSaved().length;
  savedSub.textContent = n ? `存下的示范与批改 · ${n} 篇` : '存下的示范与批改';
}

const writing = mountWritingPanel(
  document.querySelector<HTMLElement>('#bank')!,
  document.querySelector<HTMLElement>('#desk')!,
  renderTally,
  () => go('words'),
  () => go('saved'),
  renderSavedCount,
);
let words: WordsPanel | null = null;
let saved: SavedPanel | null = null;

/** 页内锚点用 #desk / #words-panel，视图 hash 必须带 / 前缀才不撞车。 */
const HASH: Record<View, string> = { write: '#/write', words: '#/words', saved: '#/saved' };
const SKIP: Record<View, { href: string; label: string }> = {
  write: { href: '#desk', label: '跳到写作区' },
  words: { href: '#words-panel', label: '跳到词本' },
  saved: { href: '#saved-panel', label: '跳到习作集' },
};
let current: View = 'write';

/** 认不出来的 hash 是页内锚点（#desk / #words-panel），不是路由：交给调用方留在当前屏。 */
function viewFromHash(): View | null {
  for (const view of Object.keys(HASH) as View[]) {
    if (location.hash === HASH[view]) return view;
  }
  return null;
}

/** 进哪个视图就重算哪个视图：词本里补的搭配、写作页里勾的目标词，切过去都是最新的。 */
function showView(view: View): void {
  current = view;
  if (view === 'words') {
    words =
      words ??
      mountWordsPanel(wordsRoot, {
        onChanged: renderTally,
        onGoWrite: () => go('write'),
        onWordsAdded: (ids) => writing.selectWords(ids),
      });
    words.redraw();
  } else if (view === 'saved') {
    saved = saved ?? mountSavedPanel(savedRoot, () => go('write'), renderSavedCount);
    saved.redraw();
  } else {
    writing.redraw();
  }
  for (const name of Object.keys(views) as View[]) views[name].hidden = name !== view;
  for (const button of viewButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
  skip.setAttribute('href', SKIP[view].href);
  skip.textContent = SKIP[view].label;
}

/** 换屏的唯一入口：改 hash，剩下的交给 hashchange，浏览器后退键因此能退回上一屏。 */
function go(view: View): void {
  if (location.hash === HASH[view]) showView(view);
  else location.hash = HASH[view];
}

for (const button of viewButtons) {
  button.addEventListener('click', () => go(button.dataset.view as View));
}

window.addEventListener('hashchange', () => showView(viewFromHash() ?? current));

renderSavedCount();
showView(viewFromHash() ?? 'write');
