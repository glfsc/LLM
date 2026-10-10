warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'db.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'public/assets/admin.css', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'public/assets/chat.css', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'scripts/capture-shots.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'scripts/check-platform.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'scripts/consistency-check.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'scripts/seed-thinking.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'scripts/sync-group-content.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'seed-content.js', LF will be replaced by CRLF the next time Git touches it
[1mdiff --git a/README.md b/README.md[m
[1mindex adee278..ed18ca4 100644[m
[1m--- a/README.md[m
[1m+++ b/README.md[m
[36m@@ -20,9 +20,22 @@[m
   二维码与管理入口都跟着走。[m
 - **一切皆题目**：实验 = 可复用的**题目模板**；问卷 = 一条链接 + 一列题目。插入模板即整组复制，复制后随便改。[m
 - **10 种题型**：打分 / 单选 / 多选 / 文本 / 排序 / 题组，以及材料消息、知情同意页、阅读确认页、结束说明页。[m
[32m+[m[32m  文本题带一个二级形态「**需输入指定内容**」：被试必须在底部输入框里输入指定内容（如「我已完成阅读」）才发送得出去，[m
[32m+[m[32m  空或不符时只在输入框上方提示（提示文案可自定义，默认「答案错误」），这一笔不落库、也不进聊天流；[m
[32m+[m[32m  断言在服务端做，标准答案不下发被试端。选入口在「插入题目」的二级菜单里。[m
 - **计时门控服务端权威**：强制阅读 N 秒、最短提交、最长作答到点自动提交、题目呈现前清屏；[m
   相邻同参数的题共用一个作答窗口；提前提交由服务端直接拒绝，不靠前端计时，也不产生轮询。[m
[31m-- **AI 思考面板**：负反馈正文之前先流式「思考」一段（可折叠、可回看），与打字机消息同一节奏。[m
[32m+[m[32m- **AI 思考面板**：负反馈正文之前先流式「思考」一段（可折叠、可回看），与打字机消息同一节奏；[m
[32m+[m[32m  时长默认 **20 秒**（在「思考过程」行里改，上限 60 秒），思考结束、正文开始前另有一行「思考已完成」，[m
[32m+[m[32m  思考内容用**五号 14px**（比正文小四小一档，读起来是个「旁白」）。[m
[32m+[m[32m- **正文一律小四 16px**：被试端（AI 消息、被试自己的气泡、题干、作答输入框、同意页文字）与管理端富文本编辑器的「正文（默认）」[m
[32m+[m[32m  都是 16px；材料里的小节标题是四号 19px（由 `db.js` 的 `body16` / `materialHtml` 统一生成，种子与线上一致）。[m
[32m+[m[32m  同样为 16px 的还有：管理端的**题卡标题 / 折叠摘要 / 思考过程 / 层级与批量数量输入**，[m
[32m+[m[32m  被试端的**勾选文案 / 整页按钮 / 编号字段名 / 选项按钮 / 排序项 / 题组子题标题**。[m
[32m+[m[32m  字段名、填写提示、参数名与单位等界面小字保持 10.5–12.5px 的层次；左侧大纲标题仍是 12px（为了同宽下多看几个字）。[m
[32m+[m[32m- **一键「显示全卷」**：编辑页右上角按钮（保存问卷左边）把每道题的正文拼成一份全文，题与题之间一条分割线，[m
[32m+[m[32m  每题上方一行灰色题目标识（不可编辑、不参与切分）——通读全卷、全选统一改字号 / 加粗都在这一个编辑器里做；[m
[32m+[m[32m  切回分题时按分割线切分写回每题，分割线数量对不上会拒绝切回并提示，不会把整卷写进一道题。[m
 - **管理端手机预览**：右侧是真被试端 iframe（同源同代码），支持 1×/5×/10×/20× 倍速、拖进度条或输题号跳题、一键「重做」；[m
   预览不建会话、不落库。[m
 - **数据即用**：每次作答都带呈现/作答时间戳与耗时落库；一键导出 Excel，含「汇总（一行一被试：各量表均分、两次作品文本、[m
[36m@@ -63,18 +76,21 @@[m [mnode server.js     # 等价 npm start；默认端口 3000，可用环境变量 P[m
 ## 被试端会经历什么（预设问卷）[m
 [m
 ```text[m
[31m-欢迎语 → 知情同意页（勾选同意）→ 任务信息 → 任务要求[m
[31m-→ 目标清晰度 5 题 → 创作指引 → 广告语创作（180 秒后才可提交 / 300 秒到点自动提交）[m
[31m-→ AI 负面反馈（先思考面板约 10 秒，再流式输出正文）→ 阅读确认页（强制停留 40 秒）[m
[32m+[m[32m欢迎语 → 知情同意页（勾选同意 + 填被试编号）→ 任务信息 → 任务要求[m
[32m+[m[32m→ 阅读材料确认（输入「已完成阅读」才能继续）[m
[32m+[m[32m→ 目标清晰度 5 题 → 创作指引 → 广告语创作（120 秒后才可提交 / 480 秒到点自动提交）[m
[32m+[m[32m→ AI 负面反馈（先思考面板 20 秒，再流式输出正文）→ 用户阅读确认反馈（输入「已完成阅读」，之前强制停留 40 秒）[m
 → 注意力检测 1 题 → 反馈来源识别 1 题[m
[31m-→ 反馈公平性 6 题 → 元过程 5 题 → 任务过程 4 题[m
[31m-→ 第 8 节「再次完成一模一样的任务」→ 再创作 1 题[m
[31m-→ 结束语 → 结束说明页（含欺骗的事后解释）[m
[32m+[m[32m→ 反馈公平性 6 题 → 元过程 5 题（进入这一节先清屏）→ 任务过程 4 题[m
[32m+[m[32m→ 第 8 节「再次完成一模一样的任务」（指导语 + 任务信息 + 任务要求）→ 再创作 1 题[m
[32m+[m[32m→ 结束说明页（含欺骗的事后解释）[m
 ```[m
 [m
[31m-- **组别3** = 目标清晰度**高**（任务要求含 6 条要求 + 100 分评价标准）；**组别4** = 目标清晰度**低**（2 条极简要求）。[m
[31m-  两组只差这两处「任务要求」文本，其余逐字节相同，由 `npm run sync-groups` 强制保证。[m
[31m-- 每份预设问卷共 39 条内容 = **24 道需作答题目** + 15 条材料与页面环节（模板 37 条，外加头尾的知情同意页与结束说明页）。[m
[32m+[m[32m- **组别3** = 目标清晰度**高**（任务要求含 6 条要求 + 100 分评价标准：品牌契合度 30 / 原创性 25 / 可记忆性 25 / 可延展性 20）；[m
[32m+[m[32m  **组别4** = 目标清晰度**低**（2 条极简要求）。两组只差这两处「任务要求」文本，其余逐字段相同，[m
[32m+[m[32m  由 `npm run sync-groups`（默认只预览，`--apply` 才写入）强制保证：脚本按 `seed-content.js` + `db.js` 的种子内容[m
[32m+[m[32m  重建两份预设问卷与两个实验模板，并逐字段复核。[m
[32m+[m[32m- 每份预设问卷共 39 条内容 = **26 道题号题** + 13 条材料与页面环节（模板 37 条，外加头尾的知情同意页与结束说明页）。[m
 [m
 ---[m
 [m
[36m@@ -125,6 +141,7 @@[m [mdesign/ demand/        设计稿与重构方案 / 原始实验材料（docx）[m
 | `simulate-subjects.js` | 走真实被试端接口灌模拟数据（`--n 20`） |[m
 | `sync-group-content.js` | 以组别4 为基准同步组别3，只保留「任务要求」两处差异 |[m
 | `seed-presets.js` / `seed-thinking.js` / `reset-db.js` | 重建预设问卷 / 补思考稿 / 删库重建 |[m
[32m+[m[32m| `sync-group-content.js` | 按种子内容重建「组别3 / 组别4 预设问卷 + 两个实验模板」（默认只预览，`--apply` 备份后写入） |[m
 | `lib/` | 自检用的直连数据库、HTTP 客户端、会话驱动器、xlsx 读取 |[m
 [m
 ---[m
[36m@@ -148,6 +165,9 @@[m [mdesign/ demand/        设计稿与重构方案 / 原始实验材料（docx）[m
 ## 说明[m
 [m
 - 运行环境 Node.js ≥ 22.13.0（用到内置 `node:sqlite`）；用便携包则无需自备 Node。[m
[31m-- 实验材料（题目、反馈正文、思考稿）来自 `db.js` 的种子与 `seed-content.js`，改完请跑 `npm run check` 自检。[m
[32m+[m[32m- 实验材料（题目、反馈正文、思考稿、量表指导语）来自 `seed-content.js` + `db.js` 的种子；改完种子想让线上预设问卷/模板跟上，[m
[32m+[m[32m  跑 `npm run sync-groups -- --apply`（会先备份 `data.db`），再跑 `npm run check` 自检。[m
[32m+[m[32m- 字号 / 排版的唯一出处：正文小四 16px、小节标题四号 19px（`db.js` 的 `body16` / `materialHtml`）；[m
[32m+[m[32m  被试端 CSS 的正文默认也是 16px（`public/assets/chat.css`），管理端编辑器默认 16px（`.rich-edit`）。[m
 - 两个组别各对应一份问卷链接，由研究者按批次分发决定谁进哪组；系统不做一人一链，也不做防重复参加。[m
 - 数据全部在 `data.db`（WAL 模式，另有 `-wal`/`-shm` 伴生文件）：可管理端导出 Excel，也可停机后整库取回。[m
[1mdiff --git a/db.js b/db.js[m
[1mindex 2a3f9b6..c3249e6 100644[m
[1m--- a/db.js[m
[1m+++ b/db.js[m
[36m@@ -9,6 +9,16 @@[m [mconst { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require('node:c[m
 const path = require('node:path');[m
 // 富文本清洗 / 互转（与浏览器共用同一份实现，见 public/assets/richtext.js）[m
 const RT = require('./public/assets/richtext.js');[m
[32m+[m[32m// 实验材料文案：数据层只管存取与排版，文案集中在 seed-content.js（改文案不必动 db.js）[m
[32m+[m[32mconst {[m
[32m+[m[32m  TASK_INFO, REQUIRE_HIGH, REQUIRE_LOW, CREATE_INTRO, CREATE2_GUIDE, CREATE2_INTRO,[m
[32m+[m[32m  FEEDBACK_TEXT, FEEDBACK_THINKING,[m
[32m+[m[32m  AGREEMENT_ANCHOR, FAIRNESS_ANCHOR,[m
[32m+[m[32m  GOAL_CLARITY, FAIRNESS, META_PROCESS, TASK_PROCESS,[m
[32m+[m[32m  GATE_TEXT, GATE_CHECK, GATE_BUTTON,[m
[32m+[m[32m  GATE_VARIANT, GATE_ID_LABEL, GATE_ID_PLACEHOLDER,[m
[32m+[m[32m  DEBRIEF_TEXT, DEBRIEF_CLOSING[m
[32m+[m[32m} = require('./seed-content');[m
 [m
 const DB_PATH = path.join(__dirname, 'data.db');[m
 const db = new DatabaseSync(DB_PATH);[m
[36m@@ -186,9 +196,34 @@[m [mconst ITEM_VARIANTS = {[m
   gate: [[m
     { key: 'gate', label: '知情同意页（仅勾选同意）' },[m
     { key: 'gateId', label: '知情同意页（需填被试编号）' }[m
[32m+[m[32m  ],[m
[32m+[m[32m  text: [[m
[32m+[m[32m    { key: 'text', label: '文本题（自由作答）' },[m
[32m+[m[32m    { key: 'textMatch', label: '文本题（需输入指定内容）' }[m
   ][m
 };[m
 [m
[32m+[m[32m// 文本题的两种形态（题型仍是一个 text，只有形态差异）：[m
[32m+[m[32m//   free  = 自由作答（默认，不落库）[m
[32m+[m[32m//   match = 需输入指定内容：被试在底部输入框里输入的正文要与「标准答案」一致才能发送出去；[m
[32m+[m[32m//           空 / 不一致时只在输入框旁提示（提示文案自定义，默认「答案错误」），这一笔不落库[m
[32m+[m[32m// 「答案错误」的兜底文案：题目没填提示文案时用它（题目填了就以题目的为准）[m
[32m+[m[32mconst MATCH_ERROR_DEFAULT = '答案错误';[m
[32m+[m[32m// 比对键：忽略大小写与所有空白（首尾、中间、全角空格都算）——被试多打一个空格不该被判错[m
[32m+[m[32mconst matchKey = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();[m
[32m+[m[32m// 标准答案一行一个：任一行匹配即通过（可写「我已完成阅读」+「已完成阅读」这类等价写法）[m
[32m+[m[32mfunction matchAnswerLines(item) {[m
[32m+[m[32m  return String((item && item.answer) || '').split('\n').map((x) => x.trim()).filter(Boolean);[m
[32m+[m[32m}[m
[32m+[m[32mfunction matchesAnswer(item, text) {[m
[32m+[m[32m  const key = matchKey(text);[m
[32m+[m[32m  return !!key && matchAnswerLines(item).some((line) => matchKey(line) === key);[m
[32m+[m[32m}[m
[32m+[m[32m// 断言失败时给被试看的文案（题目自定义 → 兜底默认）[m
[32m+[m[32mfunction matchErrorText(item) {[m
[32m+[m[32m  return String((item && item.errorText) || '').trim() || MATCH_ERROR_DEFAULT;[m
[32m+[m[32m}[m
[32m+[m
 // 各题型可添加的参数（题目下方「参数区」里按需添加，没添加就整块不显示）[m
 // 消息类题目额外可配 AI 思考时长与流式输出速度；refresh = 呈现该题前清空聊天流（刷新点）[m
 const ITEM_LIMITS = {[m
[36m@@ -213,7 +248,7 @@[m [mconst LIMIT_META = {[m
   wait: { label: '作答前强制等待', unit: '秒', hint: '需先停留 N 秒才能作答（如强制阅读）' },[m
   minSubmit: { label: '最短提交时间', unit: '秒', hint: '提交前的最短等待' },[m
   maxAnswer: { label: '最长作答时间', unit: '秒', hint: '到点自动提交已输入内容' },[m
[31m-  thinkMs: { label: 'AI 思考时长', unit: '毫秒', hint: '该消息配了思考内容时为「深度思考面板」时长；未配则只是「正在思考」转圈时长。0 = 不显示', group: 'rhythm' },[m
[32m+[m[32m  thinkMs: { label: 'AI 思考时长', unit: '毫秒', hint: '该消息配了思考内容时就是「深度思考面板」的时长（在「思考过程」行里改，单位是秒）；未配思考稿时只是「正在思考」转圈时长。0 = 不显示', group: 'rhythm' },[m
   typeMs: { label: '流式输出速度', unit: '毫秒/字', hint: '每字间隔；0 = 立即整段显示（数值越小越快）', group: 'rhythm' }[m
 };[m
 // 各参数的默认值与取值范围（门控以秒计，节奏以毫秒计，刷新点为 0/1）[m
[36m@@ -222,7 +257,7 @@[m [mconst LIMIT_SPEC = {[m
   wait: { def: 0, min: 0, max: 86400 },[m
   minSubmit: { def: 0, min: 0, max: 86400 },[m
   maxAnswer: { def: 0, min: 0, max: 86400 },[m
[31m-  thinkMs: { def: 420, min: 0, max: 10000 },[m
[32m+[m[32m  thinkMs: { def: 20000, min: 0, max: 60000 },[m
   typeMs: { def: 11, min: 0, max: 500 }[m
 };[m
 // 未配置任何参数时的生效值（服务端与两个前端共用同一份，避免兜底路径分叉）[m
[36m@@ -299,6 +334,13 @@[m [mfunction normalizeItem(raw, index) {[m
     item.rows = toClampedInt(src.rows, 1, 1, 12);[m
     item.maxLen = toClampedInt(src.maxLen, 0, 0, 5000);[m
     item.placeholder = String(src.placeholder ?? '');[m
[32m+[m[32m    // 二级形态「需输入指定内容」：variant 只在 match 时落库（free 是默认，保持 JSON 干净）[m
[32m+[m[32m    if (src.variant === 'match') {[m
[32m+[m[32m      item.variant = 'match';[m
[32m+[m[32m      item.answer = String(src.answer ?? '').trim();[m
[32m+[m[32m      item.errorText = String(src.errorText ?? '').trim();[m
[32m+[m[32m      item.required = true;                                 // 有标准答案 = 必答，没有「选填」一说[m
[32m+[m[32m    }[m
   }[m
   if (type === 'group') {[m
     // 题组：一个单元内呈现多道子题、一次提交（如「广告语 + 创作说明」）[m
[36m@@ -313,6 +355,10 @@[m [mfunction normalizeItem(raw, index) {[m
       delete sub.level;                                // 层级只属于顶层题目[m
       delete sub.fromTemplateId;[m
       delete sub.fromTemplateName;[m
[32m+[m[32m      // 「需输入指定内容」是单个文本题的形态：题组里的子题在题组输入框里作答，没有逐子题的断言[m
[32m+[m[32m      delete sub.variant;[m
[32m+[m[32m      delete sub.answer;[m
[32m+[m[32m      delete sub.errorText;[m
       subs.push(sub);[m
     });[m
     item.subs = subs;[m
[36m@@ -324,8 +370,7 @@[m [mfunction normalizeItem(raw, index) {[m
   return item;[m
 }[m
 [m
[31m-// 结束说明的收尾小字：并入正文（可编辑），不再硬编码在被试端[m
[31m-const DEBRIEF_CLOSING = '本次实验已结束，您可以关闭本页面。';[m
[32m+[m[32m// 结束说明的收尾小字（文案见 seed-content.js）：并入正文（可编辑），不再硬编码在被试端[m
 // 两段文本题组的作答约定：并入题组正文（可编辑），不再硬编码在输入框提示里[m
 function textSubsHint(item) {[m
   const subs = Array.isArray(item.subs) ? item.subs : [];[m
[36m@@ -347,7 +392,7 @@[m [mfunction richContentOf(type, src, item) {[m
   if (type === 'gate' || type === 'confirm' || type === 'debrief') {[m
     const head = title ? `<h1>${RT.escapeText(title)}</h1>` : '';[m
     let body = text;[m
[31m-    if (type === 'debrief' && body.trim() && !body.includes('关闭本页面')) body = `${body}\n\n${DEBRIEF_CLOSING}`;[m
[32m+[m[32m    if (type === 'debrief' && body.trim() && !body.includes(DEBRIEF_CLOSING)) body = `${body}\n\n${DEBRIEF_CLOSING}`;[m
     return head + RT.tex