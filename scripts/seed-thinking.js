// 把「负面反馈」消息题改造成深度思考面板形态：补写思考过程 + 思考时长 8 秒。
// 背景：思考稿写在题目里，而实验模板与问卷的题目都是创建时的快照——已建好的问卷
//       不会自动获得思考内容，需要本脚本补写（或在管理端手动粘贴）。
// 说明：「延迟发出」参数已从平台删除，等待时间由思考面板承担。
// 幂等：已有思考内容的题目默认跳过，加 --force 覆盖。
// 用法：node scripts/seed-thinking.js [--force]（建议先停止服务）
'use strict';

const store = require('../db');

const FORCE = process.argv.includes('--force');
const THINK_MS = 8000;                     // 「已思考（用时 8 秒）」
const THINKING = store.FEEDBACK_THINKING;  // 与种子一致的思考稿
const FEEDBACK_TEXT = store.FEEDBACK_TEXT;

// 判定反馈题：正文与标准反馈文本一致（不依赖题目 id，问卷里的 id 带模板前缀）
function isFeedbackItem(item) {
  return item && item.type === 'message' && String(item.text || '') === FEEDBACK_TEXT;
}

// 改造一份题目列表；返回 { items, patched } —— 不改动原数组
function patchItems(items) {
  let patched = 0;
  const out = (items || []).map((item) => {
    if (!isFeedbackItem(item)) return item;
    const hasThinking = String(item.thinking || '').trim().length > 0;
    if (hasThinking && !FORCE) return item;
    patched += 1;
    return { ...item, thinking: THINKING, limits: { ...(item.limits || {}), thinkMs: THINK_MS } };
  });
  return { items: out, patched };
}

function main() {
  let total = 0;

  // 1) 实验模板（问卷由模板复制而来，先补模板）
  for (const exp of store.listExperiments()) {
    const { items, patched } = patchItems(exp.items);
    if (!patched) continue;
    store.updateExperiment(exp.id, { name: exp.name, timing: exp.timing, items });
    total += patched;
    console.log(`↻ 实验模板「${exp.name}」：补写 ${patched} 道题的思考内容`);
  }

  // 2) 已有问卷（模板题在问卷里带模板前缀 id，按正文匹配）
  for (const brief of store.listQuestionnaires()) {
    const q = store.getQuestionnairePayload(brief.id);
    if (!q) continue;
    const { items, patched } = patchItems(q.items);
    if (!patched) continue;
    store.updateQuestionnaire(q.id, { title: q.title, timing: q.timing, items });
    total += patched;
    console.log(`↻ 问卷「${q.title}」：补写 ${patched} 道题的思考内容  /chat?q=${q.id}`);
  }

  if (!total) {
    console.log('没有需要补写的题目（反馈题已带思考内容）。如需覆盖请加 --force。');
    return;
  }
  console.log(`\n完成：共补写 ${total} 处，思考时长 ${THINK_MS / 1000} 秒，思考稿 ${THINKING.length} 字。`);
  console.log('注意：已经开始作答的会话用的是进入时快照的题目，不会回溯生效；新进入的会话即生效。');
}

main();
