import type { Feedback, MasteryStatus, Submission, Word, WritingTask } from '../../types';
import { escapeHtml } from '../../escapeHtml';
import { loadWords } from '../words/wordStore';
import { advanceMastery, markTraining, type MasteryChange } from './masteryUpdate';
import { generateMockFeedback } from './mockFeedback';
import { generateModelText, type ModelText } from './modelText';
import { createTask, MAX_TARGET_WORDS, MIN_TARGET_WORDS, sentenceTarget, setStatus } from './taskStore';

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

export function mountWritingPanel(root: HTMLElement, onMasteryChanged: () => void): void {
  let selected: string[] = [];
  let task: WritingTask | null = null;
  let mode: Mode = 'self';
  let model: ModelText | null = null;
  let trained: MasteryChange[] = [];
  let feedback: Feedback | null = null;
  let advanced: MasteryChange[] = [];
  let draftText = '';

  function resetOutput(): void {
    model = null;
    trained = [];
    feedback = null;
    advanced = [];
    draftText = '';
    mode = 'self';
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

  function renderModel(): string {
    if (!model) return '';
    return `
      <div class="passage">
        <p class="text">${escapeHtml(model.text)}</p>
        <p class="mastery">${
          trained.length
            ? `示范已读，掌握度回写：${changeLine(trained)}`
            : '这些词此前已在「练用中」或「会用」，状态不变。'
        }</p>
        <p class="hint">读示范只到「练用中」；切到「我自己写句子」用出且搭配地道，才会计入「会用」。</p>
      </div>`;
  }

  function renderSelf(): string {
    const feedbackBlock = feedback
      ? `
      <div class="feedback">
        <p class="score">用词得分 ${feedback.accuracy} · ${escapeHtml(feedback.overall)}</p>
        <ul>${feedback.usages
          .map(
            (u) =>
              `<li class="${u.used && u.natural ? 'ok' : u.used ? 'warn' : 'miss'}">${escapeHtml(u.note)}</li>`,
          )
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
        <button type="button" id="submit">提交并获取反馈</button>
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
        ${mode === 'model' ? renderModel() : renderSelf()}`
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
        const id = chip.dataset.id!;
        selected = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
        render();
      });
    });

    root.querySelector<HTMLButtonElement>('#generate')?.addEventListener('click', () => {
      task = createTask(loadWords(), selected);
      resetOutput();
      render();
    });

    root.querySelector<HTMLButtonElement>('#reset')?.addEventListener('click', () => {
      task = null;
      selected = [];
      resetOutput();
      render();
    });

    root.querySelector<HTMLButtonElement>('#mode-model')?.addEventListener('click', () => {
      if (!task) return;
      if (!model) {
        model = generateModelText(task, loadWords());
        trained = markTraining(model.wordIds);
        onMasteryChanged();
      }
      mode = 'model';
      render();
    });

    root.querySelector<HTMLButtonElement>('#mode-self')?.addEventListener('click', () => {
      mode = 'self';
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
