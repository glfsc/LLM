// 服务端：HTTP 静态资源 + API（零第三方依赖，仅用 Node 内置模块）
// 统一模型：问卷 = 一条链接 + 一列题目；每个题目自带参数（等待 / 最短提交 / 最长作答 / 思考与流式节奏 / 清屏点），
// 缺省回落到代码内置默认值（DEFAULT_LIMITS）。被试端按题目顺序推进：
//   消息类题目（message）自动以消息形式发出；其余题型构成「作答单元」。
// 计时门控全部服务端权威，且不产生额外请求：
//   作答前强制等待   → 作答单元的 availableAt = 呈现时刻 + wait
//   最短提交/最长作答 → 共用窗口（相邻且设置相同的题目共用一个起点）
// 会话创建时把题目快照进 sessions，此后修改模板 / 问卷不影响进行中的会话。
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { randomUUID } = crypto;
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

const STATUS_LABELS = { in_progress: '进行中', completed: '已完成', abandoned: '已作废' };
// 作废：数据留档但默认从数据页 / 导出中排除（被试重做、或太久没提交被系统作废）
const ABANDONED = 'abandoned';
// 选项字母：A–Z；理论上限 26 个选项，超出回落为数字（编辑器选项上限 50，不再出现 undefined）
const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function optionLetter(index) {
  return OPTION_LETTERS[index] || String(index + 1);
}

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

// 生效的参数值：题目上配了就用题目的，没配回落到代码内置默认值（DEFAULT_LIMITS）
// 不再有「问卷级默认值 + 题目覆盖」两层，作者不必心算到底哪个值在生效。
// 到点之后的宽限：被试端在到点瞬间自动提交的请求要放行；再晚就只能「重试」开新窗口
const WINDOW_GRACE_MS = 30 * 1000;

function effLimit(item, key) {
  const v = item.limits ? item.limits[key] : undefined;
  if (v !== undefined && v !== null) return Number(v) || 0;
  return Number(store.DEFAULT_LIMITS[key]) || 0;
}

function optionLabelOf(item, value) {
  const idx = Number(value) - 1;
  if (idx < 0 || idx >= (item.options || []).length) return '';
  return `${optionLetter(idx)}．${item.options[idx]}`;
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
// 每个单元带 qno：只有「需要被试作答的题目」才编号（知情同意/确认页/结束说明不占题号）。
const planCache = new Map();
const PLAN_CACHE_MAX = 2000;

function parseSession(session, st = store) {
  const hit = planCache.get(session.id);
  if (hit && hit.pendingAt === session.pending_presented_at && hit.itemsJson === session.items_json) return hit;
  const items = st.normalizeItems(JSON.parse(session.items_json || '[]'));
  const units = [];
  let qno = 0;
  items.forEach((item, index) => {
    if (item.type === 'message') return;
    const isQuestion = store.QUESTION_TYPES.includes(item.type);
    if (isQuestion) qno += 1;
    units.push({ item, index, qno: isQuestion ? qno : 0 });
  });
  const plan = { items, units, pendingAt: session.pending_presented_at, itemsJson: session.items_json };
  if (planCache.size >= PLAN_CACHE_MAX) {
    const oldest = planCache.keys().next().value;
    if (oldest !== undefined) planCache.delete(oldest);
  }
  planCache.set(session.id, plan);
  return plan;
}

// 推进：发出 (afterAnswerIndex-1, afterAnswerIndex) 之间的消息题目。
// 消息上也能配「呈现前清空」：遇到清屏点就把清屏点记到该消息之前，本批只下发达清屏点之后的消息
//（清空之前的内容仍完整留在库里，只是不再下发——刷新页面也拿不到）。
// 返回 { messages, cleared }：cleared = 本批跨过了清屏点，客户端要先清屏再呈现。
function emitMessagesBetween(session, plan, afterAnswerIndex, nowMs, st = store) {
  const units = plan.units;
  const fromItem = afterAnswerIndex > 0 ? units[afterAnswerIndex - 1].index : -1;
  const toItem = afterAnswerIndex < units.length ? units[afterAnswerIndex].index : plan.items.length;
  const emitted = [];
  let cut = 0;                                              // 只下发 emitted.slice(cut)
  let cleared = false;
  for (let i = fromItem + 1; i < toItem; i += 1) {
    const item = plan.items[i];
    if (item.type !== 'message') continue;
    if (!String(item.text || '').trim()) continue;          // 留空的消息自动跳过（也不做清屏点）
    if (effLimit(item, 'refresh') === 1) {
      const mark = st.maxMessageSeq(session.id);
      const cur = Number((st.getSession(session.id) || {}).clear_seq) || 0;
      if (mark > cur) st.setClearSeq(session.id, mark);
      cut = emitted.length;
      cleared = true;
    }
    // 呈现节奏：题目配了就用，否则用内置默认；存到消息上，恢复会话时节奏不丢
    // thinking：思考过程一并落库，保证刷新恢复后回看的是同一段内容
    // 「思考中」提示也是一个参数：没写思考稿、也没显式配思考时长 → 不显示（不凭空冒提示）
    const thinking = item.thinking || null;
    const explicitThink = item.limits && item.limits.thinkMs != null;
    const rhythm = {
      thinkMs: (thinking || explicitThink) ? effLimit(item, 'thinkMs') : 0,
      typeMs: effLimit(item, 'typeMs'),
      thinking
    };
    emitted.push(st.addMessage(session.id, 'assistant', item.html || item.text, null, { ...rhythm, itemId: item.id }));
  }
  return { messages: emitted.slice(cut), cleared };
}

// 作答单元的呈现时刻 = max(上一条作答完成时间, 最近一条消息的可见时刻, 现在)
function presentedAtFor(session, plan, completedCount, nowMs, st = store) {
  const prev = completedCount > 0 ? st.unitFirstResponse(session.id, completedCount - 1) : null;
  const prevMs = prev && prev.answered_at ? Date.parse(prev.answered_at) : Date.parse(session.started_at);
  const msgAt = st.latestMessageAt(session.id);
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
function windowStartFor(session, plan, completedCount, presentedIso, st = store) {
  const units = plan.units;
  const sig = (item) => `${item.limits.minSubmit ?? ''}|${item.limits.maxAnswer ?? ''}`;
  const curSig = sig(units[completedCount].item);
  let runStart = completedCount;
  while (runStart > 0 && sig(units[runStart - 1].item) === curSig) runStart -= 1;
  if (runStart < completedCount) {
    const first = st.unitFirstResponse(session.id, runStart);
    if (first && first.presented_at) return { startMs: Date.parse(first.presented_at), shared: true };
  }
  return { startMs: Date.parse(presentedIso), shared: runStart < completedCount };
}

// 当前待作答单元 → 操作负载（不下发正确答案，避免泄露）
function computeAction(session, plan, completedCount, nowMs, st = store) {
  const units = plan.units;
  if (completedCount >= units.length) return null;
  const unit = units[completedCount];
  const item = unit.item;
  const presentedIso = session.pending_presented_at || presentedAtFor(session, plan, completedCount, nowMs, st);
  const presentedMs = Date.parse(presentedIso);

  // 预览倍速：只缩放「门控时长」（强制等待 / 最短提交 / 最长作答）；真实会话 timeScale = 1，不受影响
  const timeScale = (st && Number(st.timeScale) > 0) ? Number(st.timeScale) : 1;
  const waitSec = effLimit(item, 'wait');
  const minSubmitSec = effLimit(item, 'minSubmit');
  const maxAnswerSec = effLimit(item, 'maxAnswer');
  const wait = waitSec / timeScale;
  const minSubmit = minSubmitSec / timeScale;
  const maxAnswer = maxAnswerSec / timeScale;
  let minSubmitAtMs = 0;
  let deadlineMs = 0;
  let sharedWindow = false;
  if (minSubmit > 0 || maxAnswer > 0) {
    const win = windowStartFor(session, plan, completedCount, presentedIso, st);
    sharedWindow = win.shared;
    if (minSubmit > 0) minSubmitAtMs = win.startMs + minSubmit * 1000;
    if (maxAnswer > 0) deadlineMs = win.startMs + maxAnswer * 1000;
  }

  const base = {
    itemId: item.id,
    itemIndex: unit.index,
    qno: unit.qno || 0,                 // 题号：只数「需要被试作答的题目」（0 = 不显示题号）
    type: item.type,
    title: item.title,
    html: item.html || '',              // 被试可见正文（清洗后的富文本）
    availableAtMs: wait > 0 ? presentedMs + wait * 1000 : 0,
    minSubmitAtMs,
    deadlineMs,
    sharedWindow,
    nowMs,
    // 预览倍速相关：真实门控时间戳是缩放后的，客户端倒计时按「设定秒数 × 倍速」显示，
    // 这样作者看到的是「50 秒从 50 开始快速跳到 0」，而不是莫名其妙变成 5 秒。
    timeScale,
    waitSec,
    minSubmitSec,
    maxAnswerSec
  };

  return { ...base, ...itemDescriptor(item) };
}

// 题型描述（不含计时与状态）：呈现当前题与回放已答题共用，保证两边渲染一致
function itemDescriptor(item) {
  if (item.type === 'rating') {
    const min = Number(item.min) || 1;
    const max = Number(item.max) || 5;
    return {
      min,
      max,
      anchor: item.anchor || '',
      options: Array.from({ length: max - min + 1 }, (_, i) => ({ value: min + i, label: String(min + i) }))
    };
  }
  if (item.type === 'single' || item.type === 'multi') {
    return { options: (item.options || []).map((t, i) => ({ value: i + 1, label: `${optionLetter(i)}．${t}` })) };
  }
  if (item.type === 'rank') {
    return { options: (item.options || []).map((t, i) => ({ value: i + 1, label: t })) };
  }
  if (item.type === 'text') {
    return {
      required: item.required !== false,
      rows: Number(item.rows) || 1,
      maxLen: Number(item.maxLen) || 0,
      placeholder: item.placeholder || '',
      // 形态：match = 需输入指定内容（被试发送前由服务端断言）。
      // 标准答案与提示文案都不下发给被试端——断言结果由 /api/step 的报错带回。
      variant: item.variant === 'match' ? 'match' : 'free'
    };
  }
  if (item.type === 'group') {
    // 题组：一次呈现多道子题、一次提交
    return {
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
        options: (sub.options || []).map((t, k) => ({ value: k + 1, label: `${optionLetter(k)}．${t}` }))
      }))
    };
  }
  if (item.type === 'gate') {
    return {
      check: item.check || '',
      button: item.button || '开始实验',
      // 含编号形态：页面上多一个编号输入框，填写后才能进入
      variant: item.variant === 'id' ? 'id' : 'plain',
      idLabel: item.idLabel || '被试编号',
      idPlaceholder: item.idPlaceholder || '请填写编号'
    };
  }
  if (item.type === 'confirm') {
    // 阅读确认页：先停留 N 秒（item.limits.wait）才能点继续
    return { button: item.button || '我已阅读完' };
  }
  if (item.type === 'debrief') return { button: '我已阅读' };
  return {};
}

// 消息式题面：文本题、以及「子题全是文本」的题组——像一条 AI 消息那样提问，被试在底部输入框作答。
// 其余题型仍是题卡（打分 / 选择 / 排序 / 混合题组）。
function isMessageStyle(item) {
  if (!item) return false;
  if (item.type === 'text') return true;
  if (item.type === 'group') {
    const subs = item.subs || [];
    return subs.length > 0 && subs.every((sub) => sub.type === 'text');
  }
  return false;
}

function sessionBrief(session) {
  return {
    id: session.id,
    uid: session.seq == null ? '' : String(session.seq),
    seq: session.seq == null ? null : Number(session.seq),
    status: session.status
  };
}

// 刷新点：呈现该题之前把聊天流整体清空。
// 清屏点记在会话上（而不是只清前端 DOM）——否则被试一刷新，服务端会把
// 清空之前的消息全部重新下发，防线等于没有。返回是否发生了清屏。
function applyRefreshPoint(session, plan, completedCount, st = store) {
  const unit = plan.units[completedCount];
  if (!unit || effLimit(unit.item, 'refresh') !== 1) return false;
  const mark = st.maxMessageSeq(session.id);
  if (mark <= (Number(session.clear_seq) || 0)) return false;   // 已经清过，不重复记
  st.setClearSeq(session.id, mark);
  return true;
}

// 回放时间线：把「已呈现过的内容」按顺序摊平，供被试刷新 / 退出重进时重建聊天流。
// 消息（含思考节奏）与被试回显都在 messages 表里按 seq 排序；卡片式题目的回显在这里
// 还原成一张「已作答卡片」——呈现与回放用同一份题型描述，两边渲染一致。
function buildReplay(session, plan, st = store) {
  const clearSeq = Number(session.clear_seq) || 0;
  const msgs = st.listVisibleMessages(session.id, new Date().toISOString(), clearSeq);
  const unitByItemId = new Map(plan.units.map((u) => [u.item.id, u]));
  const replay = [];
  for (const m of msgs) {
    const unit = m.item_id ? unitByItemId.get(m.item_id) : null;
    if (m.role === 'assistant') {
      replay.push({
        kind: 'message',
        content: m.content,
        thinking: m.thinking || '',
        thinkMs: m.think_ms,
        typeMs: m.type_ms
      });
      continue;
    }
    // 页面类题目（知情同意 / 确认页 / 结束说明）不占聊天流：它们的回显只留在数据里
    if (unit && ['gate', 'confirm', 'debrief'].includes(unit.item.type)) continue;
    if (unit && isMessageStyle(unit.item)) {
      replay.push({ kind: 'user', itemId: unit.item.id, qno: unit.qno || 0, content: m.content });
    } else if (unit) {
      replay.push({
        kind: 'card',
        itemId: unit.item.id,
        qno: unit.qno || 0,
        echo: m.content,
        item: {
          itemId: unit.item.id,
          qno: unit.qno || 0,
          type: unit.item.type,
          title: unit.item.title,
          html: unit.item.html || '',
          ...itemDescriptor(unit.item)
        }
      });
    } else {
      replay.push({ kind: 'user', content: m.content });   // 兜底：归属不明的回显
    }
  }
  return replay;
}

// 进度以「题号」报（卡面就是题号）：停在知情同意 / 确认页这类不占题号的单元时，报它之后的第一个题号。
// 提交（/api/step）与整包负载（sessionPayload）共用同一份口径——少了它，预览的进度条 / 题号框
// 每答完一题就慢一拍（屏幕已到下一题，进度还停在上一步的题号上）。
function currentQnoFor(plan, action) {
  const totalQuestions = plan.units.filter((u) => u.qno > 0).length;
  if (!action) return totalQuestions;
  const idx = plan.units.findIndex((u) => u.item.id === action.itemId);
  for (let i = Math.max(0, idx); i < plan.units.length; i += 1) {
    if (plan.units[i].qno > 0) return plan.units[i].qno;
  }
  return totalQuestions;
}

function sessionPayload(session, st = store) {
  const plan = parseSession(session, st);
  const completedCount = st.countAnswerUnits(session.id);
  const nowIsoStr = new Date().toISOString();
  const clearSeq = Number(session.clear_seq) || 0;
  const action = session.status === 'completed' ? null : computeAction(session, plan, completedCount, Date.now(), st);
  const totalQuestions = plan.units.filter((u) => u.qno > 0).length;
  return {
    session: sessionBrief(session),
    messages: st.listVisibleMessages(session.id, nowIsoStr, clearSeq),
    replay: buildReplay(session, plan, st),             // 重建聊天流（刷新 / 退出重进）
    action,
    nowMs: Date.now(),
    totalItems: plan.items.length,
    totalAnswers: plan.units.length,                    // 作答单元数（含知情同意 / 确认页 / 结束说明）
    totalQuestions,                                     // 真实题数（进度条分母按这个来）
    currentQno: currentQnoFor(plan, action),            // 当前「第几题」（progress 用）
    answeredCount: completedCount,
    timeScale: (st && Number(st.timeScale) > 0) ? Number(st.timeScale) : 1
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
    // 「太久没提交」：超过自动作废时限 → 置为作废（数据留档），设备直接释放给下一位被试
    const abandonMin = store.getAbandonAfterMinutes();
    const lastMs = store.sessionLastActiveMs(session);
    const idleMs = lastMs ? Date.now() - lastMs : 0;
    if (abandonMin > 0 && idleMs > abandonMin * 60 * 1000) {
      store.abandonSession(session.id);
      session = null;
    }
  }
  if (session && session.status === 'in_progress') {
    const hours = store.getResumeWindowHours();                                     // 中途退出保留：超出恢复窗口则重新开始
    const startedMs = Date.parse(session.started_at);
    if (hours && Number.isFinite(startedMs) && Date.now() - startedMs > hours * 3600 * 1000) session = null;
    if (session) store.touchSession(session.id);                                    // 进入即算一次活动（心跳之外的兜底）
  }
  if (session && session.status === ABANDONED) session = null;                      // 已作废的会话不再续做
  if (!session) {
    return sendJson(res, 200, {
      questionnaireTitle: questionnaire.title,
      session: null, messages: [], action: null, nowMs: Date.now()
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
    userAgent: req.headers['user-agent'] || ''
  });

  const plan = parseSession(session);
  const nowMs = Date.now();
  emitMessagesBetween(session, plan, 0, nowMs);
  applyRefreshPoint(session, plan, 0);
  store.setPendingPresentedAt(session.id, presentedAtFor(session, plan, 0, nowMs));

  sendJson(res, 200, { questionnaireTitle: questionnaire.title, ...sessionPayload(store.getSession(session.id)) });
}

// 校验并归一化作答值
function validateAnswer(item, body, deadlinePassed = false) {
  switch (item.type) {
    case 'gate': {
      if (body.consent !== true) return { error: '请先勾选同意后再开始' };
      if (item.variant === 'id') {
        const code = String(body.text ?? '').trim();
        if (!code) return { error: '请先填写编号' };
        return { value: null, valueText: code, optionLabel: `已同意并开始 · 编号 ${code}` };
      }
      return { value: null, valueText: '', optionLabel: '已同意并开始' };
    }
    case 'confirm':
      if (body.ack !== true) return { error: '请确认已阅读后再继续' };
      return { value: null, valueText: '', optionLabel: '已确认阅读' };
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
      // 二级形态「需输入指定内容」：先在服务端断言，通过了才当普通文本题落库。
      // 断言失败（含内容为空）返回研究者自定义的提示文案（默认「答案错误」），
      // 这一笔不写库、也不进聊天流——被试端只在输入框旁提示，输入内容原样保留。
      // 题目没配标准答案时退化为自由作答（管理端会在题目摘要里提醒「尚未设置答案」）。
      if (item.variant === 'match' && store.matchAnswerLines(item).length && !store.matchesAnswer(item, text)) {
        return { error: store.matchErrorText(item), assertionFailed: true };
      }
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

// 提交一步的核心：真实会话与「手机预览」会话共用同一套状态机（只是存储不同）。
// 返回 { status, error } 或 { status: 200, payload }。
async function applyStep(st, sessionId, body) {
  const session = st.getSession(sessionId);
  if (!session) return { status: 404, error: { error: 'session_not_found', message: '会话不存在' } };
  if (session.status !== 'in_progress') return { status: 409, error: { error: 'session_closed', message: '会话已结束' } };

  const plan = parseSession(session, st);
  const completedCount = st.countAnswerUnits(session.id);
  const unit = plan.units[completedCount];
  if (!unit) return { status: 409, error: { error: 'session_closed', message: '会话已结束' } };
  const item = unit.item;
  const now = new Date();
  const nowMs = now.getTime();

  // 幂等：客户端报的 itemId 必须就是「当前该答的这一题」。
  // 重复提交 / 迟到的自动提交 / 旧页面缓存如果被静默记到下一题上，表现就是「答完一题跳过了两题」。
  const bodyItemId = String(body.itemId || '').trim();
  if (bodyItemId && bodyItemId !== item.id) {
    return { status: 200, payload: { ...sessionPayload(session, st), ignored: true } };
  }

  const action = computeAction(session, plan, completedCount, nowMs, st);
  if (action.availableAtMs && nowMs < action.availableAtMs) {
    return { status: 400, error: { error: 'too_early', message: '请先完整阅读内容', availableAtMs: action.availableAtMs, nowMs } };
  }
  if (action.minSubmitAtMs && nowMs < action.minSubmitAtMs) {
    return { status: 400, error: { error: 'too_early', message: '还未到可提交时间', availableAtMs: action.minSubmitAtMs, nowMs } };
  }

  // 作答窗口已过（超出宽限）：本题锁死，被试端只能点「重试」开一个新的作答窗口
  if (action.deadlineMs && nowMs > action.deadlineMs + WINDOW_GRACE_MS) {
    st.markTimeout(sessionId, completedCount);             // 记一笔「超时未交」（重试次数另记）
    return {
      status: 409,
      error: { error: 'window_closed', message: '本题作答时间已到，请点击「重试」重新开始本题', retryable: true, nowMs }
    };
  }

  // 到点自动提交：超过最长作答时间后允许文本题为空
  const deadlinePassed = !!(action.deadlineMs && nowMs >= action.deadlineMs);
  const check = validateAnswer(item, body, deadlinePassed);
  if (check.error) {
    // 「需输入指定内容」的断言失败：也记一次「提交前的重试」——数据里能看出被试试了几次才对
    if (check.assertionFailed) st.bumpRetry(sessionId, completedCount, false);
    return {
      status: 400,
      error: { error: 'invalid_answer', message: check.error, assertionFailed: !!check.assertionFailed }
    };
  }

  const elapsedMs = Number.isFinite(Number(body.elapsedMs))
    ? Math.min(Math.max(Math.round(Number(body.elapsedMs)), 0), 24 * 3600 * 1000)
    : null;
  const presentedAt = session.pending_presented_at || new Date(nowMs).toISOString();

  // 回显：消息式题面（文本题 / 全文本题组）原样保留被试输入——他怎么写就怎么记；
  // 其余题型给出「我的选择：…」，卡片式题目的回显会就地留在卡片里。
  let echo;
  if (isMessageStyle(item)) {
    echo = item.type === 'group'
      ? check.group.map((row) => String(row.optionLabel || '').trim()).filter((x) => x).join('\n')
      : String(check.optionLabel || '');
    if (!echo) echo = '（未填写内容）';
  } else if (item.type === 'group') {
    echo = check.group
      .map((row, i) => `${(item.subs[i] || {}).title || `子题 ${i + 1}`}：${row.optionLabel || '（未填写）'}`)
      .join('\n');
  } else if (item.type === 'gate' || item.type === 'debrief') {
    echo = check.optionLabel;
  } else {
    echo = `我的选择：${check.optionLabel}`;
  }
  const userMessage = st.addMessage(sessionId, 'user', echo, null, { itemId: item.id });

  // 落库：题组一次提交写入多行（同一 unit_index，sub_index 区分）
  const rows = item.type === 'group'
    ? check.group.map((row, i) => ({ itemType: (item.subs[i] || {}).type || 'text', subIndex: i, ...row }))
    : [{ itemType: item.type, subIndex: 0, value: check.value, valueText: check.valueText, optionLabel: check.optionLabel }];
  const answeredAt = now.toISOString();
  const retryInfo = st.getRetryInfo(sessionId, completedCount);
  for (const row of rows) {
    st.addResponse({
      retryCount: retryInfo.retries,
      timedOut: retryInfo.timedOut,
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

  st.touchSession(sessionId);                           // 提交也是一次活动
  const nextCount = completedCount + 1;
  const flush = emitMessagesBetween(session, plan, nextCount, nowMs, st);
  const messages = flush.messages;                      // 消息即时可见（「延迟发出」已移除，visible_at 恒为 null）

  let completed = false;
  if (nextCount >= plan.units.length) {
    st.setPendingPresentedAt(sessionId, null);
    st.finishSession(sessionId);
    completed = true;
  } else {
    st.setPendingPresentedAt(sessionId, presentedAtFor(st.getSession(sessionId), plan, nextCount, nowMs, st));
  }

  const updated = st.getSession(sessionId);
  const nextPlan = parseSession(updated, st);
  // 下一题是刷新点：清空聊天流。本步刚发出的消息也属于「清空之前」，所以不下发。
  const unitCleared = !completed && applyRefreshPoint(updated, nextPlan, nextCount, st);
  const cleared = flush.cleared || unitCleared;
  const nextAction = completed ? null : computeAction(updated, nextPlan, nextCount, Date.now(), st);
  return {
    status: 200,
    payload: {
      userMessage,
      messages: unitCleared ? [] : messages,
      clearStream: cleared,             // 客户端先清屏，再按顺序呈现 messages（消息上的清屏点）
      action: nextAction,
      nowMs: Date.now(),
      session: sessionBrief(updated),
      answeredCount: nextCount,
      totalAnswers: plan.units.length,
      totalQuestions: nextPlan.units.filter((u) => u.qno > 0).length,   // 真实题数（进度条分母）
      currentQno: currentQnoFor(nextPlan, nextAction),                  // 当前「第几题」（进度条 / 题号框）
      timeScale: (st && Number(st.timeScale) > 0) ? Number(st.timeScale) : 1
    }
  };
}

// POST /api/step { sessionId, ...作答 }
async function handleStep(req, res) {
  const body = await readJsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  if (!sessionId) return sendJson(res, 400, { error: 'bad_request', message: '缺少 sessionId' });
  const out = await applyStep(store, sessionId, body);
  if (out.error) return sendJson(res, out.status, out.error);
  sendJson(res, 200, out.payload);
}

// POST /api/finish { sessionId, abandon? } —— 提前结束；abandon = 作废这次作答（重做 / 重新开始用）
async function handleFinish(req, res) {
  const body = await readJsonBody(req);
  const id = String(body.sessionId || '').trim();
  const session = body.abandon ? store.abandonSession(id) : store.finishSession(id);
  if (!session) return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });
  sendJson(res, 200, { session: { id: session.id, status: session.status, duration_sec: session.duration_sec } });
}

// POST /api/heartbeat { sessionId } —— 页面打开期间每分钟一次：只刷新「最近活动时间」，
// 免得被试慢慢读题时被误判成「太久没提交」而自动作废。
async function handleHeartbeat(req, res) {
  const body = await readJsonBody(req);
  const id = String(body.sessionId || '').trim();
  const session = id ? store.getSession(id) : null;
  if (!session) return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });
  if (session.status === 'in_progress') store.touchSession(id);
  sendJson(res, 200, { ok: true, status: session.status, nowMs: Date.now() });
}

// POST /api/step/retry { sessionId } —— 超时锁死后开一个新的作答窗口：
// 把本题的计时基准重置到现在（强制等待 / 最短提交 / 最长作答都重新开始），并记一次重试。
async function retryCore(st, sessionId) {
  const session = sessionId ? st.getSession(sessionId) : null;
  if (!session) return { status: 404, error: { error: 'session_not_found', message: '会话不存在' } };
  if (session.status !== 'in_progress') return { status: 409, error: { error: 'session_closed', message: '会话已结束' } };
  const plan = parseSession(session, st);
  const completedCount = st.countAnswerUnits(session.id);
  const unit = plan.units[completedCount];
  if (!unit) return { status: 409, error: { error: 'session_closed', message: '会话已结束' } };
  const action = computeAction(session, plan, completedCount, Date.now(), st);
  if (action.deadlineMs && Date.now() <= action.deadlineMs) {
    return { status: 400, error: { error: 'not_expired', message: '本题作答时间还没到，无需重试' } };
  }
  st.bumpRetry(sessionId, completedCount, true);
  st.setPendingPresentedAt(sessionId, new Date().toISOString());   // 新窗口：从现在重新计时
  const updated = st.getSession(sessionId);
  return { status: 200, payload: { ...sessionPayload(updated, st), retried: true, nowMs: Date.now() } };
}

async function handleStepRetry(req, res) {
  const body = await readJsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  const out = await retryCore(store, sessionId);
  if (out.error) return sendJson(res, out.status, out.error);
  sendJson(res, 200, out.payload);
}

// ---------------------------------------------------------------- 手机预览（内存会话，不落库）
// 管理端「实时预览 / 从头试填」用真 iframe 加载 /chat?preview=<id>：
// 与真实被试端**同一份前端代码 + 同一套服务端状态机**，只是存储换成内存，所以天然一比一。
class MemoryStore {
  constructor() {
    this.sessions = new Map();
    this.messages = new Map();
    this.responses = new Map();
    this.timeScale = 1;          // 预览倍速：>1 表示门控计时按比例缩短
  }
  resetSession(id) {
    this.messages.set(id, []);
    this.responses.set(id, []);
    const row = this.getSession(id);
    if (row) { row.clear_seq = 0; row.retry_json = '{}'; row.status = 'in_progress'; row.pending_presented_at = null; }
  }
  normalizeItems(raw) { return store.normalizeItems(raw); }
  getSession(id) { return this.sessions.get(id) || null; }
  createSession({ questionnaireId, seq, items, userAgent }) {
    const id = 'pv' + Math.random().toString(36).slice(2, 10);
    const now = new Date().toISOString();
    const row = {
      id,
      questionnaire_id: questionnaireId,
      seq: Number(seq) || 1,
      status: 'in_progress',
      started_at: now,
      active_at: now,
      ended_at: null,
      duration_sec: null,
      user_agent: userAgent || 'preview',
      items_json: JSON.stringify(items),
      pending_presented_at: null,
      clear_seq: 0,
      retry_json: '{}'
    };
    this.sessions.set(id, row);
    this.messages.set(id, []);
    this.responses.set(id, []);
    return row;
  }
  touchSession(id) { const s = this.getSession(id); if (s) s.active_at = new Date().toISOString(); }
  setPendingPresentedAt(id, iso) { const s = this.getSession(id); if (s) s.pending_presented_at = iso; }
  finishSession(id) {
    const s = this.getSession(id);
    if (s && s.status === 'in_progress') { s.status = 'completed'; s.ended_at = new Date().toISOString(); s.pending_presented_at = null; }
    return s;
  }
  abandonSession(id) {
    const s = this.getSession(id);
    if (s && s.status === 'in_progress') { s.status = 'abandoned'; s.ended_at = new Date().toISOString(); s.pending_presented_at = null; }
    return s;
  }
  addMessage(sessionId, role, content, visibleAt = null, rhythm = null) {
    const rows = this.messages.get(sessionId) || [];
    const seq = rows.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0) + 1;
    const row = {
      id: seq,
      role,
      content,
      seq,
      created_at: new Date().toISOString(),
      visible_at: visibleAt,
      thinking: rhythm && rhythm.thinking ? String(rhythm.thinking) : null,
      think_ms: rhythm && rhythm.thinkMs != null ? Number(rhythm.thinkMs) : null,
      type_ms: rhythm && rhythm.typeMs != null ? Number(rhythm.typeMs) : null,
      item_id: rhythm && rhythm.itemId ? String(rhythm.itemId) : null
    };
    rows.push(row);
    this.messages.set(sessionId, rows);
    return row;
  }
  listVisibleMessages(sessionId, now, clearSeq = 0) {
    return (this.messages.get(sessionId) || []).filter(
      (m) => (!m.visible_at || m.visible_at <= now) && (Number(m.seq) || 0) > (Number(clearSeq) || 0)
    );
  }
  maxMessageSeq(sessionId) {
    return (this.messages.get(sessionId) || []).reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);
  }
  latestMessageAt(sessionId) {
    const rows = this.messages.get(sessionId) || [];
    return rows.length ? rows[rows.length - 1].created_at : null;
  }
  setClearSeq(sessionId, seq) { const s = this.getSession(sessionId); if (s) s.clear_seq = Number(seq) || 0; }
  addResponse(row) {
    const rows = this.responses.get(row.sessionId) || [];
    rows.push({
      ...row,
      presented_at: row.presentedAt || null,
      answered_at: row.answeredAt || null,
      elapsed_ms: row.elapsedMs == null ? null : Number(row.elapsedMs),
      retry_count: Number(row.retryCount) || 0,
      timed_out: row.timedOut ? 1 : 0
    });
    this.responses.set(row.sessionId, rows);
    return rows.length;
  }
  listResponses(sessionId) { return [...(this.responses.get(sessionId) || [])]; }
  countAnswerUnits(sessionId) {
    return new Set((this.responses.get(sessionId) || []).map((r) => Number(r.unitIndex) || 0)).size;
  }
  unitFirstResponse(sessionId, unitIndex) {
    return (this.responses.get(sessionId) || []).find((r) => Number(r.unitIndex) === Number(unitIndex)) || null;
  }
  bumpRetry(sessionId, unitIndex, timedOut) {
    const s = this.getSession(sessionId);
    if (!s) return null;
    const map = JSON.parse(s.retry_json || '{}');
    const cur = map[unitIndex] || { retries: 0, timedOut: 0 };
    cur.retries += 1;
    if (timedOut) cur.timedOut = 1;
    map[unitIndex] = cur;
    s.retry_json = JSON.stringify(map);
    s.active_at = new Date().toISOString();
    return cur;
  }
  markTimeout(sessionId, unitIndex) {
    const s = this.getSession(sessionId);
    if (!s) return null;
    const map = JSON.parse(s.retry_json || '{}');
    const cur = map[unitIndex] || { retries: 0, timedOut: 0 };
    cur.timedOut = 1;
    map[unitIndex] = cur;
    s.retry_json = JSON.stringify(map);
    return cur;
  }
  getRetryInfo(sessionId, unitIndex) {
    const s = this.getSession(sessionId);
    if (!s) return { retries: 0, timedOut: 0 };
    const map = JSON.parse(s.retry_json || '{}');
    const cur = map[unitIndex] || {};
    return { retries: Number(cur.retries) || 0, timedOut: Number(cur.timedOut) || 0 };
  }
  getAbandonAfterMinutes() { return 0; }        // 预览不自动作废
}

const PREVIEW_TTL_MS = 30 * 60 * 1000;          // 预览会话「静止 30 分钟」自动销毁（点刷新 / 重试会立即销毁）
const PREVIEW_MAX = 40;
const previewStores = new Map();                // previewId -> { st, at }；Map 顺序 = LRU（最近用过的排最后）
function prunePreview() {
  const now = Date.now();
  for (const [id, rec] of previewStores) {
    if (now - rec.at > PREVIEW_TTL_MS) previewStores.delete(id);
  }
  while (previewStores.size > PREVIEW_MAX) previewStores.delete(previewStores.keys().next().value);
}
// 定期清理：以前只在「新建预览」时顺带扫一遍，管理端一直开着不新建就永远不过期
const previewSweeper = setInterval(prunePreview, 60 * 1000);
if (previewSweeper && typeof previewSweeper.unref === 'function') previewSweeper.unref();
function previewOf(id) {
  const rec = previewStores.get(id);
  if (!rec) return null;
  rec.at = Date.now();
  previewStores.delete(id);                     // LRU：访问过就挪到末尾，淘汰时不会先淘汰「正在用」的那个
  previewStores.set(id, rec);
  return rec.st;
}
function destroyPreview(id) {
  const key = String(id || '').trim();
  return key ? previewStores.delete(key) : false;
}

// 与真实 /api/session 完全同一条路径：发出首屏消息 → 呈现第一题
function seedPreviewSession(st, session) {
  const plan = parseSession(session, st);
  emitMessagesBetween(session, plan, 0, Date.now(), st);
  applyRefreshPoint(session, plan, 0, st);
  st.setPendingPresentedAt(session.id, presentedAtFor(session, plan, 0, Date.now(), st));
}

// POST /api/admin/preview { items } —— 用编辑器里（可能还没保存）的题目建一个预览会话
async function handleAdminPreviewCreate(req, res) {
  if (!requireUser(req, res)) return;
  const body = await readJsonBody(req);
  const items = store.normalizeItems(Array.isArray(body.items) ? body.items : []);
  if (!items.length) return sendJson(res, 400, { error: 'empty_items', message: '还没有题目，无法预览' });
  prunePreview();
  const st = new MemoryStore();
  const speed0 = Number(body.speed);
  if (Number.isFinite(speed0) && speed0 > 0) st.timeScale = Math.min(60, speed0);
  const session = st.createSession({ questionnaireId: 'preview', seq: 1, items, userAgent: 'preview' });
  seedPreviewSession(st, session);
  previewStores.set(session.id, { st, at: Date.now() });
  sendJson(res, 200, { previewId: session.id, url: `/chat?preview=${session.id}` });
}

// 预览端点不校验管理端登录：previewId 本身是不可猜的能力凭证（10 位随机、内存态、1 小时过期），
// 与真实被试端的 session id 同构——iframe 里的被试端页面本来就没有管理端 token。
async function handlePreviewBootstrap(req, res, url) {
  const st = previewOf((url.searchParams.get('preview') || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const sid = (url.searchParams.get('session') || '').trim();
  const session = sid ? st.getSession(sid) : null;
  if (!session) return sendJson(res, 200, { questionnaireTitle: '预览', session: null, messages: [], replay: [], action: null, nowMs: Date.now() });
  sendJson(res, 200, { questionnaireTitle: '预览', ...sessionPayload(session, st) });
}

async function handlePreviewStep(req, res) {
  const body = await readJsonBody(req);
  const st = previewOf(String(body.previewId || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const sid = String(body.sessionId || '').trim();
  if (!sid || !st.getSession(sid)) {
    return sendJson(res, 404, { error: 'session_not_found', message: '预览会话不存在，请刷新预览' });
  }
  const out = await applyStep(st, sid, body);
  if (out.error) return sendJson(res, out.status, out.error);
  sendJson(res, 200, out.payload);
}

async function handlePreviewSession(req, res) {
  const body = await readJsonBody(req);
  const st = previewOf(String(body.previewId || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const created = st.createSession({ questionnaireId: 'preview', seq: 1, items: [], userAgent: 'preview' });
  // 题目来自预览会话创建时写入的 items（这里只重置进度：清空消息与作答）
  const source = [...st.sessions.values()][0];
  if (source && source.items_json && source.items_json !== '[]') {
    created.items_json = source.items_json;
  }
  // 换 id 前先把旧 key 删掉：createSession 已经用旧 id 存过一份，
  // 不删的话 Map 里会有两个键指向同一个会话对象 —— 遍历 sessions 时会被处理两次
  //（切倍速的折算就会折算两遍，倍速被平方）。
  st.sessions.delete(created.id);
  created.id = created.id + '_' + Date.now().toString(36);
  st.sessions.set(created.id, created);
  st.messages.set(created.id, []);
  st.responses.set(created.id, []);
  if (!created.items_json || created.items_json === '[]') {
    return sendJson(res, 400, { error: 'empty_items', message: '预览题目为空，请刷新预览' });
  }
  seedPreviewSession(st, created);
  sendJson(res, 200, { questionnaireTitle: '预览', ...sessionPayload(created, st) });
}

// 预览进度跳转：把目标题之前的作答单元合成「预览已作答」，直接停在那一题。
// 口径 = **题号 qno**（与卡面「第 N 题」一致），不是作答单元序号——
// 知情同意 / 确认页 / 结束说明不占题号，用单元序号跳会整体偏一位（用户报的「跳第 5 题落到第 4 题」）。
// 合成顺序必须与真实推进一致：开场消息 →（每单元：清屏点 → 回显 → 作答行 → 该单元之后的消息）→ 目标单元的清屏点。
function seekPreview(st, sessionId, qno, fallbackIndex) {
  const session = st.getSession(sessionId);
  if (!session) return null;
  const plan = parseSession(session, st);
  if (!plan.units.length) return null;
  const want = Math.round(Number(qno) || 0);
  let target;
  if (want > 0) {
    target = plan.units.findIndex((u) => u.qno === want);
    if (target < 0) target = plan.units.findIndex((u) => u.qno > want);      // 超出题数 → 停在最后一题之后
    if (target < 0) target = plan.units.length - 1;
  } else {
    target = Math.max(0, Math.min(Math.round(Number(fallbackIndex) || 0), plan.units.length - 1));
  }
  st.resetSession(sessionId);
  const nowMs = Date.now();
  emitMessagesBetween(session, plan, 0, nowMs, st);                          // 开场消息（重置后必须补回来）
  for (let i = 0; i < target; i += 1) {
    const unit = plan.units[i];
    // 该单元是清屏点：先记清屏点，再写回显 —— 顺序反了会导致「清屏前的已答卡片」留在回放里
    applyRefreshPoint(session, plan, i, st);
    st.addMessage(sessionId, 'user', previewDummyEcho(unit.item), null, { itemId: unit.item.id });
    for (const row of previewDummyRows(unit.item)) {
      st.addResponse({
        sessionId,
        itemId: unit.item.id,
        itemIndex: unit.index,
        itemType: row.itemType,
        unitIndex: i,
        subIndex: row.subIndex,
        value: row.value,
        valueText: row.valueText,
        optionLabel: row.optionLabel,
        presentedAt: new Date(nowMs - 1000).toISOString(),
        answeredAt: new Date(nowMs).toISOString(),
        elapsedMs: 1000,
        retryCount: 0,
        timedOut: 0
      });
    }
    emitMessagesBetween(session, plan, i + 1, nowMs, st);                    // 该单元之后的、下一单元之前的消息
  }
  const cleared = applyRefreshPoint(session, plan, target, st);              // 目标题自身是清屏点：先清屏再呈现
  st.setPendingPresentedAt(sessionId, new Date(nowMs).toISOString());
  return { ...sessionPayload(st.getSession(sessionId), st), clearStream: cleared, seekedTo: qnoOf(plan, target) };
}

// 某个单元下标对应的题号（0 = 该单元不占题号）
function qnoOf(plan, index) {
  const unit = plan.units[index];
  return unit ? unit.qno || 0 : 0;
}

// 跳转用的合成作答：只为让「已答部分」在回放里显示得像真的，不参与任何分析
function previewDummyRows(item) {
  const one = (sub, i) => ({
    itemType: sub.type,
    subIndex: i,
    value: sub.type === 'rating' || sub.type === 'single' ? 3 : null,
    valueText: sub.type === 'text' ? JSON.stringify({ text: '（预览已作答）' }) : '',
    optionLabel: '（预览已作答）'
  });
  if (item.type === 'group') return (item.subs || []).map((sub, i) => one(sub, i));
  return [one(item, 0)];
}

function previewDummyEcho(item) {
  if (item.type === 'gate') return '已同意并开始（预览）';
  if (item.type === 'confirm') return '已阅读并继续（预览）';
  if (item.type === 'debrief') return '已阅读结束说明（预览）';
  return '（预览已作答）';
}

// POST /api/preview/seek { previewId, sessionId, qno }（qno = 题号，与卡面一致；兼容旧的 index 单元序号）
async function handlePreviewSeek(req, res) {
  const body = await readJsonBody(req);
  const st = previewOf(String(body.previewId || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const payload = seekPreview(st, String(body.sessionId || '').trim(), body.qno, body.index);
  if (!payload) return sendJson(res, 404, { error: 'session_not_found', message: '预览会话不存在，请刷新预览' });
  sendJson(res, 200, payload);
}

// POST /api/preview/seek-unit { previewId, sessionId, index } —— 按作答单元序号跳（自检用）
async function handlePreviewSeekUnit(req, res) {
  const body = await readJsonBody(req);
  const st = previewOf(String(body.previewId || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const payload = seekPreview(st, String(body.sessionId || '').trim(), 0, body.index);
  if (!payload) return sendJson(res, 404, { error: 'session_not_found', message: '预览会话不存在，请刷新预览' });
  sendJson(res, 200, payload);
}

// POST /api/preview/speed { previewId, speed } —— 改倍速不重建会话（已填的作答保留）
// 关键：把**所有已经写下的时间基准**按新旧倍速折算，这样在等待 / 作答过程中切速度都会立刻按新倍速走：
//   · pending_presented_at → 「作答前强制等待」的剩余时间
//   · responses.presented_at → 「最短提交 / 最长作答」的窗口起点（windowStartFor 读它）
// 不折算的话，最短提交/最长作答窗口不会跟着倍速变，而客户端倒计时会按新倍速显示，
// 就会出现「设了 50 秒、切到 10× 反而显示 500 秒」。（预览是内存会话，不写库，可以随便改时间戳。）
async function handlePreviewSpeed(req, res) {
  const body = await readJsonBody(req);
  const st = previewOf(String(body.previewId || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const speed = Number(body.speed);
  const next = Number.isFinite(speed) && speed > 0 ? Math.min(60, speed) : 1;
  const prev = Number(st.timeScale) > 0 ? Number(st.timeScale) : 1;
  const nowMs = Date.now();
  if (next !== prev) {
    // 折算规则：已过时间按 prev/next 比例缩放（保留「已过多少比例」），
    // 但**已经过点的窗口不许复活** —— 按旧倍速算已经走完的等待/作答窗口，
    // 折算后必须仍然算走完（否则切到更慢的倍速时，早就结束的强制等待又要求重新等一遍）。
    const scalePoint = (t, oldTotalMs, newTotalMs) => {
      const scaled = nowMs - (nowMs - t) * (prev / next);
      const passed = oldTotalMs > 0 && t + oldTotalMs <= nowMs;
      return passed ? Math.min(scaled, nowMs - newTotalMs - 1) : scaled;
    };
    const seenSessions = new Set();       // 去重：Map 里可能有多个键指向同一个会话对象（历史遗留），只折一次
    for (const session of st.sessions.values()) {
      if (seenSessions.has(session)) continue;
      seenSessions.add(session);
      if (!session.pending_presented_at) continue;
      const t = Date.parse(session.pending_presented_at);
      if (!Number.isFinite(t)) continue;
      const plan = parseSession(session, st);
      const unit = plan.units[st.countAnswerUnits(session.id)];
      const waitSec = unit ? effLimit(unit.item, 'wait') : 0;
      session.pending_presented_at = new Date(scalePoint(t, (waitSec / prev) * 1000, (waitSec / next) * 1000)).toISOString();
    }
    for (const [sid, rows] of st.responses) {
      const session = st.getSession(sid);
      if (!session) continue;
      const byItem = new Map(parseSession(session, st).units.map((u) => [u.item.id, u.item]));
      for (const row of rows) {
        const iso = row.presented_at || row.presentedAt;
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) continue;
        const item = byItem.get(row.itemId || row.item_id);
        const winSec = item ? Math.max(effLimit(item, 'minSubmit'), effLimit(item, 'maxAnswer')) : 0;
        const fixed = new Date(scalePoint(t, (winSec / prev) * 1000, (winSec / next) * 1000)).toISOString();
        row.presented_at = fixed;
        if (row.presentedAt != null) row.presentedAt = fixed;
      }
    }
  }
  st.timeScale = next;
  sendJson(res, 200, { ok: true, speed: st.timeScale });
}

// POST /api/preview/destroy { previewId } —— 立即销毁预览会话（点「刷新预览」或离开编辑页时调用，不等 30 分钟 TTL）
async function handlePreviewDestroy(req, res) {
  const body = await readJsonBody(req);
  const destroyed = destroyPreview(body.previewId);
  sendJson(res, 200, { ok: true, destroyed });
}

async function handlePreviewFinish(req, res) {
  const body = await readJsonBody(req);
  const st = previewOf(String(body.previewId || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const session = body.abandon ? st.abandonSession(String(body.sessionId || '').trim()) : st.finishSession(String(body.sessionId || '').trim());
  if (!session) return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });
  sendJson(res, 200, { session: { id: session.id, status: session.status, duration_sec: session.duration_sec } });
}

// ---------------------------------------------------------------- 鉴权（用户账号）
// 签名 token（HMAC，密钥持久化在 settings）：
//   旧实现是内存 Map → 服务一重启所有登录态就失效，做不到「勾记住密码后 30 天免登录」。
//   现在 token 自带过期时间且可离线校验签名，重启后仍然有效；登出走内存黑名单（本机工具够用）。
const TOKEN_TTL = 24 * 60 * 60 * 1000;                       // 默认：1 天
const TOKEN_TTL_REMEMBER = 30 * 24 * 60 * 60 * 1000;         // 勾了「记住密码」：30 天
const revokedTokens = new Set();                             // 已登出的 token 摘要（内存）

function tokenSecret() {
  let secret = store.getSetting('auth_secret');
  if (!secret) {
    secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    store.setSetting('auth_secret', secret);
  }
  return secret;
}
function tokenDigest(token) {
  return crypto.createHmac('sha256', tokenSecret()).update(String(token)).digest('base64url');
}
function issueToken(user, ttlMs = TOKEN_TTL) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, u: user.username, exp: Date.now() + ttlMs }), 'utf8').toString('base64url');
  return `${payload}.${tokenDigest(payload)}`;
}
// 校验：签名正确 + 未过期 + 未被登出
function readToken(token) {
  const str = String(token || '').trim();
  const dot = str.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = str.slice(0, dot);
  const sig = str.slice(dot + 1);
  const expect = tokenDigest(payload);
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  if (revokedTokens.has(payload)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!obj || !obj.uid || !(Number(obj.exp) > Date.now())) return null;
    return obj;
  } catch {
    return null;
  }
}

function revokeToken(token) {
  const str = String(token || '').trim();
  const dot = str.lastIndexOf('.');
  if (dot > 0) revokedTokens.add(str.slice(0, dot));
}

// 返回当前登录用户；未登录 / 过期则已发送 401 并返回 null
function requireUser(req, res) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const hit = readToken(token);
  if (!hit) {
    sendJson(res, 401, { error: 'unauthorized', message: '登录已失效，请重新登录' });
    return null;
  }
  const user = store.getUser(hit.uid);
  if (!user) {
    revokeToken(token);
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
  // 记住密码：勾选后签发 30 天的 token（前端存 localStorage，重开浏览器仍免登录）
  const ttl = body.remember ? TOKEN_TTL_REMEMBER : TOKEN_TTL;
  sendJson(res, 200, { token: issueToken(user, ttl), ttlMs: ttl, user: { id: user.id, username: user.username, role: user.role, avatar: user.avatar } });
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
    questionTypes: store.QUESTION_TYPES,
    itemTypeLabels: store.ITEM_TYPE_LABELS,
    itemVariants: store.ITEM_VARIANTS,
    itemLimits: store.ITEM_LIMITS,
    limitMeta: store.LIMIT_META,
    limitSpec: store.LIMIT_SPEC,
    limitDefaults: store.DEFAULT_LIMITS,
    abandonAfterMinutes: store.getAbandonAfterMinutes(),
    itemDefaults: store.itemDefaults(),
    defaultQuestionnaireItems: store.defaultQuestionnaireItems(),
    resumeWindowHours: store.getResumeWindowHours()
  });
}

function adminSettingsPayload() {
  return {
    resumeWindowHours: store.getResumeWindowHours(),
    abandonAfterMinutes: store.getAbandonAfterMinutes()
  };
}

function handleAdminGetSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { settings: adminSettingsPayload() });
}

async function handleAdminSaveSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);
  if (body.resumeWindowHours != null) store.setResumeWindowHours(body.resumeWindowHours);
  if (body.abandonAfterMinutes != null) store.setAbandonAfterMinutes(body.abandonAfterMinutes);
  sendJson(res, 200, { settings: adminSettingsPayload() });
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
  sendJson(res, 200, { experiment: store.updateExperiment(experiment.id, { name, items: body.items }) });
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
  sendJson(res, 200, { questionnaire: store.createQuestionnaire({ title, items: body.items, ownerId: user.id }) });
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
  sendJson(res, 200, { questionnaire: store.updateQuestionnaire(questionnaire.id, { title, items: body.items }) });
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

// 各作答单元的题号（与 parseSession 同一口径）：非 message 依次入列，需要作答的题型才编号
function unitQnosOf(items) {
  const qnos = [];
  let qno = 0;
  for (const it of items) {
    if (it.type === 'message') continue;
    const isQuestion = store.QUESTION_TYPES.includes(it.type);
    if (isQuestion) qno += 1;
    qnos.push(isQuestion ? qno : 0);
  }
  return qnos;
}

// 已完成作答单元里属于「题号」的个数（题号口径的进度；不数知情同意 / 确认页 / 结束说明）
function answeredQuestionsOf(rows, unitQnos) {
  const units = new Set();
  for (const r of rows) units.add(Number(r.unit_index) || 0);
  let n = 0;
  for (const ui of units) if ((unitQnos[ui] || 0) > 0) n += 1;
  return n;
}

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
  const unitQnos = unitQnosOf(payload.items);
  const totalQuestions = unitQnos.filter((q) => q > 0).length;

  // 会话进度按「题号」报（完成会话 = 24/24 题）；answerCount 保留为作答行数（旧口径，自检在用）
  const acc = new Map();      // session_id -> { rows, units: Set }
  for (const r of store.listResponseRows(id)) {
    let a = acc.get(r.session_id);
    if (!a) { a = { rows: 0, units: new Set() }; acc.set(r.session_id, a); }
    a.rows += 1;
    a.units.add(Number(r.unit_index) || 0);
  }

  const sessions = store.listSessionSummaries(id).map((s) => {
    const a = acc.get(s.id) || { rows: 0, units: new Set() };
    let answered = 0;
    for (const ui of a.units) if ((unitQnos[ui] || 0) > 0) answered += 1;
    return {
      id: s.id,
      seq: s.seq == null ? null : Number(s.seq),
      status: s.status,
      statusLabel: STATUS_LABELS[s.status] || s.status,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      durationSec: s.duration_sec == null ? null : Number(s.duration_sec),
      answerCount: a.rows,          // 作答行数（题组按子题分行；旧口径，保持不变）
      answeredQuestions: answered   // 已答完的题数（题号口径，界面进度列用）
    };
  });

  sendJson(res, 200, {
    questionnaire: payload,
    sessions,
    sessionCount: sessions.length,
    totalQuestions
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
  const unitQnos = unitQnosOf(items);
  const responseRows = store.listResponses(session.id);

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
      totalAnswers: items.filter((it) => it.type !== 'message').length,
      totalQuestions: unitQnos.filter((q) => q > 0).length,
      answeredQuestions: answeredQuestionsOf(responseRows, unitQnos)
    },
    messages: store.listMessages(session.id),
    responses: responseRows.map((r) => {
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
        elapsedMs: r.elapsed_ms,
        retryCount: Number(r.retry_count) || 0,     // 提交前的重试次数（超时后点「重试」+「需输入指定内容」的断言失败）
        timedOut: Boolean(r.timed_out)              // 是否曾到点未交
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
  // 默认排除「已作废」的会话（重做 / 太久未提交被系统作废）；需要时带 includeAbandoned=1
  const includeAbandoned = url.searchParams.get('includeAbandoned') === '1';
  const payload = store.getQuestionnairePayload(id);

  const items = payload.items;
  const labels = itemLabelMap(items);

  const ratingPrefixes = scaleColumns(items);
  const textItems = textColumns(items);
  const choiceItems = choiceColumns(items);

  // ---- sheet 1：汇总（一被试一行）
  const summaries = store.listQuestionnaireSummaryRows(id, { includeAbandoned });
  const summaryColumns = [
    { title: '被试编号', width: 10 },
    { title: '被试自填编号', width: 14 },   // 知情同意页「含编号」形态里被试填的；普通形态为空
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
      s.enteredCode || '',
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
  const detailRows = store.listResponseRows(id, { includeAbandoned }).map((r) => [
    r.seq == null ? '' : Number(r.seq),
    STATUS_LABELS[r.session_status] || r.session_status || '',
    labels.get(`${r.item_id}#${r.sub_index || 0}`) || r.item_id,
    store.ITEM_TYPE_LABELS[r.item_type] || r.item_type,
    r.value == null ? '' : Number(r.value),
    (r.item_type === 'text' ? textOf(r.value_text) : '') || r.option_label || '',
    fmtLocal(r.presented_at),
    fmtLocal(r.answered_at),
    sec(r.elapsed_ms),
    Number(r.retry_count) || 0,          // 提交前的重试次数（超时后点「重试」+「需输入指定内容」的断言失败）
    r.timed_out ? '是' : ''              // 是否曾到点未交（超时）
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
        { title: '耗时（秒）', width: 11 },
        { title: '重试次数', width: 11 },
        { title: '曾超时未交', width: 12 }
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

// 连接页模板（public/connect.html，占位符替换）：版式单独放文件里，改样式不用动服务端代码
const CONNECT_TEMPLATE = (() => {
  try {
    return fs.readFileSync(path.join(PUBLIC_DIR, 'connect.html'), 'utf8');
  } catch {
    return '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><body style="font-family:sans-serif;padding:32px">'
      + '<h1>连接页模板缺失</h1><p>请确认 public/connect.html 存在（便携包是否完整解压）。</p></body></html>';
  }
})();

function buildConnectHtml() {
  const urls = lanAddresses().map(entryUrl);
  const primary = urls[0] || entryUrl('');
  const altBlock = urls.length > 1
    ? `<li>若上方地址无法访问，可尝试备选地址：<ul class="alt">${urls.slice(1).map((u) => `<li><code>${u}</code></li>`).join('')}</ul></li>`
    : '';
  return CONNECT_TEMPLATE
    .replaceAll('{{QR_SVG}}', qrSvgFor(primary))
    .replaceAll('{{PRIMARY_URL}}', primary)
    .replaceAll('{{ALT_BLOCK}}', altBlock)
    .replaceAll('{{PORT}}', String(PORT));
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
    if (pathname === '/api/heartbeat' && req.method === 'POST') return await handleHeartbeat(req, res);
    if (pathname === '/api/admin/preview' && req.method === 'POST') return await handleAdminPreviewCreate(req, res);
    if (pathname === '/api/preview/bootstrap' && req.method === 'GET') return await handlePreviewBootstrap(req, res, url);
    if (pathname === '/api/preview/session' && req.method === 'POST') return await handlePreviewSession(req, res);
    if (pathname === '/api/preview/step' && req.method === 'POST') return await handlePreviewStep(req, res);
    if (pathname === '/api/preview/seek' && req.method === 'POST') return await handlePreviewSeek(req, res);
    if (pathname === '/api/preview/seek-unit' && req.method === 'POST') return await handlePreviewSeekUnit(req, res);
    if (pathname === '/api/preview/speed' && req.method === 'POST') return await handlePreviewSpeed(req, res);
    if (pathname === '/api/preview/destroy' && req.method === 'POST') return await handlePreviewDestroy(req, res);
    if (pathname === '/api/preview/finish' && req.method === 'POST') return await handlePreviewFinish(req, res);
    if (pathname === '/api/step/retry' && req.method === 'POST') return await handleStepRetry(req, res);

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
