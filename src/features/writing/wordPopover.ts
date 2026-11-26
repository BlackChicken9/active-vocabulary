import type { GlossEntry, MasteryStatus, Word } from '../../types';
import { escapeHtml } from '../../escapeHtml';
import { addWord } from '../words/wordStore';
import { requestGloss } from './aiClient';
import { lemmaCandidates, lookupGloss } from './passage';

const masteryZh: Record<MasteryStatus, string> = {
  passive: '认识',
  training: '练用中',
  active: '会用',
};

const SOURCE_ZH = {
  bank: '你的词库',
  ai: 'AI 词汇表',
  local: '本地词典',
  fetched: 'AI 现查',
} as const;

export interface WordPopoverDeps {
  words(): Word[];
  glossary(): GlossEntry[];
  /** 收进词库后通知面板重绘，词库与掌握度色带要立刻跟上。 */
  onAdd(): void;
}

export interface WordPopover {
  open(anchor: HTMLElement, term: string, sentence: string): void;
  close(restoreFocus?: boolean): void;
  /** 面板整块重绘后锚点元素会被换掉，这里按 id 找回同一个词。 */
  reanchor(): void;
  /** 换题或重写示范后清掉上一篇的现查缓存，避免旧语境释义串到新短文。 */
  clearCache(): void;
}

export function createWordPopover(deps: WordPopoverDeps): WordPopover {
  const box = document.createElement('div');
  box.className = 'gloss';
  box.id = 'gloss-popover';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', '词义');
  box.hidden = true;
  document.body.append(box);

  const fetched = new Map<string, GlossEntry>();
  let anchorId = '';
  let term = '';
  let sentence = '';
  let loading = false;
  let reqSeq = 0;
  let note: string | null = null;

  function anchor(): HTMLElement | null {
    const found = anchorId ? document.getElementById(anchorId) : null;
    return found instanceof HTMLElement ? found : null;
  }

  function inBank(value: string): Word | null {
    const keys = lemmaCandidates(value);
    return deps.words().find((w) => keys.includes(w.headword.toLowerCase())) ?? null;
  }

  function place(): void {
    const target = anchor();
    if (!target || box.hidden) return;
    if (window.matchMedia('(max-width: 639px)').matches) {
      box.dataset.dock = '1';
      box.style.left = '';
      box.style.top = '';
      return;
    }
    delete box.dataset.dock;
    const rect = target.getBoundingClientRect();
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
    let top = rect.bottom + 10;
    let side = 'bottom';
    if (top + height > window.innerHeight - 8) {
      top = rect.top - height - 10;
      side = 'top';
    }
    // 锚点可能已经被滚出视口，夹完上下边界才不会出现「词义卡在屏幕外」。
    const maxTop = Math.max(8, window.innerHeight - height - 8);
    if (top < 8 || top > maxTop) {
      top = Math.min(Math.max(8, top), maxTop);
      side = 'none';
    }
    box.dataset.side = side;
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
    box.style.setProperty('--arrow-x', `${Math.round(rect.left + rect.width / 2 - left)}px`);
  }

  function hitOf(): { entry: GlossEntry; source: keyof typeof SOURCE_ZH; word?: Word } | null {
    const cached = fetched.get(term.toLowerCase());
    if (cached?.meaningZh) return { entry: cached, source: 'fetched' };
    return lookupGloss(term, deps.glossary(), deps.words());
  }

  function paint(): void {
    const hit = hitOf();
    const bank = inBank(term);
    const entry = hit?.entry ?? null;
    const meaning = entry?.meaningZh ?? '';
    const canAdd = !!meaning && !bank;
    box.innerHTML = `
      <div class="gloss__head">
        <span class="gloss__term">${escapeHtml(term)}</span>
        ${entry?.pos ? `<span class="gloss__pos">${escapeHtml(entry.pos)}</span>` : ''}
        <button type="button" class="gloss__x" id="gloss-close" aria-label="关闭词义">
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>
        </button>
      </div>
      ${
        meaning
          ? `<p class="gloss__meaning">${escapeHtml(meaning)}</p>
             <p class="gloss__source">${SOURCE_ZH[hit!.source]}${
               bank ? ` · <i class="dot ${bank.mastery}" aria-hidden="true"></i>${masteryZh[bank.mastery]}` : ''
             }</p>`
          : loading
            ? '<p class="gloss__meaning empty busy"><span class="spinner" aria-hidden="true"></span>正在自动翻译…</p>'
            : '<p class="gloss__meaning empty">暂未查到释义。</p>'
      }
      ${
        bank?.collocations.length
          ? `<ul class="gloss__col">${bank.collocations
              .slice(0, 2)
              .map(
                (c) =>
                  `<li><b>${escapeHtml(c.phrase)}</b>${c.gloss ? `<span>${escapeHtml(c.gloss)}</span>` : ''}</li>`,
              )
              .join('')}</ul>`
          : ''
      }
      ${note ? `<p class="gloss__note">${escapeHtml(note)}</p>` : ''}
      ${
        canAdd || bank || !loading
          ? `<div class="gloss__row">
              ${
                canAdd
                  ? `<button type="button" class="btn btn--primary btn--sm" id="gloss-add">收进词库</button>`
                  : bank
                    ? `<span class="gloss__inbank">已在你的词库</span>`
                    : `<button type="button" class="btn btn--secondary btn--sm" id="gloss-ask">重试翻译</button>`
              }
            </div>`
          : ''
      }`;

    box.querySelector<HTMLButtonElement>('#gloss-close')?.addEventListener('click', () => close(true));
    box.querySelector<HTMLButtonElement>('#gloss-add')?.addEventListener('click', () => {
      const value = hitOf()?.entry;
      if (!value?.meaningZh) return;
      addWord({
        headword: value.term || term,
        meaningZh: value.meaningZh,
        source: '示范短文',
      });
      note = `已收进词库：${value.term || term}`;
      deps.onAdd();
      paint();
      place();
    });
    box.querySelector<HTMLButtonElement>('#gloss-ask')?.addEventListener('click', () => {
      if (!loading) void fetchGloss();
    });
    place();
  }

  /** 点开即自动查词；结果写进当前短文缓存，再点同一词时开箱即译。 */
  async function fetchGloss(): Promise<void> {
    const seq = ++reqSeq;
    const targetId = anchorId;
    const targetTerm = term;
    const targetSentence = sentence;
    loading = true;
    note = null;
    paint();
    const result = await requestGloss(targetTerm, targetSentence);
    if (result.data.meaningZh) {
      fetched.set(targetTerm.toLowerCase(), result.data);
    }
    if (seq !== reqSeq || box.hidden || anchorId !== targetId) return;
    loading = false;
    note = result.data.meaningZh ? null : `${result.degraded ?? 'AI 没给出释义'}。`;
    paint();
  }

  function open(target: HTMLElement, value: string, context: string): void {
    if (!box.hidden && anchorId && anchorId === target.id) {
      close(true);
      return;
    }
    reqSeq += 1;
    anchorId = target.id;
    term = value;
    sentence = context;
    loading = false;
    note = null;
    box.hidden = false;
    document.querySelectorAll<HTMLElement>('.tok[data-active="1"]').forEach((node) => {
      delete node.dataset.active;
    });
    target.dataset.active = '1';
    if (hitOf()) {
      paint();
      return;
    }
    void fetchGloss();
  }

  function close(restoreFocus = false): void {
    if (box.hidden) return;
    const target = anchor();
    reqSeq += 1;
    loading = false;
    box.hidden = true;
    document.querySelectorAll<HTMLElement>('.tok[data-active="1"]').forEach((node) => {
      delete node.dataset.active;
    });
    anchorId = '';
    if (restoreFocus) target?.focus();
  }

  document.addEventListener('pointerdown', (event) => {
    if (box.hidden) return;
    const node = event.target;
    if (node instanceof Node && (box.contains(node) || anchor()?.contains(node))) return;
    close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !box.hidden) close(true);
  });

  window.addEventListener('scroll', () => place(), { capture: true, passive: true });
  window.addEventListener('resize', () => place());

  return {
    open,
    close,
    reanchor(): void {
      if (box.hidden) return;
      if (!anchor()) {
        close();
        return;
      }
      if (loading && hitOf()) {
        reqSeq += 1;
        loading = false;
        note = null;
        paint();
        return;
      }
      place();
    },
    clearCache(): void {
      fetched.clear();
    },
  };
}