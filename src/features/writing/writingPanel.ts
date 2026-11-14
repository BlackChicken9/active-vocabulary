import type { Feedback, LengthChoice, MasteryStatus, PassageLength, Submission, Word, WordUsage, WritingTask } from '../../types';
import { escapeHtml } from '../../escapeHtml';
import { loadWords } from '../words/wordStore';
import { requestFeedback, requestModelText } from './aiClient';
import { importWords } from './intake';
import { INTAKE_SAMPLE } from './intakeSample';
import { advanceMastery, markTraining, type MasteryChange } from './masteryUpdate';
import {
  countSentences,
  LENGTH_OPTIONS,
  LENGTH_STATE_ZH,
  lengthLine,
  lengthState,
  passageSpec,
  taskLength,
} from './passageLength';
import { applyLength, createTask, MAX_TARGET_WORDS, MIN_TARGET_WORDS, setStatus } from './taskStore';
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

const PATHS_HTML = `
  <div class="paths">
    <div class="path">
      <span class="tag">路 A</span>
      <div><strong>读 AI 示范短文</strong><span>按所选篇幅现写一段，目标词高亮；读完最多到「练用中」</span></div>
    </div>
    <div class="path">
      <span class="tag">路 B</span>
      <div><strong>我自己写</strong><span>同一篇幅要求，AI 逐词点评；用出且地道才到「会用」</span></div>
    </div>
  </div>`;

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
  let busy: 'model' | 'self' | 'intake' | null = null;
  let modelEngine: string | null = null;
  let feedbackEngine: string | null = null;
  let intakeOpen = false;
  let intakeRaw = '';
  let intakeNote: string | null = null;
  let lengthChoice: LengthChoice = 'auto';
  let lengthNote: string | null = null;

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
    lengthNote = null;
  }

  function currentSpec(): PassageLength {
    return task ? taskLength(task) : passageSpec(lengthChoice, selected.length);
  }

  function statsLine(text: string, spec: PassageLength): string {
    const sentences = countSentences(text);
    const words = wordCount(text);
    const state = lengthState(spec, sentences, words);
    return `<span class="stats ${state}">${sentences} 句 · ${words} 词 · ${LENGTH_STATE_ZH[state]}（目标 ${lengthLine(spec)}）</span>`;
  }

  function lengthBlock(): string {
    const spec = currentSpec();
    const count = task ? task.targetWordIds.length : selected.length;
    const basis = task
      ? '当前任务'
      : lengthChoice === 'auto'
        ? `按 ${selected.length} 个词自动`
        : '固定篇幅';
    const crowded = count > spec.maxSentences;
    return `
      <div class="length">
        <div class="seg length-seg" role="group" aria-label="示范与自写的篇幅">
          ${LENGTH_OPTIONS.map(
            (option) => `<button type="button" class="seg-btn ${lengthChoice === option.id ? 'on' : ''}"
              data-length="${option.id}" ${busy ? 'disabled' : ''} aria-pressed="${lengthChoice === option.id}">
              <strong>${option.label}</strong><small>${option.hint}</small>
            </button>`,
          ).join('')}
        </div>
        <p class="hint">${basis}：${lengthLine(spec)} · AI 示范与自己写共用这一篇幅</p>
        ${
          crowded
            ? `<p class="hint warn">${count} 个词挤进 ${spec.minSentences}~${spec.maxSentences} 句容易偏长，换「自动」或更长的档更稳。</p>`
            : ''
        }
      </div>`;
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

  function renderModel(words: Word[], spec: PassageLength): string {
    if (busy === 'model') return '<p class="hint">AI 正在按题干与篇幅写示范…</p>';
    if (!model) return '<p class="hint">点上方「读 AI 示范短文」，按当前篇幅生成一段把目标词用出来的示范。</p>';
    const headwords = words.filter((w) => model!.wordIds.includes(w.id)).map((w) => w.headword);
    return `
      <div class="passage">
        <p class="text">${highlight(model.text, headwords)}</p>
        <p class="statsline">${statsLine(model.text, spec)}</p>
        ${engineLine(modelEngine)}
        <p class="mastery">${
          trained.length
            ? `示范已读，掌握度回写：${changeLine(trained)}`
            : '这些词此前已在「练用中」或「会用」，状态不变。'
        }</p>
        <p class="hint">读示范只到「练用中」；切到「我自己写句子」用出且搭配地道，才会计入「会用」。</p>
      </div>`;
  }

  function renderSelf(words: Word[], spec: PassageLength): string {
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
      <p class="sub">写 ${lengthLine(spec)}，把 ${task?.targetWordIds.length ?? 0} 个目标词都用出来即可提交。</p>
      <textarea id="draft" rows="${Math.min(8, Math.max(3, spec.maxSentences))}" placeholder="按篇幅写英文，把目标词用进去…">${escapeHtml(draftText)}</textarea>
      <div class="row">
        <button type="button" id="submit" ${busy === 'self' ? 'disabled' : ''}>${
          busy === 'self' ? 'AI 正在点评…' : '提交并获取反馈'
        }</button>
        <span class="hint" id="count">${statsLine(draftText, spec)}</span>
      </div>
      ${feedbackBlock}`;
  }

  /** 产品的正门：词库不是我们预设的，而是用户把自己正在背的词粘进来。 */
  function intakeBlock(empty: boolean): string {
    return `
      <div class="intake">
        <button type="button" id="intake-toggle" class="ghost">${
          intakeOpen ? '收起粘贴导入' : '粘贴你正在背的词'
        }</button>
        ${empty ? '<button type="button" id="intake-sample" class="ghost">试试粘这段</button>' : ''}
        ${
          intakeOpen
            ? `
        <textarea id="intake-raw" rows="3" placeholder="直接粘贴：一串单词、一段带释义的笔记都行，不用管格式…">${escapeHtml(
          intakeRaw,
        )}</textarea>
        <div class="row">
          <button type="button" id="intake-run" ${
            busy === 'intake' || !intakeRaw.trim() ? 'disabled' : ''
          }>${busy === 'intake' ? 'AI 正在整理词卡…' : '整理成词卡'}</button>
          <span class="hint">一次最多 30 条，已在词库里的词头会跳过</span>
        </div>`
            : ''
        }
        ${intakeNote ? `<p class="engine">${intakeNote}</p>` : ''}
      </div>`;
  }

  function render(): void {
    const words = loadWords();
    const active = task;
    const enough = selected.length >= MIN_TARGET_WORDS;
    const spec = currentSpec();
    root.innerHTML = `
      <section class="panel">
        <h2>限定写作任务</h2>
        <p class="sub">勾选 ${MIN_TARGET_WORDS}~${MAX_TARGET_WORDS} 个想练的词，系统按词出题（当前 ${selected.length} 个）</p>
        ${intakeBlock(words.length === 0)}
        ${
          words.length
            ? `<div class="chips">${chips(words, selected, true)}</div>`
            : '<p class="hint">词库还是空的：点「粘贴你正在背的词」把词粘进来，或点「试试粘这段」用样例走一遍。</p>'
        }
        ${PATHS_HTML}
        ${lengthBlock()}
        <div class="row">
          <button type="button" id="generate" ${enough ? '' : 'disabled'}>生成任务（AI 示范 / 自己写）</button>
          ${enough ? '' : `<span class="hint">至少选 ${MIN_TARGET_WORDS} 个词</span>`}
        </div>
      </section>
      <section class="panel">
        ${lengthNote ? `<p class="engine">${lengthNote}</p>` : ''}
        ${
          active
            ? `
        <div class="task">
          <h3>${escapeHtml(active.title)}<span class="badges"><span class="badge">${lengthLine(taskLength(active))}</span><span class="badge">${statusZh[active.status]}</span></span></h3>
          <p class="prompt">${escapeHtml(active.prompt).replace(/\n/g, '<br>')}</p>
          <div class="targets">目标词：${chips(
            words.filter((w) => active.targetWordIds.includes(w.id)),
            active.targetWordIds,
            false,
          )}</div>
        </div>
        <div class="seg mode-seg">
          <button type="button" id="mode-model" class="seg-btn ${mode === 'model' ? 'on' : ''}">
            <strong>读 AI 示范短文</strong><small>按篇幅现写 · 最多到「练用中」</small>
          </button>
          <button type="button" id="mode-self" class="seg-btn ${mode === 'self' ? 'on' : ''}">
            <strong>我自己写</strong><small>AI 逐词点评 · 用对才到「会用」</small>
          </button>
        </div>
        ${mode === 'model' ? renderModel(words, spec) : renderSelf(words, spec)}`
            : '<p class="hint">勾好词点「生成任务」，这里会在两条路之间切换：读 AI 示范短文，或你自己写。</p>'
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

    root.querySelector<HTMLButtonElement>('#intake-toggle')?.addEventListener('click', () => {
      if (busy) return;
      intakeOpen = !intakeOpen;
      render();
    });

    root.querySelector<HTMLButtonElement>('#intake-sample')?.addEventListener('click', () => {
      if (busy) return;
      intakeRaw = INTAKE_SAMPLE;
      intakeOpen = true;
      render();
    });

    const rawBox = root.querySelector<HTMLTextAreaElement>('#intake-raw');
    rawBox?.addEventListener('input', () => {
      intakeRaw = rawBox.value;
      const run = root.querySelector<HTMLButtonElement>('#intake-run');
      if (run) run.disabled = busy === 'intake' || !intakeRaw.trim();
    });

    root.querySelector<HTMLButtonElement>('#intake-run')?.addEventListener('click', async () => {
      if (busy || !intakeRaw.trim()) return;
      busy = 'intake';
      render();
      const outcome = await importWords(intakeRaw);
      const names = outcome.added
        .slice(0, 6)
        .map((word) => escapeHtml(word.headword))
        .join('、');
      const skippedLine = outcome.skipped.length
        ? `；跳过 ${outcome.skipped.length} 个已在词库里的词`
        : '';
      const degradedLine = outcome.degraded
        ? `<br>兜底原因：${escapeHtml(outcome.degraded)}`
        : '';
      intakeNote = outcome.added.length
        ? `已加入 ${outcome.added.length} 个词：${names}${outcome.added.length > 6 ? ' 等' : ''}${skippedLine}，已替你勾好，可以直接生成任务。${degradedLine}`
        : outcome.skipped.length
          ? `没有新词入库：粘的 ${outcome.skipped.length} 个词头都已经在词库里了。`
          : `没识别出词头，换一行一个词的写法再试一次。${degradedLine}`;
      if (outcome.added.length) {
        selected = outcome.added.slice(0, MAX_TARGET_WORDS).map((word) => word.id);
        intakeRaw = '';
      }
      busy = null;
      onMasteryChanged();
      render();
    });

    root.querySelectorAll<HTMLButtonElement>('[data-length]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (busy) return;
        const choice = btn.dataset.length as LengthChoice;
        if (choice === lengthChoice) return;
        lengthChoice = choice;
        if (task) {
          task = applyLength(task, choice);
          model = null;
          trained = [];
          feedback = null;
          advanced = [];
          modelEngine = null;
          feedbackEngine = null;
          const label = LENGTH_OPTIONS.find((o) => o.id === choice)?.label ?? choice;
          lengthNote = `篇幅已改为「${label}」（${lengthLine(taskLength(task))}）：示范与点评已清空，你的草稿保留。`;
        }
        render();
      });
    });

    root.querySelector<HTMLButtonElement>('#generate')?.addEventListener('click', () => {
      if (busy) return;
      task = createTask(loadWords(), selected, lengthChoice);
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
      if (count) count.innerHTML = statsLine(draftText, spec);
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
      lengthNote = null;
      busy = null;
      onMasteryChanged();
      render();
    });
  }

  render();
}
