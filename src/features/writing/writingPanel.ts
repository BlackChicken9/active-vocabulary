import type { Feedback, MasteryStatus, Submission, Word, WordUsage, WritingTask } from '../../types';
import { escapeHtml } from '../../escapeHtml';
import { loadWords } from '../words/wordStore';
import { requestFeedback, requestModelText } from './aiClient';
import { advanceMastery, markTraining, type MasteryChange } from './masteryUpdate';
import { createTask, MAX_TARGET_WORDS, MIN_TARGET_WORDS, sentenceTarget, setStatus } from './taskStore';
import type { ModelText } from './modelText';

const masteryZh: Record<MasteryStatus, string> = {
  passive: '认识',
  training: '练用中',
  active: '会用',
};

const statusZh: Record<WritingTask['status'], string> = {
  drafting: '待写',
  submitted: '已提交',
  reviewed: '已点评',
};

type Mode = 'model' | 'self';

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function changeLine(changes: MasteryChange[]): string {
  return changes.map((c) => `${escapeHtml(c.headword)} ${masteryZh[c.from]} → ${masteryZh[c.to]}`).join(' · ');
}

function usageTag(usage: WordUsage): string {
  if (usage.used && usage.natural) return '用出且地道';
  if (usage.used) return '用出但生硬';
  return '没用到';
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 在已转义的正文里把目标词包成 <mark>，headword 只含英文字母，转义后仍是原样。 */
function highlight(text: string, headwords: string[]): string {
  let html = escapeHtml(text);
  for (const headword of headwords) {
    const safe = escapeHtml(headword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(`\\b(${safe})\\b`, 'gi'), '<mark>$1</mark>');
  }
  return html;
}

export function mountWritingPanel(root: HTMLElement, onMasteryChanged: () => void): void {
  let selected: string[] = [];
  let task: WritingTask | null = null;
  let mode: Mode = 'self';
  let model: ModelText | null = null;
  let trained: MasteryChange[] = [];
  let feedback: Feedback | null = null;
  let advanced: MasteryChange[] = [];
  let draftText = '';
  let busy: 'model' | 'self' | null = null;
  let modelEngine: string | null = null;
  let feedbackEngine: string | null = null;

  function resetOutput(): void {
    model = null;
    trained = [];
    feedback = null;
    advanced = [];
    draftText = '';
    mode = 'self';
    busy = null;
    modelEngine = null;
    feedbackEngine = null;
  }

  function engineLine(source: string | null): string {
    return `<p class="engine">${
      source ? `兜底原因：${escapeHtml(source)}` : '来源：AI 网关（非本地 mock）'
    }</p>`;
  }

  function chips(words: Word[], ids: string[], interactive: boolean): string {
    return words
      .map((word) => {
        const on = ids.includes(word.id);
        const disabled = !interactive || (selected.length >= MAX_TARGET_WORDS && !on);
        return `<button type="button" class="chip ${on ? 'on' : ''}" data-id="${word.id}"
          ${disabled ? 'disabled' : ''}>
          <span class="hw">${escapeHtml(word.headword)}</span>
          <span class="zh">${escapeHtml(word.meaningZh)}</span>
          <span class="badge">${masteryZh[word.mastery]}</span>
        </button>`;
      })
      .join('');
  }

  function renderModel(words: Word[]): string {
    if (busy === 'model') return '<p class="hint">AI 正在按题干写示范…</p>';
    if (!model) return '<p class="hint">点上方「读 AI 示范短文」生成一段把目标词用出来的示范。</p>';
    const headwords = words.filter((w) => model!.wordIds.includes(w.id)).map((w) => w.headword);
    return `
      <div class="passage">
        <p class="text">${highlight(model.text, headwords)}</p>
        ${engineLine(modelEngine)}
        <p class="mastery">${
          trained.length
            ? `示范已读，掌握度回写：${changeLine(trained)}`
            : '这些词此前已在「练用中」或「会用」，状态不变。'
        }</p>
        <p class="hint">读示范只到「练用中」；切到「我自己写句子」用出且搭配地道，才会计入「会用」。</p>
      </div>`;
  }

  function renderSelf(words: Word[]): string {
    const feedbackBlock = feedback
      ? `
      <div class="feedback">
        <div class="scoreline">
          <span class="score">用词得分 ${clampScore(feedback.accuracy)}</span>
          <span class="bar" role="img" aria-label="用词得分 ${clampScore(feedback.accuracy)} 分（满分 100）">
            <span class="fill" style="width:${clampScore(feedback.accuracy)}%"></span>
          </span>
        </div>
        <p class="overall">${escapeHtml(feedback.overall)}</p>
        ${engineLine(feedbackEngine)}
        <ul class="usage">${feedback.usages
          .map((u) => {
            const headword = words.find((w) => w.id === u.wordId)?.headword ?? u.wordId;
            return `<li class="${u.used && u.natural ? 'ok' : u.used ? 'warn' : 'miss'}">
              <span class="hw">${escapeHtml(headword)}</span>
              <span class="tag">${usageTag(u)}</span>
              <span class="note">${escapeHtml(u.note)}</span>
            </li>`;
          })
          .join('')}</ul>
        <p class="mastery ${advanced.length ? '' : 'none'}">${
          advanced.length
            ? `掌握度回写：${changeLine(advanced)}`
            : '本篇没有词进入「会用」——目标词要用得地道才算数。'
        }</p>
      </div>`
      : '';
    return `
      <p class="sub">写 ${sentenceTarget(task?.targetWordIds.length ?? 0)}，把 ${task?.targetWordIds.length ?? 0} 个目标词都用出来即可提交。</p>
      <textarea id="draft" rows="4" placeholder="写一两句英文，把目标词用进去…">${escapeHtml(draftText)}</textarea>
      <div class="row">
        <button type="button" id="submit" ${busy === 'self' ? 'disabled' : ''}>${
          busy === 'self' ? 'AI 正在点评…' : '提交并获取反馈'
        }</button>
        <span class="hint" id="count">${wordCount(draftText)} 词</span>
      </div>
      ${feedbackBlock}`;
  }

  function render(): void {
    const words = loadWords();
    const active = task;
    const enough = selected.length >= MIN_TARGET_WORDS;
    root.innerHTML = `
      <section class="panel">
        <h2>限定写作任务</h2>
        <p class="sub">勾选 ${MIN_TARGET_WORDS}~${MAX_TARGET_WORDS} 个想练的词，系统按词出题（当前 ${selected.length} 个）</p>
        <div class="chips">${chips(words, selected, true)}</div>
        <div class="row">
          <button type="button" id="generate" ${enough ? '' : 'disabled'}>生成写作任务</button>
          ${enough ? '' : `<span class="hint">至少选 ${MIN_TARGET_WORDS} 个词</span>`}
        </div>
      </section>
      <section class="panel">
        ${
          active
            ? `
        <div class="task">
          <h3>${escapeHtml(active.title)}<span class="badge">${statusZh[active.status]}</span></h3>
          <p class="prompt">${escapeHtml(active.prompt).replace(/\n/g, '<br>')}</p>
          <div class="targets">目标词：${chips(
            words.filter((w) => active.targetWordIds.includes(w.id)),
            active.targetWordIds,
            false,
          )}</div>
        </div>
        <div class="seg">
          <button type="button" id="mode-model" class="seg-btn ${mode === 'model' ? 'on' : ''}">读 AI 示范短文</button>
          <button type="button" id="mode-self" class="seg-btn ${mode === 'self' ? 'on' : ''}">我自己写句子</button>
        </div>
        ${mode === 'model' ? renderModel(words) : renderSelf(words)}`
            : '<p class="hint">先在上方勾选目标词，再生成任务。</p>'
        }
        ${
          active
            ? `<div class="row">
          <button type="button" id="reset" class="ghost">换一批目标词</button>
        </div>`
            : ''
        }
      </section>`;

    root.querySelectorAll<HTMLButtonElement>('.chips [data-id]').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (busy) return;
        const id = chip.dataset.id!;
        selected = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
        render();
      });
    });

    root.querySelector<HTMLButtonElement>('#generate')?.addEventListener('click', () => {
      if (busy) return;
      task = createTask(loadWords(), selected);
      resetOutput();
      render();
    });

    root.querySelector<HTMLButtonElement>('#reset')?.addEventListener('click', () => {
      if (busy) return;
      task = null;
      selected = [];
      resetOutput();
      render();
    });

    root.querySelector<HTMLButtonElement>('#mode-model')?.addEventListener('click', async () => {
      if (!task || busy) return;
      const active = task;
      mode = 'model';
      if (!model) {
        busy = 'model';
        render();
        const result = await requestModelText(active, loadWords());
        model = result.data;
        modelEngine = result.degraded;
        trained = markTraining(result.data.wordIds);
        busy = null;
        onMasteryChanged();
      }
      render();
    });

    root.querySelector<HTMLButtonElement>('#mode-self')?.addEventListener('click', () => {
      if (busy) return;
      mode = 'self';
      render();
    });

    const draft = root.querySelector<HTMLTextAreaElement>('#draft');
    const count = root.querySelector<HTMLElement>('#count');
    draft?.addEventListener('input', () => {
      draftText = draft.value;
      if (count) count.textContent = `${wordCount(draftText)} 词`;
    });

    root.querySelector<HTMLButtonElement>('#submit')?.addEventListener('click', async () => {
      if (!task || busy) return;
      const active = task;
      const submission: Submission = {
        id: crypto.randomUUID(),
        taskId: active.id,
        text: draftText,
        wordIdsUsed: [],
      };
      busy = 'self';
      render();
      const result = await requestFeedback(active, submission, loadWords());
      feedback = result.data;
      feedbackEngine = result.degraded;
      advanced = advanceMastery(result.data);
      setStatus(active.id, 'reviewed');
      task = { ...active, status: 'reviewed' };
      busy = null;
      onMasteryChanged();
      render();
    });
  }

  render();
}
