// 本地假上游：只为跑通 浏览器 → vite 代理 → functions/handler.ts 这条链路。
// 不调用真实模型；真实联调把端口换成 Deno（见 README「AI 网关」）。
// 运行：node dev/function-stub.mjs  （监听 127.0.0.1:8000）
import { createServer } from 'node:http';
import { createHandler } from '../functions/handler.ts';

// 假上游只做粗切：剥掉 Markdown 装饰、中文释义和整句例句，模拟模型会给出的词头。
function stubHeadwords(raw) {
  const out = [];
  for (const line of raw.split(/\n+/)) {
    for (const chunk of line.split(/[,;:，；：、]+/)) {
      const cleaned = chunk
        .replace(/[*`>#•\-]+/g, ' ')
        .replace(/^\s*\d+\s*[.)、]?\s*/, ' ')
        .trim();
      const cut = cleaned.search(/[\u4e00-\u9fff]|\s+(?:n|v|vt|vi|adj|adv|prep|conj|pron|pl)\.\s/i);
      const head = (cut >= 0 ? cleaned.slice(0, cut) : cleaned)
        .replace(/\s+/g, ' ')
        .replace(/^[^A-Za-z]+/, '')
        .replace(/[^A-Za-z0-9' -]+$/, '')
        .trim();
      if (!/^[A-Za-z]/.test(head) || head.length > 40 || head.split(/\s+/).length > 4) continue;
      if (!out.some((h) => h.toLowerCase() === head.toLowerCase())) out.push(head);
    }
  }
  return out.slice(0, 30);
}

// 假讲解：按空格粗切主谓宾，只为验证成分映射、译文排版与点词浮层，不代表真实语法分析。
function stubExplanation(numbered) {
  const lines = numbered.split('\n').filter((line) => /^\d+\.\s/.test(line));
  const glossary = new Map();
  const sentences = lines.map((line) => {
    const en = line.replace(/^\d+\.\s*/, '');
    for (const word of en.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []) {
      const key = word.toLowerCase();
      if (!glossary.has(key)) glossary.set(key, `${key}| |（假上游）${key} 的释义`);
    }
    const words = en.replace(/[.!?]$/, '').split(' ');
    const subj = words.slice(0, 2).join(' ');
    const verb = words[2] ?? '';
    const rest = words.slice(3).join(' ');
    const marked = [`[主语 ${subj}]`, verb && `[谓语 ${verb}]`, rest && `[宾语 ${rest}]`]
      .filter(Boolean)
      .join(' ');
    return {
      zh: `（假上游译文）${en}`,
      structure: `（假上游结构）主语「${subj}」＋谓语「${verb}」，其余成分作宾语或修饰。`,
      marked,
    };
  });
  return { sentences, glossary: [...glossary.values()] };
}

globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  const system = body.messages[0].content;
  const user = body.messages[1].content;
  const isModelText = system.includes('示范答案');
  const isIntake = system.includes('词卡整理助手');
  const isExplain = system.includes('逐句讲解');
  const isGloss = system.includes('英语学习词典');
  const payload = isGloss
    ? { term: user.match(/词：(.+)/)?.[1] ?? '', pos: 'v.', meaningZh: '（本地假上游）这个词的释义' }
    : isExplain
    ? stubExplanation(user)
    : isIntake
    ? {
        // 假上游不会补释义；正好用来验证「网关没给全字段时前端不能崩」。
        words: stubHeadwords(user).map((headword) => ({
          headword,
          pos: '',
          meaningZh: '',
          theme: '本地假主题',
          examples: [],
          collocations: [],
        })),
      }
    : isModelText
    ? (() => {
        // 假上游不会写文章：按网关给的篇幅区间拼句，用来验证长度约束与高亮。
        const heads = [...system.matchAll(/id=([\w-]+) \| ([^｜]+)｜/g)].map((m) => m[2]);
        const ids = [...system.matchAll(/id=([\w-]+)/g)].map((m) => m[1]);
        const range = system.match(/(\d+)~(\d+) 句英文（约 (\d+)~(\d+) 词/);
        const minS = range ? Number(range[1]) : 2;
        const maxS = range ? Number(range[2]) : 4;
        const frames = [
          (h) => `I kept a small card for "${h}" and reread it twice before starting today's draft in class.`,
          (h) => `Today my draft finally uses "${h}" in the exact place where it actually belongs.`,
          (h) => `Using "${h}" inside a real sentence feels much easier now than it did last week.`,
          (h) => `My study partner circled "${h}" and said the collocation now sounds completely natural to her.`,
          (h) => `Once "${h}" appears naturally in the opening line, the whole paragraph holds together much better.`,
          (h) => `I plan to reuse "${h}" in tomorrow's journal entry so that it stays active for longer.`,
        ];
        const sentences = heads.map((h, i) => frames[i % frames.length](h));
        while (sentences.length < minS) {
          sentences.push(frames[sentences.length % frames.length](heads[sentences.length % heads.length]));
        }
        while (sentences.length > maxS) {
          const last = sentences.pop();
          const prev = sentences.pop();
          sentences.push(`${prev.replace(/[.!?]$/, '')}, and ${last.charAt(0).toLowerCase()}${last.slice(1)}`);
        }
        return { text: sentences.join(' '), wordIds: ids };
      })()
    : {
        usages: [...system.matchAll(/id=([\w-]+) \| ([^｜]+)｜/g)].map((m, i) => ({
          wordId: m[1],
          used: true,
          natural: i === 0,
          note: `（本地假上游）「${m[2]}」用出来了，${i === 0 ? '搭配自然' : '但没带上常见搭配'}`,
        })),
        accuracy: 60,
        overall: '（本地假上游）句子结构没问题，下次把目标词固定搭配一起写出来。',
      };
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

const handler = createHandler({ LLM_API_KEY: 'sk-local-stub-not-real' });

createServer(async (req, res) => {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.set(req.rawHeaders[i], req.rawHeaders[i + 1]);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const response = await handler(
    new Request(`http://127.0.0.1:8000${req.url}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}).listen(8000, '127.0.0.1', () => console.log('stub Function on http://127.0.0.1:8000（假上游，不调模型）'));
