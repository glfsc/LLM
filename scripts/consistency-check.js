// 一致性自检（论文复刻流程：研究2 + 研究3）
// 验证目标：
//   1) 同一情景同一组的两个会话，按相同作答序列走完全流程后，AI 消息序列逐字一致
//   2) 控制组与干预组在同一作答序列下：除"研究3 组别文本"外其余消息逐字一致，组别文本必须不同
//   3) 研究2 匹配文本随决策方向变化：同组内选 A 与选 B 会话在该步文本不同
//   4) 落库正确：responses 的 value/phase/task_index/play_count/时间戳（shown_at = answered_at − elapsed_ms）、
//      messages 全量入库且顺序与接口返回一致；uid 幂等重进返回已完成会话
// 用法：先启动服务（npm start），再执行：node scripts/consistency-check.js
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const BASE = process.env.BASE || 'http://localhost:3000';
const DB_FILE = path.join(__dirname, '..', 'data.db');
const SCENARIOS = ['medical', 'finance', 'creative', 'marketing'];

// 每任务 3 个作答步骤（r2_choice → r2_rating → r3_choice），默认任务清单 [单次, 多次] 共 6 步
const ANSWER_SEQUENCE = [1, 5, 4, 2, 6, 3];
const EXPECTED_PHASES = [
  'r2_choice', 'r2_rating', 'r3_choice',
  'r2_choice', 'r2_rating', 'r3_choice'
];
const EXPECTED_TASK_INDEX = [0, 0, 0, 1, 1, 1];
const EXPECTED_PLAY_COUNT = [1, 1, 1, 100, 100, 100];
// 组别文本（r3）在 AI 消息序列中的位置：welcome、context 之后，每任务第 2 条生成消息
const r3MessageIndices = [3, 6];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(route, options = {}) {
  const res = await fetch(BASE + route, {
    method: options.body ? 'POST' : 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function uniqueUid(groupId, tag) {
  return `selfcheck-${groupId}-${tag}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

// 按固定作答序列走完整个流程，收集消息序列与逐步状态
async function runSession(groupId, tag, answers) {
  const uid = uniqueUid(groupId, tag);
  const created = await request('/api/session', { body: { group: groupId, uid } });

  const aiSequence = created.messages.map((m) => m.content);
  const messageSequence = created.messages.map((m) => ({ role: m.role, content: m.content }));
  const steps = [];

  let action = created.action;
  for (let i = 0; i < answers.length; i += 1) {
    if (!action) throw new Error(`${groupId}: 第 ${i + 1} 步缺少待作答操作`);
    const elapsedMs = 1600 + i * 250;
    const res = await request('/api/step', {
      body: { sessionId: created.session.id, value: answers[i], elapsedMs }
    });
    messageSequence.push({ role: res.userMessage.role, content: res.userMessage.content });
    for (const m of res.messages) {
      aiSequence.push(m.content);
      messageSequence.push({ role: m.role, content: m.content });
    }
    steps.push({ value: answers[i], elapsedMs, action, next: res.action, session: res.session });
    action = res.action;
  }

  return { uid, sessionId: created.session.id, firstAction: created.action, aiSequence, messageSequence, steps, finalSession: steps[steps.length - 1].session };
}

// 逐步状态机结构校验：决策/评分类型轮换、结束后 action 为空、会话完成
function checkFlow(groupId, run) {
  const errors = [];
  if (run.firstAction?.type !== 'choice') errors.push('首个操作应为决策');
  const expectedNext = ['rating', 'choice', 'choice', 'rating', 'choice', null];
  run.steps.forEach((s, i) => {
    const type = s.next ? s.next.type : null;
    if (type !== expectedNext[i]) errors.push(`第 ${i + 1} 步后的操作类型应为 ${expectedNext[i]}，实际 ${type}`);
  });
  if (run.finalSession.status !== 'completed') errors.push('流程结束会话状态应为 completed');
  if (!run.finalSession.code) errors.push('流程结束应生成完成码');
  if (errors.length) throw new Error(`${groupId}: ${errors.join('；')}`);
}

async function checkScenario(scenario) {
  const controlA = await runSession(`${scenario}-control`, 'a', ANSWER_SEQUENCE);
  const controlB = await runSession(`${scenario}-control`, 'b', ANSWER_SEQUENCE);
  const treatA = await runSession(`${scenario}-treat`, 'a', ANSWER_SEQUENCE);
  const treatB = await runSession(`${scenario}-treat`, 'b', ANSWER_SEQUENCE);
  // 方向对照：仅第一步决策换向（选 B），其余相同
  const flipped = [4, 5, 4, 2, 6, 3];
  const controlFlip = await runSession(`${scenario}-control`, 'f', flipped);

  checkFlow(`${scenario}-control`, controlA);
  checkFlow(`${scenario}-treat`, treatA);

  const sameSeq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const sameGroupAB = sameSeq(controlA.aiSequence, controlB.aiSequence) && sameSeq(treatA.aiSequence, treatB.aiSequence);

  const findDiffIndices = (a, b) => {
    const out = [];
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) if (a[i] !== b[i]) out.push(i);
    return out;
  };
  const groupDiff = findDiffIndices(controlA.aiSequence, treatA.aiSequence);
  const groupsAsExpected =
    controlA.aiSequence.length === treatA.aiSequence.length &&
    groupDiff.length === r3MessageIndices.length &&
    groupDiff.every((idx, k) => idx === r3MessageIndices[k]);

  const dirDiff = findDiffIndices(controlA.aiSequence, controlFlip.aiSequence);
  const directionAsExpected = dirDiff.length === 1 && dirDiff[0] === 2;

  return {
    scenario,
    sessions: { controlA, controlB, treatA, treatB, controlFlip },
    sameGroupAB,
    groupsAsExpected,
    groupDiff,
    directionAsExpected,
    dirDiff
  };
}

/* ---------------------------------------------------------------- 落库校验 */

function openDbReadOnly() {
  try {
    return new DatabaseSync(DB_FILE, { readOnly: true });
  } catch {
    return new DatabaseSync(DB_FILE);
  }
}

function makeQuery(db) {
  return async (sql, params = []) => {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return db.prepare(sql).all(...params);
      } catch (err) {
        lastErr = err;
        await sleep(120);
      }
    }
    throw lastErr;
  };
}

async function checkDb(account) {
  const db = openDbReadOnly();
  const all = makeQuery(db);
  const problems = [];

  // —— responses：值与时间戳
  const rows = await all('SELECT * FROM responses WHERE session_id = ? ORDER BY id ASC', [account.sessionId]);
  if (rows.length !== ANSWER_SEQUENCE.length) {
    problems.push(`responses 数量应为 ${ANSWER_SEQUENCE.length}，实际 ${rows.length}`);
  } else {
    rows.forEach((row, i) => {
      const no = `第 ${i + 1} 条 response`;
      if (Number(row.value) !== ANSWER_SEQUENCE[i]) problems.push(`${no} value 应为 ${ANSWER_SEQUENCE[i]}，实际 ${row.value}`);
      if (row.phase !== EXPECTED_PHASES[i]) problems.push(`${no} phase 应为 ${EXPECTED_PHASES[i]}，实际 ${row.phase}`);
      if (Number(row.task_index) !== EXPECTED_TASK_INDEX[i]) problems.push(`${no} task_index 应为 ${EXPECTED_TASK_INDEX[i]}，实际 ${row.task_index}`);
      if (Number(row.play_count) !== EXPECTED_PLAY_COUNT[i]) problems.push(`${no} play_count 应为 ${EXPECTED_PLAY_COUNT[i]}，实际 ${row.play_count}`);
      if (!row.option_label) problems.push(`${no} option_label 为空`);
      if (row.shown_at && row.answered_at) {
        const diff = new Date(row.answered_at).getTime() - new Date(row.shown_at).getTime();
        if (Math.abs(diff - account.steps[i].elapsedMs) > 2) {
          problems.push(`${no} 时间戳不符：answered_at − shown_at = ${diff}ms，应为 ${account.steps[i].elapsedMs}ms`);
        }
      } else {
        problems.push(`${no} 缺少 shown_at / answered_at`);
      }
    });
  }

  // —— messages：全量入库且顺序与接口返回一致
  const msgRows = await all('SELECT role, content FROM messages WHERE session_id = ? ORDER BY seq ASC', [account.sessionId]);
  const expectMsgs = account.messageSequence;
  const messagesOk =
    msgRows.length === expectMsgs.length &&
    msgRows.every((row, i) => row.role === expectMsgs[i].role && row.content === expectMsgs[i].content);
  if (!messagesOk) problems.push(`messages 落库不一致（库中 ${msgRows.length} 条，期望 ${expectMsgs.length} 条）`);

  db.close();
  if (problems.length) throw new Error(problems.join('；'));
  return { responseCount: rows.length, messageCount: msgRows.length };
}

/* ---------------------------------------------------------------- 主流程 */

function clip(text, n = 46) {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

async function main() {
  console.log(`一致性自检开始（BASE = ${BASE}）`);
  let allPass = true;
  const check = (name, ok, extra) => {
    allPass = allPass && ok;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  -> ${extra}` : ''}`);
  };

  for (const scenario of SCENARIOS) {
    console.log(`\n[${scenario}]`);
    let result;
    try {
      result = await checkScenario(scenario);
    } catch (err) {
      allPass = false;
      console.log(`  FAIL  流程执行异常 -> ${err.message}`);
      continue;
    }

    check('组内两会话 AI 消息逐字一致', result.sameGroupAB);
    check(
      '控制/干预组仅研究3文本不同',
      result.groupsAsExpected,
      `差异位置 [${result.groupDiff.join(', ')}]（期望 [${r3MessageIndices.join(', ')}]）`
    );
    check('研究2匹配文本随决策方向变化', result.directionAsExpected, `差异位置 [${result.dirDiff.join(', ')}]（期望 [2]）`);

    if (result.groupsAsExpected) {
      const c = result.sessions.controlA.aiSequence;
      const t = result.sessions.treatA.aiSequence;
      console.log(`  · 控制组研究3文本：${clip(c[r3MessageIndices[0]])}`);
      console.log(`  · 干预组研究3文本：${clip(t[r3MessageIndices[0]])}`);
    }

    try {
      const dbInfo = await checkDb(result.sessions.controlA);
      check('responses 值/阶段/时间戳落库正确', true, `${dbInfo.responseCount} 条`);
      check('messages 全量入库且顺序一致', true, `${dbInfo.messageCount} 条`);
    } catch (err) {
      check('responses/messages 落库校验', false, err.message);
    }

    // uid 幂等：同一 uid 重新进入应返回已完成会话
    try {
      const reopen = await request('/api/session', {
        body: { group: `${scenario}-control`, uid: result.sessions.controlA.uid }
      });
      check(
        'uid 幂等重进返回已完成会话',
        reopen.session.id === result.sessions.controlA.sessionId &&
          reopen.session.status === 'completed' &&
          reopen.action === null
      );
    } catch (err) {
      check('uid 幂等重进', false, err.message);
    }
  }

  console.log(`\n---- result: ${allPass ? 'ALL PASS' : 'HAS FAILURES'} ----`);
  process.exitCode = allPass ? 0 : 1;
}

main().catch((err) => {
  console.error('SELF-CHECK ERROR:', err.message);
  console.error(`请确认服务已启动：${BASE}`);
  process.exitCode = 1;
});
