// 本地假上游：只为跑通 浏览器 → vite 代理 → functions/handler.ts 这条链路。
// 不调用真实模型；真实联调把端口换成 Deno（见 README「AI 网关」）。
// 运行：node dev/function-stub.mjs  （监听 127.0.0.1:8000）
import { createServer } from 'node:http';
import { createHandler } from '../functions/handler.ts';

globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  const system = body.messages[0].content;
  const user = body.messages[1].content;
  const isModelText = system.includes('示范答案');
  const isIntake = system.includes('词卡整理助手');
  const payload = isIntake
    ? {
        // 假上游只会切分，不会补释义；正好用来验证「网关没给全字段时前端不能崩」。
        words: user
          .split(/[\n,;，；]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 30)
          .map((headword) => ({ headword, pos: '', meaningZh: '', examples: [], collocations: [] })),
      }
    : isModelText
    ? {
        text: 'Running in the morning helps me alleviate stress before class. Reading one page a day lets me accumulate knowledge without noticing.',
        wordIds: [...system.matchAll(/id=(\w+)/g)].map((m) => m[1]),
      }
    : {
        usages: [...system.matchAll(/id=(\w+) \| (\w+)/g)].map((m, i) => ({
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
