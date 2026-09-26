// 实验平台服务端：HTTP 静态资源 + API（零第三方依赖，仅用 Node 内置模块）
// 问卷化流程：一份问卷 = 一条通用链接（/chat?q=<短码>）+ 固定组别 + 实验编排（研究2 / 研究3 可多个混排）。
//   研究2 段（kind=r2）：决策① → 按选择匹配文本 → 相似度评分
//   研究3 段（kind=r3）：基线决策 → 组别文本 → 再决策
// 实验计划在会话创建时快照（plan_json），此后修改问卷不影响进行中的会话。
// 全部文本来自数据库固定存储，运行时不做任何生成；组别与文本选择只在服务端完成。
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const store = require('./db');
const { buildXlsx } = require('./xlsx');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// ---------------------------------------------------------------- 固定选项与展示文案

const RATING_OPTIONS = [1, 2, 3, 4, 5, 6, 7].map((v) => ({ value: v, label: String(v) }));

const ROLE_LABELS = { control: '控制组', treat: '干预组' };
const KIND_LABELS = { r2: '研究2', r3: '研究3' };
const STATUS_LABELS = { in_progress: '进行中', completed: '已完成' };
const PHASE_LABELS = {
  r2_choice: '研究2·决策①',
  r2_rating: '研究2·评分',
  r3_base: '研究3·基线决策',
  r3_choice: '研究3·再决策'
};
// 问题（阶段）短名：用于数据页筛选与导出文件名
const PHASE_SHORT_LABELS = {
  r2_choice: '决策①',
  r2_rating: '评分',
  r3_base: '基线决策',
  r3_choice: '再决策'
};

// ---------------------------------------------------------------- 基础工具

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let relPath = null;
  if (pathname === '/' || pathname === '/index.html') relPath = 'index.html';
  else if (pathname === '/chat' || pathname === '/chat.html') relPath = 'chat.html';
  else if (pathname === '/admin' || pathname === '/admin.html') relPath = 'admin.html';
  else if (pathname.startsWith('/assets/')) relPath = pathname.slice(1);

  if (!relPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const absPath = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (!absPath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(absPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(absPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- 流程状态机
// 会话的实验计划快照 plan = { experiments: [{ sort, kind, scenarioId, scenarioName, tasks: [1,100] }] }
// 展开为步骤序列：研究2 段每任务 2 步（决策① → 评分）；研究3 段每任务 2 步（基线决策 → 再决策）。
// 其中决策① / 基线决策为任务起点（taskStart），新任务开始时由服务端补发衔接语与材料。

function parsePlan(session) {
  let plan = null;
  try {
    plan = JSON.parse(session.plan_json || 'null');
  } catch {
    plan = null;
  }
  return plan && Array.isArray(plan.experiments) ? plan : { experiments: [] };
}

function buildSteps(plan) {
  const steps = [];
  (plan.experiments || []).forEach((exp, expIndex) => {
    (exp.tasks || []).forEach((playCount, taskIndex) => {
      const base = {
        expIndex,
        sort: Number(exp.sort) || expIndex + 1,
        kind: exp.kind === 'r3' ? 'r3' : 'r2',
        scenarioId: exp.scenarioId,
        scenarioName: exp.scenarioName || exp.scenarioId,
        taskIndex,
        playCount: Number(playCount)
      };
      if (base.kind === 'r3') {
        steps.push({ ...base, phase: 'r3_base', taskStart: true });
        steps.push({ ...base, phase: 'r3_choice', taskStart: false });
      } else {
        steps.push({ ...base, phase: 'r2_choice', taskStart: true });
        steps.push({ ...base, phase: 'r2_rating', taskStart: false });
      }
    });
  });
  return steps;
}

// 由已完成作答数推导当前待作答步骤（steps[completedCount]）
function computeAction(steps, completedCount, gt) {
  if (completedCount >= steps.length) return null;
  const step = steps[completedCount];
  const scenario = store.getScenario(step.scenarioId);
  if (!scenario) return null;
  if (step.phase === 'r2_rating') {
    return {
      taskIndex: step.taskIndex,
      playCount: step.playCount,
      phase: step.phase,
      type: 'rating',
      question: scenario.rating_question,
      options: RATING_OPTIONS,
      anchor: gt.ratingAnchor
    };
  }
  return {
    taskIndex: step.taskIndex,
    playCount: step.playCount,
    phase: step.phase,
    type: 'choice',
    question: step.playCount === 1 ? scenario.once_question : scenario.multi_question,
    options: gt.choiceOptions,
    anchor: ''
  };
}

// 研究3 组别文本：按会话组别（问卷固定）取该情景对应组的研究3文本
function groupTextFor(scenarioId, groupRole, playCount) {
  const groups = store.listGroupsByScenario(scenarioId);
  const group = groups.find((g) => g.role === groupRole) || groups[0];
  if (!group) return '';
  return Number(playCount) === 1 ? group.r3_once : group.r3_multi;
}

// 刚完成一笔作答后，生成后续 AI 消息（返回值均为已入库的消息）
// 规则：决策①完成 → 按选择呈现匹配文本；基线决策完成 → 按组别呈现研究3文本；
//       评分 / 再决策完成 → 进入下一任务（衔接语 + 材料）或结束
function advanceMessages(session, steps, completedCount, flow) {
  const messages = [];
  const last = steps[completedCount - 1];
  if (!last) return messages;

  if (last.phase === 'r2_choice') {
    const scenario = store.getScenario(last.scenarioId);
    const lastResponse = store.listResponses(session.id).slice(-1)[0];
    const isOptionA = Number(lastResponse ? lastResponse.value : 1) <= 2;
    let text = '';
    if (scenario) {
      if (last.playCount === 1) text = isOptionA ? scenario.r2_once_a : scenario.r2_once_b;
      else text = isOptionA ? scenario.r2_multi_a : scenario.r2_multi_b;
    }
    if (text) messages.push(store.addMessage(session.id, 'assistant', text));
    return messages;
  }

  if (last.phase === 'r3_base') {
    const text = groupTextFor(last.scenarioId, session.group_role, last.playCount);
    if (text) messages.push(store.addMessage(session.id, 'assistant', text));
    return messages;
  }

  // 刚完成评分（研究2 段收尾）或再决策（研究3 段收尾）
  if (completedCount >= steps.length) {
    if (flow.endText) messages.push(store.addMessage(session.id, 'assistant', flow.endText));
    store.finishSession(session.id);
    return messages;
  }

  const next = steps[completedCount];
  if (next.taskStart) {
    const scenario = store.getScenario(next.scenarioId);
    const parts = [];
    if (flow.nextTaskText) parts.push(flow.nextTaskText);
    if (scenario) parts.push(scenario.context_text);
    if (parts.length) messages.push(store.addMessage(session.id, 'assistant', parts.join('\n\n')));
  }
  return messages;
}

// 新建会话的首批消息：欢迎语（可删）+ 第一个任务的情境材料
function seedSessionMessages(session, plan, flow) {
  const messages = [];
  if (flow.welcomeText) messages.push(store.addMessage(session.id, 'assistant', flow.welcomeText));
  const first = buildSteps(plan)[0];
  if (first) {
    const scenario = store.getScenario(first.scenarioId);
    if (scenario) messages.push(store.addMessage(session.id, 'assistant', scenario.context_text));
  }
  return messages;
}

function sessionBrief(session) {
  return {
    id: session.id,
    uid: session.seq == null ? '' : String(session.seq),
    seq: session.seq == null ? null : Number(session.seq),
    status: session.status
  };
}

// 会话当前状态负载：历史消息 + 待作答步骤（问卷级文案由调用方补充）
function sessionPayload(session, flow) {
  const plan = parsePlan(session);
  const steps = buildSteps(plan);
  const completedCount = store.countResponses(session.id);
  const action =
    session.status === 'completed' ? null : computeAction(steps, completedCount, store.getGlobalTexts());
  return {
    session: sessionBrief(session),
    messages: store.listMessages(session.id),
    action
  };
}

// GET /api/bootstrap?q=<问卷短码>&session=<会话id>
// 返回问卷名与问卷级文案；session 存在且有效时附带历史消息与当前待作答步骤
function handleBootstrap(req, res, url) {
  const code = (url.searchParams.get('q') || '').trim();
  const sid = (url.searchParams.get('session') || '').trim();

  const questionnaire = store.getQuestionnairePayload(code);
  if (!questionnaire) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在或链接已失效' });
  }
  const flow = questionnaire.flow || {};
  const texts = {
    consentText: flow.consentText || '',
    debriefText: flow.debriefText || ''
  };

  let session = sid ? store.getSession(sid) : null;
  if (session && session.questionnaire_id !== code) session = null; // 防止跨问卷串数据
  if (!session) {
    return sendJson(res, 200, {
      questionnaireName: questionnaire.name,
      session: null,
      messages: [],
      action: null,
      ...texts
    });
  }
  sendJson(res, 200, {
    questionnaireName: questionnaire.name,
    ...sessionPayload(session, flow),
    ...texts
  });
}

// POST /api/session  { q }
// 创建会话：按问卷内进入顺序自动编号（seq = 被试编号），固化实验计划快照并写入首批消息
async function handleCreateSession(req, res) {
  const body = await readJsonBody(req);
  const code = String(body.q || '').trim();

  const questionnaire = store.getQuestionnairePayload(code);
  if (!questionnaire) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在或链接已失效' });
  }
  if (!questionnaire.experiments.length) {
    return sendJson(res, 400, { error: 'empty_experiments', message: '该问卷尚未配置实验，请联系研究人员' });
  }

  // 实验计划快照：后续修改问卷不影响本次会话
  const experiments = [];
  for (const exp of questionnaire.experiments) {
    const scenario = store.getScenario(exp.scenarioId);
    if (!scenario) {
      return sendJson(res, 400, { error: 'scenario_missing', message: `实验引用的情景不存在：${exp.scenarioId}` });
    }
    experiments.push({
      sort: exp.sort,
      kind: exp.kind,
      scenarioId: exp.scenarioId,
      scenarioName: exp.scenarioName,
      tasks: store.listTasks(exp.scenarioId).map((t) => Number(t.play_count))
    });
  }
  const plan = { experiments };

  const seq = store.nextSessionSeq(code);
  const session = store.createSession({
    questionnaireId: code,
    seq,
    groupRole: questionnaire.groupRole,
    planJson: JSON.stringify(plan),
    scenarioId: experiments[0].scenarioId,
    userAgent: req.headers['user-agent'] || ''
  });
  seedSessionMessages(session, plan, questionnaire.flow || {});

  const fresh = store.getSession(session.id);
  const flow = questionnaire.flow || {};
  sendJson(res, 200, {
    questionnaireName: questionnaire.name,
    ...sessionPayload(fresh, flow),
    consentText: flow.consentText || '',
    debriefText: flow.debriefText || ''
  });
}

// POST /api/step  { sessionId, value, elapsedMs }
// 记录一次作答（决策 / 评分），生成后续 AI 消息，并返回下一个待作答步骤
async function handleStep(req, res) {
  const body = await readJsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  const value = Number(body.value);
  const elapsedMs = Number.isFinite(Number(body.elapsedMs))
    ? Math.min(Math.max(Math.round(Number(body.elapsedMs)), 0), 24 * 3600 * 1000)
    : null;

  if (!sessionId) {
    return sendJson(res, 400, { error: 'bad_request', message: '缺少 sessionId' });
  }

  const session = store.getSession(sessionId);
  if (!session) {
    return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });
  }
  if (session.status !== 'in_progress') {
    return sendJson(res, 409, { error: 'session_closed', message: '会话已结束' });
  }

  const questionnaire = store.getQuestionnairePayload(session.questionnaire_id || '');
  const flow = questionnaire ? questionnaire.flow || {} : {};
  const steps = buildSteps(parsePlan(session));
  const completedCount = store.countResponses(session.id);
  const gt = store.getGlobalTexts();
  const action = computeAction(steps, completedCount, gt);
  if (!action) {
    return sendJson(res, 409, { error: 'session_closed', message: '会话已结束' });
  }

  // 校验作答值范围：决策 1-4；评分 1-7
  const maxValue = action.type === 'choice' ? gt.choiceOptions.length : RATING_OPTIONS.length;
  if (!Number.isInteger(value) || value < 1 || value > maxValue) {
    return sendJson(res, 400, { error: 'bad_value', message: '作答值不合法' });
  }

  const step = steps[completedCount];
  const answeredAt = new Date();
  const optionLabel =
    action.type === 'choice'
      ? gt.choiceOptions.find((o) => o.value === value).label
      : `相似度 ${value} 分`;
  const shownAt = elapsedMs == null ? null : new Date(answeredAt.getTime() - elapsedMs).toISOString();

  // 用户动作回显（聊天流）
  const echo = action.type === 'choice' ? `我选择：${optionLabel}` : `相似度评分：${value} 分`;
  const userMessage = store.addMessage(sessionId, 'user', echo);

  store.addResponse({
    sessionId,
    questionnaireId: session.questionnaire_id || '',
    scenarioId: step.scenarioId,
    groupId: `${step.scenarioId}-${session.group_role === 'treat' ? 'treat' : 'control'}`,
    experimentSort: step.sort,
    experimentKind: step.kind,
    taskIndex: step.taskIndex,
    playCount: step.playCount,
    phase: step.phase,
    value,
    optionLabel,
    shownAt,
    answeredAt: answeredAt.toISOString(),
    elapsedMs
  });

  const nextCount = completedCount + 1;
  const messages = advanceMessages(session, steps, nextCount, flow);
  const nextAction = computeAction(steps, nextCount, gt);
  const updated = store.getSession(sessionId);

  sendJson(res, 200, {
    userMessage,
    messages,
    action: nextAction,
    session: sessionBrief(updated)
  });
}

// POST /api/finish  { sessionId } —— 提前结束会话（保留供备用）
async function handleFinish(req, res) {
  const body = await readJsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  const session = store.finishSession(sessionId);
  if (!session) {
    return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });
  }
  sendJson(res, 200, {
    session: {
      id: session.id,
      status: session.status,
      uid: session.seq == null ? '' : String(session.seq),
      duration_sec: session.duration_sec
    }
  });
}

// ---------------------------------------------------------------- 管理端 API

const ADMIN_TOKEN_TTL = 24 * 60 * 60 * 1000;
const adminTokens = new Map();

function issueAdminToken() {
  const token = randomUUID();
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL);
  return token;
}

function requireAdmin(req, res) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const expiresAt = adminTokens.get(token);
  if (!token || !expiresAt || expiresAt < Date.now()) {
    adminTokens.delete(token);
    sendJson(res, 401, { error: 'unauthorized', message: '登录已失效，请重新登录' });
    return false;
  }
  return true;
}

// POST /api/admin/login  { password }
async function handleAdminLogin(req, res) {
  const body = await readJsonBody(req);
  const password = String(body.password || '');
  const expected = store.getSetting('admin_password') || '';
  if (!password || password !== expected) {
    return sendJson(res, 401, { error: 'bad_credentials', message: '密码不正确' });
  }
  sendJson(res, 200, { token: issueAdminToken() });
}

// POST /api/admin/logout
async function handleAdminLogout(req, res) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  adminTokens.delete(token);
  sendJson(res, 200, { ok: true });
}

// GET /api/admin/scenarios —— 全部情景树（含组与任务清单）
function handleAdminScenarios(req, res) {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { scenarios: store.listScenarios().map(store.adminScenarioPayload) });
}

function adminSettingsPayload() {
  const gt = store.getGlobalTexts();
  return {
    welcomeText: gt.welcomeText,
    nextTaskText: gt.nextTaskText,
    endText: gt.endText,
    choiceOptions: gt.choiceOptions,
    ratingAnchor: gt.ratingAnchor,
    consentText: gt.consentText,
    debriefText: gt.debriefText
  };
}

// GET /api/admin/settings —— 全局文案（流程页面 / 选项卡片 / 评分锚点 / 伦理页面）
function handleAdminGetSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { settings: adminSettingsPayload() });
}

// POST /api/admin/settings —— 保存流程页面文案（作为新建问卷的默认内容模板）
async function handleAdminSaveSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);
  const required = [
    ['welcomeText', '欢迎语'],
    ['nextTaskText', '任务衔接语'],
    ['endText', '结束语'],
    ['consentText', '知情同意文案'],
    ['debriefText', '结束说明文案']
  ];
  for (const [key, label] of required) {
    if (!String(body[key] ?? '').trim()) {
      return sendJson(res, 400, { error: 'bad_field', message: `${label}不能为空` });
    }
  }

  // 注意：完成环节不提供任何跳转（无问卷链接 / 返回按钮），保存时不再传递问卷链接字段
  store.saveGlobalTexts({
    welcome_text: String(body.welcomeText),
    next_task_text: String(body.nextTaskText),
    end_text: String(body.endText),
    consent_text: String(body.consentText),
    debrief_text: String(body.debriefText)
  });
  sendJson(res, 200, { settings: adminSettingsPayload() });
}

// ---------------------------------------------------------------- 管理端 · 情景 CRUD

const SCENARIO_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// POST /api/admin/scenario —— 保存整棵情景树（情景文本 + 任务清单 + 两个组）
async function handleAdminSaveScenario(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);

  const id = String(body.id || '').trim();
  const scenario = store.getScenario(id);
  if (!scenario) {
    return sendJson(res, 404, { error: 'scenario_not_found', message: '情景不存在' });
  }

  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: 'bad_name', message: '情景名称不能为空' });

  const required = [
    ['contextText', '情境材料'],
    ['onceQuestion', '单次博弈提问'],
    ['multiQuestion', '多次博弈提问'],
    ['ratingQuestion', '相似度评分题目'],
    ['r2OnceA', '研究2文本（单次·选A）'],
    ['r2OnceB', '研究2文本（单次·选B）'],
    ['r2MultiA', '研究2文本（多次·选A）'],
    ['r2MultiB', '研究2文本（多次·选B）']
  ];
  for (const [key, label] of required) {
    if (!String(body[key] ?? '').trim()) {
      return sendJson(res, 400, { error: 'bad_field', message: `${label}不能为空` });
    }
  }

  const tasks = Array.isArray(body.tasks) ? body.tasks.map((t) => Number(t)) : [];
  if (tasks.length === 0) {
    return sendJson(res, 400, { error: 'bad_tasks', message: '任务清单至少包含一个任务' });
  }
  if (tasks.some((t) => t !== 1 && t !== 100)) {
    return sendJson(res, 400, { error: 'bad_tasks', message: '任务只能为「单次博弈」或「多次博弈」' });
  }
  if (new Set(tasks).size !== tasks.length) {
    return sendJson(res, 400, { error: 'bad_tasks', message: '任务清单不能重复' });
  }

  // 全局文案（选项卡片 ×4 与评分锚点）：随情景一并提交
  const globalTexts = body.globalTexts && typeof body.globalTexts === 'object' ? body.globalTexts : null;
  if (globalTexts) {
    for (const [key, label] of [
      ['choiceOption1', '选项 1 文案'],
      ['choiceOption2', '选项 2 文案'],
      ['choiceOption3', '选项 3 文案'],
      ['choiceOption4', '选项 4 文案'],
      ['ratingAnchor', '评分区间锚点']
    ]) {
      if (!String(globalTexts[key] ?? '').trim()) {
        return sendJson(res, 400, { error: 'bad_field', message: `${label}不能为空` });
      }
    }
  }

  const existingGroups = store.listGroupsByScenario(id);
  const groups = Array.isArray(body.groups) ? body.groups : [];
  const groupPayload = [];
  for (const g of existingGroups) {
    const incoming = groups.find((x) => x.id === g.id);
    if (!incoming) {
      return sendJson(res, 400, { error: 'bad_groups', message: `缺少分组：${g.name}` });
    }
    const gName = String(incoming.name || '').trim();
    if (!gName) return sendJson(res, 400, { error: 'bad_groups', message: `${g.name} 的名称不能为空` });
    for (const [key, label] of [['r3Once', '单次文本'], ['r3Multi', '多次文本']]) {
      if (!String(incoming[key] ?? '').trim()) {
        return sendJson(res, 400, { error: 'bad_groups', message: `${gName}的${label}不能为空` });
      }
    }
    groupPayload.push({
      id: g.id,
      name: gName,
      r3Once: String(incoming.r3Once ?? ''),
      r3Multi: String(incoming.r3Multi ?? '')
    });
  }

  store.saveScenarioTree(id, {
    name,
    contextText: String(body.contextText ?? ''),
    onceQuestion: String(body.onceQuestion ?? ''),
    multiQuestion: String(body.multiQuestion ?? ''),
    r2OnceA: String(body.r2OnceA ?? ''),
    r2OnceB: String(body.r2OnceB ?? ''),
    r2MultiA: String(body.r2MultiA ?? ''),
    r2MultiB: String(body.r2MultiB ?? ''),
    ratingQuestion: String(body.ratingQuestion ?? ''),
    tasks,
    groups: groupPayload,
    globalTexts
  });

  sendJson(res, 200, { scenario: store.adminScenarioPayload(store.getScenario(id)) });
}

// POST /api/admin/scenario/create { id, name, copyFrom? }
// 新建情景（copyFrom 存在时复制全部文本 / 任务 / 组文本），随即跳转编辑页完善
async function handleAdminCreateScenario(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);
  const id = String(body.id || '').trim();
  const name = String(body.name || '').trim();
  const copyFrom = String(body.copyFrom || '').trim();

  if (!SCENARIO_ID_RE.test(id)) {
    return sendJson(res, 400, {
      error: 'invalid_id',
      message: '情景 ID 需为小写字母、数字或连字符（40 位以内，字母或数字开头）'
    });
  }
  if (!name) return sendJson(res, 400, { error: 'bad_name', message: '情景名称不能为空' });
  if (store.getScenario(id)) {
    return sendJson(res, 409, { error: 'id_taken', message: '该情景 ID 已存在，请更换' });
  }
  if (copyFrom && !store.getScenario(copyFrom)) {
    return sendJson(res, 400, { error: 'copy_source_not_found', message: '复制来源情景不存在' });
  }

  const scenario = store.createScenario({ id, name, copyFrom: copyFrom || null });
  sendJson(res, 200, { scenario: store.adminScenarioPayload(scenario) });
}

// POST /api/admin/scenario/delete { id } —— 删除情景（存在被试会话或仅剩一个情景时拒绝）
async function handleAdminDeleteScenario(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);
  const id = String(body.id || '').trim();
  const result = store.deleteScenario(id);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      return sendJson(res, 404, { error: 'scenario_not_found', message: '情景不存在' });
    }
    if (result.reason === 'has_sessions') {
      return sendJson(res, 400, {
        error: 'has_sessions',
        message: `该情景已有 ${result.sessionCount} 个被试会话，不能删除（防止误删科研数据）`
      });
    }
    return sendJson(res, 400, { error: 'last_scenario', message: '至少需要保留一个情景，不能删除最后一个' });
  }
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- 管理端 · 问卷管理（列表 / 创建 / 修改 / 删除）

// 从请求体提取并校验问卷字段（创建 / 更新共用）
function parseQuestionnaireBody(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: '问卷名称不能为空' };

  const groupRole = body.groupRole === 'treat' ? 'treat' : 'control';
  const flow = body.flow && typeof body.flow === 'object' ? body.flow : {};

  const rawExperiments = Array.isArray(body.experiments) ? body.experiments : [];
  if (rawExperiments.length === 0) return { error: '请至少插入一个研究实验' };
  const experiments = [];
  for (const exp of rawExperiments) {
    const kind = exp && exp.kind === 'r3' ? 'r3' : 'r2';
    const scenarioId = String((exp && exp.scenarioId) || '').trim();
    if (!scenarioId || !store.getScenario(scenarioId)) {
      return { error: `实验引用的情景不存在：${scenarioId || '(空)'}` };
    }
    experiments.push({ kind, scenarioId });
  }
  return { value: { name, groupRole, flow, experiments } };
}

// GET /api/admin/questionnaires —— 问卷列表（含数据量）
function handleAdminQuestionnaires(req, res) {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { questionnaires: store.listQuestionnaires() });
}

// GET /api/admin/questionnaire?id= —— 单条问卷（含流程文案与实验编排）
function handleAdminQuestionnaire(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const id = (url.searchParams.get('id') || '').trim();
  const questionnaire = store.getQuestionnairePayload(id);
  if (!questionnaire) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  sendJson(res, 200, { questionnaire });
}

// POST /api/admin/questionnaire/create —— 生成问卷（自动分配链接短码）
async function handleAdminQuestionnaireCreate(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);
  const parsed = parseQuestionnaireBody(body);
  if (parsed.error) return sendJson(res, 400, { error: 'bad_field', message: parsed.error });
  const questionnaire = store.createQuestionnaire(parsed.value);
  sendJson(res, 200, { questionnaire });
}

// POST /api/admin/questionnaire/update —— 修改问卷（进行中的会话不受影响）
async function handleAdminQuestionnaireUpdate(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);
  const id = String(body.id || '').trim();
  if (!store.getQuestionnaire(id)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const parsed = parseQuestionnaireBody(body);
  if (parsed.error) return sendJson(res, 400, { error: 'bad_field', message: parsed.error });
  const questionnaire = store.updateQuestionnaire(id, parsed.value);
  sendJson(res, 200, { questionnaire });
}

// POST /api/admin/questionnaire/delete { id, force? } —— 删除问卷（有数据需 force，连带删数据）
async function handleAdminQuestionnaireDelete(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);
  const id = String(body.id || '').trim();
  const result = store.deleteQuestionnaire(id, { force: !!body.force });
  if (!result.ok) {
    if (result.reason === 'not_found') {
      return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
    }
    return sendJson(res, 400, {
      error: 'has_sessions',
      message: `该问卷已有 ${result.sessionCount} 份被试数据，删除将一并清空，请确认`,
      sessionCount: result.sessionCount
    });
  }
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- 管理端 · 问卷数据与导出

// 实验摘要：如「研究2·医疗情景 + 研究3·医疗情景」
function planSummaryOf(plan) {
  return (plan.experiments || [])
    .map((e) => `${KIND_LABELS[e.kind] || e.kind}·${e.scenarioName || e.scenarioId}`)
    .join(' + ');
}

// GET /api/admin/questionnaire/sessions?id=&experiment=&phase=
// 问卷详情页：作答明细（一行 = 一条作答），支持按实验段（experiment_sort）/ 问题（阶段）筛选
function handleAdminQuestionnaireSessions(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const id = (url.searchParams.get('id') || '').trim();
  const questionnaire = store.getQuestionnairePayload(id);
  if (!questionnaire) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const rows = store.listQuestionnaireExportRows(id, {
    experimentSort: (url.searchParams.get('experiment') || '').trim(),
    phase: (url.searchParams.get('phase') || '').trim()
  });
  const sessionIds = new Set(rows.map((r) => r.session_id));
  sendJson(res, 200, {
    questionnaire,
    rows: rows.map((r) => ({
      sessionId: r.session_id,
      seq: r.seq == null ? null : Number(r.seq),
      status: r.session_status,
      statusLabel: STATUS_LABELS[r.session_status] || r.session_status,
      groupRoleName: ROLE_LABELS[r.group_role] || r.group_role || '',
      experimentSort: Number(r.experiment_sort) || 0,
      experimentKind: r.experiment_kind,
      scenarioId: r.scenario_id,
      scenarioName: r.scenario_name || r.scenario_id,
      taskIndex: Number(r.task_index),
      playCount: Number(r.play_count),
      phase: r.phase,
      phaseLabel: PHASE_LABELS[r.phase] || r.phase,
      value: Number(r.value),
      optionLabel: r.option_label || '',
      shownAt: r.shown_at,
      answeredAt: r.answered_at,
      elapsedMs: r.elapsed_ms == null ? null : Number(r.elapsed_ms)
    })),
    rowCount: rows.length,
    sessionCount: sessionIds.size
  });
}

// GET /api/admin/questionnaire/session?id=&sid= —— 个案详情（会话元信息 + 消息 + 作答）
function handleAdminQuestionnaireSession(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const id = (url.searchParams.get('id') || '').trim();
  const sid = (url.searchParams.get('sid') || '').trim();
  const questionnaire = store.getQuestionnairePayload(id);
  if (!questionnaire) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const session = store.getSession(sid);
  if (!session || session.questionnaire_id !== id) {
    return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });
  }
  sendJson(res, 200, {
    questionnaire,
    session: {
      id: session.id,
      seq: session.seq == null ? null : Number(session.seq),
      status: session.status,
      statusLabel: STATUS_LABELS[session.status] || session.status,
      group_role: session.group_role,
      groupRoleName: ROLE_LABELS[session.group_role] || session.group_role || '',
      started_at: session.started_at,
      ended_at: session.ended_at,
      duration_sec: session.duration_sec,
      plan: parsePlan(session),
      planSummary: planSummaryOf(parsePlan(session))
    },
    messages: store.listMessages(session.id),
    responses: store.listResponses(session.id).map((r) => ({
      ...r,
      phaseLabel: PHASE_LABELS[r.phase] || r.phase
    }))
  });
}

// GET /api/admin/questionnaire/export.xlsx?id=&experiment=&phase=
// 导出：按实验分 sheet（一个实验一个 sheet）；支持按实验段 / 问题筛选；
// 文件名 = 问卷名（-实验名）（-问题名），如「演示问卷·控制组-研究3·医疗情景-基线决策.xlsx」
function handleAdminQuestionnaireExport(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const id = (url.searchParams.get('id') || '').trim();
  const questionnaire = store.getQuestionnairePayload(id);
  if (!questionnaire) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }

  const experimentSort = (url.searchParams.get('experiment') || '').trim();
  const phase = (url.searchParams.get('phase') || '').trim();
  const rows = store.listQuestionnaireExportRows(id, { experimentSort, phase });

  // 按实验段（experiment_sort）分组，每个实验一个 sheet
  const grouped = new Map();
  for (const row of rows) {
    const key = Number(row.experiment_sort) || 0;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const columns = [
    { title: '被试编号', width: 10 },
    { title: '组别', width: 10 },
    { title: '状态', width: 10 },
    { title: '任务', width: 16 },
    { title: '阶段', width: 18 },
    { title: '作答值', width: 8 },
    { title: '选项/分数文案', width: 34 },
    { title: '呈现时间', width: 20 },
    { title: '作答时间', width: 20 },
    { title: '耗时（秒）', width: 10 }
  ];

  const sheets = [];
  for (const [sort, items] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    const first = items[0];
    sheets.push({
      name: `${sort}-${KIND_LABELS[first.experiment_kind] || first.experiment_kind}-${first.scenario_name || first.scenario_id}`,
      columns,
      rows: items.map((r) => [
        Number(r.seq),
        ROLE_LABELS[r.group_role] || r.group_role || '',
        STATUS_LABELS[r.session_status] || r.session_status || '',
        `任务${Number(r.task_index) + 1}·${Number(r.play_count) === 1 ? '单次' : '多次'}`,
        PHASE_LABELS[r.phase] || r.phase,
        Number(r.value),
        r.option_label || '',
        fmtLocal(r.shown_at),
        fmtLocal(r.answered_at),
        r.elapsed_ms == null ? '' : Math.round(Number(r.elapsed_ms) / 100) / 10
      ])
    });
  }
  if (!sheets.length) sheets.push({ name: '无数据', columns, rows: [] });

  // 文件名：问卷名（-实验名）（-问题名），如「演示问卷-研究3·医疗情景-基线决策.xlsx」
  const nameParts = [questionnaire.name];
  if (experimentSort) {
    const exp = (questionnaire.experiments || []).find((e) => String(e.sort) === String(experimentSort));
    if (exp) nameParts.push(`${KIND_LABELS[exp.kind] || exp.kind}·${exp.scenarioName}`);
  }
  if (phase) nameParts.push(PHASE_SHORT_LABELS[phase] || phase);
  const fileName = `${nameParts.join('-')}.xlsx`;

  const buf = buildXlsx(sheets);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="questionnaire-${id}.xlsx"; filename*=UTF-8''${encodeURIComponent(
      fileName
    )}`
  });
  res.end(buf);
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    // 被试端
    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      return handleBootstrap(req, res, url);
    }
    if (pathname === '/api/session' && req.method === 'POST') {
      return await handleCreateSession(req, res);
    }
    if (pathname === '/api/step' && req.method === 'POST') {
      return await handleStep(req, res);
    }
    if (pathname === '/api/finish' && req.method === 'POST') {
      return await handleFinish(req, res);
    }
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }
    // 管理端 · 基础
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      return await handleAdminLogin(req, res);
    }
    if (pathname === '/api/admin/logout' && req.method === 'POST') {
      return await handleAdminLogout(req, res);
    }
    if (pathname === '/api/admin/scenarios' && req.method === 'GET') {
      return handleAdminScenarios(req, res);
    }
    if (pathname === '/api/admin/settings' && req.method === 'GET') {
      return handleAdminGetSettings(req, res);
    }
    if (pathname === '/api/admin/settings' && req.method === 'POST') {
      return await handleAdminSaveSettings(req, res);
    }
    // 管理端 · 情景 CRUD
    if (pathname === '/api/admin/scenario' && req.method === 'POST') {
      return await handleAdminSaveScenario(req, res);
    }
    if (pathname === '/api/admin/scenario/create' && req.method === 'POST') {
      return await handleAdminCreateScenario(req, res);
    }
    if (pathname === '/api/admin/scenario/delete' && req.method === 'POST') {
      return await handleAdminDeleteScenario(req, res);
    }
    // 管理端 · 问卷管理
    if (pathname === '/api/admin/questionnaires' && req.method === 'GET') {
      return handleAdminQuestionnaires(req, res);
    }
    if (pathname === '/api/admin/questionnaire' && req.method === 'GET') {
      return handleAdminQuestionnaire(req, res, url);
    }
    if (pathname === '/api/admin/questionnaire/create' && req.method === 'POST') {
      return await handleAdminQuestionnaireCreate(req, res);
    }
    if (pathname === '/api/admin/questionnaire/update' && req.method === 'POST') {
      return await handleAdminQuestionnaireUpdate(req, res);
    }
    if (pathname === '/api/admin/questionnaire/delete' && req.method === 'POST') {
      return await handleAdminQuestionnaireDelete(req, res);
    }
    if (pathname === '/api/admin/questionnaire/sessions' && req.method === 'GET') {
      return handleAdminQuestionnaireSessions(req, res, url);
    }
    if (pathname === '/api/admin/questionnaire/session' && req.method === 'GET') {
      return handleAdminQuestionnaireSession(req, res, url);
    }
    if (pathname === '/api/admin/questionnaire/export.xlsx' && req.method === 'GET') {
      return handleAdminQuestionnaireExport(req, res, url);
    }

    if (req.method === 'GET') {
      return serveStatic(res, pathname);
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    sendJson(res, 500, { error: 'server_error', message: err.message });
  }
});

server.listen(PORT, () => {
  const questionnaires = store.listQuestionnaires();
  console.log('实验平台已启动');
  console.log(`  管理端入口：  http://localhost:${PORT}/admin`);
  if (questionnaires.length) {
    console.log(
      `  被试端示例：  http://localhost:${PORT}/chat?q=${questionnaires[0].id}（${questionnaires[0].name}）`
    );
  } else {
    console.log('  提示：暂无问卷，请先在管理端创建问卷');
  }
});