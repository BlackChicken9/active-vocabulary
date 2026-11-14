export interface GatewayEnv {
  LLM_API_KEY?: string;
  AI_MODEL?: string;
  AI_BASE_URL?: string;
}

interface TargetWord {
  id: string;
  headword: string;
  meaningZh: string;
  collocations: string[];
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';
const MAX_BODY = 12_000;
const MAX_TEXT = 2_000;
const MAX_RAW = 6_000;
const MAX_CARDS = 30;
const MAX_GLOSS = 120;
const MAX_EXPLAIN_SENTENCES = 12;
/** 访客自带密钥：走请求头，不进 URL、不进日志，也只在这一次请求里活着。 */
const MODEL_KEY_HEADER = 'x-model-key';
const MODEL_KEY_OK = /^[A-Za-z0-9_\-.]{8,200}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function route(pathname: string): 'feedback' | 'model-text' | 'intake' | 'explain' | 'gloss' | null {
  if (pathname.endsWith('/feedback')) return 'feedback';
  if (pathname.endsWith('/model-text')) return 'model-text';
  if (pathname.endsWith('/intake')) return 'intake';
  if (pathname.endsWith('/explain')) return 'explain';
  if (pathname.endsWith('/gloss')) return 'gloss';
  return null;
}

const ABBREV = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|a\.m|p\.m|No|Fig)\.$/i;
const INITIAL = /(?:^|\s)[A-Z]\.$/;

/** 与 src/features/writing/passage.ts 的切法保持一致：逐句讲解按序号对齐，切法不同译文就会错位。 */
function splitSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < clean.length; i += 1) {
    if (!'.!?…'.includes(clean[i])) continue;
    let end = i + 1;
    while (end < clean.length && '.!?…'.includes(clean[end])) end += 1;
    while (end < clean.length && '"\'”’)'.includes(clean[end])) end += 1;
    if (end < clean.length && clean[end] !== ' ') continue;
    const piece = clean.slice(start, end);
    if (ABBREV.test(piece) || INITIAL.test(piece)) continue;
    out.push(piece.trim());
    start = end + 1;
  }
  const tail = clean.slice(start).trim();
  if (tail) out.push(tail);
  return out;
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
    if (!id || !headword) return null;
    // 粘贴导入的词可能还没有释义，缺了不该让整次点评失败。
    const meaningZh = asString(record.meaningZh, 120) ?? '';
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

async function chat(
  env: GatewayEnv,
  prompt: string,
  user: string,
  options: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const response = await fetch(`${env.AI_BASE_URL ?? DEFAULT_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.LLM_API_KEY}`,
      // 运行时 fetch 默认不带 UA，这里显式给一个可识别的桌面端标识。
      'user-agent': 'active-vocab-sites/1.0 (Windows)',
    },
    body: JSON.stringify({
      model: env.AI_MODEL || DEFAULT_MODEL,
      temperature: 0.2,
      // 默认 4096 会把逐句讲解的 JSON 截断在半句上，讲解这一路显式抬高。
      max_tokens: options.maxTokens ?? 4096,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
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

function modelTextPrompt(words: TargetWord[], length: PassageLength): string {
  return [
    '你是英语写作助教，为学习者写一段「示范答案」，把每个目标词自然用出来，并尽量带上它的常见搭配。',
    `只输出 JSON：{"text":"${length.minSentences}~${length.maxSentences} 句英文（约 ${length.minWords}~${length.maxWords} 词），连贯成一段","wordIds":["实际用到的目标词 id"]}。`,
    '句数与词数都要落在给定区间内；每个目标词至少出现一次；不要中文，不要解释，不要列出词表。',
    '目标词表：',
    describe(words),
  ].join('\n');
}

interface PassageLength {
  minSentences: number;
  maxSentences: number;
  minWords: number;
  maxWords: number;
}

/** 篇幅由前端选，但网关夹住上下限：模型不该被要求写 500 句，也不该收到 min>max 的区间。 */
function parseLength(value: unknown, wordCount: number): PassageLength {
  const record = (value ?? {}) as Record<string, unknown>;
  const num = (input: unknown, fallback: number): number =>
    typeof input === 'number' && Number.isFinite(input) ? Math.round(input) : fallback;
  const minSentences = Math.min(12, Math.max(1, num(record.minSentences, Math.min(8, Math.max(2, wordCount)))));
  const maxSentences = Math.min(12, Math.max(minSentences, num(record.maxSentences, minSentences + 2)));
  const minWords = Math.min(400, Math.max(10, num(record.minWords, minSentences * 14)));
  const maxWords = Math.min(400, Math.max(minWords, num(record.maxWords, maxSentences * 18)));
  return { minSentences, maxSentences, minWords, maxWords };
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
  // 长档最多 12 句，1200 字会把正常长示范截断。
  const text = asString(record.text, 2_600);
  if (!text) throw new Error('upstream_empty');
  const ids = Array.isArray(record.wordIds)
    ? record.wordIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { text, wordIds: ids.length ? ids : words.map((w) => w.id) };
}

function explainPrompt(words: TargetWord[], count: number): string {
  return [
    '你是英语写作助教，为学习者逐句讲解一段示范短文：翻译、句子结构、生词释义。',
    '只输出 JSON：{"sentences":[{"zh":"这一句的简体中文翻译","structure":"中文一句话讲清主干与从句","marked":"[主语 ...][谓语 ...][宾语 ...]"}],"glossary":["原文词|词性|中文释义"]}。',
    `sentences 必须正好 ${count} 项，与下面编号一一对应，不要合并、拆分或改写英文原句。`,
    'marked 把该句按顺序切成 2~6 段：方括号里先写成分名（主语/谓语/宾语/表语/补语/定语/状语/从句/连接词），空格后原样抄写那一段英文；各段拼起来要能还原整句。',
    'structure 只讲结构（谁是主语、谓语是什么、哪个是从句、修饰谁），不要重复译文，不要泛泛而谈。',
    'glossary 覆盖文中所有实词（名词、动词、形容词、副词）和固定搭配，用文中出现的形态，最多 120 条，释义 12 字以内；目标词也要给，释义与词卡一致。',
    '全部中文用简体，不要输出 Markdown 或额外解释。',
    words.length ? '目标词表：' : '',
    words.length ? describe(words) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 与前端 parseMarked 同一套写法：[成分 英文]，模型偶尔用 | 分隔也认。 */
function parseMarked(value: unknown): { text: string; role: string }[] {
  const marked = asString(value, 900);
  if (!marked) return [];
  const out: { text: string; role: string }[] = [];
  for (const match of marked.matchAll(/\[([^\]\s|]{1,8})[|\s]\s*([^\]]+)\]/g)) {
    const text = clip(match[2].trim(), 160);
    if (text) out.push({ role: match[1], text });
    if (out.length >= 12) break;
  }
  return out;
}

const GLOSS_TERM_OK = /^[A-Za-z](?:[A-Za-z0-9'’ -]{0,38}[A-Za-z0-9'’.])?$/;

/** 词汇表既接受 "词|词性|释义" 紧凑串，也接受对象；脏条目丢掉，不让整次讲解失败。 */
function normalizeGlossary(value: unknown): { term: string; pos: string; meaningZh: string }[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: { term: string; pos: string; meaningZh: string }[] = [];
  for (const item of value) {
    let term = '';
    let pos = '';
    let meaningZh = '';
    if (typeof item === 'string') {
      const parts = item.split('|');
      term = (parts[0] ?? '').trim();
      pos = (parts[1] ?? '').trim();
      meaningZh = (parts.slice(2).join('|') ?? '').trim();
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      term = asString(record.term, 48) ?? '';
      pos = asString(record.pos, 16) ?? '';
      meaningZh = asString(record.meaningZh, 60) ?? '';
    }
    if (!term || !meaningZh || !GLOSS_TERM_OK.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, pos: clip(pos, 16), meaningZh: clip(meaningZh, 60) });
    if (out.length >= MAX_GLOSS) break;
  }
  return out;
}

function normalizeExplanation(data: unknown, sentences: string[]) {
  const record = (data ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(record.sentences) ? record.sentences : [];
  const notes = sentences.map((en, index) => {
    const item = (raw[index] ?? {}) as Record<string, unknown>;
    return {
      en,
      zh: asString(item.zh, 400) ?? '',
      structure: asString(item.structure, 400) ?? '',
      parts: parseMarked(item.marked),
    };
  });
  const glossary = normalizeGlossary(record.glossary);
  if (!glossary.length && !notes.some((note) => note.zh || note.structure)) {
    throw new Error('upstream_empty');
  }
  return { sentences: notes, glossary };
}

function glossPrompt(): string {
  return [
    '你是英语学习词典。给出这个词在给定句子语境下的中文释义。',
    '只输出 JSON：{"term":"词头（原形）","pos":"词性，如 v. / n. / adj. / 短语","meaningZh":"简体中文释义，20 字以内，贴合该句语境"}。',
    '不要输出例句、解释或 Markdown。',
  ].join('\n');
}

function normalizeGloss(data: unknown, term: string) {
  const record = (data ?? {}) as Record<string, unknown>;
  const meaningZh = asString(record.meaningZh, 80);
  if (!meaningZh) throw new Error('upstream_empty');
  const head = asString(record.term, 48);
  return {
    term: head && GLOSS_TERM_OK.test(head) ? head : term,
    pos: asString(record.pos, 16) ?? '',
    meaningZh,
  };
}

function intakePrompt(): string {
  return [
    '你是英语词卡整理助手。用户会粘贴任意格式的内容：可能只是一串单词，也可能是带释义、派生词和例句的笔记。',
    '只输出 JSON：{"words":[{"headword":"英文词头或短语","pos":"词性，如 v. / adj. / n. / 短语；原文没有就留空字符串","meaningZh":"简体中文释义","theme":"这批词共同的话题，简体中文 2~6 个字，如「海洋与环境」；判断不出就留空字符串","examples":["一句英文例句"],"collocations":[{"phrase":"英文搭配","gloss":"中文说明"}]}]}。',
    '规则：原文已有的释义、派生词、例句照抄，不要改写；只有原文缺失时才由你补，补的例句要短、日常可用；',
    '搭配必须是能整块复用的词块（如 early intervention），不要拿派生词充当搭配；同一次粘贴的词尽量归到同一个 theme；',
    '词头去重；最多 30 条；不要输出解释。',
  ].join('\n');
}

function asStringList(value: unknown, max: number, limit: number, itemMax: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((item) => asString(item, itemMax))
    .filter((item): item is string => item !== null)
    .slice(0, max);
}

/** 词头只允许英文、空格与常见标点：模型把整行笔记、例句或中文释义当词头时直接丢掉，别污染用户词库。 */
const HEADWORD_OK = /^[A-Za-z](?:[A-Za-z0-9'’ -]{0,38}[A-Za-z0-9'’.])?$/;

/** 用户粘什么都有可能，所以这里逐条兜底：缺词头就丢掉，其余字段缺了给空值，不让前端拿到脏结构。 */
function normalizeIntake(data: unknown) {
  const record = (data ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(record.words) ? record.words : [];
  const seen = new Set<string>();
  const words: {
    headword: string;
    pos: string;
    meaningZh: string;
    theme: string;
    examples: string[];
    collocations: { phrase: string; gloss: string }[];
  }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const card = item as Record<string, unknown>;
    const headword = asString(card.headword, 64);
    if (!headword || !HEADWORD_OK.test(headword)) continue;
    const key = headword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const collocations = (Array.isArray(card.collocations) ? card.collocations : [])
      .slice(0, 4)
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const phrase = asString((entry as Record<string, unknown>).phrase, 80);
        if (!phrase) return null;
        return { phrase, gloss: asString((entry as Record<string, unknown>).gloss, 60) ?? '' };
      })
      .filter((entry): entry is { phrase: string; gloss: string } => entry !== null);
    words.push({
      headword,
      pos: asString(card.pos, 16) ?? '',
      meaningZh: asString(card.meaningZh, 160) ?? '',
      theme: asString(card.theme, 24) ?? '',
      examples: asStringList(card.examples, 2, 4, 240),
      collocations,
    });
    if (words.length >= MAX_CARDS) break;
  }
  if (!words.length) throw new Error('upstream_empty');
  return { words };
}

/** 上游细节（状态码、异常文本、密钥）一律不外泄，前端只看到稳定错误码。 */
function upstreamFailure(error: unknown, fromUserKey: boolean): Response {
  const code = error instanceof Error ? error.message : '';
  // 401/403 只在访客自带 key 时单独报出来：那是他自己的密钥问题，不是网关故障。
  if (fromUserKey && (code === 'upstream_401' || code === 'upstream_403')) {
    return json({ ok: false, error: 'model_key_rejected' }, 400);
  }
  return json({ ok: false, error: 'upstream_unavailable' }, 502);
}

export function createHandler(env: GatewayEnv = {}) {
  return async function handler(request: Request): Promise<Response> {
    const path = route(new URL(request.url).pathname);
    if (!path) return json({ ok: false, error: 'not_found' }, 404);
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

    // 自带 key 优先；带了就只用它，失败也不回落到站点 key——那会悄悄花掉站主的额度。
    const provided = (request.headers.get(MODEL_KEY_HEADER) ?? '').trim().slice(0, 256);
    const fromUserKey = provided.length > 0;
    if (fromUserKey && !MODEL_KEY_OK.test(provided)) {
      return json({ ok: false, error: 'model_key_invalid' }, 400);
    }
    const apiKey = fromUserKey ? provided : env.LLM_API_KEY?.trim() ?? '';
    if (!apiKey) return json({ ok: false, error: 'service_not_configured' }, 503);
    const cfg: GatewayEnv = { ...env, LLM_API_KEY: apiKey };

    const body = await readBody(request);
    if (!body) return json({ ok: false, error: 'invalid_request' }, 400);

    if (path === 'intake') {
      const raw = asString(body.raw, MAX_RAW);
      if (!raw) return json({ ok: false, error: 'invalid_request' }, 400);
      try {
        return json({ ok: true, ...normalizeIntake(await chat(cfg, intakePrompt(), raw)) });
      } catch (error) {
        return upstreamFailure(error, fromUserKey);
      }
    }

    if (path === 'gloss') {
      const term = asString(body.term, 48);
      if (!term || !GLOSS_TERM_OK.test(term)) return json({ ok: false, error: 'invalid_request' }, 400);
      const sentence = asString(body.sentence, 600) ?? '';
      try {
        const entry = normalizeGloss(
          await chat(cfg, glossPrompt(), `词：${term}\n所在句子：${sentence}`, { maxTokens: 512 }),
          term,
        );
        return json({ ok: true, entry });
      } catch (error) {
        return upstreamFailure(error, fromUserKey);
      }
    }

    if (path === 'explain') {
      const text = asString(body.text, MAX_TEXT);
      if (!text) return json({ ok: false, error: 'invalid_request' }, 400);
      const sentences = splitSentences(text).slice(0, MAX_EXPLAIN_SENTENCES);
      if (!sentences.length) return json({ ok: false, error: 'invalid_request' }, 400);
      // 讲解只把目标词当释义参考，词表缺失也能讲。
      const words = parseWords(body.words) ?? [];
      const numbered = sentences.map((sentence, index) => `${index + 1}. ${sentence}`).join('\n');
      try {
        const explanation = normalizeExplanation(
          await chat(cfg, explainPrompt(words, sentences.length), numbered, {
            maxTokens: 6_000,
            timeoutMs: 45_000,
          }),
          sentences,
        );
        return json({ ok: true, explanation });
      } catch (error) {
        return upstreamFailure(error, fromUserKey);
      }
    }

    const words = parseWords(body.words);
    if (!words) return json({ ok: false, error: 'invalid_request' }, 400);

    try {
      if (path === 'model-text') {
        const prompt = asString(body.prompt, 600) ?? '';
        const length = parseLength(body.length, words.length);
        const modelText = normalizeModelText(
          await chat(cfg, modelTextPrompt(words, length), `题干：${prompt}`),
          words,
        );
        return json({ ok: true, modelText });
      }

      const text = asString(body.text, MAX_TEXT) ?? '';
      const taskId = asString(body.taskId, 64) ?? '';
      const feedback = normalizeFeedback(
        await chat(cfg, feedbackPrompt(words), `学习者写的句子：\n${text}`),
        words,
        text,
        taskId,
      );
      return json({ ok: true, feedback });
    } catch (error) {
      return upstreamFailure(error, fromUserKey);
    }
  };
}
