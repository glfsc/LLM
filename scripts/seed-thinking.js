// 把「负面反馈」这道消息题同步成 seed-content.js 的最新版：正文 + 排版 html + 思考稿 + 思考时长。
//
// 为什么需要它：文案与思考稿都存在题目里，而实验模板与问卷的题目是**创建时的快照**——
//   改了种子不会回溯生效。要把新文案推到已经在跑的线上问卷上，有两种办法：
//     ① 整份重建：`npm run sync-groups -- --apply`（按种子重建两份问卷与两个模板；
//        会一并重排第 8 节的结构，适合「线上就是种子的样子」时用）；
//     ② 只同步反馈题：本脚本（只动这一道题的四个字段，线上手改过的其它题目一律不碰）。
//
// 幂等：四个字段与种子一致时什么都不写；`--dry` 只看不动。建议先停止服务再执行。
// 用法：node scripts/seed-thinking.js [--dry]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('../db');

const DRY = process.argv.includes('--dry');
const THINK_MS = store.FEEDBACK_THINK_MS;   // 思考面板时长（种子里是 20 秒，「已思考（用时 20 秒）」）
const THINKING = store.FEEDBACK_THINKING;   // 与种子一致的思考稿
const FEEDBACK_TEXT = store.FEEDBACK_TEXT;
const FEEDBACK_HTML = store.body16(FEEDBACK_TEXT);

// 判定反馈题：id 就是 feedback（模板里）或以 __feedback 结尾（问卷里带模板前缀），
// 或正文与标准反馈文本一致（线上一旦被改过 id 也能认出来）。
// 不按「正文与旧版逐字一致」判定 —— 那样一改文案就再也匹配不上，脚本会静默地什么都不做。
function isFeedbackItem(item) {
  if (!item || item.type !== 'message') return false;
  const id = String(item.id || '');
  return id === 'feedback' || id.endsWith('__feedback') || String(item.text || '') === FEEDBACK_TEXT;
}

// 同步一份题目列表；返回 { items, patched } —— 不改动原数组
function patchItems(items) {
  let patched = 0;
  const out = (items || []).map((item) => {
    if (!isFeedbackItem(item)) return item;
    const sameText = String(item.text || '') === FEEDBACK_TEXT;
    const sameHtml = String(item.html || '') === FEEDBACK_HTML;
    const sameThinking = String(item.thinking || '') === THINKING;
    const sameMs = Number((item.limits || {}).thinkMs) === THINK_MS;
    if (sameText && sameHtml && sameThinking && sameMs) return item;
    patched += 1;
    return {
      ...item,
      text: FEEDBACK_TEXT,
      html: FEEDBACK_HTML,
      thinking: THINKING,
      limits: { ...(item.limits || {}), thinkMs: THINK_MS }
    };
  });
  return { items: out, patched };
}

function main() {
  let total = 0;
  const todo = [];

  // 1) 实验模板（问卷由模板复制而来，先补模板）
  for (const exp of store.listExperiments()) {
    const { items, patched } = patchItems(exp.items);
    if (!patched) continue;
    todo.push(() => store.updateExperiment(exp.id, { name: exp.name, timing: exp.timing, items }));
    total += patched;
    console.log(`↻ 实验模板「${exp.name}」：反馈题需同步 ${patched} 处`);
  }

  // 2) 已有问卷（模板题在问卷里带模板前缀 id，也按 __feedback 后缀 / 正文匹配）
  for (const brief of store.listQuestionnaires()) {
    const q = store.getQuestionnairePayload(brief.id);
    if (!q) continue;
    const { items, patched } = patchItems(q.items);
    if (!patched) continue;
    todo.push(() => store.updateQuestionnaire(q.id, { title: q.title, timing: q.timing, items }));
    total += patched;
    console.log(`↻ 问卷「${q.title}」：反馈题需同步 ${patched} 处  /chat?q=${q.id}`);
  }

  if (!total) {
    console.log('没有需要同步的反馈题（正文 / 排版 / 思考稿 / 思考时长都与种子一致）。');
    return;
  }
  if (DRY) {
    console.log('\n（--dry：只看不动。去掉 --dry 即写入）');
    return;
  }
  // 备份 → 写入（与 sync-group-content.js 同一套做法：动线上数据前先留一份）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(__dirname, '..', '.tmp', `backup-${stamp}.db`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  // 与 db.js 同口径：默认项目根目录的 data.db，可用 DB_PATH 覆盖
  const live = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, '..', 'data.db');
  fs.copyFileSync(live, backup);
  console.log(`\n已备份：${path.relative(process.cwd(), backup)}`);
  for (const run of todo) run();
  console.log(`\n完成：共同步 ${total} 处，思考时长 ${THINK_MS / 1000} 秒，思考稿 ${THINKING.length} 字，反馈正文 ${FEEDBACK_TEXT.length} 字。`);
  console.log('注意：已经开始作答的会话用的是进入时快照的题目，不会回溯生效；新进入的会话即生效。');
}

main();
