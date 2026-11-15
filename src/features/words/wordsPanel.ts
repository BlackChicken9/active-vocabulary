import type { Word } from '../../types';
import { escapeHtml } from '../../escapeHtml';
import { loadWords } from './wordStore';
import { importWords } from './intake';
import { INTAKE_SAMPLE } from './intakeSample';
import { masteryOrder, masteryZh, type MasteryFilter } from './mastery';
import { mountAddWordForm } from './addWordForm';
import { mountWordDetailView } from './wordDetailView';

export interface WordsPanel {
  redraw: () => void;
}

export interface WordsPanelOptions {
  /** 词库或掌握度变了，让外壳重算顶部统计。 */
  onChanged?: () => void;
  /** 粘贴收词成功后把新词交给写作页当目标词，返回没被勾上的 id（本次目标词已选满）。 */
  onWordsAdded?: (ids: string[]) => string[];
  /** 「去写作」按钮：由外壳负责切屏。 */
  onGoWrite?: () => void;
}

function wordCardHtml(word: Word): string {
  const coll = word.collocations
    .slice(0, 3)
    .map((c) => escapeHtml(c.phrase))
    .join(' · ');
  return `
    <li>
      <button class="wcard ${word.mastery}" type="button" data-word="${escapeHtml(word.id)}">
        <span class="wcard-top">
          <span class="wb-hw">${escapeHtml(word.headword)}</span>
          ${word.pos ? `<span class="wb-pos">${escapeHtml(word.pos)}</span>` : ''}
          <span class="badge ${word.mastery}">${masteryZh[word.mastery]}</span>
        </span>
        <span class="wcard-meaning${word.meaningZh ? '' : ' empty'}">${
          word.meaningZh ? escapeHtml(word.meaningZh) : '释义待补'
        }</span>
        ${coll ? `<span class="wcard-coll">搭配：${coll}</span>` : '<span class="wcard-coll">还没有搭配</span>'}
      </button>
    </li>`;
}

function countFor(words: Word[], key: MasteryFilter): number {
  return key === 'all' ? words.length : words.filter((w) => w.mastery === key).length;
}

function chipsHtml(words: Word[], filter: MasteryFilter): string {
  return (['all', ...masteryOrder] as MasteryFilter[])
    .map(
      (key) => `
      <button type="button" class="wchip" data-filter="${key}" aria-pressed="${key === filter}">
        ${key === 'all' ? '全部' : masteryZh[key]} <b>${countFor(words, key)}</b>
      </button>`,
    )
    .join('');
}

function listHtml(words: Word[], filter: MasteryFilter): string {
  const chips = `<div class="wfilter" role="group" aria-label="按掌握度筛选">${chipsHtml(words, filter)}</div>`;
  if (words.length === 0) {
    return `${chips}<p class="wempty">词本还是空的。粘一段正在背的笔记，或者手动填一个词。</p>`;
  }
  const visible = filter === 'all' ? words : words.filter((w) => w.mastery === filter);
  return `${chips}${
    visible.length === 0
      ? '<p class="wempty">这个状态下还没有词。</p>'
      : `<ul class="wlist">${visible.map((w) => wordCardHtml(w)).join('')}</ul>`
  }`;
}

export function mountWordsPanel(root: HTMLElement, options: WordsPanelOptions = {}): WordsPanel {
  let filter: MasteryFilter = 'all';
  let openWordId: string | null = null;
  let intakeRaw = '';
  let intakeNote = '';
  let intakeJump = false;
  let intakeBusy = false;
  let manualOpen = false;
  let flash = '';
  /** null = 还没点过：词本空着时默认摊开粘贴框走首屏闭环，已有词时收成一行。 */
  let intakeOpen: boolean | null = null;

  function draw(): void {
    const words = loadWords();
    const opened = openWordId ? words.find((w) => w.id === openWordId) : undefined;
    const showIntake = intakeOpen ?? words.length === 0;

    root.innerHTML = `
      <div class="wb__head">
        <h2 id="wb-h">词本</h2>
        <span class="bank__count">${words.length} 词</span>
      </div>
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
      options.onChanged?.();
      return;
    }

    body.innerHTML = `
      <div class="intake">
        <div class="wbar">
          <button type="button" class="btn btn--sm btn--secondary" id="intake-toggle" aria-expanded="${showIntake}">${
            showIntake ? '收起收词框' : '粘贴收词'
          }</button>
          <button type="button" class="btn btn--sm btn--secondary" id="manual-toggle" aria-expanded="${manualOpen}">${
            manualOpen ? '收起手动填词' : '手动填一个'
          }</button>
          ${
            intakeNote
              ? `<p class="wstatus">${intakeNote}${
                  intakeJump ? '<button type="button" class="wlink" id="go-write">去写作</button>' : ''
                }</p>`
              : ''
          }
        </div>
        ${
          showIntake
            ? `
        <label class="hint" for="intake-raw">一串单词、一段带释义的笔记都行，不用管格式</label>
        <textarea id="intake-raw" rows="3" placeholder="直接粘贴，AI 会整理成词卡…">${escapeHtml(intakeRaw)}</textarea>
        <div class="intake__bar">
          <button type="button" class="btn btn--primary btn--sm" id="intake-run" ${
            intakeBusy || !intakeRaw.trim() ? 'disabled' : ''
          }>${intakeBusy ? 'AI 正在整理词卡…' : '整理成词卡'}</button>
          <button type="button" class="btn btn--secondary btn--sm" id="intake-sample" ${
            intakeBusy ? 'disabled' : ''
          }>试试粘这段</button>
          <span class="hint">一次最多 30 条，已有的跳过</span>
        </div>`
            : ''
        }
      </div>
      ${manualOpen ? '<div class="wform-host"></div>' : ''}
      ${flash ? `<p class="wnote">${escapeHtml(flash)}</p>` : ''}
      <div class="wlist-host"></div>`;

    const rawBox = body.querySelector<HTMLTextAreaElement>('#intake-raw');
    rawBox?.addEventListener('input', () => {
      intakeRaw = rawBox.value;
      const run = body.querySelector<HTMLButtonElement>('#intake-run');
      if (run) run.disabled = intakeBusy || !intakeRaw.trim();
    });

    body.querySelector<HTMLButtonElement>('#intake-toggle')?.addEventListener('click', () => {
      intakeOpen = !showIntake;
      draw();
      if (intakeOpen) root.querySelector<HTMLTextAreaElement>('#intake-raw')?.focus();
    });

    body.querySelector<HTMLButtonElement>('#intake-sample')?.addEventListener('click', () => {
      if (intakeBusy) return;
      intakeRaw = INTAKE_SAMPLE;
      intakeNote = '';
      draw();
      const again = root.querySelector<HTMLTextAreaElement>('#intake-raw');
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    });

    body.querySelector<HTMLButtonElement>('#intake-run')?.addEventListener('click', async () => {
      if (intakeBusy || !intakeRaw.trim()) return;
      intakeBusy = true;
      draw();
      const outcome = await importWords(intakeRaw);
      intakeBusy = false;
      const overflow = outcome.added.length
        ? options.onWordsAdded?.(outcome.added.map((word) => word.id)) ?? []
        : [];
      if (outcome.added.length) intakeRaw = '';
      const headwords = (ids: string[]) => {
        const names = outcome.added
          .filter((word) => ids.includes(word.id))
          .map((word) => escapeHtml(word.headword));
        return names.length > 3 ? `${names.slice(0, 3).join('、')} 等` : names.join('、');
      };
      const skippedLine = outcome.skipped.length
        ? `，跳过 ${outcome.skipped.length} 个已在词库`
        : '';
      const degradedLine = outcome.degraded ? `<br>兜底原因：${escapeHtml(outcome.degraded)}` : '';
      const pickLine = overflow.length
        ? `，${headwords(overflow)} 没勾上（目标词已满）`
        : '，已勾成这次的目标词';
      intakeJump = outcome.added.length > 0;
      intakeNote = outcome.added.length
        ? `已加入 ${outcome.added.length} 个词${skippedLine}${pickLine}。${degradedLine}`
        : outcome.skipped.length
          ? `没有新词入库：粘的 ${outcome.skipped.length} 个词头都已经在词本里了。`
          : `没识别出词头，换一行一个词的写法再试一次。${degradedLine}`;
      options.onChanged?.();
      draw();
    });

    body.querySelector<HTMLButtonElement>('#go-write')?.addEventListener('click', () => {
      options.onGoWrite?.();
    });

    body.querySelector<HTMLButtonElement>('#manual-toggle')?.addEventListener('click', () => {
      manualOpen = !manualOpen;
      draw();
      if (manualOpen) root.querySelector<HTMLInputElement>('#wb-headword')?.focus();
    });

    if (manualOpen) {
      mountAddWordForm(body.querySelector<HTMLElement>('.wform-host')!, (headword) => {
        flash = `已收录「${headword}」，刷新后仍在词本里。`;
        draw();
      });
    }

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

    options.onChanged?.();
  }

  draw();
  return { redraw: draw };
}
