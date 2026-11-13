// 本机没有 Deno，用 Node 直接跑 functions/handler.ts 的纯 Web 标准逻辑。
// 运行：node dev/handler-node-test.mjs
import assert from 'node:assert/strict';
import { createHandler } from '../functions/handler.ts';

const WORDS = [
  { id: 'alleviate', headword: 'alleviate', meaningZh: '减轻', collocations: [{ phrase: 'alleviate stress' }] },
  { id: 'leverage', headword: 'leverage', meaningZh: '利用', collocations: [] },
];

let upstreamCalls = [];

function stubUpstream(payload, init = {}) {
  upstreamCalls = [];
  globalThis.fetch = async (url, options) => {
    upstreamCalls.push({ url: String(url), options });
    if (init.status && init.status !== 200) {
      return new Response(JSON.stringify({ message: 'secret upstream detail' }), {
        status: init.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

function post(path, body) {
  return new Request(`https://site.example/functions/v1/app/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const configured = createHandler({ DASHSCOPE_API_KEY: 'sk-test' });
const unconfigured = createHandler({});

// 1. 路由与方法
assert.equal((await unconfigured(post('feedback', { words: WORDS, text: 'x', taskId: 't1' }))).status, 503);
assert.equal((await configured(new Request('https://site.example/functions/v1/app/feedback'))).status, 405);
assert.equal((await configured(new Request('https://site.example/functions/v1/app/unknown'))).status, 404);

// 2. 缺 key 时不碰上游
stubUpstream({});
const noKey = await unconfigured(post('feedback', { words: WORDS, text: 'x', taskId: 't1' }));
assert.equal(JSON.parse(await noKey.text()).error, 'service_not_configured');
assert.equal(upstreamCalls.length, 0);

// 3. 非法入参被拒
stubUpstream({});
assert.equal((await configured(post('feedback', { text: 'x' }))).status, 400);
assert.equal((await configured(post('feedback', 'not json'))).status, 400);
assert.equal((await configured(post('feedback', { words: [], text: 'x' }))).status, 400);

// 4. feedback 正常路径：按目标词表补齐判定、夹住 accuracy
stubUpstream({
  usages: [
    { wordId: 'alleviate', used: true, natural: true, note: '搭配正确' },
    { wordId: 'leverage', used: false, natural: false, note: '没用上' },
    { wordId: 'evil', used: true, natural: true, note: '不在词表里' },
  ],
  accuracy: 250,
  overall: '总体不错',
});
const feedbackResult = await configured(post('feedback', { words: WORDS, text: 'I alleviate stress.', taskId: 't1' }));
const feedback = JSON.parse(await feedbackResult.text());
assert.equal(feedbackResult.status, 200);
assert.equal(feedback.ok, true);
assert.equal(feedback.feedback.usages.length, 2);
assert.deepEqual(feedback.feedback.usages.map((u) => u.wordId), ['alleviate', 'leverage']);
assert.equal(feedback.feedback.accuracy, 100);
assert.equal(feedback.feedback.taskId, 't1');
assert.match(upstreamCalls[0].url, /dashscope\.aliyuncs\.com\/compatible-mode\/v1\/chat\/completions$/);
assert.match(upstreamCalls[0].options.headers.authorization, /^Bearer sk-test$/);

// 5. 代码围栏包裹的 JSON 也能解析
stubUpstream('```json\n{"usages":[{"wordId":"alleviate","used":true,"natural":false,"note":"硬塞"}],"accuracy":40,"overall":"再练"}\n```');
const fenced = JSON.parse(await (await configured(post('feedback', { words: WORDS, text: 'x', taskId: 't1' }))).text());
assert.equal(fenced.feedback.usages[0].natural, false);

// 6. model-text 正常路径
stubUpstream({ text: 'Running helps me alleviate stress and you can leverage the same habit.', wordIds: ['alleviate'] });
const model = JSON.parse(await (await configured(post('model-text', { words: WORDS, prompt: '写一句' }))).text());
assert.equal(model.ok, true);
assert.match(model.modelText.text, /alleviate/);
assert.deepEqual(model.modelText.wordIds, ['alleviate']);

// 7. 上游 5xx → 稳定错误码，且不泄漏上游文本
stubUpstream({}, { status: 500 });
const failed = await configured(post('feedback', { words: WORDS, text: 'x', taskId: 't1' }));
assert.equal(failed.status, 502);
assert.deepEqual(JSON.parse(await failed.text()), { ok: false, error: 'upstream_unavailable' });

// 8. 上游返回非 JSON → 同样收敛为 502
stubUpstream('模型今天不想说话');
assert.equal((await configured(post('model-text', { words: WORDS, prompt: 'x' }))).status, 502);

console.log('functions/handler.ts 全部 8 组断言通过');
