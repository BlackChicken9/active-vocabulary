import type { Explanation, Feedback, LengthChoice, MasteryStatus, PassageLength, SentenceNote, SentencePart, Submission, Word, WordUsage, WritingTask } from '../../types';
import { escapeHtml } from '../../escapeHtml';
import { loadWords } from '../words/wordStore';
import { requestExplain, requestFeedback, requestModelText } from './aiClient';
import { advanceMastery, markTraining, type MasteryChange } from './masteryUpdate';
import { lemmaCandidates, roleClass, segmentSentence, splitSentences, tokenize } from './passage';
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
import { createWordPopover } from './wordPopover';

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

const PATH_COPY: Record<Path, { title: string; text: string; ceiling: MasteryStatus }> = {
  a: {
    title: '读 AI 示范短文',
    text: '按上面的篇幅现写一段，逐句给译文与句子结构，点任意单词看释义。',
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

/** 目标词在文中常是变位形态，按原形候选判断要不要标成目标词。 */
function targetKeys(words: Word[]): Set<string> {
  return new Set(words.flatMap((word) => lemmaCandidates(word.headword)));
}

function tokenButton(value: string, id: string, scope: string, isTarget: boolean): string {
  return `<button type="button" class="tok${isTarget ? ' is-target' : ''}" id="${id}" data-term="${escapeHtml(
    value,
  )}" data-si="${scope}" tabindex="-1">${escapeHtml(value)}</button>`;
}

/** 逐词渲染成可点按钮；成分对得上原句时，把同一成分的连续片段包进一个 span 供高亮。 */
function sentenceBody(
  sentence: string,
  parts: SentencePart[],
  scope: string,
  keys: Set<string>,
): string {
  const segments = segmentSentence(sentence, parts);
  const roleAt = (start: number, end: number): string | null => {
    if (!segments) return null;
    let at = 0;
    for (const segment of segments) {
      if (start >= at && end <= at + segment.text.length) {
        return segment.role ? roleClass(segment.role) : null;
      }
      at += segment.text.length;
    }
    return null;
  };
  let html = '';
  let open: string | null = null;
  let pos = 0;
  tokenize(sentence).forEach((token, index) => {
    const role = token.word ? roleAt(pos, pos + token.text.length) : open;
    if (role !== open) {
      if (open) html += '</span>';
      if (role) html += `<span class="part" data-role="${role}">`;
      open = role;
    }
    html += token.word
      ? tokenButton(
          token.text,
          `tok-${scope}-${index}`,
          scope,
          lemmaCandidates(token.text).some((key) => keys.has(key)),
        )
      : escapeHtml(token.text);
    pos += token.text.length;
  });
  if (open) html += '</span>';
  return html;
}

export interface WritingPanel {
  redraw: () => void;
  /** 词本刚收的新词补进本次目标词；已选满时把没放进去的 id 原样返回，由调用方如实提示。 */
  selectWords: (ids: string[]) => string[];
}

export function mountWritingPanel(
  bankRoot: HTMLElement,
  deskRoot: HTMLElement,
  onMasteryChanged: () => void,
  onOpenWords: () => void,
): WritingPanel {
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
  let lengthChoice: LengthChoice = 'auto';
  let lengthNote: string | null = null;
  let explain: Explanation | null = null;
  let explainBusy = false;
  let explainEngine: string | null = null;
  let passageView: 'whole' | 'sentences' = 'whole';
  let closedNotes = new Set<number>();
  let notePending = new Set<number>();
  let noteError = new Map<number, string>();

  const popover = createWordPopover({
    words: loadWords,
    glossary: () => explain?.glossary ?? [],
    onAdd: () => {
      onMasteryChanged();
      render();
    },
  });

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
    explain = null;
    explainBusy = false;
    explainEngine = null;
    closedNotes = new Set();
    notePending = new Set();
    noteError = new Map();
    popover.close();
  }

  /** 示范一落地就先显示，讲解慢一步再补：读短文这件事不该等翻译。 */
  async function loadExplain(active: WritingTask, source: string): Promise<void> {
    explainBusy = true;
    render();
    const result = await requestExplain(active, source, loadWords());
    explainBusy = false;
    // 期间可能换了题或改了篇幅，对不上当前示范的结果直接丢掉。
    if (task?.id !== active.id || model?.text !== source) return;
    explain = result.data;
    explainEngine = result.degraded;
    noteError = new Map();
    render();
  }

  /** 整篇讲解失败或某句缺译文时，可以只重讲这一句：请求小，成功率高。 */
  async function explainOne(active: WritingTask, index: number): Promise<void> {
    const note = explain?.sentences[index];
    if (!note || notePending.has(index)) return;
    notePending.add(index);
    noteError.delete(index);
    render();
    const result = await requestExplain(active, note.en, loadWords());
    notePending.delete(index);
    if (task?.id !== active.id || !explain) return;
    const fresh = result.data.sentences[0];
    if (result.degraded || !fresh || (!fresh.zh && !fresh.structure)) {
      noteError.set(index, result.degraded ?? 'AI 这次没给出讲解');
      render();
      return;
    }
    const merged = new Map(explain.glossary.map((entry) => [entry.term.toLowerCase(), entry]));
    for (const entry of result.data.glossary) {
      if (!merged.has(entry.term.toLowerCase())) merged.set(entry.term.toLowerCase(), entry);
    }
    explain = {
      sentences: explain.sentences.map((item, i) => (i === index ? { ...fresh, en: item.en } : item)),
      glossary: [...merged.values()],
    };
    if (explainEngine && explain.sentences.every((item) => item.zh || item.structure)) {
      explainEngine = null;
    }
    render();
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

  function wordPick(word: Word): string {
    const on = selected.includes(word.id);
    const disabled = busy !== null || (selected.length >= MAX_TARGET_WORDS && !on);
    const meaning = word.meaningZh.trim();
    return `
      <button type="button" class="pick" id="w-${word.id}" data-id="${word.id}"
        aria-pressed="${on}" ${disabled ? 'disabled' : ''}>
        <i class="dot ${word.mastery}" aria-hidden="true"></i>
        <span class="pick__hw">${escapeHtml(word.headword)}</span>
        <span class="pick__zh${meaning ? '' : ' empty'}">${escapeHtml(meaning || '释义待补')}</span>
        <span class="sr-only">${masteryZh[word.mastery]}</span>
      </button>`;
  }

  function renderPick(words: Word[]): void {
    bankRoot.innerHTML = `
      <div class="bank__head">
        <h2 id="bank-h">本次目标词</h2>
        <span class="bank__count">词本 ${words.length} 词</span>
      </div>
      <p class="sub">点词卡勾上，${MIN_TARGET_WORDS}~${MAX_TARGET_WORDS} 个；右边按这批词出题。</p>
      ${
        words.length
          ? `<div class="pickrow">${words.map(wordPick).join('')}</div>
             <div class="bank__foot">
               <p class="hint">已选 ${selected.length}/${MAX_TARGET_WORDS} · 掌握度只升不降</p>
               <button type="button" class="btn btn--secondary btn--sm" id="open-words">去词本收词</button>
             </div>`
          : `<div class="pickrow empty">
               <p class="hint">词本还是空的，先去词本粘一段正在背的笔记收词。</p>
               <button type="button" class="btn btn--primary btn--sm" id="open-words">去词本收词</button>
             </div>`
      }`;

    bankRoot.querySelectorAll<HTMLButtonElement>('.pick').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (busy) return;
        const id = chip.dataset.id!;
        selected = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
        render();
      });
    });

    bankRoot.querySelectorAll<HTMLButtonElement>('#open-words').forEach((btn) => {
      btn.addEventListener('click', () => onOpenWords());
    });
  }

  function noteCount(): number {
    if (explain?.sentences.length) return explain.sentences.length;
    return model ? splitSentences(model.text).length : 0;
  }

  function notesAllClosed(): boolean {
    const count = noteCount();
    return count > 0 && closedNotes.size >= count;
  }

  function noteBody(note: SentenceNote, index: number): string {
    if (notePending.has(index)) {
      return '<p class="busy"><span class="spinner" aria-hidden="true"></span>AI 正在讲这一句…</p>';
    }
    const error = noteError.get(index);
    if (!note.zh && !note.structure) {
      return `
        <p class="sent__missing">${
          explainBusy
            ? 'AI 正在写这一句的译文与结构…'
            : error
              ? `这句讲解没拿到：${escapeHtml(error)}`
              : '这一句还没有译文与结构。'
        }</p>
        <button type="button" class="btn btn--secondary btn--sm" id="note-ask-${index}" ${
          explainBusy ? 'disabled' : ''
        }>讲这一句</button>`;
    }
    return `
      ${
        note.zh
          ? `<p class="sent__zh"><span class="sent__tag">译</span><span>${escapeHtml(note.zh)}</span></p>`
          : ''
      }
      ${
        note.structure
          ? `<p class="sent__struct"><span class="sent__tag">结构</span><span>${escapeHtml(note.structure)}</span></p>`
          : ''
      }`;
  }

  function sentenceCard(note: SentenceNote, index: number, keys: Set<string>): string {
    const closed = closedNotes.has(index);
    const roles: string[] = [];
    for (const part of note.parts) {
      if (part.role && !roles.includes(part.role)) roles.push(part.role);
    }
    return `
      <li class="sent" id="sent-${index}" data-si="${index}">
        <div class="sent__top">
          <span class="sent__no" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
          <p class="sent__en">${sentenceBody(note.en, note.parts, String(index), keys)}</p>
          <button type="button" class="sent__toggle" id="note-toggle-${index}" data-closed="${closed}"
            aria-expanded="${!closed}" aria-controls="note-${index}" aria-label="第 ${index + 1} 句讲解">
            <span class="sent__toggle-t">${closed ? '讲解' : '收起'}</span>
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>
          </button>
        </div>
        <div class="sent__note" id="note-${index}" ${closed ? 'hidden' : ''}>
          ${noteBody(note, index)}
          ${
            roles.length
              ? `<div class="roles" role="group" aria-label="第 ${index + 1} 句成分">
                  ${roles
                    .map(
                      (role) =>
                        `<button type="button" class="role-chip" data-role="${roleClass(role)}" aria-pressed="false">
                          <i class="role-dot" aria-hidden="true"></i>${escapeHtml(role)}
                        </button>`,
                    )
                    .join('')}
                </div>`
              : ''
          }
        </div>
      </li>`;
  }

  function explainLine(): string {
    if (explainBusy) {
      return '<p class="busy"><span class="spinner" aria-hidden="true"></span>AI 正在逐句拆解：译文 · 句子结构 · 词汇表…</p>';
    }
    if (!explain) return '';
    const missing = explain.sentences.filter((note) => !note.zh && !note.structure).length;
    if (explainEngine) {
      return `<p class="engine">兜底原因：${escapeHtml(explainEngine)}${
        missing ? '，点该句的「讲这一句」可以单独重试' : ''
      }</p>`;
    }
    return `<p class="engine">讲解来源：AI 网关 · ${
      explain.glossary.length ? `${explain.glossary.length} 词释义` : '词汇表为空，点词时现查'
    }${missing ? ` · 还有 ${missing} 句待讲` : ''}</p>`;
  }

  /** 整段视图的译文和英文在同一块里：拿逐句译文按序拼，没讲齐就不硬拼半截糊弄读者。 */
  function wholeTranslation(notes: SentenceNote[]): string {
    const done = notes.filter((note) => note.zh);
    if (!done.length) return '';
    if (done.length < notes.length) {
      return `<p class="passage__zh">译文还差 ${notes.length - done.length} 句，切到「逐句讲解」点那一句重试。</p>`;
    }
    const joined = done
      .map((note) => {
        const zh = note.zh.trim();
        return /[。！？.!?]$/.test(zh) ? zh : `${zh}。`;
      })
      .join('');
    return `<p class="passage__zh">${escapeHtml(joined)}</p>`;
  }

  function renderModel(words: Word[], spec: PassageLength): string {
    if (busy === 'model') {
      return '<p class="busy"><span class="spinner" aria-hidden="true"></span>AI 正在按题干与篇幅写示范…</p>';
    }
    if (!model) return '<p class="hint">点上面的 A，按当前篇幅生成一段把目标词用出来的示范。</p>';
    const active = task!;
    const marked = words.filter((w) => model!.wordIds.includes(w.id));
    const keys = targetKeys(
      marked.length ? marked : words.filter((w) => active.targetWordIds.includes(w.id)),
    );
    const notes: SentenceNote[] = explain?.sentences.length
      ? explain.sentences
      : splitSentences(model.text).map((en) => ({ en, zh: '', structure: '', parts: [] }));
    return `
      <div class="passage">
        <div class="reader__bar">
          <div class="seg seg--sm" role="group" aria-label="示范短文视图">
            <button type="button" class="seg-btn" id="view-whole" aria-pressed="${passageView === 'whole'}">
              <strong>整段</strong>
            </button>
            <button type="button" class="seg-btn" id="view-sentences" aria-pressed="${passageView === 'sentences'}">
              <strong>逐句讲解</strong>
            </button>
          </div>
          ${
            passageView === 'sentences'
              ? `<button type="button" class="btn btn--secondary btn--sm" id="notes-all">${
                  notesAllClosed() ? '展开全部讲解' : '只看英文'
                }</button>`
              : ''
          }
          <span class="hint reader__tip">点任意单词看释义</span>
        </div>
        ${
          passageView === 'whole'
            ? `<div class="passage__pair"><p class="passage__text">${sentenceBody(
                model.text,
                [],
                'w',
                keys,
              )}</p>${wholeTranslation(notes)}</div>`
            : `<ol class="sents">${notes.map((note, index) => sentenceCard(note, index, keys)).join('')}</ol>`
        }
        <p class="statsline">${statsLine(model.text, spec)}</p>
        ${engineLine(modelEngine)}
        ${explainLine()}
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
                (w) => `<button type="button" class="target" id="tgt-${w.id}" data-term="${escapeHtml(w.headword)}" data-si="w">
                  <b>${escapeHtml(w.headword)}</b><span>${escapeHtml(w.meaningZh.trim() || '释义待补')}</span>
                </button>`,
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

    workSlot.querySelectorAll<HTMLElement>('.sent__en, .passage__text').forEach((scope) => {
      const first = scope.querySelector<HTMLButtonElement>('.tok');
      if (first) first.tabIndex = 0;
    });

    workSlot.querySelector<HTMLButtonElement>('#view-whole')?.addEventListener('click', () => {
      if (passageView === 'whole') return;
      passageView = 'whole';
      render();
    });

    workSlot.querySelector<HTMLButtonElement>('#view-sentences')?.addEventListener('click', () => {
      if (passageView === 'sentences') return;
      passageView = 'sentences';
      render();
    });

    workSlot.querySelector<HTMLButtonElement>('#notes-all')?.addEventListener('click', () => {
      closedNotes = notesAllClosed()
        ? new Set()
        : new Set(Array.from({ length: noteCount() }, (_, index) => index));
      render();
    });

    // 讲解开合与成分高亮只改这一句的 DOM：整块重绘会把浮层锚点和滚动位置一起弄丢。
    workSlot.querySelectorAll<HTMLButtonElement>('.sent__toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = Number(btn.id.slice('note-toggle-'.length));
        const closed = !closedNotes.has(index);
        if (closed) closedNotes.add(index);
        else closedNotes.delete(index);
        const note = workSlot.querySelector<HTMLElement>(`#note-${index}`);
        if (note) note.hidden = closed;
        btn.setAttribute('aria-expanded', String(!closed));
        btn.dataset.closed = String(closed);
        const label = btn.querySelector<HTMLElement>('.sent__toggle-t');
        if (label) label.textContent = closed ? '讲解' : '收起';
        const all = workSlot.querySelector<HTMLButtonElement>('#notes-all');
        if (all) all.textContent = notesAllClosed() ? '展开全部讲解' : '只看英文';
      });
    });

    workSlot.querySelectorAll<HTMLButtonElement>('.role-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const sent = chip.closest<HTMLElement>('.sent');
        if (!sent) return;
        const role = chip.dataset.role!;
        const on = sent.dataset.focusRole !== role;
        if (on) sent.dataset.focusRole = role;
        else delete sent.dataset.focusRole;
        sent.querySelectorAll<HTMLElement>('.part').forEach((part) => {
          part.dataset.dim = String(on && part.dataset.role !== role);
        });
        sent.querySelectorAll<HTMLButtonElement>('.role-chip').forEach((other) => {
          other.setAttribute('aria-pressed', String(on && other.dataset.role === role));
        });
      });
    });

    workSlot.querySelectorAll<HTMLButtonElement>('[id^="note-ask-"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!task) return;
        void explainOne(task, Number(btn.id.slice('note-ask-'.length)));
      });
    });

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
          explain = null;
          explainBusy = false;
          explainEngine = null;
          closedNotes = new Set();
          notePending = new Set();
          noteError = new Map();
          popover.close();
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
      (bankRoot.querySelector<HTMLButtonElement>('.pick') ??
        bankRoot.querySelector<HTMLButtonElement>('#open-words'))?.focus();
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
      // 新示范一落地先看整段：连着把这段话读完，再切「逐句讲解」逐句拆。
      passageView = 'whole';
      modelEngine = result.degraded;
      trained = markTraining(result.data.wordIds);
      busy = null;
      onMasteryChanged();
      render();
      pathsBox.querySelector<HTMLButtonElement>(`#path-${path}`)?.focus();
      if (result.data.text.trim()) void loadExplain(active, result.data.text);
      return;
    }
    render();
    pathsBox.querySelector<HTMLButtonElement>(`#path-${path}`)?.focus();
  }

  pathsBox.querySelectorAll<HTMLButtonElement>('.path').forEach((btn) => {
    btn.addEventListener('click', () => {
      void pathClick(btn.dataset.path as Path);
    });
  });

  // 一段短文上百个词，用委托而不是逐词挂监听；重绘换掉节点也不会漏。
  deskRoot.addEventListener('click', (event) => {
    const node = event.target instanceof Element ? event.target.closest<HTMLElement>('.tok, .target') : null;
    const term = node?.dataset.term;
    if (!node || !term) return;
    const scope = node.dataset.si ?? 'w';
    const context =
      scope === 'w'
        ? (model?.text ?? '')
        : (explain?.sentences[Number(scope)]?.en ?? model?.text ?? '');
    popover.open(node, term, context);
  });

  /** 一句里的词是一个漫游焦点组：左右键扫词，Tab 不会被迫停一百次。 */
  deskRoot.addEventListener('keydown', (event) => {
    const node = event.target;
    if (!(node instanceof HTMLButtonElement) || !node.classList.contains('tok')) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const scope = node.closest<HTMLElement>('.sent__en, .passage__text');
    if (!scope) return;
    const list = [...scope.querySelectorAll<HTMLButtonElement>('.tok')];
    const at = list.indexOf(node);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? list.length - 1
          : event.key === 'ArrowLeft'
            ? Math.max(0, at - 1)
            : Math.min(list.length - 1, at + 1);
    event.preventDefault();
    list.forEach((btn, index) => {
      btn.tabIndex = index === next ? 0 : -1;
    });
    list[next]?.focus();
  });

  let refocus: { id: string; caret: number | null } | null = null;

  /** 整块重绘会换掉输入框，这里把焦点与光标放回原处，粘词和写作时手感不断。 */
  function render(): void {
    const focused = document.activeElement;
    const focusId = focused instanceof HTMLElement && focused.id ? focused.id : (refocus?.id ?? '');
    const caret =
      focused instanceof HTMLTextAreaElement ? focused.selectionStart : (refocus?.caret ?? null);
    const words = loadWords();
    renderPick(words);
    renderDesk(words);
    popover.reanchor();
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
  return {
    redraw: render,
    selectWords: (ids) => {
      const next = [...selected];
      const overflow: string[] = [];
      for (const id of ids) {
        if (next.includes(id)) continue;
        if (next.length >= MAX_TARGET_WORDS) overflow.push(id);
        else next.push(id);
      }
      selected = next;
      render();
      return overflow;
    },
  };
}
