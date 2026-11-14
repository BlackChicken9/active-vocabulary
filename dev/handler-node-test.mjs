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

function post(path, body, headers = {}) {
  return new Request(`https://site.example/functions/v1/app/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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
    { headword: '## 科技与生活' },
    { headword: '- **1. ubiquitous**  adj. 无处不在的' },
    { headword: 'Phones are ubiquitous in our daily lives. 手机在日常生活中无处不在。' },
    { headword: 'a'.repeat(45) },
    { headword: "it's hard to know for sure" },
  ],
});
const intakeResult = await configured(post('intake', { raw: 'ubiquitous, bare' }));
const intake = JSON.parse(await intakeResult.text());
assert.equal(intakeResult.status, 200);
assert.equal(intake.ok, true);
assert.deepEqual(intake.words.map((w) => w.headword), ['ubiquitous', 'bare', "it's hard to know for sure"]);
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

// 12. 粘贴导入的词可能没有释义：feedback / model-text 不能因此拒绝请求
stubUpstream({ usages: [{ wordId: 'bare', used: true, natural: true, note: '用得自然' }], accuracy: 90, overall: '不错' });
const noGloss = [{ id: 'bare', headword: 'ubiquitous', meaningZh: '', collocations: [] }];
const bareFeedback = await configured(post('feedback', { words: noGloss, text: 'Phones are ubiquitous.', taskId: 't2' }));
assert.equal(bareFeedback.status, 200);
assert.equal(JSON.parse(await bareFeedback.text()).feedback.usages[0].natural, true);
stubUpstream({ text: 'Phones are ubiquitous.', wordIds: ['bare'] });
assert.equal((await configured(post('model-text', { words: noGloss, prompt: '写一句' }))).status, 200);

// 13. model-text 篇幅：区间进 prompt，越界被夹住，缺省按词数估
stubUpstream({ text: 'One. Two. Three.', wordIds: ['alleviate'] });
await configured(post('model-text', {
  words: WORDS,
  prompt: 'x',
  length: { minSentences: 7, maxSentences: 10, minWords: 100, maxWords: 180 },
}));
let systemPrompt = JSON.parse(upstreamCalls[0].options.body).messages[0].content;
assert.match(systemPrompt, /7~10 句英文（约 100~180 词）/);
stubUpstream({ text: 'x', wordIds: [] });
await configured(post('model-text', {
  words: WORDS,
  prompt: 'x',
  length: { minSentences: 99, maxSentences: 1, minWords: -5, maxWords: 9000 },
}));
systemPrompt = JSON.parse(upstreamCalls[0].options.body).messages[0].content;
assert.match(systemPrompt, /12~12 句英文（约 10~400 词）/);
stubUpstream({ text: 'x', wordIds: [] });
await configured(post('model-text', { words: WORDS, prompt: 'x' }));
systemPrompt = JSON.parse(upstreamCalls[0].options.body).messages[0].content;
assert.match(systemPrompt, /2~4 句英文（约 28~72 词）/);

// 14. 长示范不被旧的 1200 字上限截断
const longText = 'A very long sentence about daily practice. '.repeat(60);
stubUpstream({ text: longText, wordIds: ['alleviate'] });
const longModel = JSON.parse(await (await configured(post('model-text', {
  words: WORDS,
  prompt: 'x',
  length: { minSentences: 7, maxSentences: 10, minWords: 100, maxWords: 180 },
}))).text());
assert.equal(longModel.modelText.text, longText.trim());

// 15. explain：按网关自己的分句编号对齐，紧凑词汇表与成分串都要解析出来
stubUpstream({
  sentences: [
    {
      zh: '跑步帮我减轻压力。',
      structure: '主语 Running，谓语 helps，宾语 me，不定式作宾补。',
      marked: '[主语 Running] [谓语 helps] [宾语 me] [补语 alleviate stress]',
    },
    { zh: '你可以利用同一个习惯。', structure: '主谓宾结构。', marked: '[主语 You][谓语 can leverage][宾语 the same habit]' },
  ],
  glossary: [
    'running|n.|跑步',
    'alleviate|v.|减轻',
    'leverage|v.|利用',
    'habit|n.|习惯',
    'running|n.|重复项',
    'bad|entry',
    '|v.|缺词头',
    '中文|n.|不是英文词头',
    { term: 'stress', pos: 'n.', meaningZh: '压力' },
  ],
});
const explained = JSON.parse(await (await configured(post('explain', {
  words: WORDS,
  text: 'Running helps me alleviate stress. You can leverage the same habit.',
}))).text());
assert.equal(explained.ok, true);
assert.deepEqual(explained.explanation.sentences.map((s) => s.en), [
  'Running helps me alleviate stress.',
  'You can leverage the same habit.',
]);
assert.equal(explained.explanation.sentences[0].zh, '跑步帮我减轻压力。');
assert.deepEqual(explained.explanation.sentences[0].parts[3], { role: '补语', text: 'alleviate stress' });
assert.deepEqual(explained.explanation.sentences[1].parts.map((p) => p.role), ['主语', '谓语', '宾语']);
assert.deepEqual(explained.explanation.glossary.map((g) => g.term), [
  'running',
  'alleviate',
  'leverage',
  'habit',
  'stress',
]);
let explainBody = JSON.parse(upstreamCalls[0].options.body);
assert.match(explainBody.messages[1].content, /^1\. Running helps me alleviate stress\.\n2\. You can leverage/);
assert.match(explainBody.messages[0].content, /必须正好 2 项/);
assert.equal(explainBody.max_tokens, 4000);

// 16. explain：模型少回一句也不崩，缺的那句留空；全空则收敛为 502
stubUpstream({ sentences: [{ zh: '只回了第一句' }], glossary: [] });
const partial = JSON.parse(await (await configured(post('explain', {
  words: WORDS,
  text: 'One two three. Four five six.',
}))).text());
assert.equal(partial.explanation.sentences.length, 2);
assert.equal(partial.explanation.sentences[1].zh, '');
assert.deepEqual(partial.explanation.sentences[1].parts, []);
stubUpstream({ sentences: [], glossary: [] });
assert.equal((await configured(post('explain', { words: WORDS, text: 'One. Two.' }))).status, 502);
stubUpstream({ sentences: [{ zh: '有译文' }] });
assert.equal((await configured(post('explain', { text: 'One.' }))).status, 200);
assert.equal((await configured(post('explain', { words: WORDS }))).status, 400);
assert.equal((await configured(post('explain', { words: WORDS, text: '   ' }))).status, 400);

// 17. explain 句数封顶 12，缩写不切句
stubUpstream({ sentences: [], glossary: ['word|n.|词'] });
const many = JSON.parse(await (await configured(post('explain', {
  text: Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(' '),
}))).text());
assert.equal(many.explanation.sentences.length, 12);
stubUpstream({ sentences: [], glossary: ['word|n.|词'] });
const abbrev = JSON.parse(await (await configured(post('explain', { text: 'Use e.g. this one. Then stop.' }))).text());
assert.deepEqual(abbrev.explanation.sentences.map((s) => s.en), ['Use e.g. this one.', 'Then stop.']);

// 18. gloss：查一个词，脏词头被拒，缺释义收敛为 502
stubUpstream({ term: 'absorbs', pos: 'v.', meaningZh: '吸收' });
const glossed = JSON.parse(await (await configured(post('gloss', { term: 'absorbs', sentence: 'The ocean absorbs heat.' }))).text());
assert.deepEqual(glossed.entry, { term: 'absorbs', pos: 'v.', meaningZh: '吸收' });
assert.equal(JSON.parse(upstreamCalls[0].options.body).max_tokens, 512);
stubUpstream({ term: '模型乱改的词', meaningZh: '释义' });
const keptTerm = JSON.parse(await (await configured(post('gloss', { term: 'absorbs' }))).text());
assert.equal(keptTerm.entry.term, 'absorbs');
assert.equal((await configured(post('gloss', { term: 'not a word at all!!' }))).status, 400);
assert.equal((await configured(post('gloss', {}))).status, 400);
stubUpstream({ term: 'absorbs' });
assert.equal((await configured(post('gloss', { term: 'absorbs' }))).status, 502);

// 19. 词汇表条数封顶 120
stubUpstream({
  sentences: [],
  glossary: Array.from({ length: 200 }, (_, i) => `word${i}|n.|释义${i}`),
});
const cappedGloss = JSON.parse(await (await configured(post('explain', { text: 'One. Two.' }))).text());
assert.equal(cappedGloss.explanation.glossary.length, 120);

// 20. 访客自带密钥：优先于站点密钥、缺站点密钥也能用、脏值与上游拒绝单独报错、绝不回显
const BYO = 'sk-user-own-key-0001';
const byoOnly = createHandler({});
stubUpstream({ text: 'Phones are ubiquitous.', wordIds: ['bare'] });
const byoModel = await byoOnly(post('model-text', { words: WORDS, prompt: 'x' }, { 'x-model-key': BYO }));
assert.equal(byoModel.status, 200);
assert.match(upstreamCalls[0].options.headers.authorization, new RegExp(`^Bearer ${BYO}$`));
assert.equal((await byoModel.text()).includes(BYO), false);
// 站点密钥和自带密钥同时存在时，用的是自带的那个。
stubUpstream({ text: 'Phones are ubiquitous.', wordIds: ['bare'] });
await configured(post('model-text', { words: WORDS, prompt: 'x' }, { 'x-model-key': BYO }));
assert.match(upstreamCalls[0].options.headers.authorization, new RegExp(`^Bearer ${BYO}$`));
// 形状不对的自带密钥在本地就拒掉，一次上游都不打。
stubUpstream({});
for (const bad of ['ab', 'sk-bad key', 'k'.repeat(300)]) {
  const rejected = await configured(post('model-text', { words: WORDS, prompt: 'x' }, { 'x-model-key': bad }));
  assert.equal(rejected.status, 400);
  assert.deepEqual(JSON.parse(await rejected.text()), { ok: false, error: 'model_key_invalid' });
}
assert.equal(upstreamCalls.length, 0);
// 上游拒绝自带密钥 → model_key_rejected，且不回落到站点密钥再打一次。
stubUpstream({}, { status: 401 });
const keyRejected = await configured(post('model-text', { words: WORDS, prompt: 'x' }, { 'x-model-key': BYO }));
assert.equal(keyRejected.status, 400);
assert.deepEqual(JSON.parse(await keyRejected.text()), { ok: false, error: 'model_key_rejected' });
assert.equal(upstreamCalls.length, 1);
// 用的是站点密钥时，上游 401 仍然只是网关故障，不泄漏任何 key。
stubUpstream({}, { status: 401 });
const siteKeyRejected = await configured(post('model-text', { words: WORDS, prompt: 'x' }));
assert.equal(siteKeyRejected.status, 502);
assert.deepEqual(JSON.parse(await siteKeyRejected.text()), { ok: false, error: 'upstream_unavailable' });

console.log('functions/handler.ts 全部 20 组断言通过');
