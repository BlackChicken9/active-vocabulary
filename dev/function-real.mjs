// 本地真上游联调：跑真 functions/handler.ts，fetch 不拦截，直连 DeepSeek。
// 站点密钥从仓库根的 .env.local 读 API_KEY（该文件已被 gitignore，别提交），shell 环境变量优先。
// 页面里粘的「自己的密钥」（x-model-key）优先级更高，会顶掉站点密钥。
// 运行：node dev/function-real.mjs  （监听 127.0.0.1:8000，配合 vite 代理）
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../functions/handler.ts';

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
} catch {
  // 没有 .env.local 就只用当前 shell 的环境变量
}

const handler = createHandler({
  LLM_API_KEY: process.env.API_KEY,
  AI_MODEL: process.env.AI_MODEL,
  AI_BASE_URL: process.env.AI_BASE_URL,
});

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
}).listen(8000, '127.0.0.1', () =>
  console.log(
    `real Function on http://127.0.0.1:8000（直连 DeepSeek）\n  站点密钥：${
      process.env.API_KEY ? '已加载，免费示范额度可用' : '未设置 API_KEY，只有页面里粘自己的密钥才走 AI'
    }`,
  ),
);
