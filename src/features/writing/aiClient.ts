import type {
  Collocation,
  Explanation,
  Feedback,
  GlossEntry,
  SentenceNote,
  SentencePart,
  Submission,
  Word,
  WordUsage,
  WritingTask,
} from '../../types';
import { ApiError, requestJson } from './api';
import { loadModelKey } from '../../modelKey';
import { generateMockFeedback } from './mockFeedback';
import { generateExplanation, generateModelText, type ModelText } from './modelText';
import { splitSentences } from './passage';
import { taskLength } from './passageLength';

export interface AiResult<T> {
  data: T;
  /** 非 null 表示这次没走真实 LLM，前端要如实标出来。 */
  degraded: string | null;
  /** 网关带回的实际型号；没走成 AI 时为 null。 */
  model: string | null;
}

const FALLBACK_MESSAGES: Record<string, string> = {
  service_not_configured: 'AI 网关未配置密钥',
  model_key_invalid: '你的模型密钥格式不对（页脚可改）',
  model_key_rejected: '你的模型密钥被上游拒绝（页脚可换）',
  upstream_unavailable: 'AI 网关调用上游失败',
  invalid_request: 'AI 网关拒绝了请求参数',
  access_denied: '没有访问 AI 网关的权限',
  invalid_response: 'AI 网关没有可用响应（本地未启动 Function，或站点尚未部署网关）',
  network_error: 'AI 网关请求未送达',
  request_failed: 'AI 网关调用失败',
};

function reason(error: unknown): string {
  if (error instanceof ApiError) {
    return FALLBACK_MESSAGES[error.code] ?? `AI 网关返回 ${error.code}`;
  }
  return 'AI 网关响应不符合契约';
}

/** 网关会把这次实际用的型号带回来；没带就当作未知，界面宁可不显示也不猜。 */
function modelOf(value: unknown): string | null {
  const raw = (value as Record<string, unknown>)?.model;
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 64) : null;
}

function targets(task: WritingTask, words: Word[]) {
  return words
    .filter((word) => task.targetWordIds.includes(word.id))
    .map((word) => ({
      id: word.id,
      headword: word.headword,
      meaningZh: word.meaningZh,
      collocations: word.collocations,
    }));
}

/**
 * 生成类请求一次只跑一路：两屏各持自己的忙标记，互相不知道对方在不在调用，
 * 排队比让它们同时打到上游稳——后来的请求等前面那条落地，界面照常转圈。
 */
let lane: Promise<unknown> = Promise.resolve();

function queue<T>(call: () => Promise<T>): Promise<T> {
  const run = lane.then(call, call);
  lane = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function post(path: string, payload: unknown): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // 自带密钥走请求头：不进 URL、不进日志，网关用完这一次就丢。
  const userKey = loadModelKey();
  if (userKey) headers['x-model-key'] = userKey;
  const call = () =>
    requestJson(
      `/functions/v1/app/${path}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      },
      FALLBACK_MESSAGES,
    );
  // 点词查释义短而即时，别排在生成类请求后面；其余长请求一次只跑一路。
  return path === 'gloss' ? call() : queue(call);
}

function readFeedback(value: unknown, task: WritingTask, submission: Submission): Feedback {
  const body = (value as Record<string, unknown>)?.feedback;
  if (!body || typeof body !== 'object') throw new Error('invalid_feedback');
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.usages)) throw new Error('invalid_feedback');
  const usages: WordUsage[] = task.targetWordIds.map((wordId) => {
    const usage = raw.usages as Record<string, unknown>[];
    const hit = usage.find((u) => u?.wordId === wordId);
    const used = hit?.used === true;
    return {
      wordId,
      used,
      natural: used && hit?.natural === true,
      note: typeof hit?.note === 'string' && hit.note ? hit.note : 'AI 未返回该词的判定。',
    };
  });
  const accuracy = typeof raw.accuracy === 'number' ? Math.max(0, Math.min(100, raw.accuracy)) : 0;
  if (typeof raw.overall !== 'string') throw new Error('invalid_feedback');
  return {
    taskId: task.id,
    submittedText: submission.text,
    usages,
    accuracy,
    overall: raw.overall,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

function readModelText(value: unknown): ModelText {
  const raw = (value as Record<string, unknown>)?.modelText;
  if (!raw || typeof raw !== 'object') throw new Error('invalid_model_text');
  const body = raw as Record<string, unknown>;
  if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('invalid_model_text');
  const wordIds = Array.isArray(body.wordIds)
    ? body.wordIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { text: body.text, wordIds };
}

export async function requestFeedback(
  task: WritingTask,
  submission: Submission,
  words: Word[],
): Promise<AiResult<Feedback>> {
  try {
    const data = await post('feedback', {
      taskId: task.id,
      text: submission.text,
      words: targets(task, words),
    });
    return { data: readFeedback(data, task, submission), degraded: null, model: modelOf(data) };
  } catch (error) {
    return {
      data: generateMockFeedback(task, submission, words),
      degraded: `${reason(error)}，已用本地 mock 点评`,
      model: null,
    };
  }
}

export async function requestModelText(
  task: WritingTask,
  words: Word[],
): Promise<AiResult<ModelText>> {
  try {
    const data = await post('model-text', {
      prompt: task.prompt,
      words: targets(task, words),
      length: taskLength(task),
    });
    return { data: readModelText(data), degraded: null, model: modelOf(data) };
  } catch (error) {
    return {
      data: generateModelText(task, words),
      degraded: `${reason(error)}，示范短文改由词本例句拼接`,
      model: null,
    };
  }
}

function readParts(value: unknown): SentencePart[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const part = (item ?? {}) as Record<string, unknown>;
      return { text: text(part.text, 160), role: text(part.role, 12) };
    })
    .filter((part) => part.text && part.role)
    .slice(0, 12);
}

function readGlossary(value: unknown): GlossEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: GlossEntry[] = [];
  for (const item of value) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const term = text(entry.term, 48);
    const meaningZh = text(entry.meaningZh, 80);
    if (!term || !meaningZh || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push({ term, pos: text(entry.pos, 16), meaningZh });
    if (out.length >= 140) break;
  }
  return out;
}

/** 句子一律用前端自己切的那份：网关按序号回讲解，两边切法一致才不会错位。 */
function readExplanation(value: unknown, source: string): Explanation {
  const raw = (value as Record<string, unknown>)?.explanation;
  if (!raw || typeof raw !== 'object') throw new Error('invalid_explanation');
  const body = raw as Record<string, unknown>;
  const list = Array.isArray(body.sentences) ? body.sentences : [];
  const sentences: SentenceNote[] = splitSentences(source).map((en, index) => {
    const item = (list[index] ?? {}) as Record<string, unknown>;
    return {
      en,
      zh: text(item.zh, 400),
      structure: text(item.structure, 400),
      parts: readParts(item.parts),
    };
  });
  const glossary = readGlossary(body.glossary);
  if (!sentences.length || (!glossary.length && !sentences.some((s) => s.zh || s.structure))) {
    throw new Error('invalid_explanation');
  }
  return { sentences, glossary };
}

/** 讲解只认网关契约里的词形；补分析时词卡可能已删，用存下来的目标词凑同一份。 */
export interface ExplainWord {
  id: string;
  headword: string;
  meaningZh: string;
  collocations: Collocation[];
}

async function explainCall(source: string, words: ExplainWord[]): Promise<AiResult<Explanation>> {
  try {
    const data = await post('explain', { text: source, words });
    return { data: readExplanation(data, source), degraded: null, model: modelOf(data) };
  } catch (error) {
    return {
      data: generateExplanation(source),
      degraded: `${reason(error)}，译文与结构暂缺`,
      model: null,
    };
  }
}

export async function requestExplain(
  task: WritingTask,
  source: string,
  words: Word[],
): Promise<AiResult<Explanation>> {
  return explainCall(source, targets(task, words));
}

/** 习作集里的补分析：没有任务，只有当时存下的正文与目标词。 */
export function requestExplainTerms(
  source: string,
  terms: { headword: string; meaningZh: string }[],
): Promise<AiResult<Explanation>> {
  return explainCall(
    source,
    terms.slice(0, 8).map((term) => ({
      id: term.headword,
      headword: term.headword,
      meaningZh: term.meaningZh,
      collocations: [],
    })),
  );
}

export async function requestGloss(term: string, sentence: string): Promise<AiResult<GlossEntry>> {
  try {
    const data = await post('gloss', { term, sentence });
    const entry = (data as Record<string, unknown>)?.entry as Record<string, unknown> | undefined;
    const meaningZh = text(entry?.meaningZh, 80);
    if (!meaningZh) throw new Error('invalid_gloss');
    return {
      data: { term: text(entry?.term, 48) || term, pos: text(entry?.pos, 16), meaningZh },
      degraded: null,
      model: modelOf(data),
    };
  } catch (error) {
    return { data: { term, pos: '', meaningZh: '' }, degraded: reason(error), model: null };
  }
}

export interface IntakeCard {
  headword: string;
  pos: string;
  meaningZh: string;
  theme: string;
  examples: string[];
  collocations: Collocation[];
}

const MAX_INTAKE = 30;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function readIntakeCards(value: unknown): IntakeCard[] {
  const raw = (value as Record<string, unknown>)?.words;
  if (!Array.isArray(raw) || !raw.length) throw new Error('invalid_intake');
  return raw
    .map((item) => {
      const card = (item ?? {}) as Record<string, unknown>;
      const examples = Array.isArray(card.examples)
        ? card.examples.filter((e): e is string => typeof e === 'string' && !!e.trim()).slice(0, 2)
        : [];
      const collocations = Array.isArray(card.collocations)
        ? card.collocations
            .map((entry) => {
              const c = (entry ?? {}) as Record<string, unknown>;
              return { phrase: text(c.phrase, 80), gloss: text(c.gloss, 60) };
            })
            .filter((c) => c.phrase)
            .slice(0, 4)
        : [];
      return {
        headword: text(card.headword, 64),
        pos: text(card.pos, 16),
        meaningZh: text(card.meaningZh, 160),
        theme: text(card.theme, 24),
        examples,
        collocations,
      };
    })
    .filter((card) => card.headword)
    .slice(0, MAX_INTAKE);
}

/** 释义通常从中文或词性缩写开始，前面那段才是词头。 */
const POS_MARKER = /\s+(?:n|v|vt|vi|adj|adv|prep|conj|pron|pl)\.\s/i;

function headwordFrom(chunk: string): string {
  const cleaned = chunk
    .replace(/[*`>#•\-]+/g, ' ')
    .replace(/^\s*\d+\s*[.)、]?\s*/, ' ')
    .trim();
  const cuts = [cleaned.search(/[\u4e00-\u9fff]/), cleaned.search(POS_MARKER)].filter(
    (index) => index >= 0,
  );
  const head = (cuts.length ? cleaned.slice(0, Math.min(...cuts)) : cleaned)
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z]+/, '')
    .replace(/[^A-Za-z0-9' -]+$/, '')
    .trim();
  if (!/[A-Za-z]/.test(head) || head.length > 40) return '';
  // 四个词以上基本是例句，不是词头。
  return head.split(/\s+/).length > 4 ? '' : head;
}

/** 网关不可用时的退路：不猜释义，只把词头切出来，并如实告诉用户这次没走 AI。 */
function splitLocally(raw: string): IntakeCard[] {
  const seen = new Set<string>();
  const cards: IntakeCard[] = [];
  for (const line of raw.split(/\n+/)) {
    for (const chunk of line.split(/[,;:，；：、]+/)) {
      const headword = headwordFrom(chunk);
      if (!headword) continue;
      const key = headword.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({ headword, pos: '', meaningZh: '', theme: '', examples: [], collocations: [] });
      if (cards.length >= MAX_INTAKE) return cards;
    }
  }
  return cards;
}

export async function requestIntake(raw: string): Promise<AiResult<IntakeCard[]>> {
  try {
    const data = await post('intake', { raw });
    const cards = readIntakeCards(data);
    if (!cards.length) throw new Error('invalid_intake');
    return { data: cards, degraded: null, model: modelOf(data) };
  } catch (error) {
    return {
      data: splitLocally(raw),
      degraded: `${reason(error)}，已本地切出词头，释义与例句留空`,
      model: null,
    };
  }
}
