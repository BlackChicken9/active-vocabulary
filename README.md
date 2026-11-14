# 主动词库

把「认识但不会用」的英文词，练成会在作文里主动用出来的词。

背单词和写作用词是断开的：阅读时认得的词，落到笔上就是想不起来，想起来了搭配也常常错。主动词库不加新的背诵环节，而是把你已经在背的词直接塞进一段限定写作任务里——勾词、按这批词出题、读 AI 示范或自己写、AI 逐词判定用没用出来、搭配地不地道，用出来且地道才算真正掌握。

在线地址：<https://active-vocab-em96hhnq10h.qoder.zone>（Qoder Sites 部署，当前访问策略为指定账号，需登录后打开）

## 核心闭环

1. **收词**：在写作面板点「粘贴你正在背的词」，把自己正在背的笔记整段粘进来，`/intake` 整理成词卡（自动勾选前 5 个）；也可以在词本里手动填一个。首屏词库是空的，不预设任何词，空词库时另有「试试粘这段」用样例走一遍闭环。
2. **出题**：在左侧词库勾 2~5 个词，题干按这批词的主题生成，不是固定模板轮播——勾海洋主题的词，出的就是海洋的题。
3. **练用**：两条路共用同一篇幅要求。**A 读 AI 示范短文**（按题干和篇幅现写，逐句给译文与句子结构，点任意单词看释义）；**B 我自己写**（写完 AI 逐词判定是否用出、搭配是否自然，给得分和可抄的改法）。
4. **进阶**：掌握度从 `认识` 推到 `练用中`，再到 `会用`。

## 掌握度

| 状态     | 中文   | 怎么到                                             |
| -------- | ------ | -------------------------------------------------- |
| `passive`  | 认识   | 粘贴导入或手动收词的初始状态                       |
| `training` | 练用中 | 读完 AI 示范短文（路径 A 的上限），或在词卡一键标记 |
| `active`   | 会用   | 自己写（路径 B），AI 判为用出且搭配地道            |

只升不降：读示范最多到 `training`，亲手写出来且用对搭配才计入 `active`。判定与回写在 `src/features/writing/masteryUpdate.ts`，类型契约在 `src/types.ts`。

## 界面

顶部两个视图切换，进哪个视图就重算哪个视图的数据。

- **写作**：左「我的词库」（勾选、粘贴收词）、右「限定写作」（篇幅、A/B 两条路、题干与目标词、结果区）。
- **词本**：词卡列表 + 按掌握度筛选 + 手动收词表单；点词卡进学习视图，补搭配和例句、一键标记「练用中」。
- **篇幅四档**：自动（句数 = 目标词数，夹在 2~8 句）/ 短 2~3 句 / 中 4~6 句 / 长 7~10 句，见 `src/features/writing/passageLength.ts`。示范短文与自写共用同一区间，写作时实时显示句数/词数偏短、达标还是偏长。
- **逐句讲解**：示范短文可切「整段 / 逐句」，逐句展开给译文、结构说明和按成分切分的原句高亮；某一句讲解失败可以单独重试。
- **点词查释义**：示范与讲解里的每个单词都是按钮，点开看它在这一句里的释义；词库里没有的词可以直接「收进词库」。

词库、任务与草稿都存在这台设备的浏览器 localStorage（键名 `tianchi.words` / `tianchi.tasks`），不上传任何文本内容；只有生成示范和点评时，题干与勾选项会发给 AI 网关。

## AI 网关

前端只调同源 `/functions/v1/app/{intake,model-text,explain,gloss,feedback}`，密钥不进浏览器。

| 路由         | 作用                              | 入参                              | 出参                  |
| ------------ | --------------------------------- | --------------------------------- | --------------------- |
| `intake`     | 把任意粘贴文本整理成词卡          | `{ raw }`（≤6000 字）             | `{ ok, words[] }`（≤30 条） |
| `model-text` | 按题干与篇幅生成示范短文          | `{ prompt, words[], length }`     | `{ ok, modelText }`   |
| `explain`    | 示范短文逐句讲解（译文/结构/成分）| `{ text, words[] }`               | `{ ok, explanation }` |
| `gloss`      | 单个词在该句语境下的释义          | `{ term, sentence }`              | `{ ok, entry }`       |
| `feedback`   | 逐词判定是否用出、是否地道        | `{ taskId, text, words[] }`       | `{ ok, feedback }`    |

`intake` 是收词的正门：不规定粘贴格式，一串单词、一段带释义的笔记都能进。返回的每条是 `{ headword, pos, meaningZh, theme, examples[≤2], collocations[≤4]{phrase,gloss} }`，字段缺了就是空串/空数组，词头已去重。词头有校验（`HEADWORD_OK`：英文开头、≤40 字符，模型把整行笔记、例句或中文释义当词头时直接丢掉），所以入库的一定是词而不是句子。`theme` 是模型对这批词共同话题的判断（如「海洋与环境」），入库后存成词卡的 `source: 粘贴导入 · ${theme}`，出题时按「·」后的主题生成题干——这就是「按词出题」的来源。

网关侧的约束（`functions/handler.ts`）：只接受 POST，请求体 ≤12000 字；`feedback` / `model-text` 的 `words[]` 为 1~8 条，`id` 与 `headword` 必填，`meaningZh` **允许空串**（刚粘贴导入的词可能还没有释义，缺释义不该让整次点评失败）；`explain` 词表缺失也能讲。篇幅契约 `length = { minSentences, maxSentences, minWords, maxWords }`，网关把句数夹在 1~12、词数夹在 10~400 并保证 min ≤ max。

上游走 DeepSeek 的 OpenAI 兼容接口（`https://api.deepseek.com/v1`），环境变量：`API_KEY`（必填 Secret，填 DeepSeek 的 key）、`AI_MODEL`（默认 `deepseek-chat`）、`AI_BASE_URL`（可选，换服务商时用）。密钥只在 edge 运行时读取，打包产物里没有。

**任何一路不通都不假装成功。** 缺 key 返回 `service_not_configured`，上游失败返回 `upstream_unavailable`，前端每一路都有本地兜底并在结果里写明这次为什么没走 AI：点评退回本地 mock 规则、示范退回词卡例句拼接、讲解只切句不给译文、收词按换行与逗号切分只填 `headword`。返回体也不带上游细节（状态码、异常文本、密钥）。

## 技术选型

- **Vite 7 + TypeScript 5.6**，无前端框架：视图是模板字符串 + `escapeHtml` 转义，状态在模块闭包里，改动走重绘；没有虚拟 DOM 与运行时依赖，构建产物就是静态资源。
- **样式**：`src/style.css` 一套设计令牌（配色/字体/圆角/按钮），`public/assets/ui/cards.css`、`public/assets/motion/motion.css` 是卡片与动效的公共层，字体子集本地化在 `public/assets/fonts/`。
- **AI 网关**：Deno Function（`functions/index.ts` 入口 + `functions/handler.ts` 全部逻辑），单文件、无框架，按路径尾段路由。
- **存储**：浏览器 localStorage，无账号、无服务端数据库。

## 目录

```
src/
  main.ts                  # 顶栏、掌握度色带、两个视图的切换
  types.ts                 # Word / WritingTask / Feedback / PassageLength 契约
  features/words/          # 词本：列表与筛选、手动收词、词卡学习视图、localStorage
  features/writing/        # 写作：选词出题、两条路径、逐句讲解、点词释义、AI 客户端与降级
functions/                 # Sites Function：五个路由的网关实现
public/assets/             # 字体、卡片与动效样式、分享图
dev/                       # 网关断言与本地假上游
docs/                      # 任务清单与过程截图
```

## 本地开发

```bash
npm install
npm run dev        # 本地开发，http://127.0.0.1:5173
npm run build      # 产出 dist/
npm run typecheck  # 类型检查
```

不调真实模型也能跑完整闭环：

```bash
node dev/handler-node-test.mjs   # 网关逻辑断言（本机无 Deno 也能跑）
node dev/passage-test.mjs        # 分句与成分切分断言
node dev/function-stub.mjs       # 本地假上游，不调模型，监听 127.0.0.1:8000
npm run dev                      # vite 把 /functions/v1/app 代理到上面的端口
deno run --allow-net --allow-env functions/index.ts   # 有 Deno 时的真实入口
```

## 部署

站点部署在 Qoder Sites（项目 slug `active-vocab`），`dist/` 为静态产物，`functions/` 为同源 AI 网关，密钥放在站点 Settings 的 Secret `API_KEY` 里。

## 协作约定

- `main` 为可信主干：按功能开 `feat/xxx` 分支，合并走 PR，另一人 review。
- 共享文件（`src/types.ts`、入口接线如 `src/main.ts`）的改动一律走 PR。
- **Mock 先行，互不阻塞**：词库与写作两侧各自在 `src/features/words/`、`src/features/writing/` 目录内开发，跨目录只经 `types.ts` 契约。
- 任务认领看 `docs/issues.md`，一个任务一条 GitHub Issue；关键步骤截图存 `docs/process/NN-MM-DD-描述.png`。
