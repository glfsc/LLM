// 一致性自检（问卷化流程：为问卷插入研究2 / 研究3 实验编排）
// 验证目标：
//   1) 同一问卷内，相同作答序列的两个会话，AI 消息序列逐字一致
//   2) 控制组 / 干预组两份问卷（相同实验编排、相同作答序列）：除研究3 组别文本外其余消息逐字一致
//   3) 研究2 匹配文本随决策方向变化：仅决策①换向时，仅对应匹配文本不同
//   4) 落库正确：responses 的 value/phase/task_index/play_count/experiment_sort/时间戳
//      （shown_at = answered_at − elapsed_ms）、messages 全量入库且与接口返回一致
//   5) 问卷数据页接口（编号按进入顺序）与 xlsx 导出可用
// 用法：先启动服务（npm start），再执行：node scripts/consistency-check.js
// 说明：脚本会创建两份「自检问卷·控制组 / 干预组」跑完全流程校验，结束后自动删除，不留数据。
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DB_FILE = path.join(__dirname, '..', 'data.db');

const Q_NAME_CONTROL = '自检问卷·控制组';
const Q_NAME_TREAT = '自检问卷·干预组';

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

let adminToken = '';

async function admin(route, options = {}) {
  const headers = { Authorization: `Bearer ${adminToken}` };
  if (options.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + route, {
    method: options.body ? 'POST' : 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  if (options.raw) {
    if (!res.ok) throw new Error(`${route} -> ${res.status}`);
    return { res, buffer: Buffer.from(await res.arrayBuffer()) };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/* ---------------------------------------------------------------- 会话驱动 */

// 实验编排展开为作答序列：研究2 段每任务 2 步（决策① → 评分），研究3 段每任务 2 步（基线决策 → 再决策）
function buildAnswers(expDefs) {
  const answers = [];
  expDefs.forEach((exp) => {
    exp.tasks.forEach((playCount, taskIndex) => {
      if (exp.kind === 'r2') {
        answers.push(taskIndex % 2 === 0 ? 1 : 2, taskIndex % 2 === 0 ? 5 : 6);
      } else {
        answers.push(taskIndex % 2 === 0 ? 2 : 1, taskIndex % 2 === 0 ? 4 : 3);
      }
    });
  });
  return answers;
}

function expectedShape(expDefs) {
  const phases = [];
  const taskIndex = [];
  const playCount = [];
  const experimentSort = [];
  expDefs.forEach((exp, expIndex) => {
    exp.tasks.forEach((pc, tIndex) => {
      const pair = exp.kind === 'r2' ? ['r2_choice', 'r2_rating'] : ['r3_base', 'r3_choice'];
      phases.push(...pair);
      taskIndex.push(tIndex, tIndex);
      playCount.push(pc, pc);
      experimentSort.push(expIndex + 1, expIndex + 1);
    });
  });
  return { phases, taskIndex, playCount, experimentSort };
}

// 按固定作答序列走完整个流程，收集消息序列与逐步状态
async function runSession(code, answers) {
  const created = await request('/api/session', { body: { q: code } });

  const aiSequence = created.messages.map((m) => m.content);
  const messageSequence = created.messages.map((m) => ({ role: m.role, content: m.content }));
  const steps = [];

  let action = created.action;
  for (let i = 0; i < answers.length; i += 1) {
    if (!action) throw new Error(`第 ${i + 1} 步缺少待作答操作`);
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

  return {
    sessionId: created.session.id,
    seq: created.session.seq,
    aiSequence,
    messageSequence,
    steps,
    finalSession: steps[steps.length - 1].session
  };
}

// 逐步状态机结构校验：操作类型按步骤展开轮换、结束后 action 为空、会话完成
function checkFlow(run, phases) {
  const errors = [];
  if (run.steps[0].action?.phase !== phases[0]) {
    errors.push(`首个待作答阶段应为 ${phases[0]}，实际 ${run.steps[0].action?.phase}`);
  }
  const expectedNext = phases.slice(1).map((p) => (p === 'r2_rating' ? 'rating' : 'choice')).concat([null]);
  run.steps.forEach((s, i) => {
    const type = s.next ? s.next.type : null;
    if (type !== expectedNext[i]) errors.push(`第 ${i + 1} 步后的操作类型应为 ${expectedNext[i]}，实际 ${type}`);
  });
  if (run.finalSession.status !== 'completed') errors.push('流程结束会话状态应为 completed');
  if (errors.length) throw new Error(errors.join('；'));
}

const sameSeq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function findDiffIndices(a, b) {
  const out = [];
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) if (a[i] !== b[i]) out.push(i);
  return out;
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

async function checkDb(account, expected, code) {
  const db = openDbReadOnly();
  const all = makeQuery(db);
  const problems = [];

  // —— responses：值 / 阶段 / 任务 / 实验段 / 时间戳
  const rows = await all('SELECT * FROM responses WHERE session_id = ? ORDER BY id ASC', [account.sessionId]);
  if (rows.length !== expected.answers.length) {
    problems.push(`responses 数量应为 ${expected.answers.length}，实际 ${rows.length}`);
  } else {
    rows.forEach((row, i) => {
      const no = `第 ${i + 1} 条 response`;
      if (Number(row.value) !== expected.answers[i]) problems.push(`${no} value 应为 ${expected.answers[i]}，实际 ${row.value}`);
      if (row.phase !== expected.phases[i]) problems.push(`${no} phase 应为 ${expected.phases[i]}，实际 ${row.phase}`);
      if (Number(row.task_index) !== expected.taskIndex[i]) problems.push(`${no} task_index 应为 ${expected.taskIndex[i]}，实际 ${row.task_index}`);
      if (Number(row.play_count) !== expected.playCount[i]) problems.push(`${no} play_count 应为 ${expected.playCount[i]}，实际 ${row.play_count}`);
      if (Number(row.experiment_sort) !== expected.experimentSort[i]) {
        problems.push(`${no} experiment_sort 应为 ${expected.experimentSort[i]}，实际 ${row.experiment_sort}`);
      }
      if (row.questionnaire_id !== code) problems.push(`${no} questionnaire_id 应为 ${code}，实际 ${row.questionnaire_id}`);
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

  // 0) 登录管理端，读取一个情景（优先 medical）作为实验材料
  const login = await request('/api/admin/login', { body: { password: ADMIN_PASSWORD } });
  adminToken = login.token;

  const scenarioList = await admin('/api/admin/scenarios');
  const scenario = scenarioList.scenarios.find((s) => s.id === 'medical') || scenarioList.scenarios[0];
  if (!scenario) throw new Error('没有可用情景，请先在管理端创建情景');
  const groups = scenario.groups || [];
  const controlGroup = groups.find((g) => g.role === 'control') || groups[0];
  const treatGroup = groups.find((g) => g.role === 'treat') || groups[1];
  const groupText = (group, playCount) => (Number(playCount) === 1 ? group.r3Once : group.r3Multi);
  console.log(`使用情景：${scenario.name}（${scenario.id}），任务清单 [${scenario.tasks.join(', ')}]`);

  // 1) 清理旧的同名自检问卷（避免重复运行堆积）
  const existing = await admin('/api/admin/questionnaires');
  for (const q of existing.questionnaires) {
    if (q.name === Q_NAME_CONTROL || q.name === Q_NAME_TREAT) {
      await admin('/api/admin/questionnaire/delete', { body: { id: q.id, force: true } });
      console.log(`已清理旧问卷：${q.name}`);
    }
  }

  // 2) 创建控制组 / 干预组两份问卷（相同实验编排；流程文案留空，消息只由材料与文本构成）
  const experiments = [
    { kind: 'r2', scenarioId: scenario.id },
    { kind: 'r3', scenarioId: scenario.id }
  ];
  const controlQ = (
    await admin('/api/admin/questionnaire/create', {
      body: { name: Q_NAME_CONTROL, groupRole: 'control', flow: {}, experiments }
    })
  ).questionnaire;
  const treatQ = (
    await admin('/api/admin/questionnaire/create', {
      body: { name: Q_NAME_TREAT, groupRole: 'treat', flow: {}, experiments }
    })
  ).questionnaire;

  const expDefs = [
    { kind: 'r2', tasks: scenario.tasks },
    { kind: 'r3', tasks: scenario.tasks }
  ];
  const answers = buildAnswers(expDefs);
  const shape = expectedShape(expDefs);
  const expected = { answers, ...shape };

  // 3) 运行业务会话
  console.log('\n[流程与时序]');
  const controlA = await runSession(controlQ.id, answers);
  const controlB = await runSession(controlQ.id, answers);
  const treatA = await runSession(treatQ.id, answers);
  checkFlow(controlA, shape.phases);
  checkFlow(treatA, shape.phases);
  check('流程状态机（8 步：决策→评分×2 + 基线→再决策×2）', true);

  check('同问卷两会话 AI 消息逐字一致', sameSeq(controlA.aiSequence, controlB.aiSequence));

  // 组别对照：仅研究3 组别文本不同
  const groupDiff = findDiffIndices(controlA.aiSequence, treatA.aiSequence);
  const controlTexts = scenario.tasks.map((pc) => groupText(controlGroup, pc));
  const treatTexts = scenario.tasks.map((pc) => groupText(treatGroup, pc));
  const groupsAsExpected =
    controlA.aiSequence.length === treatA.aiSequence.length &&
    groupDiff.length === scenario.tasks.length &&
    groupDiff.every(
      (idx, k) => controlA.aiSequence[idx] === controlTexts[k] && treatA.aiSequence[idx] === treatTexts[k]
    );
  check(
    '控制/干预组仅研究3文本不同',
    groupsAsExpected,
    `差异位置 [${groupDiff.join(', ')}]（期望 ${scenario.tasks.length} 处）`
  );
  if (groupsAsExpected) {
    console.log(`  · 控制组研究3文本：${clip(controlTexts[0])}`);
    console.log(`  · 干预组研究3文本：${clip(treatTexts[0])}`);
  }

  // 方向对照：仅决策①换向（1 → 4）
  const flipped = [...answers];
  flipped[0] = answers[0] === 1 ? 4 : 1;
  const controlFlip = await runSession(controlQ.id, flipped);
  const dirDiff = findDiffIndices(controlA.aiSequence, controlFlip.aiSequence);
  const expectedMatch = flipped[0] <= 2 ? scenario.r2OnceA : scenario.r2OnceB;
  const directionAsExpected =
    dirDiff.length === 1 &&
    controlA.aiSequence[dirDiff[0]] === scenario.r2OnceA &&
    controlFlip.aiSequence[dirDiff[0]] === expectedMatch;
  check('研究2匹配文本随决策方向变化', directionAsExpected, `差异位置 [${dirDiff.join(', ')}]（期望 1 处）`);

  // 4) 落库校验
  try {
    const dbInfo = await checkDb(controlA, expected, controlQ.id);
    check('responses 值/阶段/实验段/时间戳落库正确', true, `${dbInfo.responseCount} 条`);
    check('messages 全量入库且顺序一致', true, `${dbInfo.messageCount} 条`);
  } catch (err) {
    check('responses/messages 落库校验', false, err.message);
  }

  // 5) 问卷数据页接口：行级作答视图 + 实验 / 问题筛选
  try {
    const list = await admin(`/api/admin/questionnaire/sessions?id=${controlQ.id}`);
    const seqs = [...new Set(list.rows.map((r) => r.seq))].sort((a, b) => a - b);
    const idsIncluded = [controlA, controlB, controlFlip].every((r) =>
      list.rows.some((row) => row.sessionId === r.sessionId)
    );
    check(
      '数据页接口：行级作答 + 编号按进入顺序 1 起连续',
      idsIncluded &&
        list.rowCount === 24 &&
        list.sessionCount === 3 &&
        seqs.length === 3 &&
        seqs.every((n, i) => n === i + 1),
      `${list.rowCount} 条作答 / ${list.sessionCount} 位被试，编号 [${seqs.join(', ')}]`
    );
    check(
      '数据页接口：行字段完整（实验 / 问题 / 作答值 / 时间）',
      list.rows.every(
        (r) => r.experimentSort && r.phaseLabel && r.phase && r.answeredAt != null && r.value != null && r.optionLabel
      ),
      clip(`${list.rows[0]?.experimentSort}. ${list.rows[0]?.phaseLabel} = ${list.rows[0]?.value}`)
    );

    const filtered = await admin(`/api/admin/questionnaire/sessions?id=${controlQ.id}&experiment=2&phase=r3_base`);
    // 研究3 段共 2 个任务（任务清单 [1, 100]），每个任务一条基线决策：3 会话 × 2 = 6 条
    check(
      '数据页接口：实验 / 问题筛选生效',
      filtered.rowCount === 6 && filtered.rows.every((r) => r.experimentSort === 2 && r.phase === 'r3_base'),
      `experiment=2&phase=r3_base -> ${filtered.rowCount} 条`
    );
  } catch (err) {
    check('数据页接口', false, err.message);
  }

  // 6) xlsx 导出：按实验分表；文件名跟随筛选（问卷名-实验-问题）
  try {
    const { res, buffer } = await admin(`/api/admin/questionnaire/export.xlsx?id=${controlQ.id}`, { raw: true });
    const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    check(
      'xlsx 导出（全部）可用',
      isZip && /spreadsheetml/.test(res.headers.get('content-type') || ''),
      `${buffer.length} 字节`
    );

    const filtered = await admin(`/api/admin/questionnaire/export.xlsx?id=${controlQ.id}&experiment=2&phase=r3_base`, {
      raw: true
    });
    const disposition = decodeURIComponent(filtered.res.headers.get('content-disposition') || '');
    check(
      'xlsx 导出（筛选）：文件名＝问卷名-实验-问题',
      /attachment/.test(disposition) &&
        disposition.includes(`${Q_NAME_CONTROL}-研究3·${scenario.name}-基线决策.xlsx`),
      disposition.replace('attachment; ', '')
    );
  } catch (err) {
    check('xlsx 导出', false, err.message);
  }

  // 7) 清理：删除自检问卷（连同数据），不留痕
  try {
    await admin('/api/admin/questionnaire/delete', { body: { id: controlQ.id, force: true } });
    await admin('/api/admin/questionnaire/delete', { body: { id: treatQ.id, force: true } });
    console.log('\n已清理自检问卷与数据');
  } catch (err) {
    console.log(`\n清理自检问卷失败（可手动删除）：${err.message}`);
  }

  console.log(`\n---- result: ${allPass ? 'ALL PASS' : 'HAS FAILURES'} ----`);
  process.exitCode = allPass ? 0 : 1;
}

main().catch((err) => {
  console.error('SELF-CHECK ERROR:', err.message);
  console.error(`请确认服务已启动：${BASE}`);
  process.exitCode = 1;
});
