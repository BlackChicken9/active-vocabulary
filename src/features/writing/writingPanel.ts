import type { Feedback, MasteryStatus, Submission, Word, WritingTask } from '../../types';
import { escapeHtml } from '../../escapeHtml';
import { loadWords } from '../words/wordStore';
import { advanceMastery, type MasteryChange } from './masteryUpdate';
import { generateMockFeedback } from './mockFeedback';
import { createTask, MAX_TARGET_WORDS, MIN_TARGET_WORDS, setStatus } from './taskStore';

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

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function mountWritingPanel(root: HTMLElement, onMasteryChanged: () => void): void {
  let selected: string[] = [];
  let task: WritingTask | null = null;
  let feedback: Feedback | null = null;
  let advanced: MasteryChange[] = [];
  let draftText = '';

  function chips(words: Word[], ids: string[], interactive: boolean): string {
    return words
      .map((word) => {
        const on = ids.includes(word.id);
        const atMax = selected.length >= MAX_TARGET_WORDS;
        const disabled = !interactive || (atMax && !on);
        return `<button type="button" class="chip ${on ? 'on' : ''}" data-id="${word.id}"
          ${disabled ? 'disabled' : ''}>
          <span class="hw">${escapeHtml(word.headword)}</span>
          <span class="zh">${escapeHtml(word.meaningZh)}</span>
          <span class="badge">${masteryZh[word.mastery]}</span>
        </button>`;
      })
      .join('');
  }

  function renderFeedback(): string {
    if (!feedback) return '';
    const written =
      advanced.length === 0
        ? '<p class="mastery">本篇没有词进入「会用」——目标词要用得地道才算数。</p>'
        : `<p class="mastery">掌握度回写：${advanced
            .map((c) => `${escapeHtml(c.headword)} ${masteryZh[c.from]} → ${masteryZh[c.to]}`)
            .join(' · ')}</p>`;
    return `
      <div class="feedback">
        <p class="score">用词得分 ${feedback.accuracy} · ${escapeHtml(feedback.overall)}</p>
        <ul>${feedback.usages
          .map(
            (u) =>
              `<li class="${u.used && u.natural ? 'ok' : u.used ? 'warn' : 'miss'}">${escapeHtml(u.note)}</li>`,
          )
          .join('')}</ul>
        ${written}
      </div>`;
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
        <textarea id="draft" rows="6" placeholder="在这里写你的英文段落…">${escapeHtml(draftText)}</textarea>
        <div class="row">
          <button type="button" id="submit">提交并获取反馈</button>
          <button type="button" id="reset" class="ghost">换一批目标词</button>
          <span class="hint" id="count">${wordCount(draftText)} 词</span>
        </div>`
            : '<p class="hint">先在上方勾选目标词，再生成任务。</p>'
        }
        ${renderFeedback()}
      </section>`;

    root.querySelectorAll<HTMLButtonElement>('.chips [data-id]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.id!;
        selected = selected.includes(id)
          ? selected.filter((s) => s !== id)
          : [...selected, id];
        render();
      });
    });

    root.querySelector<HTMLButtonElement>('#generate')?.addEventListener('click', () => {
      task = createTask(loadWords(), selected);
      feedback = null;
      advanced = [];
      draftText = '';
      render();
    });

    root.querySelector<HTMLButtonElement>('#reset')?.addEventListener('click', () => {
      task = null;
      feedback = null;
      advanced = [];
      draftText = '';
      render();
    });

    const draft = root.querySelector<HTMLTextAreaElement>('#draft');
    const count = root.querySelector<HTMLElement>('#count');
    draft?.addEventListener('input', () => {
      draftText = draft.value;
      if (count) count.textContent = `${wordCount(draftText)} 词`;
    });

    root.querySelector<HTMLButtonElement>('#submit')?.addEventListener('click', () => {
      if (!task) return;
      const taskId = task.id;
      const submission: Submission = {
        id: crypto.randomUUID(),
        taskId,
        text: draftText,
        wordIdsUsed: [],
      };
      feedback = generateMockFeedback(task, submission, loadWords());
      advanced = advanceMastery(feedback);
      setStatus(taskId, 'reviewed');
      task = { ...task, status: 'reviewed' };
      onMasteryChanged();
      render();
    });
  }

  render();
}
