export interface GatewayEnv {
  DASHSCOPE_API_KEY?: string;
  AI_MODEL?: string;
  AI_BASE_URL?: string;
}

interface TargetWord {
  id: string;
  headword: string;
  meaningZh: string;
  collocations: string[];
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen-plus';
const MAX_BODY = 12_000;
const MAX_TEXT = 2_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function route(pathname: string): 'feedback' | 'model-text' | null {
  if (pathname.endsWith('/feedback')) return 'feedback';
  if (pathname.endsWith('/model-text')) return 'model-text';
  return null;
}

function asString(value: unknown, max = 300): string | null {
  return typeof value === 'string' && value.trim() ? clip(value.trim(), max) : null;
}

/** 只接受前端契约里的字段；词表上限 8，防止把任意长文本灌进 prompt。 */
function parseWords(value: unknown): TargetWord[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null;
  const words: TargetWord[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const id = asString(record.id, 64);
    const headword = asString(record.headword, 64);
    const meaningZh = asString(record.meaningZh, 120);
    if (!id || !headword || !meaningZh) return null;
    const collocations = Array.isArray(record.collocations)
      ? record.collocations
          .map((c) =>
            c && typeof c === 'object' ? asString((c as Record<string, unknown>).phrase, 80) : null,
          )
          .filter((phrase): phrase is string => phrase !== null)
      : [];
    words.push({ id, headword, meaningZh, collocations });
  }
  return words;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function chat(env: GatewayEnv, prompt: string, user: string): Promise<unknown> {
  const response = await fetch(`${env.AI_BASE_URL ?? DEFAULT_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.AI_MODEL || DEFAULT_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('upstream_empty');
  return JSON.parse(content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
}

function describe(words: TargetWord[]): string {
  return words
    .map((w) => `- id=${w.id} | ${w.headword}｜${w.meaningZh}｜搭配: ${w.collocations.join(' / ') || '无'}`)
    .join('\n');
}

function feedbackPrompt(words: TargetWord[]): string {
  return [
    '你是英语写作助教，判断学习者的句子里是否「主动用出」了目标词，以及用得是否地道。',
    '地道 = 命中该词的常见搭配或自然用法；只是把词硬塞进句子、搭配错误或中式表达算不地道。',
    '只输出 JSON：{"usages":[{"wordId":"","used":true,"natural":true,"note":"中文一句话点评，指出问题并给可抄的改法"}],"accuracy":0-100,"overall":"中文两句话总评"}。',
    'accuracy = 用出且地道的比例；note 与 overall 用简体中文，不要复述整段原文。',
    '目标词表：',
    describe(words),
  ].join('\n');
}

function modelTextPrompt(words: TargetWord[]): string {
  return [
    '你是英语写作助教，为学习者写一段「示范答案」，把每个目标词自然用出来，并尽量带上它的常见搭配。',
    '只输出 JSON：{"text":"1~3 句英文，连贯成一小段","wordIds":["实际用到的目标词 id"]}。',
    '不要中文，不要解释，不要列出词表。',
    '目标词表：',
    describe(words),
  ].join('\n');
}

function normalizeFeedback(data: unknown, words: TargetWord[], text: string, taskId: string) {
  const record = (data ?? {}) as Record<string, unknown>;
  const rawUsages = Array.isArray(record.usages) ? record.usages : [];
  const usages = words.map((word) => {
    const hit = rawUsages.find(
      (u) => u && typeof u === 'object' && (u as Record<string, unknown>).wordId === word.id,
    ) as Record<string, unknown> | undefined;
    const used = hit?.used === true;
    return {
      wordId: word.id,
      used,
      natural: used && hit?.natural === true,
      note: asString(hit?.note) ?? `AI 未返回「${word.headword}」的判定，请重写一次或先用它造一句。`,
    };
  });
  const counted = usages.filter((u) => u.used).length;
  const natural = usages.filter((u) => u.natural).length;
  const fromModel = typeof record.accuracy === 'number' ? record.accuracy : Number(record.accuracy);
  const accuracy = Number.isFinite(fromModel)
    ? Math.max(0, Math.min(100, Math.round(fromModel)))
    : usages.length === 0
      ? 0
      : Math.round(((counted + natural) / (2 * usages.length)) * 100);
  return {
    taskId,
    submittedText: text,
    usages,
    accuracy,
    overall: asString(record.overall, 600) ?? 'AI 未返回总评。',
    updatedAt: new Date().toISOString(),
  };
}

function normalizeModelText(data: unknown, words: TargetWord[]) {
  const record = (data ?? {}) as Record<string, unknown>;
  const text = asString(record.text, 1_200);
  if (!text) throw new Error('upstream_empty');
  const ids = Array.isArray(record.wordIds)
    ? record.wordIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { text, wordIds: ids.length ? ids : words.map((w) => w.id) };
}

export function createHandler(env: GatewayEnv = {}) {
  return async function handler(request: Request): Promise<Response> {
    const path = route(new URL(request.url).pathname);
    if (!path) return json({ ok: false, error: 'not_found' }, 404);
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
    if (!env.DASHSCOPE_API_KEY?.trim()) {
      return json({ ok: false, error: 'service_not_configured' }, 503);
    }

    const body = await readBody(request);
    const words = body ? parseWords(body.words) : null;
    if (!body || !words) return json({ ok: false, error: 'invalid_request' }, 400);

    try {
      if (path === 'model-text') {
        const prompt = asString(body.prompt, 600) ?? '';
        const modelText = normalizeModelText(
          await chat(env, modelTextPrompt(words), `题干：${prompt}`),
          words,
        );
        return json({ ok: true, modelText });
      }

      const text = asString(body.text, MAX_TEXT) ?? '';
      const taskId = asString(body.taskId, 64) ?? '';
      const feedback = normalizeFeedback(
        await chat(env, feedbackPrompt(words), `学习者写的句子：\n${text}`),
        words,
        text,
        taskId,
      );
      return json({ ok: true, feedback });
    } catch {
      // 上游细节（状态码、异常文本、密钥）一律不外泄，前端只看到稳定错误码。
      return json({ ok: false, error: 'upstream_unavailable' }, 502);
    }
  };
}
