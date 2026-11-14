// 纯函数校验：分句、分词、成分映射、原形还原、点词查义。
// 运行：node dev/passage-test.mjs
import assert from 'node:assert/strict';
import {
  lemmaCandidates,
  lookupGloss,
  parseMarked,
  roleClass,
  segmentSentence,
  splitSentences,
  tokenize,
} from '../src/features/writing/passage.ts';

// 1. 分句：缩写、人名首字母、引号、省略号
assert.deepEqual(splitSentences('One two. Three four! Five?'), ['One two.', 'Three four!', 'Five?']);
assert.deepEqual(splitSentences('Use e.g. this one. Then stop.'), ['Use e.g. this one.', 'Then stop.']);
assert.deepEqual(splitSentences('Mr. Green said "go home." Then he left.'), [
  'Mr. Green said "go home."',
  'Then he left.',
]);
assert.deepEqual(splitSentences('J. R. Tolkien wrote it.'), ['J. R. Tolkien wrote it.']);
assert.deepEqual(splitSentences('Wait… what?'), ['Wait…', 'what?']);
assert.deepEqual(splitSentences('  No   punctuation here  '), ['No punctuation here']);
assert.deepEqual(splitSentences(''), []);
assert.deepEqual(splitSentences('Pi is 3.14 exactly.'), ['Pi is 3.14 exactly.']);

// 2. 分词：词与非词交替，拼回去必须还原原句
const sentence = 'The ocean absorbs much of the heat, doesn\'t it?';
const tokens = tokenize(sentence);
assert.equal(tokens.map((t) => t.text).join(''), sentence);
assert.equal(tokens.filter((t) => t.word).length, 9);
assert.deepEqual(tokens.slice(0, 3), [
  { text: 'The', word: true },
  { text: ' ', word: false },
  { text: 'ocean', word: true },
]);
assert.equal(tokenize('well-known').length, 1);
assert.equal(tokenize('word-')[1].text, '-');

// 3. 成分串解析：空格与竖线两种分隔都认，脏段丢掉
assert.deepEqual(parseMarked('[主语 The ocean] [谓语 absorbs] [宾语 much of the heat]'), [
  { role: '主语', text: 'The ocean' },
  { role: '谓语', text: 'absorbs' },
  { role: '宾语', text: 'much of the heat' },
]);
assert.deepEqual(parseMarked('[主语|The ocean][谓语|absorbs]'), [
  { role: '主语', text: 'The ocean' },
  { role: '谓语', text: 'absorbs' },
]);
assert.deepEqual(parseMarked('[主语 ] 没有方括号的普通句子'), []);
assert.deepEqual(parseMarked(''), []);

// 4. 成分映射：顺序对得上才上色，对不上整句放弃
const parts = parseMarked('[主语 The ocean] [谓语 absorbs] [宾语 much of the heat]');
const segments = segmentSentence('The ocean absorbs much of the heat.', parts);
assert.deepEqual(segments, [
  { text: 'The ocean', role: '主语' },
  { text: ' ', role: null },
  { text: 'absorbs', role: '谓语' },
  { text: ' ', role: null },
  { text: 'much of the heat', role: '宾语' },
  { text: '.', role: null },
]);
assert.equal(segments.map((s) => s.text).join(''), 'The ocean absorbs much of the heat.');
assert.equal(segmentSentence('The ocean absorbs heat.', [{ role: '主语', text: 'A boat' }]), null);
assert.equal(segmentSentence('One two three.', [{ role: '主语', text: 'two' }, { role: '谓语', text: 'One' }]), null);
assert.equal(segmentSentence('Anything.', []), null);
assert.equal(segmentSentence('the ocean absorbs heat', [{ role: '主语', text: 'The ocean' }])[0].text, 'the ocean');

// 5. 成分名归到色号
assert.equal(roleClass('主语'), 'subj');
assert.equal(roleClass('定语从句'), 'clause');
assert.equal(roleClass('谓语动词'), 'verb');
assert.equal(roleClass('时间状语'), 'adv');
assert.equal(roleClass('没见过的成分'), 'other');

// 6. 原形还原
assert.ok(lemmaCandidates('absorbs').includes('absorb'));
assert.ok(lemmaCandidates('absorbed').includes('absorb'));
assert.ok(lemmaCandidates('running').includes('run'));
assert.ok(lemmaCandidates('studies').includes('study'));
assert.ok(lemmaCandidates('easier').includes('easy') === false);
assert.ok(lemmaCandidates('cities').includes('city'));
assert.ok(lemmaCandidates("ocean's").includes('ocean'));
assert.ok(lemmaCandidates('quickly').includes('quick'));

// 7. 点词查义：词库优先，其次 AI 词汇表，最后本地虚词词典
const words = [
  { id: '1', headword: 'alleviate', pos: 'v.', meaningZh: '减轻（词库）', examples: [], collocations: [], mastery: 'training', updatedAt: '' },
  { id: '2', headword: 'bare', meaningZh: '', examples: [], collocations: [], mastery: 'passive', updatedAt: '' },
];
const glossary = [
  { term: 'alleviate', pos: 'v.', meaningZh: '减轻（AI）' },
  { term: 'heat', pos: 'n.', meaningZh: '热量' },
  { term: 'bare', pos: 'adj.', meaningZh: '光秃的' },
];
assert.equal(lookupGloss('alleviates', glossary, words).source, 'bank');
assert.equal(lookupGloss('alleviates', glossary, words).entry.meaningZh, '减轻（词库）');
assert.equal(lookupGloss('alleviates', glossary, words).entry.term, 'alleviates');
assert.equal(lookupGloss('heat', glossary, words).source, 'ai');
assert.equal(lookupGloss('bare', glossary, words).source, 'ai');
assert.equal(lookupGloss('the', glossary, words).source, 'local');
assert.equal(lookupGloss('THE', glossary, words).entry.meaningZh.startsWith('art.'), true);
assert.equal(lookupGloss('zzz', glossary, words), null);

console.log('src/features/writing/passage.ts 全部 7 组断言通过');