import type { Word } from '../../types';
import { loadWords } from './wordStore';
import { escapeHtml } from './html';
import { masteryOrder, masteryZh, type MasteryFilter } from './mastery';
import { mountAddWordForm } from './addWordForm';
import { mountWordDetailView } from './wordDetailView';

function wordCardHtml(word: Word): string {
  const coll = word.collocations.slice(0, 2).map((c) => escapeHtml(c.phrase)).join(' · ');
  const example = word.examples[0] ?? '';
  return `
    <li>
      <button class="wcard ${word.mastery}" type="button" data-word="${escapeHtml(word.id)}">
        <span class="wcard-top">
          <span class="hw">${escapeHtml(word.headword)}</span>
          ${word.pos ? `<span class="pos">${escapeHtml(word.pos)}</span>` : ''}
          <span class="badge ${word.mastery}">${masteryZh[word.mastery]}</span>
        </span>
        <span class="wcard-meaning">${escapeHtml(word.meaningZh)}</span>
        ${coll ? `<span class="wcard-coll">搭配：${coll}</span>` : '<span class="wcard-coll">还没有搭配</span>'}
        ${example ? `<span class="wcard-example">${escapeHtml(example)}</span>` : ''}
      </button>
    </li>`;
}

function countFor(words: Word[], key: MasteryFilter): number {
  return key === 'all' ? words.length : words.filter((w) => w.mastery === key).length;
}

function listHtml(words: Word[], filter: MasteryFilter): string {
  const visible = filter === 'all' ? words : words.filter((w) => w.mastery === filter);

  const chips = (['all', ...masteryOrder] as MasteryFilter[])
    .map(
      (key) => `
        <button type="button" class="wchip ${key === filter ? 'on' : ''}" data-filter="${key}"
          aria-pressed="${key === filter}">
          ${key === 'all' ? '全部' : masteryZh[key]} ${countFor(words, key)}
        </button>`,
    )
    .join('');

  return `
    <div class="wfilter" role="group" aria-label="按掌握度筛选">${chips}</div>
    ${
      visible.length === 0
        ? '<p class="wempty">这个状态下还没有词。</p>'
        : `<ul class="wlist">${visible.map((w) => wordCardHtml(w)).join('')}</ul>`
    }`;
}

export function mountWordsPanel(root: HTMLElement): void {
  let filter: MasteryFilter = 'all';
  let openWordId: string | null = null;
  let flash = '';

  const draw = (): void => {
    const words = loadWords();
    const opened = openWordId ? words.find((w) => w.id === openWordId) : undefined;

    root.innerHTML = `
      <h1>主动词库</h1>
      <p class="sub">收词 → 学搭配例句 → 写作里用出来</p>
      <div class="wpanel-body"></div>`;
    const body = root.querySelector<HTMLElement>('.wpanel-body')!;

    if (opened) {
      mountWordDetailView(body, opened, {
        onBack: () => {
          openWordId = null;
          draw();
        },
        onChanged: () => draw(),
      });
      return;
    }

    body.innerHTML = `
      <div class="wform-host"></div>
      ${flash ? `<p class="wnote">${escapeHtml(flash)}</p>` : ''}
      <div class="wlist-host"></div>`;

    mountAddWordForm(body.querySelector<HTMLElement>('.wform-host')!, (headword) => {
      flash = `已收录「${headword}」，刷新后仍在词本里。`;
      draw();
    });

    const listHost = body.querySelector<HTMLElement>('.wlist-host')!;
    listHost.innerHTML = listHtml(words, filter);

    listHost.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((chip) => {
      chip.addEventListener('click', () => {
        filter = chip.dataset.filter as MasteryFilter;
        draw();
      });
    });
    listHost.querySelectorAll<HTMLButtonElement>('[data-word]').forEach((card) => {
      card.addEventListener('click', () => {
        openWordId = card.dataset.word ?? null;
        draw();
      });
    });
  };

  draw();
}
