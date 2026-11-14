import type { SentenceNote } from '../../types';
import { escapeHtml } from '../../escapeHtml';
import { requestExplainTerms } from './aiClient';
import { roleClass, segmentSentence } from './passage';
import {
  loadSaved,
  removeSaved,
  savedClip,
  setSavedExplanation,
  type SavedPassage,
} from './savedStore';

export interface SavedPanel {
  redraw: () => void;
}

// 展开哪一行、哪一行在等二次确认：换筛选或删完都不该记住旧 id，但同一屏里重绘要保住。
let rowOpen: string | null = null;
let confirmId: string | null = null;
// 补分析一次只跑一篇：请求在 aiClient 里排队，界面先把「分析中」显示出来。
let analyzing: string | null = null;
const analyzeNote = new Map<string, string>();

function day(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 成分对得上原句就按写作屏同一套色带上色，对不上只留文字，绝不猜位置。 */
function enLine(note: SentenceNote): string {
  const segments = segmentSentence(note.en, note.parts);
  if (!segments) return escapeHtml(note.en);
  return segments
    .map((segment) =>
      segment.role
        ? `<span class="part" data-role="${roleClass(segment.role)}">${escapeHtml(segment.text)}</span>`
        : escapeHtml(segment.text),
    )
    .join('');
}

/** 讲解快照按句列出译文、结构与成分；这里只静态复现，点词查释义仍属写作屏。 */
function notes(item: SavedPassage): string {
  const explanation = item.explanation;
  if (!explanation) return '';
  const rows = explanation.sentences
    .map((note, index) => {
      const parts = note.parts.length
        ? `<p class="saved__parts">${note.parts
            .map(
              (part) =>
                `<span class="saved__part" data-role="${roleClass(part.role)}"><b>${escapeHtml(
                  part.role,
                )}</b>${escapeHtml(part.text)}</span>`,
            )
            .join('')}</p>`
        : '';
      const detail =
        note.zh || note.structure || parts
          ? `
            ${note.zh ? `<p class="saved__zh"><b>译</b>${escapeHtml(note.zh)}</p>` : ''}
            ${note.structure ? `<p class="saved__zh"><b>结构</b>${escapeHtml(note.structure)}</p>` : ''}
            ${parts}`
          : '<p class="saved__zh">这一句当时没讲到。</p>';
      return `
        <li class="saved__note">
          <span class="saved__no" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
          <p class="saved__en">${enLine(note)}</p>
          ${detail}
        </li>`;
    })
    .join('');
  const glossary = explanation.glossary.length
    ? `<p class="saved__gloss">${explanation.glossary
        .map(
          (entry) =>
            `<span class="saved__word"><b>${escapeHtml(entry.term)}</b>${escapeHtml(
              [entry.pos, entry.meaningZh].filter(Boolean).join(' · '),
            )}</span>`,
        )
        .join('')}</p>`
    : '';
  return `
    <div class="saved__notes">
      <p class="saved__notes-h">逐句讲解 · ${explanation.sentences.length} 句</p>
      <ol class="saved__sents">${rows}</ol>
      ${glossary}
    </div>`;
}

function body(item: SavedPassage): string {
  const score =
    item.accuracy === null
      ? ''
      : `<p class="overall">${escapeHtml(item.overall)}</p>
         <p class="statsline"><span class="stats ok">用词得分 ${
           Math.max(0, Math.min(100, Math.round(item.accuracy)))
         }/100</span></p>`;
  const usage = item.usages.length
    ? `<ul class="usage">${item.usages
        .map((u) => {
          const cls = u.tag === '用出且地道' ? 'ok' : u.tag === '用出但生硬' ? 'warn' : 'miss';
          return `<li class="${cls}"><span class="hw">${escapeHtml(u.headword)}</span><span class="tag">${escapeHtml(
            u.tag,
          )}</span><span class="note">${escapeHtml(u.note)}</span></li>`;
        })
        .join('')}</ul>`
    : '';
  return `
    <p class="saved__text">${escapeHtml(item.text).replace(/\n/g, '<br>')}</p>
    ${item.zh ? `<p class="passage__zh">${escapeHtml(item.zh)}</p>` : ''}
    ${score}
    ${usage}
    ${notes(item)}`;
}

function row(item: SavedPassage): string {
  const open = rowOpen === item.id;
  const confirming = confirmId === item.id;
  // 只有示范、且当时没生成过讲解，才需要补分析；自己写那篇的分析是逐词判定，已经存着了。
  const askable = item.kind === 'model' && !item.explanation;
  const failed = analyzeNote.get(item.id);
  return `
    <li class="saved__item" id="saved-${item.id}">
      <div class="saved__top">
        <span class="badge">${item.kind === 'model' ? 'AI 示范' : '我的习作'}</span>
        <span class="saved__title">${escapeHtml(item.title)}</span>
        <span class="saved__meta">${escapeHtml(item.lengthLabel)} · ${day(item.savedAt)}${
          item.explanation ? ' · 已带讲解' : ''
        }</span>
        ${
          askable
            ? `<button type="button" class="btn btn--sm btn--secondary" id="saved-ask-${item.id}" ${
                analyzing ? 'disabled' : ''
              }>${analyzing === item.id ? '分析中…' : '补分析'}</button>`
            : ''
        }
        <button type="button" class="btn btn--sm btn--secondary" id="saved-open-${item.id}"
          aria-expanded="${open}" aria-controls="saved-body-${item.id}">${open ? '收起' : '打开'}</button>
        <button type="button" class="btn btn--sm btn--secondary" id="saved-copy-${item.id}">复制</button>
        <button type="button" class="btn btn--sm btn--secondary" id="saved-del-${item.id}" ${
          confirming ? 'data-confirm="1"' : ''
        }>${confirming ? '确认删除' : '删除'}</button>
      </div>
      ${failed ? `<p class="hint warn">补分析没走成：${escapeHtml(failed)}。再点一次「补分析」。</p>` : ''}
      <div class="saved__body" id="saved-body-${item.id}" ${open ? '' : 'hidden'}>${open ? body(item) : ''}</div>
    </li>`;
}

function page(items: SavedPassage[]): string {
  if (!items.length) {
    return `
      <div class="saved__head">
        <h2 id="saved-h">习作集</h2>
        <p class="sub">这里放你自己存下来的 AI 示范和写过的段落。</p>
      </div>
      <p class="hint">还没有存过。读完示范或拿到点评之后，点结果卡头上的「保存这篇」就会进这里。</p>
      <div class="row">
        <button type="button" class="btn btn--secondary btn--sm" id="saved-go-write">去写作</button>
        <span class="hint">存下来的东西只在这台设备的浏览器里，不上传。</span>
      </div>`;
  }
  return `
    <div class="saved__head">
      <h2 id="saved-h">习作集</h2>
      <span class="badge">${items.length} 篇</span>
      <p class="sub">存在这台设备的浏览器里，换浏览器或清掉站点数据就看不到。</p>
    </div>
    <ul class="saved__list">${items.map(row).join('')}</ul>`;
}

export function mountSavedPanel(
  root: HTMLElement,
  onGoWrite: () => void,
  onCountChanged: () => void,
): SavedPanel {
  async function analyze(id: string): Promise<void> {
    const item = loadSaved().find((saved) => saved.id === id);
    if (!item) return;
    analyzing = id;
    analyzeNote.delete(id);
    redraw();
    const result = await requestExplainTerms(item.text, item.terms);
    analyzing = null;
    // 本地兜底那份没有译文，存下来只会把「补分析」藏掉，所以失败就照实说。
    if (result.degraded || !result.data.sentences.some((note) => note.zh || note.structure)) {
      analyzeNote.set(id, result.degraded ?? 'AI 这次没给出讲解');
      redraw();
      return;
    }
    setSavedExplanation(id, result.data);
    rowOpen = id;
    redraw();
  }

  function redraw(): void {
    const items = loadSaved();
    root.innerHTML = page(items);
    // 顶栏那档也显示篇数，在这里删掉一篇后徽标不能停在旧数字上。
    onCountChanged();
    root.querySelector<HTMLButtonElement>('#saved-go-write')?.addEventListener('click', onGoWrite);
    root.querySelectorAll<HTMLButtonElement>('[id^="saved-open-"]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.id.slice('saved-open-'.length);
        rowOpen = rowOpen === id ? null : id;
        redraw();
        // 重绘会重建按钮，焦点跟回去才不至于按完一次再点就跑别处。
        root.querySelector<HTMLButtonElement>(`#saved-open-${id}`)?.focus();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[id^="saved-ask-"]').forEach((button) => {
      button.addEventListener('click', () => {
        if (analyzing) return;
        void analyze(button.id.slice('saved-ask-'.length));
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[id^="saved-copy-"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const item = items.find((i) => i.id === button.id.slice('saved-copy-'.length));
        if (!item) return;
        const label = button.textContent ?? '复制';
        try {
          await navigator.clipboard.writeText(savedClip(item));
          button.textContent = '已复制';
        } catch {
          button.textContent = '没复制到剪贴板，打开这篇自己选中复制';
        }
        setTimeout(() => {
          button.textContent = label;
        }, 1800);
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[id^="saved-del-"]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.id.slice('saved-del-'.length);
        if (confirmId !== id) {
          confirmId = id;
          button.dataset.confirm = '1';
          button.textContent = '确认删除';
          return;
        }
        confirmId = null;
        rowOpen = null;
        analyzeNote.delete(id);
        removeSaved(id);
        redraw();
      });
    });
  }

  redraw();
  return { redraw };
}
