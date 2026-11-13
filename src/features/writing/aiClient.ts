import type { Collocation, Feedback, Submission, Word, WordUsage, WritingTask } from '../../types';
import { ApiError, requestJson } from './api';
import { generateMockFeedback } from './mockFeedback';
import { generateModelText, type ModelText } from './modelText';

export interface AiResult<T> {
  data: T;
  /** 非 null 表示这次没走真实 LLM，前端要如实标出来。 */
  degraded: string | null;
}

const FALLBACK_MESSAGES: Record<string, string> = {
  service_not_configured: 'AI 网关未配置密钥',
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

async function post(path: string, payload: unknown): Promise<unknown> {
  return requestJson(
    `/functions/v1/app/${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    FALLBACK_MESSAGES,
  );
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
    return { data: readFeedback(data, task, submission), degraded: null };
  } catch (error) {
    return {
      data: generateMockFeedback(task, submission, words),
      degraded: `${reason(error)}，已用本地 mock 点评`,
    };
  }
}

export async function requestModelText(
  task: WritingTask,
  words: Word[],
): Promise<AiResult<ModelText>> {
  try {
    const data = await post('model-text', { prompt: task.prompt, words: targets(task, words) });
    return { data: readModelText(data), degraded: null };
  } catch (error) {
    return {
      data: generateModelText(task, words),
      degraded: `${reason(error)}，示范短文改由词本例句拼接`,
    };
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
    return { data: cards, degraded: null };
  } catch (error) {
    return {
      data: splitLocally(raw),
      degraded: `${reason(error)}，已本地切出词头，释义与例句留空`,
    };
  }
}
