import type { GlossEntry, SentencePart, Word } from '../../types';

/** 缩写与人名首字母后面的句点不算句末，否则「e.g.」会把一句切成两句。 */
const ABBREV = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|a\.m|p\.m|No|Fig)\.$/i;
const INITIAL = /(?:^|\s)[A-Z]\.$/;

/** 网关和前端必须切出同样的句子：逐句讲解按序号对齐，切法不一致译文就会错位。 */
export function splitSentences(text: string): string[] {
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

export interface Token {
  text: string;
  word: boolean;
}

/** 把一句拆成「词 / 非词」交替的片段，词片段渲染成可点的按钮，标点原样留着。 */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(/[A-Za-z](?:[A-Za-z0-9'’-]*[A-Za-z0-9])?/g)) {
    const at = match.index;
    if (at > last) out.push({ text: text.slice(last, at), word: false });
    out.push({ text: match[0], word: true });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), word: false });
  return out;
}

/** 模型用 [主语 The ocean] [谓语 absorbs] 这种紧凑写法回成分，比逐段 JSON 省一半 token。 */
export function parseMarked(marked: string): SentencePart[] {
  const out: SentencePart[] = [];
  for (const match of marked.matchAll(/\[([^\]\s|]{1,8})[|\s]\s*([^\]]+)\]/g)) {
    const text = match[2].trim();
    if (text) out.push({ role: match[1], text });
  }
  return out;
}

export interface Segment {
  text: string;
  role: string | null;
}

function indexOfCaseInsensitive(haystack: string, needle: string, from: number): number {
  const direct = haystack.indexOf(needle, from);
  return direct >= 0 ? direct : haystack.toLowerCase().indexOf(needle.toLowerCase(), from);
}

/** 成分必须按顺序落在原句里；对不上就整句放弃上色，只留文字讲解，绝不猜位置。 */
export function segmentSentence(sentence: string, parts: SentencePart[]): Segment[] | null {
  if (!parts.length) return null;
  const out: Segment[] = [];
  let cursor = 0;
  for (const part of parts) {
    const needle = part.text.trim();
    if (!needle) return null;
    const at = indexOfCaseInsensitive(sentence, needle, cursor);
    if (at < 0) return null;
    if (at > cursor) out.push({ text: sentence.slice(cursor, at), role: null });
    out.push({ text: sentence.slice(at, at + needle.length), role: part.role });
    cursor = at + needle.length;
  }
  if (cursor < sentence.length) out.push({ text: sentence.slice(cursor), role: null });
  return out;
}

const ROLE_CLASS: Record<string, string> = {
  主语: 'subj',
  谓语: 'verb',
  宾语: 'obj',
  表语: 'pred',
  补语: 'comp',
  定语: 'attr',
  状语: 'adv',
  从句: 'clause',
  连接词: 'link',
  同位语: 'appos',
  其他: 'other',
};

export function roleClass(role: string): string {
  if (ROLE_CLASS[role]) return ROLE_CLASS[role];
  if (role.includes('从句')) return 'clause';
  if (role.includes('主')) return 'subj';
  if (role.includes('谓') || role.includes('动词')) return 'verb';
  if (role.includes('宾')) return 'obj';
  if (role.includes('定')) return 'attr';
  if (role.includes('状')) return 'adv';
  return 'other';
}

/** 点的是文中形态（absorbs / absorbed），词表存的是原形，这里给出可能的原形。 */
export function lemmaCandidates(term: string): string[] {
  const t = term.toLowerCase();
  const out = [t];
  const push = (value: string) => {
    if (value.length >= 2 && !out.includes(value)) out.push(value);
  };
  const undouble = (stem: string) => {
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) push(stem.slice(0, -1));
  };
  if (t.endsWith("'s")) push(t.slice(0, -2));
  if (t.endsWith('ies')) push(`${t.slice(0, -3)}y`);
  if (t.endsWith('es')) {
    push(t.slice(0, -2));
    push(t.slice(0, -1));
  }
  if (t.endsWith('s') && !t.endsWith('ss')) push(t.slice(0, -1));
  if (t.endsWith('ing')) {
    const stem = t.slice(0, -3);
    push(stem);
    push(`${stem}e`);
    undouble(stem);
  }
  if (t.endsWith('ed')) {
    const stem = t.slice(0, -2);
    push(stem);
    push(`${stem}e`);
    undouble(stem);
  }
  if (t.endsWith('ly')) push(t.slice(0, -2));
  if (t.endsWith('er')) {
    push(t.slice(0, -2));
    push(t.slice(0, -1));
  }
  if (t.endsWith('est')) {
    push(t.slice(0, -3));
    push(t.slice(0, -2));
  }
  return out;
}

/** 虚词释义不值得花一次模型调用：这份小词典随前端一起走，点了立刻出。 */
const FUNCTION_WORDS: Record<string, string> = {
  the: 'art. 这（那）个；定冠词',
  a: 'art. 一个；不定冠词',
  an: 'art. 一个（元音前）',
  and: 'conj. 和；并且',
  or: 'conj. 或者；否则',
  but: 'conj. 但是',
  so: 'conj./adv. 所以；如此',
  because: 'conj. 因为',
  although: 'conj. 尽管',
  while: 'conj./n. 当…时；然而',
  when: 'conj./adv. 当…时',
  where: 'conj./adv. 在…的地方',
  which: 'pron. 哪一个；引导定语从句',
  that: 'pron./conj. 那个；引导从句',
  who: 'pron. 谁；引导定语从句',
  whose: 'pron. 谁的',
  what: 'pron. 什么',
  how: 'adv. 怎样；多么',
  why: 'adv. 为什么',
  if: 'conj. 如果；是否',
  than: 'conj./prep. 比',
  as: 'conj./prep. 作为；像…一样',
  of: 'prep. …的',
  in: 'prep. 在…里',
  on: 'prep. 在…上；关于',
  at: 'prep. 在（某点）',
  to: 'prep./不定式符号 到；向',
  for: 'prep. 为了；因为',
  with: 'prep. 和…一起；带有',
  without: 'prep. 没有',
  from: 'prep. 从',
  by: 'prep. 通过；被',
  into: 'prep. 进入',
  onto: 'prep. 到…之上',
  about: 'prep./adv. 关于；大约',
  over: 'prep./adv. 在…上方；超过',
  under: 'prep. 在…下方',
  between: 'prep. 在…之间',
  among: 'prep. 在…之中',
  through: 'prep. 穿过；通过',
  during: 'prep. 在…期间',
  before: 'prep./conj. 在…之前',
  after: 'prep./conj. 在…之后',
  until: 'prep./conj. 直到',
  against: 'prep. 反对；靠着',
  across: 'prep. 横过',
  beyond: 'prep. 超出',
  within: 'prep. 在…之内',
  i: 'pron. 我',
  me: 'pron. 我（宾格）',
  my: 'pron. 我的',
  mine: 'pron. 我的（东西）',
  we: 'pron. 我们',
  us: 'pron. 我们（宾格）',
  our: 'pron. 我们的',
  you: 'pron. 你；你们',
  your: 'pron. 你的；你们的',
  he: 'pron. 他',
  him: 'pron. 他（宾格）',
  his: 'pron. 他的',
  she: 'pron. 她',
  her: 'pron. 她的；她（宾格）',
  it: 'pron. 它',
  its: 'pron. 它的',
  they: 'pron. 他们；它们',
  them: 'pron. 他们（宾格）',
  their: 'pron. 他们的',
  this: 'pron. 这个',
  these: 'pron. 这些',
  those: 'pron. 那些',
  there: 'adv. 那里；（there be）有',
  here: 'adv. 这里',
  is: 'v. 是（be 的第三人称单数）',
  am: 'v. 是（be 的第一人称单数）',
  are: 'v. 是（be 的复数）',
  was: 'v. 是（be 的过去式）',
  were: 'v. 是（be 的过去式复数）',
  be: 'v. 是；成为',
  been: 'v. be 的过去分词',
  being: 'v. be 的现在分词',
  do: 'v. 做；助动词',
  does: 'v. do 的第三人称单数',
  did: 'v. do 的过去式',
  done: 'v. do 的过去分词',
  have: 'v. 有；助动词',
  has: 'v. have 的第三人称单数',
  had: 'v. have 的过去式',
  will: 'v. 将要',
  would: 'v. 将会；愿意',
  can: 'v. 能够',
  could: 'v. 能够（过去/委婉）',
  should: 'v. 应该',
  may: 'v. 可以；也许',
  might: 'v. 也许',
  must: 'v. 必须',
  not: 'adv. 不',
  no: 'adv./det. 不；没有',
  very: 'adv. 非常',
  too: 'adv. 太；也',
  also: 'adv. 也',
  just: 'adv. 刚刚；只是',
  only: 'adv./adj. 只；唯一的',
  more: 'adv./det. 更多',
  most: 'adv./det. 最多；大多数',
  much: 'adv./det. 许多',
  many: 'det. 许多',
  some: 'det. 一些',
  any: 'det. 任何',
  all: 'det. 全部',
  each: 'det. 每个',
  every: 'det. 每一个',
  both: 'det. 两者都',
  such: 'det. 这样的',
  own: 'adj. 自己的',
  same: 'adj. 相同的',
  other: 'adj./pron. 其他的',
  then: 'adv. 然后',
  now: 'adv. 现在',
  again: 'adv. 再一次',
  still: 'adv. 仍然',
  even: 'adv. 甚至',
  once: 'adv./conj. 一次；一旦',
  up: 'adv./prep. 向上',
  out: 'adv. 向外；出去',
  down: 'adv./prep. 向下',
  off: 'adv./prep. 离开；关掉',
  away: 'adv. 离开',
  back: 'adv./n. 回；后面',
};

export type GlossSource = 'bank' | 'ai' | 'local';

export interface GlossHit {
  entry: GlossEntry;
  source: GlossSource;
  word?: Word;
}

function findEntry(term: string, list: GlossEntry[]): GlossEntry | null {
  const keys = lemmaCandidates(term);
  for (const key of keys) {
    const hit = list.find((entry) => entry.term.toLowerCase() === key);
    if (hit) return hit;
  }
  return null;
}

/** 先认词库（用户自己的释义最准），再认 AI 词汇表，最后落到本地虚词词典。 */
export function lookupGloss(term: string, glossary: GlossEntry[], words: Word[]): GlossHit | null {
  const keys = lemmaCandidates(term);
  for (const key of keys) {
    const word = words.find((w) => w.headword.toLowerCase() === key);
    if (word?.meaningZh.trim()) {
      return {
        entry: { term, pos: word.pos ?? '', meaningZh: word.meaningZh.trim() },
        source: 'bank',
        word,
      };
    }
  }
  const ai = findEntry(term, glossary);
  if (ai) return { entry: { ...ai, term }, source: 'ai' };
  const local = FUNCTION_WORDS[term.toLowerCase()];
  if (local) return { entry: { term, pos: '', meaningZh: local }, source: 'local' };
  return null;
}