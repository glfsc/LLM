// 服务端：HTTP 静态资源 + API（零第三方依赖，仅用 Node 内置模块）
// 统一模型：问卷 = 一条链接 + 一列题目 + 计时默认值。被试端按题目顺序推进：
//   消息类题目（message）自动以消息形式发出；其余题型构成「作答单元」。
// 计时门控全部服务端权威，且不产生额外请求：
//   延迟发出       → 消息落库带 visible_at，到时才对被试可见
//   作答前强制等待 → 作答单元的 availableAt = 呈现时刻 + wait
//   最短提交/最长作答 → 共用窗口（相邻且设置相同的题目共用一个起点）
// 会话创建时把题目与计时快照进 sessions，此后修改模板 / 问卷不影响进行中的会话。
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const store = require('./db');
const { buildXlsx } = require('./xlsx');
const qrcode = require('./vendor/qrcode');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const STATUS_LABELS = { in_progress: '进行中', completed: '已完成' };
const OPTION_LETTERS = 'ABCDEFGH';

// ---------------------------------------------------------------- 基础工具

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, absPath) {
  fs.readFile(absPath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(absPath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

function serveStatic(res, pathname) {
  let relPath = '';
  if (pathname === '/' || pathname === '/index.html') relPath = 'index.html';
  else if (pathname === '/chat' || pathname === '/chat.html') relPath = 'chat.html';
  else if (pathname === '/admin' || pathname === '/admin.html') relPath = 'admin.html';
  else if (pathname.startsWith('/assets/')) relPath = pathname.slice(1);
  if (!relPath) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
  serveFile(res, path.join(PUBLIC_DIR, relPath));
}

function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 生效的计时限制：题目勾选优先，否则用问卷默认值
function effLimit(item, key, timing) {
  const v = item.limits ? item.limits[key] : undefined;
  if (v !== undefined && v !== null) return Number(v) || 0;
  return Number((timing || {})[key]) || 0;
}

function optionLabelOf(item, value) {
  const idx = Number(value) - 1;
  if (idx < 0 || idx >= (item.options || []).length) return '';
  return `${OPTION_LETTERS[idx]}．${item.options[idx]}`;
}

function textOf(valueText) {
  try {
    const obj = JSON.parse(valueText || 'null');
    return obj && typeof obj === 'object' ? String(obj.text ?? '') : String(valueText || '');
  } catch {
    return String(valueText || '');
  }
}

// ---------------------------------------------------------------- 状态机
// 作答单元 = 除 message 外的所有题目；message 在推进时自动作为消息发出。
const planCache = new Map();
const PLAN_CACHE_MAX = 2000;

function parseSession(session) {
  const hit = planCache.get(session.id);
  if (hit && hit.pendingAt === session.pending_presented_at && hit.itemsJson === session.items_json) return hit;
  const items = store.normalizeItems(JSON.parse(session.items_json || '[]'));
  const timing = store.normalizeTiming(JSON.parse(session.timing_json || '{}'));
  const units = [];
  items.forEach((item, index) => { if (item.type !== 'message') units.push({ item, index }); });
  const plan = { items, timing, units, pendingAt: session.pending_presented_at, itemsJson: session.items_json };
  if (planCache.size >= PLAN_CACHE_MAX) {
    const oldest = planCache.keys().next().value;
    if (oldest !== undefined) planCache.delete(oldest);
  }
  planCache.set(session.id, plan);
  return plan;
}

// 推进：发出 (afterAnswerIndex-1, afterAnswerIndex) 之间的消息题目
function emitMessagesBetween(session, plan, afterAnswerIndex, nowMs) {
  const units = plan.units;
  const fromItem = afterAnswerIndex > 0 ? units[afterAnswerIndex - 1].index : -1;
  const toItem = afterAnswerIndex < units.length ? units[afterAnswerIndex].index : plan.items.length;
  const emitted = [];
  for (let i = fromItem + 1; i < toItem; i += 1) {
    const item = plan.items[i];
    if (item.type !== 'message') continue;
    if (!String(item.text || '').trim()) continue;                    // 留空的消息自动跳过
    const delay = effLimit(item, 'delay', plan.timing);
    const visibleAt = delay > 0 ? new Date(nowMs + delay * 1000).toISOString() : null;
    // 呈现节奏：题目覆盖优先，否则用问卷默认；存到消息上，延迟消息经 bootstrap 拉取时也不丢
    const rhythm = {
      thinkMs: effLimit(item, 'thinkMs', plan.timing),
      typeMs: effLimit(item, 'typeMs', plan.timing)
    };
    emitted.push(store.addMessage(session.id, 'assistant', item.text, visibleAt, rhythm));
  }
  return emitted;
}

// 作答单元的呈现时刻 = max(上一条作答完成时间, 最近一条消息的可见时刻, 现在)
function presentedAtFor(session, plan, completedCount, nowMs) {
  const prev = completedCount > 0 ? store.unitFirstResponse(session.id, completedCount - 1) : null;
  const prevMs = prev && prev.answered_at ? Date.parse(prev.answered_at) : Date.parse(session.started_at);
  const msgAt = store.latestMessageAt(session.id);
  const msgMs = msgAt ? Date.parse(msgAt) : 0;
  let ms = Math.max(
    Number.isFinite(prevMs) ? prevMs : nowMs,
    Number.isFinite(msgMs) ? msgMs : 0,
    nowMs
  );
  if (!Number.isFinite(ms)) ms = nowMs;
  return new Date(ms).toISOString();
}

// 共用窗口：相邻且「最短提交 / 最长作答」设置相同的作答题目共用一个起点
function windowStartFor(session, plan, completedCount, presentedIso) {
  const units = plan.units;
  const sig = (item) => `${item.limits.minSubmit ?? ''}|${item.limits.maxAnswer ?? ''}`;
  const curSig = sig(units[completedCount].item);
  let runStart = completedCount;
  while (runStart > 0 && sig(units[runStart - 1].item) === curSig) runStart -= 1;
  if (runStart < completedCount) {
    const first = store.unitFirstResponse(session.id, runStart);
    if (first && first.presented_at) return { startMs: Date.parse(first.presented_at), shared: true };
  }
  return { startMs: Date.parse(presentedIso), shared: runStart < completedCount };
}

// 当前待作答单元 → 操作负载（不下发正确答案，避免泄露）
function computeAction(session, plan, completedCount, nowMs) {
  const units = plan.units;
  if (completedCount >= units.length) return null;
  const unit = units[completedCount];
  const item = unit.item;
  const presentedIso = session.pending_presented_at || presentedAtFor(session, plan, completedCount, nowMs);
  const presentedMs = Date.parse(presentedIso);

  const wait = effLimit(item, 'wait', plan.timing);
  const minSubmit = effLimit(item, 'minSubmit', plan.timing);
  const maxAnswer = effLimit(item, 'maxAnswer', plan.timing);
  let minSubmitAtMs = 0;
  let deadlineMs = 0;
  let sharedWindow = false;
  if (minSubmit > 0 || maxAnswer > 0) {
    const win = windowStartFor(session, plan, completedCount, presentedIso);
    sharedWindow = win.shared;
    if (minSubmit > 0) minSubmitAtMs = win.startMs + minSubmit * 1000;
    if (maxAnswer > 0) deadlineMs = win.startMs + maxAnswer * 1000;
  }

  const base = {
    itemId: item.id,
    itemIndex: unit.index,
    type: item.type,
    title: item.title,
    availableAtMs: wait > 0 ? presentedMs + wait * 1000 : 0,
    minSubmitAtMs,
    deadlineMs,
    sharedWindow,
    nowMs
  };

  if (item.type === 'rating') {
    const min = Number(item.min) || 1;
    const max = Number(item.max) || 5;
    return {
      ...base,
      min,
      max,
      anchor: item.anchor || '',
      options: Array.from({ length: max - min + 1 }, (_, i) => ({ value: min + i, label: String(min + i) }))
    };
  }
  if (item.type === 'single' || item.type === 'multi') {
    return { ...base, options: (item.options || []).map((t, i) => ({ value: i + 1, label: `${OPTION_LETTERS[i]}．${t}` })) };
  }
  if (item.type === 'rank') {
    return { ...base, options: (item.options || []).map((t, i) => ({ value: i + 1, label: t })) };
  }
  if (item.type === 'text') {
    return {
      ...base,
      required: item.required !== false,
      rows: Number(item.rows) || 1,
      maxLen: Number(item.maxLen) || 0,
      placeholder: item.placeholder || ''
    };
  }
  if (item.type === 'group') {
    // 题组：一次呈现多道子题、一次提交
    return {
      ...base,
      text: item.text || '',
      layout: item.layout === 'row' ? 'row' : 'column',
      subs: (item.subs || []).map((sub, i) => ({
        index: i,
        type: sub.type,
        title: sub.title,
        required: sub.required !== false,
        rows: Number(sub.rows) || 1,
        maxLen: Number(sub.maxLen) || 0,
        placeholder: sub.placeholder || '',
        min: Number(sub.min) || 1,
        max: Number(sub.max) || 5,
        anchor: sub.anchor || '',
        options: (sub.options || []).map((t, k) => ({ value: k + 1, label: `${OPTION_LETTERS[k]}．${t}` }))
      }))
    };
  }
  if (item.type === 'gate') return { ...base, text: item.text || '', check: item.check || '', button: item.button || '开始实验' };
  if (item.type === 'debrief') return { ...base, text: item.text || '', button: '我已阅读' };
  return base;
}

function sessionBrief(session) {
  return {
    id: session.id,
    uid: session.seq == null ? '' : String(session.seq),
    seq: session.seq == null ? null : Number(session.seq),
    status: session.status
  };
}

function sessionPayload(session) {
  const plan = parseSession(session);
  const completedCount = store.countAnswerUnits(session.id);
  const nowIsoStr = new Date().toISOString();
  return {
    session: sessionBrief(session),
    messages: store.listVisibleMessages(session.id, nowIsoStr),
    action: session.status === 'completed' ? null : computeAction(session, plan, completedCount, Date.now()),
    pendingAt: store.nextPendingVisibleAt(session.id, nowIsoStr),
    nowMs: Date.now(),
    totalItems: plan.items.length,
    totalAnswers: plan.units.length,
    answeredCount: completedCount
  };
}

// ---------------------------------------------------------------- 被试端 API

// GET /api/bootstrap?q=<短码>&session=<会话id>
function handleBootstrap(req, res, url) {
  const code = (url.searchParams.get('q') || '').trim();
  const sid = (url.searchParams.get('session') || '').trim();
  const questionnaire = store.getQuestionnairePayload(code, { withItems: false });
  if (!questionnaire) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在或链接已失效' });
  }
  let session = sid ? store.getSession(sid) : null;
  if (session && session.questionnaire_id !== code) session = null;                 // 防止跨问卷串数据
  if (session && session.status === 'in_progress') {
    const hours = store.getResumeWindowHours();                                     // 中途退出保留：超出恢复窗口则重新开始
    const startedMs = Date.parse(session.started_at);
    if (hours && Number.isFinite(startedMs) && Date.now() - startedMs > hours * 3600 * 1000) session = null;
  }
  if (!session) {
    return sendJson(res, 200, {
      questionnaireTitle: questionnaire.title,
      session: null, messages: [], action: null, pendingAt: null, nowMs: Date.now()
    });
  }
  sendJson(res, 200, { questionnaireTitle: questionnaire.title, ...sessionPayload(session) });
}

// POST /api/session { q }
async function handleCreateSession(req, res) {
  const body = await readJsonBody(req);
  const code = String(body.q || '').trim();
  const questionnaire = store.getQuestionnairePayload(code);
  if (!questionnaire) return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在或链接已失效' });
  if (!questionnaire.items.length) return sendJson(res, 400, { error: 'empty_items', message: '该问卷尚未配置题目，请联系研究人员' });

  const seq = store.nextSessionSeq(code);
  const session = store.createSession({
    questionnaireId: code,
    seq,
    items: questionnaire.items,
    timing: questionnaire.timing,
    userAgent: req.headers['user-agent'] || ''
  });

  const plan = parseSession(session);
  const nowMs = Date.now();
  emitMessagesBetween(session, plan, 0, nowMs);
  store.setPendingPresentedAt(session.id, presentedAtFor(session, plan, 0, nowMs));

  sendJson(res, 200, { questionnaireTitle: questionnaire.title, ...sessionPayload(store.getSession(session.id)) });
}

// 校验并归一化作答值
function validateAnswer(item, body, deadlinePassed = false) {
  switch (item.type) {
    case 'gate':
      if (body.consent !== true) return { error: '请先勾选同意后再开始' };
      return { value: null, valueText: '', optionLabel: '已同意并开始' };
    case 'debrief':
      if (body.ack !== true) return { error: '请阅读后继续' };
      return { value: null, valueText: '', optionLabel: '已阅读结束说明' };
    case 'rating': {
      const min = Number(item.min) || 1;
      const max = Number(item.max) || 5;
      const v = Number(body.value);
      if (!Number.isInteger(v) || v < min || v > max) return { error: '作答值不合法' };
      return { value: v, valueText: '', optionLabel: `${v} 分` };
    }
    case 'single': {
      const v = Number(body.value);
      const n = (item.options || []).length;
      if (!Number.isInteger(v) || v < 1 || v > n) return { error: '作答值不合法' };
      return { value: v, valueText: '', optionLabel: optionLabelOf(item, v) };
    }
    case 'multi': {
      const raw = Array.isArray(body.values) ? body.values.map(Number) : [];
      const n = (item.options || []).length;
      if (!raw.length) return { error: '请至少选择一项' };
      if (raw.some((v) => !Number.isInteger(v) || v < 1 || v > n)) return { error: '作答值不合法' };
      const uniq = [...new Set(raw)].sort((a, b) => a - b);
      return {
        value: uniq[0],
        valueText: JSON.stringify(uniq),
        optionLabel: uniq.map((v) => optionLabelOf(item, v)).join('、')
      };
    }
    case 'rank': {
      const order = Array.isArray(body.order) ? body.order.map(Number) : [];
      const n = (item.options || []).length;
      if (order.length !== n || new Set(order).size !== n || order.some((v) => !Number.isInteger(v) || v < 1 || v > n)) {
        return { error: '请完成完整排序' };
      }
      return {
        value: order[0],
        valueText: JSON.stringify(order),
        optionLabel: order.map((v, i) => `${i + 1}. ${(item.options || [])[v - 1]}`).join('  ')
      };
    }
    case 'text': {
      const text = String(body.text ?? '').trim();
      const maxLen = Number(item.maxLen) || 0;
      if (item.required !== false && !text && !deadlinePassed) return { error: '请填写内容后再提交' };
      if (maxLen > 0 && text.length > maxLen) return { error: `字数不能超过 ${maxLen} 字` };
      return { value: null, valueText: JSON.stringify({ text }), optionLabel: text };
    }
    case 'group': {
      const subs = item.subs || [];
      if (!subs.length) return { error: '题组未配置子题' };
      const raw2 = Array.isArray(body.answers) ? body.answers : [];
      const rows = [];
      for (let i = 0; i < subs.length; i += 1) {
        const sub = subs[i];
        // 子题按各自题型校验（复用同一套规则）
        const one = validateAnswer(sub, raw2[i] && typeof raw2[i] === 'object' ? raw2[i] : {}, deadlinePassed);
        if (one.error) {
          if (!deadlinePassed) {
            return { error: `${sub.title || `子题 ${i + 1}`}：${one.error}` };
          }
          rows.push({ value: null, valueText: JSON.stringify({ text: '' }), optionLabel: '（时间已到，未填写内容）' });
          continue;
        }
        rows.push({ value: one.value, valueText: one.valueText, optionLabel: one.optionLabel });
      }
      return { group: rows };
    }
    default:
      return { error: '不支持的题型' };
  }
}

// POST /api/step { sessionId, ...作答 }
async function handleStep(req, res) {
  const body = await readJsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  if (!sessionId) return sendJson(res, 400, { error: 'bad_request', message: '缺少 sessionId' });

  const session = store.getSession(sessionId);
  if (!session) return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });
  if (session.status !== 'in_progress') return sendJson(res, 409, { error: 'session_closed', message: '会话已结束' });

  const plan = parseSession(session);
  const completedCount = store.countAnswerUnits(session.id);
  const unit = plan.units[completedCount];
  if (!unit) return sendJson(res, 409, { error: 'session_closed', message: '会话已结束' });
  const item = unit.item;
  const now = new Date();
  const nowMs = now.getTime();

  const action = computeAction(session, plan, completedCount, nowMs);
  if (action.availableAtMs && nowMs < action.availableAtMs) {
    return sendJson(res, 400, { error: 'too_early', message: '请先完整阅读内容', availableAtMs: action.availableAtMs, nowMs });
  }
  if (action.minSubmitAtMs && nowMs < action.minSubmitAtMs) {
    return sendJson(res, 400, { error: 'too_early', message: '还未到可提交时间', availableAtMs: action.minSubmitAtMs, nowMs });
  }

  // 到点自动提交：超过最长作答时间后允许文本题为空
  const deadlinePassed = !!(action.deadlineMs && nowMs >= action.deadlineMs);
  const check = validateAnswer(item, body, deadlinePassed);
  if (check.error) {
    return sendJson(res, 400, { error: 'invalid_answer', message: check.error });
  }

  const elapsedMs = Number.isFinite(Number(body.elapsedMs))
    ? Math.min(Math.max(Math.round(Number(body.elapsedMs)), 0), 24 * 3600 * 1000)
    : null;
  const presentedAt = session.pending_presented_at || new Date(nowMs).toISOString();

  // 回显：题组逐子题列出，其余按题型单行
  let echo;
  if (item.type === 'group') {
    echo = check.group
      .map((row, i) => `${(item.subs[i] || {}).title || `子题 ${i + 1}`}：${row.optionLabel || '（未填写）'}`)
      .join('\n');
  } else if (item.type === 'text') {
    echo = `我的回答：「${check.optionLabel}」`;
  } else if (item.type === 'gate' || item.type === 'debrief') {
    echo = check.optionLabel;
  } else {
    echo = `我的选择：${check.optionLabel}`;
  }
  const userMessage = store.addMessage(sessionId, 'user', echo);

  // 落库：题组一次提交写入多行（同一 unit_index，sub_index 区分）
  const rows = item.type === 'group'
    ? check.group.map((row, i) => ({ itemType: (item.subs[i] || {}).type || 'text', subIndex: i, ...row }))
    : [{ itemType: item.type, subIndex: 0, value: check.value, valueText: check.valueText, optionLabel: check.optionLabel }];
  const answeredAt = now.toISOString();
  for (const row of rows) {
    store.addResponse({
      sessionId,
      itemId: item.id,
      itemIndex: unit.index,
      itemType: row.itemType,
      unitIndex: completedCount,
      subIndex: row.subIndex,
      value: row.value,
      valueText: row.valueText,
      optionLabel: row.optionLabel,
      presentedAt,
      answeredAt,
      elapsedMs
    });
  }

  const nextCount = completedCount + 1;
  const emitted = emitMessagesBetween(session, plan, nextCount, nowMs);
  const nowIsoStr = now.toISOString();
  const messages = emitted.filter((m) => !m.visible_at || m.visible_at <= nowIsoStr);

  let completed = false;
  if (nextCount >= plan.units.length) {
    store.setPendingPresentedAt(sessionId, null);
    store.finishSession(sessionId);
    completed = true;
  } else {
    store.setPendingPresentedAt(sessionId, presentedAtFor(store.getSession(sessionId), plan, nextCount, nowMs));
  }

  const updated = store.getSession(sessionId);
  const nextPlan = parseSession(updated);
  sendJson(res, 200, {
    userMessage,
    messages,
    action: completed ? null : computeAction(updated, nextPlan, nextCount, Date.now()),
    pendingAt: store.nextPendingVisibleAt(sessionId, nowIsoStr),
    nowMs: Date.now(),
    session: sessionBrief(updated),
    answeredCount: nextCount,
    totalAnswers: plan.units.length
  });
}

// POST /api/finish { sessionId } —— 提前结束（备用）
async function handleFinish(req, res) {
  const body = await readJsonBody(req);
  const session = store.finishSession(String(body.sessionId || '').trim());
  if (!session) return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });
  sendJson(res, 200, { session: { id: session.id, status: session.status, duration_sec: session.duration_sec } });
}

// ---------------------------------------------------------------- 鉴权（用户账号）
const TOKEN_TTL = 24 * 60 * 60 * 1000;
const tokens = new Map(); // token -> { userId, expiresAt }

function issueToken(user) {
  const token = randomUUID();
  tokens.set(token, { userId: user.id, expiresAt: Date.now() + TOKEN_TTL });
  return token;
}

function revokeToken(token) {
  tokens.delete(token);
}

// 返回当前登录用户；未登录 / 过期则已发送 401 并返回 null
function requireUser(req, res) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const hit = tokens.get(token);
  if (!token || !hit || hit.expiresAt < Date.now()) {
    tokens.delete(token);
    sendJson(res, 401, { error: 'unauthorized', message: '登录已失效，请重新登录' });
    return null;
  }
  const user = store.getUser(hit.userId);
  if (!user) {
    tokens.delete(token);
    sendJson(res, 401, { error: 'unauthorized', message: '账号不存在，请重新登录' });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendJson(res, 403, { error: 'forbidden', message: '需要管理员权限' });
    return null;
  }
  return user;
}

// 数据按创建者完全隔离：每个账号（含管理员）只能看到和操作自己创建的实验 / 问卷
function canAccess(user, row) {
  return !!row && row.owner_id === user.id;
}

async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  try {
    const user = store.createUser({ username: body.username, password: body.password, role: 'user' });
    sendJson(res, 200, { token: issueToken(user), user: { id: user.id, username: user.username, role: user.role, avatar: user.avatar } });
  } catch (err) {
    sendJson(res, 400, { error: 'register_failed', message: err.message || '注册失败' });
  }
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const user = store.getUserByName(body.username);
  if (!user || !store.verifyPassword(user, String(body.password || ''))) {
    return sendJson(res, 401, { error: 'bad_credentials', message: '账号或密码不正确' });
  }
  sendJson(res, 200, { token: issueToken(user), user: { id: user.id, username: user.username, role: user.role, avatar: user.avatar } });
}

async function handleLogout(req, res) {
  revokeToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim());
  sendJson(res, 200, { ok: true });
}

function handleMe(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, { user: { id: user.id, username: user.username, role: user.role, avatar: user.avatar } });
}

async function handleChangePassword(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  if (!store.verifyPassword(user, String(body.oldPassword || ''))) {
    return sendJson(res, 400, { error: 'bad_password', message: '当前密码不正确' });
  }
  try {
    store.updateUserPassword(user.id, String(body.newPassword || ''));
  } catch (err) {
    return sendJson(res, 400, { error: 'bad_password', message: err.message || '密码修改失败' });
  }
  sendJson(res, 200, { ok: true });
}

async function handleAvatar(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const avatar = String(body.avatar || '');
  if (avatar && !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(avatar)) {
    return sendJson(res, 400, { error: 'bad_avatar', message: '仅支持图片文件' });
  }
  if (avatar.length > 600 * 1024) {
    return sendJson(res, 400, { error: 'avatar_too_large', message: '图片过大，请换一张较小的图片' });
  }
  store.updateUser(user.id, { avatar });
  sendJson(res, 200, { avatar });
}

// ---------------------------------------------------------------- 用户管理（管理员）
function handleUsersList(req, res) {
  const user = requireAdmin(req, res);
  if (!user) return;
  sendJson(res, 200, { users: store.listUsers() });
}

async function handleUserCreate(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = await readJsonBody(req);
  try {
    sendJson(res, 200, { user: store.createUser(body) });
  } catch (err) {
    sendJson(res, 400, { error: 'user_create_failed', message: err.message || '创建失败' });
  }
}

async function handleUserUpdate(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = await readJsonBody(req);
  const target = store.getUser(String(body.id || '').trim());
  if (!target) return sendJson(res, 404, { error: 'user_not_found', message: '用户不存在' });
  try {
    sendJson(res, 200, { user: store.updateUser(target.id, body) });
  } catch (err) {
    sendJson(res, 400, { error: 'user_update_failed', message: err.message || '修改失败' });
  }
}

async function handleUserDelete(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = await readJsonBody(req);
  const id = String(body.id || '').trim();
  if (id === admin.id) return sendJson(res, 400, { error: 'self_delete', message: '不能删除自己的账号' });
  const result = store.deleteUser(id);
  if (!result.ok) return sendJson(res, 404, { error: 'user_not_found', message: '用户不存在' });
  sendJson(res, 200, { ok: true });
}

// GET /api/admin/meta —— 编辑器元信息（题型 / 限制 / 默认题目 / 设置）
function handleAdminMeta(req, res) {
  if (!requireUser(req, res)) return;
  sendJson(res, 200, {
    itemTypes: store.ITEM_TYPES,
    itemTypeLabels: store.ITEM_TYPE_LABELS,
    itemLimits: store.ITEM_LIMITS,
    timingKeys: store.TIMING_KEYS,
    timingMeta: store.TIMING_META,
    itemDefaults: store.itemDefaults(),
    defaultQuestionnaireItems: store.defaultQuestionnaireItems(),
    resumeWindowHours: store.getResumeWindowHours()
  });
}

function handleAdminGetSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { settings: { resumeWindowHours: store.getResumeWindowHours() } });
}

async function handleAdminSaveSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);
  if (body.resumeWindowHours != null) store.setResumeWindowHours(body.resumeWindowHours);
  sendJson(res, 200, { settings: { resumeWindowHours: store.getResumeWindowHours() } });
}

// ---------------------------------------------------------------- 实验模板库（按创建者隔离）
function handleAdminExperiments(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, { experiments: store.listExperiments(user.id) });
}

function handleAdminExperiment(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const experiment = store.getExperiment((url.searchParams.get('id') || '').trim());
  if (!experiment || !canAccess(user, experiment)) {
    return sendJson(res, 404, { error: 'experiment_not_found', message: '实验不存在' });
  }
  sendJson(res, 200, { experiment: store.getExperimentPayload(experiment.id) });
}

async function handleAdminExperimentCreate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: 'bad_name', message: '实验名称不能为空' });
  const copyFrom = String(body.copyFrom || '').trim();
  if (copyFrom) {
    const source = store.getExperiment(copyFrom);
    if (!source || !canAccess(user, source)) {
      return sendJson(res, 400, { error: 'copy_source_not_found', message: '复制来源实验不存在' });
    }
  }
  sendJson(res, 200, { experiment: store.createExperiment({ name, copyFrom: copyFrom || null, ownerId: user.id }) });
}

async function handleAdminExperimentUpdate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const experiment = store.getExperiment(String(body.id || '').trim());
  if (!experiment || !canAccess(user, experiment)) {
    return sendJson(res, 404, { error: 'experiment_not_found', message: '实验不存在' });
  }
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: 'bad_name', message: '实验名称不能为空' });
  sendJson(res, 200, { experiment: store.updateExperiment(experiment.id, { name, timing: body.timing, items: body.items }) });
}

async function handleAdminExperimentDelete(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const experiment = store.getExperiment(String(body.id || '').trim());
  if (!experiment || !canAccess(user, experiment)) {
    return sendJson(res, 404, { error: 'experiment_not_found', message: '实验不存在' });
  }
  store.deleteExperiment(experiment.id);
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- 问卷（按创建者隔离）
function handleAdminQuestionnaires(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, { questionnaires: store.listQuestionnaires(user.id) });
}

function handleAdminQuestionnaire(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const questionnaire = store.getQuestionnaire((url.searchParams.get('id') || '').trim());
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  sendJson(res, 200, { questionnaire: store.getQuestionnairePayload(questionnaire.id) });
}

async function handleAdminQuestionnaireCreate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const title = String(body.title || '').trim();
  if (!title) return sendJson(res, 400, { error: 'bad_title', message: '问卷名称不能为空' });
  const copyFrom = String(body.copyFrom || '').trim();
  if (copyFrom) {
    const source = store.getQuestionnaire(copyFrom);
    if (!source || !canAccess(user, source)) {
      return sendJson(res, 400, { error: 'copy_source_not_found', message: '复制来源问卷不存在' });
    }
    const copied = store.copyQuestionnaire(copyFrom, title, user.id);
    if (!copied) return sendJson(res, 400, { error: 'copy_source_not_found', message: '复制来源问卷不存在' });
    return sendJson(res, 200, { questionnaire: copied });
  }
  sendJson(res, 200, { questionnaire: store.createQuestionnaire({ title, timing: body.timing, items: body.items, ownerId: user.id }) });
}

async function handleAdminQuestionnaireUpdate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const questionnaire = store.getQuestionnaire(String(body.id || '').trim());
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const title = String(body.title || '').trim();
  if (!title) return sendJson(res, 400, { error: 'bad_title', message: '问卷名称不能为空' });
  sendJson(res, 200, { questionnaire: store.updateQuestionnaire(questionnaire.id, { title, timing: body.timing, items: body.items }) });
}

async function handleAdminQuestionnaireDelete(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const questionnaire = store.getQuestionnaire(String(body.id || '').trim());
  if (!questionnaire || !canAccess(user, questionnaire)) {
    if (questionnaire) return sendJson(res, 403, { error: 'forbidden', message: '无权删除该问卷' });
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const result = store.deleteQuestionnaire(questionnaire.id, { force: !!body.force });
  if (!result.ok) {
    if (result.reason === 'not_found') return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
    return sendJson(res, 400, {
      error: 'has_sessions',
      message: `该问卷已有 ${result.sessionCount} 份被试数据，删除将一并清空，请确认`,
      sessionCount: result.sessionCount
    });
  }
  sendJson(res, 200, { ok: true });
}

// 作答原子：把题目展开为「一个可作答项」（题组的子题逐个展开，键为 题目id#子题序号）
function answerAtoms(items) {
  const atoms = [];
  let lastMessageTitle = '';
  const textSeen = new Map();
  for (const it of items) {
    if (it.type === 'message') { lastMessageTitle = it.title || ''; continue; }
    const subs = it.type === 'group' ? (it.subs || []) : null;
    const list = subs || [it];
    list.forEach((sub, si) => {
      const key = `${it.id}#${si}`;
      const isScale = sub.type === 'rating';
      let label;
      if (isScale) {
        const m = String(sub.id || '').match(/^(.*)_(\d+)$/);
        const idx = m ? Number(m[2]) : si + 1;
        label = `${lastMessageTitle || sub.title || it.title} 第 ${idx} 题`;
      } else if (sub.type === 'text') {
        const base = subs ? `${it.title} · ${sub.title}` : (sub.title || it.id);
        const n = (textSeen.get(base) || 0) + 1;
        textSeen.set(base, n);
        label = n > 1 ? `${base}（第 ${n} 次）` : base;
      } else {
        label = subs ? `${it.title} · ${sub.title}` : (sub.title || it.id);
      }
      atoms.push({
        item: it,
        sub: subs ? sub : null,
        subIndex: subs ? si : 0,
        key,
        type: sub.type,
        label,
        scalePrefix: isScale ? String(sub.id || '').replace(/_\d+$/, '') : '',
        scaleName: isScale ? (lastMessageTitle || sub.title || it.title) : ''
      });
    });
  }
  return atoms;
}

function itemLabelMap(items) {
  const map = new Map();
  for (const a of answerAtoms(items)) map.set(a.key, a.label);
  for (const it of items) if (it.type === 'message') map.set(`${it.id}#0`, it.title || it.id);
  return map;
}

// 量表列：同一量表前缀取首个打分题的名称（沿用指导语消息标题）
function scaleColumns(items) {
  const out = [];
  const seen = new Set();
  for (const a of answerAtoms(items)) {
    if (a.type !== 'rating' || seen.has(a.scalePrefix)) continue;
    seen.add(a.scalePrefix);
    out.push({ prefix: a.scalePrefix, name: a.scaleName || a.scalePrefix });
  }
  return out;
}

function textColumns(items) { return answerAtoms(items).filter((a) => a.type === 'text'); }
function choiceColumns(items) { return answerAtoms(items).filter((a) => a.type === 'single' || a.type === 'multi'); }

// GET /api/admin/questionnaire/sessions?id=
function handleAdminQuestionnaireSessions(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const id = (url.searchParams.get('id') || '').trim();
  const questionnaire = store.getQuestionnaire(id);
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const payload = store.getQuestionnairePayload(id);

  // 可作答题目数（消息类只呈现，不计入作答进度）
  const answerable = payload.itemCount - payload.items.filter((it) => it.type === 'message').length;

  const counts = new Map();
  for (const r of store.listResponseRows(id)) counts.set(r.session_id, (counts.get(r.session_id) || 0) + 1);

  const sessions = store.listSessionSummaries(id).map((s) => ({
    id: s.id,
    seq: s.seq == null ? null : Number(s.seq),
    status: s.status,
    statusLabel: STATUS_LABELS[s.status] || s.status,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    durationSec: s.duration_sec == null ? null : Number(s.duration_sec),
    answerCount: counts.get(s.id) || 0
  }));

  sendJson(res, 200, {
    questionnaire: payload,
    sessions,
    sessionCount: sessions.length,
    answerable
  });
}

// POST /api/admin/questionnaire/sessions/delete { id, ids }
async function handleAdminSessionsDelete(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const id = String(body.id || '').trim();
  const questionnaire = store.getQuestionnaire(id);
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const result = store.deleteSessions(id, body.ids);
  sendJson(res, 200, { ok: true, deleted: result.deleted });
}

// GET /api/admin/questionnaire/session?id=&sid=
function handleAdminQuestionnaireSession(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const id = (url.searchParams.get('id') || '').trim();
  const sid = (url.searchParams.get('sid') || '').trim();
  const questionnaire = store.getQuestionnaire(id);
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const session = store.getSession(sid);
  if (!session || session.questionnaire_id !== id) return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });

  const items = store.normalizeItems(JSON.parse(session.items_json || '[]'));
  const atoms = answerAtoms(items);
  const atomByKey = new Map(atoms.map((a) => [a.key, a]));
  const labels = itemLabelMap(items);

  sendJson(res, 200, {
    questionnaire: store.getQuestionnairePayload(id, { withItems: false }),
    session: {
      id: session.id,
      seq: session.seq == null ? null : Number(session.seq),
      status: session.status,
      statusLabel: STATUS_LABELS[session.status] || session.status,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      durationSec: session.duration_sec == null ? null : Number(session.duration_sec),
      userAgent: session.user_agent,
      totalAnswers: items.filter((it) => it.type !== 'message').length
    },
    messages: store.listMessages(session.id),
    responses: store.listResponses(session.id).map((r) => {
      const atom = atomByKey.get(`${r.item_id}#${r.sub_index || 0}`);
      const correct = atom && atom.type === 'single' ? Number(atom.sub ? atom.sub.correct : atom.item.correct) || 0 : 0;
      return {
        id: r.id,
        itemId: r.item_id,
        itemType: r.item_type,
        itemTypeLabel: store.ITEM_TYPE_LABELS[r.item_type] || r.item_type,
        itemLabel: labels.get(`${r.item_id}#${r.sub_index || 0}`) || r.item_id,
        value: r.value,
        text: r.item_type === 'text' ? textOf(r.value_text) : '',
        optionLabel: r.option_label,
        isCorrect: correct ? (Number(r.value) === correct ? '正确' : '错误') : '',
        presentedAt: r.presented_at,
        answeredAt: r.answered_at,
        elapsedMs: r.elapsed_ms
      };
    })
  });
}

// GET /api/admin/questionnaire/export.xlsx?id=
function handleAdminQuestionnaireExport(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const id = (url.searchParams.get('id') || '').trim();
  const questionnaire = store.getQuestionnaire(id);
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const payload = store.getQuestionnairePayload(id);

  const items = payload.items;
  const labels = itemLabelMap(items);

  const ratingPrefixes = scaleColumns(items);
  const textItems = textColumns(items);
  const choiceItems = choiceColumns(items);

  // ---- sheet 1：汇总（一被试一行）
  const summaries = store.listQuestionnaireSummaryRows(id);
  const summaryColumns = [
    { title: '被试编号', width: 10 },
    { title: '状态', width: 10 },
    { title: '开始时间', width: 20 },
    { title: '结束时间', width: 20 },
    { title: '时长（秒）', width: 11 },
    ...ratingPrefixes.map((s) => ({ title: `${s.name}（均分）`, width: 18 })),
    ...textItems.flatMap((c) => [
      { title: c.label, width: 30 },
      { title: `${c.label}·作答时间`, width: 20 },
      { title: `${c.label}·耗时（秒）`, width: 16 }
    ]),
    ...choiceItems.flatMap((c) => {
      const cols = [{ title: c.label, width: 26 }];
      const correct = c.sub ? c.sub.correct : c.item.correct;
      if (c.type === 'single' && Number(correct)) cols.push({ title: `${c.label}·是否正确`, width: 16 });
      cols.push({ title: `${c.label}·耗时（秒）`, width: 16 });
      return cols;
    })
  ];
  const sec = (ms) => (ms == null ? '' : Math.round(Number(ms) / 100) / 10);
  const summaryRows = summaries.map((s) => {
    const out = [
      s.seq == null ? '' : s.seq,
      STATUS_LABELS[s.status] || s.status || '',
      fmtLocal(s.startedAt),
      fmtLocal(s.endedAt),
      s.durationSec == null ? '' : s.durationSec
    ];
    for (const sp of ratingPrefixes) {
      const acc = s.scales.get(sp.prefix);
      out.push(acc && acc.n ? Math.round((acc.sum / acc.n) * 100) / 100 : '');
    }
    for (const c of textItems) {
      const t = s.texts.get(c.key);
      out.push(t ? t.text : '', t ? fmtLocal(t.answeredAt) : '', t ? sec(t.elapsedMs) : '');
    }
    for (const col of choiceItems) {
      const c = s.choices.get(col.key);
      const correct = col.sub ? col.sub.correct : col.item.correct;
      out.push(c ? c.label : '');
      if (col.type === 'single' && Number(correct)) {
        out.push(c ? (Number(c.value) === Number(correct) ? '正确' : '错误') : '');
      }
      out.push(c ? sec(c.elapsedMs) : '');
    }
    return out;
  });

  // ---- sheet 2：作答明细
  const detailRows = store.listResponseRows(id).map((r) => [
    r.seq == null ? '' : Number(r.seq),
    STATUS_LABELS[r.session_status] || r.session_status || '',
    labels.get(`${r.item_id}#${r.sub_index || 0}`) || r.item_id,
    store.ITEM_TYPE_LABELS[r.item_type] || r.item_type,
    r.value == null ? '' : Number(r.value),
    (r.item_type === 'text' ? textOf(r.value_text) : '') || r.option_label || '',
    fmtLocal(r.presented_at),
    fmtLocal(r.answered_at),
    sec(r.elapsed_ms)
  ]);

  const sheets = [
    { name: '汇总（一被试一行）', columns: summaryColumns, rows: summaryRows },
    {
      name: '作答明细',
      columns: [
        { title: '被试编号', width: 10 },
        { title: '状态', width: 10 },
        { title: '题目', width: 34 },
        { title: '题型', width: 12 },
        { title: '作答值', width: 9 },
        { title: '作答文本 / 选项', width: 40 },
        { title: '呈现时间', width: 20 },
        { title: '作答时间', width: 20 },
        { title: '耗时（秒）', width: 11 }
      ],
      rows: detailRows
    }
  ];

  const fileName = `${payload.title}.xlsx`;
  const buf = buildXlsx(sheets);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="questionnaire-${id}.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  });
  res.end(buf);
}

// ---------------------------------------------------------------- 局域网预实验 · 连接页与二维码

// 枚举本机局域网 IPv4：排除回环/链路本地（169.254.*）与重复项，
// 常见私网网段优先（192.168 > 10 > 172.16-31），用于手机同 WiFi 直连。
function lanAddresses() {
  const seen = new Set();
  const list = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const ni of ifaces || []) {
      if (ni.family !== 'IPv4' || ni.internal || seen.has(ni.address)) continue;
      seen.add(ni.address);
      if (/^169\.254\./.test(ni.address)) continue;
      list.push(ni.address);
    }
  }
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return list.sort((a, b) => rank(a) - rank(b));
}

function entryUrl(ip) {
  return `http://${ip || 'localhost'}:${PORT}/`;
}

function makeQr(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr;
}

function qrSvgFor(text, cellSize = 6, margin = 2) {
  return makeQr(text).createSvgTag({ cellSize, margin, scalable: true });
}

// 控制台二维码：用半块字符（▀▄█）把两个模块行压进一个字符行，宽度翻倍近似方比例
function qrAsciiFor(text) {
  const qr = makeQr(text);
  const n = qr.getModuleCount();
  const quiet = 2;
  const total = n + quiet * 2;
  const dark = (x, y) => x >= quiet && x < quiet + n && y >= quiet && y < quiet + n && qr.isDark(y - quiet, x - quiet);
  const lines = [];
  for (let y = 0; y < total; y += 2) {
    let line = '';
    for (let x = 0; x < total; x++) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      line += top && bottom ? '██' : top ? '▀▀' : bottom ? '▄▄' : '  ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function buildConnectHtml() {
  const urls = lanAddresses().map(entryUrl);
  const primary = urls[0] || entryUrl('');
  const altItems = urls.slice(1).map((u) => `<li><code>${u}</code></li>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>手机连接 · 预实验入口</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; min-height: 100vh; display: flex; justify-content: center; padding: 32px 16px; }
  .card { background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(31,35,41,.08);
          max-width: 420px; width: 100%; padding: 32px 24px; height: fit-content; }
  h1 { font-size: 20px; text-align: center; margin-bottom: 4px; }
  .sub { text-align: center; color: #86909c; font-size: 13px; margin-bottom: 20px; }
  .qr { display: flex; justify-content: center; margin: 8px 0 16px; }
  .qr svg { width: 240px; height: 240px; }
  .url { text-align: center; margin-bottom: 20px; }
  .url code { background: #f2f3f5; border-radius: 8px; padding: 8px 14px; font-size: 15px; word-break: break-all; }
  h2 { font-size: 14px; margin: 16px 0 8px; color: #4e5969; }
  ul.tips { list-style: none; }
  ul.tips li { font-size: 13px; color: #4e5969; line-height: 1.7; padding-left: 18px; position: relative; }
  ul.tips li::before { content: "·"; position: absolute; left: 6px; font-weight: 700; }
  .alt { font-size: 12px; color: #86909c; margin-top: 4px; }
  .admin { margin-top: 20px; padding-top: 16px; border-top: 1px solid #e5e6eb; font-size: 12px; color: #86909c; text-align: center; }
  .admin a { color: #165dff; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">
    <h1>手机扫码进入实验</h1>
    <p class="sub">请确保手机与这台电脑连接同一个 WiFi（或电脑开的热点）</p>
    <div class="qr">${qrSvgFor(primary)}</div>
    <div class="url"><code>${primary}</code></div>
    <ul class="tips">
      <li>用手机「相机」扫码，选择浏览器打开；微信扫一扫若无法打开，请改用相机。</li>
      <li>打不开时检查：手机是否在用流量（需关闭并连 WiFi）；路由器是否开启了「AP 隔离」。</li>
      <li>没有共同 WiFi 时：电脑开启「移动热点」，手机连上热点后再扫码即可。</li>
      ${altItems ? `<li>若上方地址无法访问，可尝试备选地址：<ul class="alt">${altItems}</ul></li>` : ''}
    </ul>
    <div class="admin">电脑端编辑/数据入口：<a href="/admin">http://localhost:${PORT}/admin</a>（本机打开）</div>
  </div>
</body>
</html>`;
}

function handleConnect(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(buildConnectHtml());
}

function handleQrSvg(res, url) {
  const target = (url.searchParams.get('u') || '').trim();
  if (!target || target.length > 512 || !/^https?:\/\//.test(target)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(qrSvgFor(target, 8, 2));
}

// ---------------------------------------------------------------- 路由
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });

    // 预实验 · 局域网连接页与二维码
    if (pathname === '/connect' && req.method === 'GET') return handleConnect(res);
    if (pathname === '/qr.svg' && req.method === 'GET') return handleQrSvg(res, url);

    // 被试端
    if (pathname === '/api/bootstrap' && req.method === 'GET') return handleBootstrap(req, res, url);
    if (pathname === '/api/session' && req.method === 'POST') return await handleCreateSession(req, res);
    if (pathname === '/api/step' && req.method === 'POST') return await handleStep(req, res);
    if (pathname === '/api/finish' && req.method === 'POST') return await handleFinish(req, res);

    // 管理端 · 登录与元信息
    if (pathname === '/api/auth/register' && req.method === 'POST') return await handleRegister(req, res);
    if (pathname === '/api/auth/login' && req.method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/auth/logout' && req.method === 'POST') return await handleLogout(req, res);
    if (pathname === '/api/auth/me' && req.method === 'GET') return handleMe(req, res);
    if (pathname === '/api/auth/password' && req.method === 'POST') return await handleChangePassword(req, res);
    if (pathname === '/api/auth/avatar' && req.method === 'POST') return await handleAvatar(req, res);
    if (pathname === '/api/admin/meta' && req.method === 'GET') return handleAdminMeta(req, res);
    if (pathname === '/api/admin/settings' && req.method === 'GET') return handleAdminGetSettings(req, res);
    if (pathname === '/api/admin/settings' && req.method === 'POST') return await handleAdminSaveSettings(req, res);

    // 用户管理（管理员）
    if (pathname === '/api/admin/users' && req.method === 'GET') return handleUsersList(req, res);
    if (pathname === '/api/admin/users/create' && req.method === 'POST') return await handleUserCreate(req, res);
    if (pathname === '/api/admin/users/update' && req.method === 'POST') return await handleUserUpdate(req, res);
    if (pathname === '/api/admin/users/delete' && req.method === 'POST') return await handleUserDelete(req, res);

    // 管理端 · 实验模板库
    if (pathname === '/api/admin/experiments' && req.method === 'GET') return handleAdminExperiments(req, res);
    if (pathname === '/api/admin/experiment' && req.method === 'GET') return handleAdminExperiment(req, res, url);
    if (pathname === '/api/admin/experiment/create' && req.method === 'POST') return await handleAdminExperimentCreate(req, res);
    if (pathname === '/api/admin/experiment/update' && req.method === 'POST') return await handleAdminExperimentUpdate(req, res);
    if (pathname === '/api/admin/experiment/delete' && req.method === 'POST') return await handleAdminExperimentDelete(req, res);

    // 管理端 · 问卷
    if (pathname === '/api/admin/questionnaires' && req.method === 'GET') return handleAdminQuestionnaires(req, res);
    if (pathname === '/api/admin/questionnaire' && req.method === 'GET') return handleAdminQuestionnaire(req, res, url);
    if (pathname === '/api/admin/questionnaire/create' && req.method === 'POST') return await handleAdminQuestionnaireCreate(req, res);
    if (pathname === '/api/admin/questionnaire/update' && req.method === 'POST') return await handleAdminQuestionnaireUpdate(req, res);
    if (pathname === '/api/admin/questionnaire/delete' && req.method === 'POST') return await handleAdminQuestionnaireDelete(req, res);
    if (pathname === '/api/admin/questionnaire/sessions' && req.method === 'GET') return handleAdminQuestionnaireSessions(req, res, url);
    if (pathname === '/api/admin/questionnaire/sessions/delete' && req.method === 'POST') return await handleAdminSessionsDelete(req, res, url);
    if (pathname === '/api/admin/questionnaire/session' && req.method === 'GET') return handleAdminQuestionnaireSession(req, res, url);
    if (pathname === '/api/admin/questionnaire/export.xlsx' && req.method === 'GET') return handleAdminQuestionnaireExport(req, res, url);

    if (req.method === 'GET') return serveStatic(res, pathname);
    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    sendJson(res, 500, { error: 'server_error', message: err.message });
  }
});

server.listen(PORT, () => {
  const urls = lanAddresses().map(entryUrl);
  const primary = urls[0] || entryUrl('');
  console.log('实验平台已启动（局域网预实验模式）');
  console.log(`  电脑端管理入口：http://localhost:${PORT}/admin`);
  console.log(`  手机入口（同一 WiFi 扫码）：${primary}`);
  if (urls.length > 1) console.log(`  备选地址：${urls.slice(1).join('   ')}`);
  console.log('');
  console.log(qrAsciiFor(primary));
  console.log('');
  console.log('  ↑ 用手机相机扫码进入；手机需与本机在同一 WiFi 或热点。');
  console.log('  停止服务：关闭本窗口（进行中的被试会话数据已实时落库，不会丢失）。');
  if (process.env.OPEN_CONNECT === '1') {
    try {
      require('node:child_process').exec(`start "" "http://localhost:${PORT}/connect"`, { windowsHide: true });
    } catch { /* 自动打开浏览器失败不影响服务 */ }
  }
});
