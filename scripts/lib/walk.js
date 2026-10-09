// 走查脚本公共：会话驱动器
// 按题型给出确定性作答，把一份问卷走完；门控不真实等待，收到 too_early 就回拨时间基准快进。
'use strict';

const { fastForwardGates } = require('./direct-db');
// 正文以清洗后的 HTML 落库（管理端富文本）；比对时统一折成纯文本
const RT = require('../../public/assets/richtext.js');

// 确定性作答：按题型给出可预期的值（同一份问卷两次走查结果可比对）
function answerBody(action, seed) {
  switch (action.type) {
    case 'gate': return { consent: true, text: 'AUTO-01' };   // 「含编号」形态要求填编号；普通形态会忽略它
    case 'confirm': return { ack: true };
    case 'debrief': return { ack: true };
    case 'rating': return { value: 3 };
    case 'single': return { value: action.options.length >= 3 ? 3 : 2 };
    case 'multi': return { values: [1, Math.min(2, action.options.length)] };
    case 'rank': return { order: action.options.map((o) => o.value) };
    case 'text': return { text: `作品${seed}` };
    case 'group': return { answers: (action.subs || []).map((sub) => (sub.type === 'text' ? { text: `作品${seed}` } : { value: 1 })) };
    default: return {};
  }
}

// 走完一份问卷。返回 { sessionId, messages, action, seen, flags, gates, finished }
//   messages：AI 消息 + 占位的用户回显，用于跨会话/跨组逐字比对
//   flags：门控类型是否出现过（延迟发出 / 强制等待 / 时间窗 / 共用窗口 / 题组窗口）
//   gates：门控快进的实况（被拒次数、回拨总时长）
async function walk({ request, questionnaireId, record }) {
  const created = await request('/api/session', { body: { q: questionnaireId } });
  if (!created.ok) throw new Error('创建会话失败: ' + JSON.stringify(created.data));
  const sessionId = created.data.session.id;
  let action = created.data.action;
  const messages = created.data.messages.map((m) => ({ role: m.role, content: m.content }));

  let guard = 0;
  let seed = 0;
  const seen = [];
  const qnos = {};          // itemId -> 服务端下发的题号（0 = 不占题号：消息 / 页面类题目）
  const flags = { wait: false, window: false, shared: false, autoSubmit: false, cleared: false };
  const gates = { rejected: 0, fastForwardedMs: 0 };

  while (action && guard++ < 200) {
    if (!seen.includes(`${action.type}:${action.itemId}`)) seen.push(`${action.type}:${action.itemId}`);
    qnos[action.itemId] = action.qno || 0;
    if (action.availableAtMs && action.availableAtMs > (action.nowMs || 0)) flags.wait = true;
    if (action.minSubmitAtMs || action.deadlineMs) flags.window = true;
    if (action.sharedWindow) flags.shared = true;
    if (action.type === 'group' && (action.minSubmitAtMs || action.deadlineMs)) flags.groupWindow = true;

    if (action.type === 'text' || action.type === 'group') seed += 1;
    const res = await request('/api/step', { body: { sessionId, elapsedMs: 400, ...answerBody(action, seed) } });
    if (res.status === 400 && res.data.error === 'too_early') {
      // 门控确实会拦：真发一次请求、断言被拒（保留覆盖），但不真实等待——
      // 直接把时间基准往前拨过门控，立刻重发。
      gates.rejected += 1;
      const remain = Math.max(0, (res.data.availableAtMs || 0) - (res.data.nowMs || Date.now()));
      const delta = remain + 1000;
      fastForwardGates(sessionId, delta);
      gates.fastForwardedMs += delta;
      continue;
    }
    if (!res.ok) throw new Error('step 失败: ' + JSON.stringify(res.data));
    if (res.data.clearStream || (res.data.action && res.data.action.clearStream)) flags.cleared = true;
    messages.push({ role: 'user', content: '(echo)' });
    for (const m of res.data.messages) messages.push({ role: m.role, content: m.content });
    action = res.data.action;
    if (res.data.session.status === 'completed') break;
  }

  const result = { sessionId, messages, action, seen, flags, gates, qnos, finished: !action };
  if (record) Object.assign(record, result);
  return result;
}

// 只取 AI 消息的正文序列（跨会话/跨组逐字比对用）
// AI 消息正文（HTML）→ 纯文本，便于逐字比对
const aiTexts = (messages) => messages
  .filter((m) => m.role === 'assistant')
  .map((m) => RT.htmlToText(m.content));

module.exports = { answerBody, walk, aiTexts };
