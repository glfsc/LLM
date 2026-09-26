// 实验平台服务端：HTTP 静态资源 + API（零第三方依赖，仅用 Node 内置模块）
// 流程引擎：研究2（决策 → 按选择匹配文本 → 评分）+ 研究3（组别文本 → 再决策），
// 全部文本来自数据库固定存储，运行时不做任何生成；组别与文本选择只在服务端完成。
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const store = require('./db');

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

// ---------------------------------------------------------------- 固定文案与选项

const WELCOME_TEXT =
  '您好！我是您的智能决策助手。接下来我会为您呈现若干决策任务，请仔细阅读每一项材料，并按照您的真实想法作答。';

const NEXT_TASK_TEXT = '下面进入下一项决策任务，请继续仔细阅读以下材料。';

const END_TEXT = '本次全部决策任务已完成，感谢您的参与！';

const CHOICE_OPTIONS = [
  { value: 1, label: '非常可能选择方案A' },
  { value: 2, label: '可能选择方案A' },
  { value: 3, label: '可能选择方案B' },
  { value: 4, label: '非常可能选择方案B' }
];

const RATING_OPTIONS = [1, 2, 3, 4, 5, 6, 7].map((v) => ({ value: v, label: String(v) }));

const RATING_ANCHOR = '1 = 非常不相似　·　7 = 非常相似';

const PHASES = ['r2_choice', 'r2_rating', 'r3_choice'];

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

// ---------------------------------------------------------------- 流程状态机

// 由作答记录数推导当前待作答步骤：每任务 3 步（r2_choice → r2_rating → r3_choice）
function computeAction(scenario, tasks, completedCount) {
  const total = tasks.length * 3;
  if (completedCount >= total) return null;

  const taskIndex = Math.floor(completedCount / 3);
  const phase = PHASES[completedCount % 3];
  const task = tasks[taskIndex];
  const playCount = Number(task.play_count);

  if (phase === 'r2_rating') {
    return {
      taskIndex,
      playCount,
      phase,
      type: 'rating',
      question: scenario.rating_question,
      options: RATING_OPTIONS,
      anchor: RATING_ANCHOR
    };
  }
  return {
    taskIndex,
    playCount,
    phase,
    type: 'choice',
    question: playCount === 1 ? scenario.once_question : scenario.multi_question,
    options: CHOICE_OPTIONS,
    anchor: ''
  };
}

// 刚完成一笔作答后，生成后续 AI 消息（返回值均为已入库的消息）
function advanceMessages(session, scenario, group, tasks, completedCount) {
  const messages = [];
  const remainder = completedCount % 3;
  const lastTaskIndex = Math.floor((completedCount - 1) / 3);
  const lastTask = tasks[lastTaskIndex];

  if (remainder === 1) {
    // 刚提交研究2·决策① → 按选择与博弈次数呈现匹配文本
    const lastResponse = store.listResponses(session.id).slice(-1)[0];
    const isOptionA = Number(lastResponse.value) <= 2;
    let text;
    if (Number(lastTask.play_count) === 1) {
      text = isOptionA ? scenario.r2_once_a : scenario.r2_once_b;
    } else {
      text = isOptionA ? scenario.r2_multi_a : scenario.r2_multi_b;
    }
    messages.push(store.addMessage(session.id, 'assistant', text));
  } else if (remainder === 2) {
    // 刚提交研究2·评分 → 按组别呈现研究3文本
    const text = Number(lastTask.play_count) === 1 ? group.r3_once : group.r3_multi;
    messages.push(store.addMessage(session.id, 'assistant', text));
  } else {
    // 刚提交研究3·决策② → 进入下一任务或结束
    if (completedCount >= tasks.length * 3) {
      messages.push(store.addMessage(session.id, 'assistant', END_TEXT));
      store.finishSession(session.id);
    } else {
      messages.push(
        store.addMessage(session.id, 'assistant', `${NEXT_TASK_TEXT}\n\n${scenario.context_text}`)
      );
    }
  }
  return messages;
}

// 新建会话的首批消息：欢迎语 + 第一个任务的情境材料
function seedSessionMessages(session, scenario) {
  const messages = [];
  messages.push(store.addMessage(session.id, 'assistant', WELCOME_TEXT));
  messages.push(store.addMessage(session.id, 'assistant', scenario.context_text));
  return messages;
}

function sessionBrief(session) {
  return {
    id: session.id,
    status: session.status,
    code: session.code || ''
  };
}

// GET /api/bootstrap?group=xxx&uid=xxx
// 返回组（仅名称）、情景、历史消息与当前待作答步骤
function handleBootstrap(req, res, url) {
  const groupId = (url.searchParams.get('group') || '').trim();
  const uid = (url.searchParams.get('uid') || '').trim();

  const group = store.getGroup(groupId);
  if (!group || !group.enabled) {
    return sendJson(res, 404, { error: 'group_not_found', message: '该分组不存在或未启用' });
  }
  const scenario = store.getScenario(group.scenario_id);
  if (!scenario || !scenario.enabled) {
    return sendJson(res, 404, { error: 'group_not_found', message: '该分组不存在或未启用' });
  }

  const session = uid ? store.findSessionByUid(groupId, uid) : null;
  if (!session) {
    return sendJson(res, 200, { groupName: group.name, session: null, messages: [], action: null });
  }

  const tasks = store.listTasks(scenario.id);
  const completedCount = store.countResponses(session.id);
  const action = session.status === 'completed' ? null : computeAction(scenario, tasks, completedCount);

  sendJson(res, 200, {
    groupName: group.name,
    session: sessionBrief(session),
    messages: store.listMessages(session.id),
    action
  });
}

// POST /api/session  { group, uid }
// 创建会话（同 uid + 组 幂等：已存在则直接返回），并写入欢迎语与首个情境
async function handleCreateSession(req, res) {
  const body = await readJsonBody(req);
  const groupId = String(body.group || '').trim();
  const uid = String(body.uid || '').trim();

  const group = store.getGroup(groupId);
  if (!group || !group.enabled) {
    return sendJson(res, 404, { error: 'group_not_found', message: '该分组不存在或未启用' });
  }
  const scenario = store.getScenario(group.scenario_id);
  if (!scenario || !scenario.enabled) {
    return sendJson(res, 404, { error: 'group_not_found', message: '该分组不存在或未启用' });
  }

  let session = uid ? store.findSessionByUid(groupId, uid) : null;
  if (!session) {
    session = store.createSession({
      scenarioId: scenario.id,
      groupId,
      uid,
      userAgent: req.headers['user-agent'] || ''
    });
    seedSessionMessages(session, scenario);
    session = store.getSession(session.id);
  }

  const tasks = store.listTasks(scenario.id);
  const completedCount = store.countResponses(session.id);
  const action = session.status === 'completed' ? null : computeAction(scenario, tasks, completedCount);

  sendJson(res, 200, {
    groupName: group.name,
    session: sessionBrief(session),
    messages: store.listMessages(session.id),
    action
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

  const group = store.getGroup(session.group_id);
  const scenario = store.getScenario(session.scenario_id);
  if (!group || !scenario) {
    return sendJson(res, 404, { error: 'group_not_found', message: '分组或情景不存在' });
  }

  const tasks = store.listTasks(scenario.id);
  const completedCount = store.countResponses(session.id);
  const action = computeAction(scenario, tasks, completedCount);
  if (!action) {
    return sendJson(res, 409, { error: 'session_closed', message: '会话已结束' });
  }

  // 校验作答值范围：决策 1-4；评分 1-7
  const maxValue = action.type === 'choice' ? CHOICE_OPTIONS.length : RATING_OPTIONS.length;
  if (!Number.isInteger(value) || value < 1 || value > maxValue) {
    return sendJson(res, 400, { error: 'bad_value', message: '作答值不合法' });
  }

  const answeredAt = new Date();
  const optionLabel =
    action.type === 'choice'
      ? CHOICE_OPTIONS.find((o) => o.value === value).label
      : `相似度 ${value} 分`;
  const shownAt = elapsedMs == null ? null : new Date(answeredAt.getTime() - elapsedMs).toISOString();

  // 用户动作回显（聊天流）
  const echo = action.type === 'choice' ? `我选择：${optionLabel}` : `相似度评分：${value} 分`;
  const userMessage = store.addMessage(sessionId, 'user', echo);

  store.addResponse({
    sessionId,
    scenarioId: scenario.id,
    groupId: group.id,
    taskIndex: action.taskIndex,
    playCount: action.playCount,
    phase: action.phase,
    value,
    optionLabel,
    shownAt,
    answeredAt: answeredAt.toISOString(),
    elapsedMs
  });

  const nextCount = completedCount + 1;
  const messages = advanceMessages(session, scenario, group, tasks, nextCount);
  const nextAction = computeAction(scenario, tasks, nextCount);
  const updated = store.getSession(sessionId);

  sendJson(res, 200, {
    userMessage,
    messages,
    action: nextAction,
    session: sessionBrief(updated)
  });
}

// POST /api/finish  { sessionId }
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
      code: session.code,
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
      r3Multi: String(incoming.r3Multi ?? ''),
      enabled: incoming.enabled !== false
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
    enabled: body.enabled !== false,
    tasks,
    groups: groupPayload
  });

  sendJson(res, 200, { scenario: store.adminScenarioPayload(store.getScenario(id)) });
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
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
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      return await handleAdminLogin(req, res);
    }
    if (pathname === '/api/admin/logout' && req.method === 'POST') {
      return await handleAdminLogout(req, res);
    }
    if (pathname === '/api/admin/scenarios' && req.method === 'GET') {
      return handleAdminScenarios(req, res);
    }
    if (pathname === '/api/admin/scenario' && req.method === 'POST') {
      return await handleAdminSaveScenario(req, res);
    }
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
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
  console.log('实验平台已启动');
  console.log(`  调试入口：    http://localhost:${PORT}/`);
  console.log(`  被试端示例：  http://localhost:${PORT}/chat?group=medical-control&uid=1001`);
  console.log(`  管理端入口：  http://localhost:${PORT}/admin`);
});
