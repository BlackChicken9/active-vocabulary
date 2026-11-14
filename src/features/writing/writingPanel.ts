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
type Path = 'a' | 'b';

const ARROW = `<svg class="m-arrow" viewBox="0 0 12 12" aria-hidden="true"><path class="m-arrow__stem" d="M1 6h7"/><path class="m-arrow__head" d="M5.5 2.5 9 6l-3.5 3.5"/></svg>`;

const CHECK = `<span class="word__check" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M2.5 6.2 4.8 8.5 9.5 3.5"/></svg></span>`;

const PATH_COPY: Record<Path, { title: string; text: string; ceiling: MasteryStatus }> = {
  a: {
    title: '读 AI 示范短文',
    text: '按上面的篇幅现写一段，目标词高亮，看它们在真实句子里怎么搭配。',
    ceiling: 'training',
  },
  b: {
    title: '我自己写',
    text: '同一篇幅要求，AI 逐词点评搭配与语气，指出哪个词用出了、哪个还生硬。',
    ceiling: 'active',
  },
};

function pathButton(path: Path): string {
  const copy = PATH_COPY[path];
  return `
    <button type="button" class="card path" id="path-${path}" data-path="${path}" aria-pressed="false">
      <span class="path__key" aria-hidden="true">${path.toUpperCase()}</span>
      <span class="path__body">
        <span class="path__title">${copy.title}</span>
        <span class="path__text">${copy.text}</span>
        <span class="path__ceil"><i class="dot ${copy.ceiling}" aria-hidden="true"></i>最高到「${masteryZh[copy.ceiling]}」</span>
      </span>
      ${ARROW}
    </button>`;
}

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

export function mountWritingPanel(
  bankRoot: HTMLElement,
  deskRoot: HTMLElement,
  onMasteryChanged: () => void,
): void {
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
  let intakeOpen = loadWords().length === 0;
  let intakeRaw = '';
  let intakeNote: string | null = null;
  let lengthChoice: LengthChoice = 'auto';
  let lengthNote: string | null = null;

  deskRoot.innerHTML = `
    <div class="desk__head">
      <h2 id="desk-h">限定写作</h2>
      <p class="sub">选篇幅，然后点 A 读示范或点 B 自己写——题目跟着你勾的词走。</p>
    </div>
    <div class="card setup m-nolift">
      <div id="lengthbar"></div>
      <div class="paths" id="paths" data-active="none" role="group" aria-label="两条练习路径">
        <span class="m-tab-ind" aria-hidden="true"></span>
        ${pathButton('a')}
        ${pathButton('b')}
      </div>
      <p class="hint path-hint" id="path-hint"></p>
    </div>
    <div id="work-slot"></div>`;

  const pathsBox = deskRoot.querySelector<HTMLElement>('#paths')!;
  const indicator = pathsBox.querySelector<HTMLElement>('.m-tab-ind')!;
  const lengthBar = deskRoot.querySelector<HTMLElement>('#lengthbar')!;
  const pathHint = deskRoot.querySelector<HTMLElement>('#path-hint')!;
  const workSlot = deskRoot.querySelector<HTMLElement>('#work-slot')!;
  let placed = false;

  /** 滑块按目标卡片的实测像素走：百分比 translate 在 Chrome 里会卡住不动。 */
  function placeIndicator(): void {
    if (!task) return;
    const btn = pathsBox.querySelector<HTMLButtonElement>(`#path-${mode === 'model' ? 'a' : 'b'}`)!;
    const jump = !placed;
    if (jump) indicator.classList.add('is-jump');
    indicator.style.setProperty('--w', `${btn.offsetWidth}px`);
    indicator.style.setProperty('--h', `${btn.offsetHeight}px`);
    indicator.style.setProperty('--x', `${btn.offsetLeft}px`);
    indicator.style.setProperty('--y', `${btn.offsetTop}px`);
    placed = true;
    if (jump) requestAnimationFrame(() => indicator.classList.remove('is-jump'));
  }

  new ResizeObserver(() => {
    if (!placed) return;
    indicator.classList.add('is-jump');
    placeIndicator();
    requestAnimationFrame(() => indicator.classList.remove('is-jump'));
  }).observe(pathsBox);

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

  function sameSelection(): boolean {
    return task !== null && [...task.targetWordIds].sort().join('|') === [...selected].sort().join('|');
  }

  function statsLine(text: string, spec: PassageLength): string {
    const sentences = countSentences(text);
    const words = wordCount(text);
    const state = lengthState(spec, sentences, words);
    return `<span class="stats ${state}">${sentences} 句 · ${words} 词 · ${LENGTH_STATE_ZH[state]}（目标 ${lengthLine(spec)}）</span>`;
  }

  function engineLine(source: string | null): string {
    return `<p class="engine">${
      source ? `兜底原因：${escapeHtml(source)}` : '来源：AI 网关（非本地 mock）'
    }</p>`;
  }

  function lengthBlock(): string {
    const spec = currentSpec();
    const count = task ? task.targetWordIds.length : selected.length;
    const basis = task
      ? '当前任务'
      : lengthChoice === 'auto'
        ? selected.length
          ? `按 ${selected.length} 个词自动`
          : '按勾选词数自动'
        : '固定篇幅';
    const crowded = count > spec.maxSentences;
    return `
      <div class="lengthbar">
        <div class="lengthbar__top">
          <span class="lengthbar__label" id="length-label">篇幅</span>
          <div class="seg" role="group" aria-labelledby="length-label">
            ${LENGTH_OPTIONS.map(
              (option) => `<button type="button" class="seg-btn" id="len-${option.id}"
                data-length="${option.id}" ${busy ? 'disabled' : ''} aria-pressed="${lengthChoice === option.id}">
                <strong>${option.label}</strong><small>${option.hint}</small>
              </button>`,
            ).join('')}
          </div>
        </div>
        <p class="hint">${basis}：${lengthLine(spec)} · A 与 B 共用这一篇幅</p>
        ${
          crowded
            ? `<p class="hint warn">${count} 个词挤进 ${spec.minSentences}~${spec.maxSentences} 句容易偏长，换「自动」或更长的档更稳。</p>`
            : ''
        }
      </div>`;
  }

  function wordRow(word: Word): string {
    const on = selected.includes(word.id);
    const disabled = busy !== null || (selected.length >= MAX_TARGET_WORDS && !on);
    const meaning = word.meaningZh.trim();
    return `
      <li>
        <button type="button" class="word" id="w-${word.id}" data-id="${word.id}"
          aria-pressed="${on}" ${disabled ? 'disabled' : ''}>
          ${CHECK}
          <span class="word__body">
            <span class="word__hw">${escapeHtml(word.headword)}</span>
            <span class="word__zh ${meaning ? '' : 'empty'}">${escapeHtml(meaning || '释义待补')}</span>
          </span>
          <span class="badge ${word.mastery}"><i class="dot ${word.mastery}" aria-hidden="true"></i>${masteryZh[word.mastery]}</span>
        </button>
      </li>`;
  }

  /** 产品的正门：词库不是我们预设的，而是用户把自己正在背的词粘进来。 */
  function intakeBlock(empty: boolean): string {
    const open = intakeOpen || empty;
    // 空词库且框里还没字时，唯一能点的就是样例：让它亮着，别把唯一入口画成次要按钮。
    const sampleLead = empty && !intakeRaw.trim();
    return `
      <div class="intake">
        <div class="intake__bar">
          ${
            empty
              ? `<button type="button" class="btn ${sampleLead ? 'btn--primary' : 'btn--secondary'} btn--sm" id="intake-sample" ${
                  busy ? 'disabled' : ''
                }>试试粘这段</button>`
              : `<button type="button" class="btn btn--secondary btn--sm" id="intake-toggle" ${
                  busy ? 'disabled' : ''
                }>${intakeOpen ? '收起粘贴区' : '粘贴你正在背的词'}</button>`
          }
        </div>
        ${
          open
            ? `
        <label class="hint" for="intake-raw">一串单词、一段带释义的笔记都行，不用管格式</label>
        <textarea id="intake-raw" rows="3" placeholder="直接粘贴，AI 会整理成词卡…">${escapeHtml(intakeRaw)}</textarea>
        <div class="intake__bar">
          <button type="button" class="btn btn--primary btn--sm" id="intake-run" ${
            busy === 'intake' || !intakeRaw.trim() ? 'disabled' : ''
          }>${busy === 'intake' ? 'AI 正在整理词卡…' : '整理成词卡'}</button>
          <span class="hint">一次最多 30 条，已在词库的词头会跳过</span>
        </div>`
            : ''
        }
        ${intakeNote ? `<p class="engine">${intakeNote}</p>` : ''}
      </div>`;
  }

  function renderBank(words: Word[]): void {
    bankRoot.innerHTML = `
      <div class="bank__head">
        <h2 id="bank-h">我的词库</h2>
        <span class="bank__count">${words.length} 词</span>
      </div>
      <p class="sub">勾 ${MIN_TARGET_WORDS}~${MAX_TARGET_WORDS} 个想练的词，右边按这批词出题。</p>
      ${intakeBlock(words.length === 0)}
      ${
        words.length
          ? `<ul class="words">${words.map(wordRow).join('')}</ul>
             <div class="bank__foot"><p class="hint">已选 ${selected.length}/${MAX_TARGET_WORDS} · 掌握度只升不降</p></div>`
          : ''
      }`;

    bankRoot.querySelectorAll<HTMLButtonElement>('.word').forEach((row) => {
      row.addEventListener('click', () => {
        if (busy) return;
        const id = row.dataset.id!;
        selected = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
        render();
      });
    });

    bankRoot.querySelector<HTMLButtonElement>('#intake-toggle')?.addEventListener('click', () => {
      if (busy) return;
      intakeOpen = !intakeOpen;
      render();
    });

    bankRoot.querySelector<HTMLButtonElement>('#intake-sample')?.addEventListener('click', () => {
      if (busy) return;
      intakeRaw = INTAKE_SAMPLE;
      intakeOpen = true;
      render();
    });

    const rawBox = bankRoot.querySelector<HTMLTextAreaElement>('#intake-raw');
    rawBox?.addEventListener('input', () => {
      intakeRaw = rawBox.value;
      const run = bankRoot.querySelector<HTMLButtonElement>('#intake-run');
      if (run) run.disabled = busy === 'intake' || !intakeRaw.trim();
      const sample = bankRoot.querySelector<HTMLButtonElement>('#intake-sample');
      if (sample) {
        const lead = !intakeRaw.trim();
        sample.classList.toggle('btn--primary', lead);
        sample.classList.toggle('btn--secondary', !lead);
      }
    });

    bankRoot.querySelector<HTMLButtonElement>('#intake-run')?.addEventListener('click', async () => {
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
      const degradedLine = outcome.degraded ? `<br>兜底原因：${escapeHtml(outcome.degraded)}` : '';
      intakeNote = outcome.added.length
        ? `已加入 ${outcome.added.length} 个词：${names}${outcome.added.length > 6 ? ' 等' : ''}${skippedLine}，已替你勾好，点 A 或 B 开始。${degradedLine}`
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
  }

  function renderModel(words: Word[], spec: PassageLength): string {
    if (busy === 'model') {
      return '<p class="busy"><span class="spinner" aria-hidden="true"></span>AI 正在按题干与篇幅写示范…</p>';
    }
    if (!model) return '<p class="hint">点上面的 A，按当前篇幅生成一段把目标词用出来的示范。</p>';
    const headwords = words.filter((w) => model!.wordIds.includes(w.id)).map((w) => w.headword);
    return `
      <div class="passage">
        <p class="passage__text">${highlight(model.text, headwords)}</p>
        <p class="statsline">${statsLine(model.text, spec)}</p>
        ${engineLine(modelEngine)}
        <p class="mastery ${trained.length ? '' : 'none'}">${
          trained.length
            ? `示范已读，掌握度回写：${changeLine(trained)}`
            : '这些词此前已在「练用中」或「会用」，状态不变。'
        }</p>
        <p class="hint">读示范只到「练用中」。点 B 自己写一段，用出且搭配地道，才会计入「会用」。</p>
      </div>`;
  }

  function renderSelf(words: Word[], spec: PassageLength): string {
    const feedbackBlock = feedback
      ? `
      <div class="feedback">
        <div class="scoreline">
          <span class="score"><small>用词得分</small>${clampScore(feedback.accuracy)}</span>
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
      <div class="editor">
        <p class="sub">写 ${lengthLine(spec)}，把 ${task?.targetWordIds.length ?? 0} 个目标词都用出来即可提交。</p>
        <label class="hint" for="draft">你的段落</label>
        <textarea id="draft" rows="${Math.min(8, Math.max(3, spec.maxSentences))}" placeholder="按篇幅写英文，把目标词用进去…">${escapeHtml(draftText)}</textarea>
        <div class="editor__row">
          <span class="hint" id="count">${statsLine(draftText, spec)}</span>
          <button type="button" class="btn btn--primary" id="submit" ${busy === 'self' ? 'disabled' : ''}>${
            busy === 'self' ? 'AI 正在点评…' : '提交并获取反馈'
          }</button>
        </div>
      </div>
      ${feedbackBlock}`;
  }

  function ladderCard(): string {
    return `
      <section class="card work m-nolift" aria-label="掌握度怎么升">
        <div class="ladder">
          <h3>掌握度怎么升</h3>
          <div class="ladder__steps">
            <span class="ladder__step passive"><i class="dot" aria-hidden="true"></i>认识</span>
            <span class="ladder__arrow" aria-hidden="true">→</span>
            <span class="ladder__step training"><i class="dot training" aria-hidden="true"></i>练用中</span>
            <span class="ladder__arrow" aria-hidden="true">→</span>
            <span class="ladder__step active"><i class="dot active" aria-hidden="true"></i>会用</span>
          </div>
          <p class="sub">读一遍 AI 示范，词只到「练用中」；自己写一段、被点评判为用出且地道，才升到「会用」。掌握度只升不降。</p>
          <p class="hint">勾好词后点上面的 A 或 B，这里就会出现题目。</p>
        </div>
      </section>`;
  }

  function workCard(words: Word[], spec: PassageLength): string {
    if (!task) return ladderCard();
    const active = task;
    const targets = words.filter((w) => active.targetWordIds.includes(w.id));
    return `
      <section class="card work m-nolift" aria-label="当前写作任务">
        <div class="work__head">
          <div class="work__title">
            <h3>${escapeHtml(active.title)}</h3>
            <span class="badges">
              <span class="badge">${mode === 'model' ? 'A · 读示范' : 'B · 自己写'}</span>
              <span class="badge">${lengthLine(taskLength(active))}</span>
              <span class="badge">${statusZh[active.status]}</span>
            </span>
          </div>
          <p class="prompt">${escapeHtml(active.prompt).replace(/\n/g, '<br>')}</p>
          <div class="targets">
            <span class="targets__label">目标词</span>
            ${targets
              .map(
                (w) => `<span class="target"><b>${escapeHtml(w.headword)}</b><span>${escapeHtml(
                  w.meaningZh.trim() || '释义待补',
                )}</span></span>`,
              )
              .join('')}
          </div>
        </div>
        <div class="work__body">
          ${lengthNote ? `<p class="engine">${lengthNote}</p>` : ''}
          ${mode === 'model' ? renderModel(words, spec) : renderSelf(words, spec)}
        </div>
        <div class="row">
          <button type="button" class="btn btn--secondary btn--sm" id="reset" ${busy ? 'disabled' : ''}>换一批词</button>
          <span class="hint">回到左边重新勾词，再点 A 或 B。</span>
        </div>
      </section>`;
  }

  function pathHintLine(): string {
    if (busy === 'model') return 'AI 正在写示范，稍等一下。';
    if (!task) {
      return selected.length >= MIN_TARGET_WORDS
        ? `点 A 读示范，或点 B 自己写：两条路都按 ${lengthLine(currentSpec())} 出题。`
        : `先在左边勾 ${MIN_TARGET_WORDS}~${MAX_TARGET_WORDS} 个词，A 与 B 就可以点了。`;
    }
    if (sameSelection()) return 'A 与 B 随时切换，题目、示范与草稿都留着。';
    return selected.length >= MIN_TARGET_WORDS
      ? '左边勾选已改动：再点 A 或 B 会按新词重新出题。'
      : `勾选不足 ${MIN_TARGET_WORDS} 个，暂时按当前任务的词切换。`;
  }

  function renderDesk(words: Word[]): void {
    const spec = currentSpec();
    lengthBar.innerHTML = lengthBlock();
    pathHint.textContent = pathHintLine();
    pathsBox.dataset.active = task ? (mode === 'model' ? 'a' : 'b') : 'none';
    const pathsDisabled = busy !== null || (!task && selected.length < MIN_TARGET_WORDS);
    pathsBox.querySelectorAll<HTMLButtonElement>('.path').forEach((btn) => {
      const on = task !== null && (btn.dataset.path === 'a') === (mode === 'model');
      btn.setAttribute('aria-pressed', String(on));
      btn.disabled = pathsDisabled;
      btn.classList.toggle('m-nolift', on);
    });
    placeIndicator();
    workSlot.innerHTML = workCard(words, spec);

    lengthBar.querySelectorAll<HTMLButtonElement>('[data-length]').forEach((btn) => {
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

    deskRoot.querySelector<HTMLButtonElement>('#reset')?.addEventListener('click', () => {
      if (busy) return;
      task = null;
      selected = [];
      resetOutput();
      render();
      // 换词后这个按钮本身就消失了，把键盘焦点送到下一步要操作的地方。
      (bankRoot.querySelector<HTMLButtonElement>('.word') ??
        bankRoot.querySelector<HTMLButtonElement>('#intake-toggle'))?.focus();
    });

    const draft = deskRoot.querySelector<HTMLTextAreaElement>('#draft');
    const count = deskRoot.querySelector<HTMLElement>('#count');
    draft?.addEventListener('input', () => {
      draftText = draft.value;
      if (count) count.innerHTML = statsLine(draftText, spec);
    });

    deskRoot.querySelector<HTMLButtonElement>('#submit')?.addEventListener('click', async () => {
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

  /** A 与 B 就是出题按钮：没有任务时按当前勾选与篇幅建任务，已有任务时切换两条路。 */
  async function pathClick(path: Path): Promise<void> {
    if (busy) return;
    const next: Mode = path === 'a' ? 'model' : 'self';
    if (!sameSelection() && selected.length >= MIN_TARGET_WORDS) {
      task = createTask(loadWords(), selected, lengthChoice);
      resetOutput();
    }
    if (!task) return;
    mode = next;
    if (next === 'model' && !model) {
      const active = task;
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
    pathsBox.querySelector<HTMLButtonElement>(`#path-${path}`)?.focus();
  }

  pathsBox.querySelectorAll<HTMLButtonElement>('.path').forEach((btn) => {
    btn.addEventListener('click', () => {
      void pathClick(btn.dataset.path as Path);
    });
  });

  let refocus: { id: string; caret: number | null } | null = null;

  /** 整块重绘会换掉输入框，这里把焦点与光标放回原处，粘词和写作时手感不断。 */
  function render(): void {
    const focused = document.activeElement;
    const focusId = focused instanceof HTMLElement && focused.id ? focused.id : (refocus?.id ?? '');
    const caret =
      focused instanceof HTMLTextAreaElement ? focused.selectionStart : (refocus?.caret ?? null);
    const words = loadWords();
    renderBank(words);
    renderDesk(words);
    refocus = null;
    if (!focusId) return;
    const again = document.getElementById(focusId);
    if (!(again instanceof HTMLElement)) return;
    // 忙碌态的按钮是 disabled，focus() 会落空；留到它恢复可点的那次重绘再放回去。
    if ((again as HTMLButtonElement).disabled) {
      refocus = { id: focusId, caret };
      return;
    }
    if (again === focused) return;
    again.focus();
    if (caret !== null && again instanceof HTMLTextAreaElement) again.setSelectionRange(caret, caret);
  }

  render();
}