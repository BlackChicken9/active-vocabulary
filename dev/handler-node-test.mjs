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

const configured = createHandler({ LLM_API_KEY: 'sk-test' });
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
assert.match(upstreamCalls[0].url, /api\.deepseek\.com\/v1\/chat\/completions$/);
assert.match(upstreamCalls[0].options.headers['user-agent'], /Windows/);
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

// 9. intake 正常路径：脏字段被清掉、词头去重、缺字段留空
stubUpstream({
  words: [
    {
      headword: 'ubiquitous',
      pos: 'adj.',
      meaningZh: '无处不在的',
      theme: '科技与社会',
      examples: ['Phones are ubiquitous.'],
      collocations: [{ phrase: 'ubiquitous in daily life', gloss: '在日常生活中无处不在' }],
    },
    { headword: '   ' },
    { headword: 'UBIQUITOUS', meaningZh: '重复词头' },
    { headword: 'bare', meaningZh: 123, theme: 456, examples: 'not an array', collocations: [{ gloss: '没有 phrase' }, 'junk'] },
  ],
});
const intakeResult = await configured(post('intake', { raw: 'ubiquitous, bare' }));
const intake = JSON.parse(await intakeResult.text());
assert.equal(intakeResult.status, 200);
assert.equal(intake.ok, true);
assert.deepEqual(intake.words.map((w) => w.headword), ['ubiquitous', 'bare']);
assert.deepEqual(intake.words[1], {
  headword: 'bare',
  pos: '',
  meaningZh: '',
  theme: '',
  examples: [],
  collocations: [],
});
assert.equal(intake.words[0].theme, '科技与社会');
assert.equal(intake.words[0].collocations[0].phrase, 'ubiquitous in daily life');
assert.equal(upstreamCalls[0].options.body.includes('Phones are ubiquitous'), false);
assert.equal(JSON.parse(upstreamCalls[0].options.body).messages[1].content, 'ubiquitous, bare');

// 10. intake 入参与空结果
stubUpstream({ words: [] });
assert.equal((await configured(post('intake', {}))).status, 400);
assert.equal((await configured(post('intake', { raw: '   ' }))).status, 400);
assert.equal(upstreamCalls.length, 0);
assert.equal((await configured(post('intake', { raw: 'accumulate' }))).status, 502);

// 11. intake 词卡数量封顶 30
stubUpstream({ words: Array.from({ length: 40 }, (_, i) => ({ headword: `word${i}` })) });
const capped = JSON.parse(await (await configured(post('intake', { raw: 'x'.repeat(6000) }))).text());
assert.equal(capped.words.length, 30);

console.log('functions/handler.ts 全部 11 组断言通过');
