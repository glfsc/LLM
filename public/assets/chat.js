// 被试端：统一题目模型 · 内联一问一答
// 呈现方式：消息（打字机）穿插题目卡片；每道题「一个问题一个答案」——
//   未作答：卡片内直接给出作答控件，全部题型都点「确认提交 / 提交创作」提交（门控期间控件可填，只有提交按钮置灰）
//   已作答：控件就地保留为只读（选中态 + ✓ 已提交），卡片可折叠（顶部一个按钮可折叠全部已答题目，便于回看材料）
// 计时门控以服务端时间为准：延迟发出（等待「对方正在输入…」）、作答前强制等待、作答窗口（最短提交 / 最长作答自动提交）。
'use strict';

const params = new URLSearchParams(location.search);
const questionnaireCode = (params.get('q') || '').trim();
const forceFresh = params.get('fresh') === '1';

const $stream = document.getElementById('chat-stream');
const $scroll = document.getElementById('chat-scroll');
const $brandSub = document.getElementById('brand-sub');
const $btnCollapseAll = document.getElementById('btn-collapse-all');
const $pageScreen = document.getElementById('page-screen');
const $pageTitle = document.getElementById('page-title');
const $pageText = document.getElementById('page-text');
const $pageCheckWrap = document.getElementById('page-check-wrap');
const $pageCheck = document.getElementById('page-check');
const $pageCheckLabel = document.getElementById('page-check-label');
const $pageHint = document.getElementById('page-hint');
const $pageBtn = document.getElementById('page-btn');
const $errorScreen = document.getElementById('error-screen');
const $errorText = document.getElementById('error-text');

const state = {
  sessionId: null,
  action: null,
  busy: false,
  completed: false,
  renderedMessages: 0,      // 已渲染的 assistant 消息数（用于增量拉取）
  serverOffsetMs: 0,
  pendingAtMs: 0,
  waitingRow: null,
  questionNodes: new Map(), // itemId -> { card, ... } 当前待作答卡片
  answeredCount: 0,
  totalAnswers: 0,
  collapseAll: false,
  draft: {},                // itemId -> { subIndex: text }
  deadlineFired: false
};

const STORAGE_PREFIX = 'expchat_q_';
const DRAFT_PREFIX = 'expchat_draft_';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `请求失败（${res.status}）`);
    err.code = data.error;
    throw err;
  }
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function scrollToBottom(smooth = true) {
  $scroll.scrollTo({ top: $scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}
function scrollToNode(node) {
  if (!node) return;
  // 用 rect 计算：滚动容器是 static 定位，offsetTop 会相对于 body，导致滚到底部
  const top = node.getBoundingClientRect().top - $scroll.getBoundingClientRect().top + $scroll.scrollTop - 12;
  $scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

// 一轮推进（提交 / 拉取）结束时，把视口落在「本轮新增内容的开头」，让被试从上往下读（issue 5）
let stepAnchorNode = null;
let stepMarked = false;
function markStepStart() { stepAnchorNode = $stream.lastElementChild; stepMarked = true; }
function takeFirstNewNode(fallback) {
  const first = !stepMarked
    ? fallback
    : (!stepAnchorNode || !stepAnchorNode.isConnected
      ? ($stream.firstElementChild || fallback)
      : (stepAnchorNode.nextElementSibling || fallback));
  stepMarked = false;
  stepAnchorNode = null;
  return first;
}
function serverNow() {
  return Date.now() + state.serverOffsetMs;
}

/* ---------------------------------------------------------------- 本机记录 */

function loadStoredSession() {
  if (forceFresh) return '';
  try { return localStorage.getItem(STORAGE_PREFIX + questionnaireCode) || ''; } catch { return ''; }
}
function storeSession(id) {
  try { localStorage.setItem(STORAGE_PREFIX + questionnaireCode, id); } catch { /* 忽略 */ }
}
function clearStoredSession() {
  try { localStorage.removeItem(STORAGE_PREFIX + questionnaireCode); } catch { /* 忽略 */ }
}
function draftKey(itemId) { return `${DRAFT_PREFIX}${questionnaireCode}_${itemId}`; }
function saveDraft(itemId, map) {
  try {
    const empty = Object.values(map || {}).every((v) => !String(v || '').trim());
    if (empty) localStorage.removeItem(draftKey(itemId));
    else localStorage.setItem(draftKey(itemId), JSON.stringify(map));
  } catch { /* 忽略 */ }
}
function loadDraft(itemId) {
  try {
    const raw = localStorage.getItem(draftKey(itemId));
    return raw ? JSON.parse(raw) || {} : {};
  } catch { return {}; }
}
function clearDraft(itemId) {
  try { localStorage.removeItem(draftKey(itemId)); } catch { /* 忽略 */ }
}

/* ---------------------------------------------------------------- 消息渲染 */

function appendUserMessage(text) {
  const row = el('div', 'msg user');
  const bubble = el('div', 'bubble');
  bubble.textContent = text;
  row.appendChild(bubble);
  $stream.appendChild(row);
  scrollToBottom();
}

function appendAiMessageStatic(text) {
  const row = el('div', 'msg ai');
  const body = el('div', 'ai-body');
  body.appendChild(el('div', 'ai-text', text));
  row.appendChild(body);
  $stream.appendChild(row);
  return row;
}

function appendThinkingRow() {
  const row = el('div', 'msg ai');
  const body = el('div', 'ai-body thinking-line');
  body.appendChild(el('span', 'thinking-label', '正在思考'));
  const typing = el('div', 'typing');
  typing.append(el('span'), el('span'), el('span'));
  body.appendChild(typing);
  row.appendChild(body);
  $stream.appendChild(row);
  scrollToBottom();
  return row;
}

function showWaitingRow() {
  if (state.waitingRow) return state.waitingRow;
  const row = el('div', 'msg ai');
  const body = el('div', 'ai-body thinking-line');
  const label = el('span', 'thinking-label', '对方正在输入…');
  const typing = el('div', 'typing');
  typing.append(el('span'), el('span'), el('span'));
  body.append(label, typing);
  row.appendChild(body);
  $stream.appendChild(row);
  scrollToBottom();
  state.waitingRow = { row, label };
  return state.waitingRow;
}

function removeWaitingRow() {
  if (state.waitingRow) { state.waitingRow.row.remove(); state.waitingRow = null; }
  state.pendingAtMs = 0;
}

// 打字机与思考节奏由服务端按消息下发（think_ms / type_ms；题目可覆盖，否则用问卷默认）
// 标点在基础速度上额外停顿，读起来更像真实输入
const PUNCT_PAUSE = '，。；：！？、,.!?;:';
const PUNCT_EXTRA = 54;          // 标点额外停顿（毫秒）
const THINK_MS_DEFAULT = 420;    // 未配置时的思考时长
const TYPE_MS_DEFAULT = 11;      // 未配置时的流式速度

function typewrite(textEl, text, typeMs) {
  const speed = Number.isFinite(Number(typeMs)) ? Number(typeMs) : TYPE_MS_DEFAULT;
  if (speed <= 0) { textEl.textContent = text; scrollToBottom(false); return Promise.resolve(); }
  return new Promise((resolve) => {
    let i = 0;
    textEl.classList.add('typing');
    const step = () => {
      if (i >= text.length) { textEl.classList.remove('typing'); resolve(); return; }
      textEl.textContent += text[i];
      i += 1;
      if (i % 5 === 0 || i === text.length) scrollToBottom(false);
      window.setTimeout(step, PUNCT_PAUSE.includes(text[i - 1]) ? speed + PUNCT_EXTRA : speed);
    };
    step();
  });
}

// 先「正在思考」（thinkMs = 0 则跳过），再流式输出（typeMs = 0 则立即整段显示）
async function appendAiMessageAnimated(text, rhythm) {
  const thinkMs = rhythm && Number.isFinite(Number(rhythm.thinkMs)) ? Number(rhythm.thinkMs) : THINK_MS_DEFAULT;
  const typeMs = rhythm && Number.isFinite(Number(rhythm.typeMs)) ? Number(rhythm.typeMs) : TYPE_MS_DEFAULT;
  if (thinkMs > 0) {
    const thinking = appendThinkingRow();
    await sleep(thinkMs);
    thinking.remove();
  }
  const row = appendAiMessageStatic('');
  await typewrite(row.querySelector('.ai-text'), text, typeMs);
  scrollToBottom();
  return row;
}

// 只渲染 AI 消息：被试的答案显示在对应题目卡片内（一个问题一个答案，不重复堆叠）
async function renderMessages(messages, animate) {
  let consumed = 0;
  for (const m of messages) {
    consumed += 1;
    if (m.role !== 'assistant') continue;
    if (animate) await appendAiMessageAnimated(m.content, { thinkMs: m.think_ms, typeMs: m.type_ms });
    else appendAiMessageStatic(m.content);
  }
  return consumed;
}

/* ---------------------------------------------------------------- 全屏页面（知情同意 / 结束说明） */

let pageHandler = null;
let pageHideTimer = null;

function showPage({ title, text, check, button, requireCheck }) {
  clearTimeout(pageHideTimer);
  $pageTitle.textContent = title || '';
  $pageText.textContent = text || '';
  if (check) {
    $pageCheckWrap.classList.remove('hidden');
    $pageCheckLabel.textContent = check;
    $pageCheck.checked = false;
    $pageBtn.disabled = !!requireCheck;
    $pageBtn.textContent = button || '继续';
  } else {
    $pageCheckWrap.classList.add('hidden');
    $pageBtn.disabled = false;
    $pageBtn.textContent = button || '继续';
  }
  $pageHint.classList.add('hidden');
  $pageScreen.classList.remove('hidden');
  requestAnimationFrame(() => $pageScreen.classList.add('visible'));
}

function hidePage() {
  $pageScreen.classList.remove('visible');
  clearTimeout(pageHideTimer);
  pageHideTimer = setTimeout(() => $pageScreen.classList.add('hidden'), 260);
}

$pageCheck.addEventListener('change', () => { $pageBtn.disabled = !$pageCheck.checked; });
$pageBtn.addEventListener('click', async () => { if (pageHandler) await pageHandler(); });

function showError(message) {
  $errorText.textContent = message;
  $errorScreen.classList.remove('hidden');
  requestAnimationFrame(() => $errorScreen.classList.add('visible'));
}

/* ---------------------------------------------------------------- 题目卡片 */

// 自动加高的文本框
function autoGrow(input) {
  const resize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.max(input.scrollHeight, input.dataset.minHeight ? Number(input.dataset.minHeight) : 0)}px`;
  };
  input.addEventListener('input', resize);
  window.setTimeout(resize, 0);
  return resize;
}

function makeTextInput(sub, value, onInput) {
  const rows = Math.max(1, Number(sub.rows) || 1);
  const input = rows > 1 ? el('textarea') : el('input');
  if (rows > 1) {
    input.rows = rows;
    input.dataset.minHeight = String(rows * 24 + 22);
  } else {
    input.type = 'text';
  }
  input.className = 'answer-input';
  input.placeholder = sub.placeholder || '请输入…';
  input.value = value || '';
  input.addEventListener('input', () => onInput(input.value));
  if (rows > 1) autoGrow(input);
  return input;
}

// 子题作答控件：返回 { node, getPayload, isReady, resetState }
// withTitle = false 时不再渲染题干（单题题目已由卡片标题显示，避免重复）
function buildSubControl(sub, value, onChange, onSubmit, withTitle = true) {
  const wrap = el('div', 'sub-control');
  const titleText = sub.title || '';
  if (withTitle) {
    const label = el('div', 'sub-title', titleText);
    // 题干里已写明「上限 N 字 / 选填」时不再重复提示
    if (sub.type === 'text') {
      if (sub.maxLen && !titleText.includes('上限')) label.appendChild(el('span', 'sub-note', `（上限 ${sub.maxLen} 字）`));
      if (sub.required === false && !titleText.includes('选填')) label.appendChild(el('span', 'sub-note', '（选填）'));
    }
    wrap.appendChild(label);
  } else if (sub.type === 'text') {
    // 单题也把字数上限/选填提示显示出来（题干已在卡片标题里）
    const notes = [];
    if (sub.maxLen && !titleText.includes('上限')) notes.push(`上限 ${sub.maxLen} 字`);
    if (sub.required === false && !titleText.includes('选填')) notes.push('选填');
    if (notes.length) wrap.appendChild(el('div', 'sub-title sub-note-only', `（${notes.join(' · ')}）`));
  }

  if (sub.type === 'text') {
    const input = makeTextInput(sub, value, (v) => { onChange(v); refresh(); });
    wrap.appendChild(input);
    const count = sub.maxLen ? el('div', 'sub-count') : null;
    const refresh = () => {
      if (count) count.textContent = `${input.value.length}/${sub.maxLen}`;
      onSubmit && onSubmit();
    };
    if (count) { refresh(); wrap.appendChild(count); }
    return {
      node: wrap,
      getPayload: () => ({ text: input.value.trim() }),
      isReady: () => (sub.required === false ? true : input.value.trim().length > 0),
      focus: () => input.focus()
    };
  }
  if (sub.type === 'rating') {
    const row = el('div', 'opt-row rating-row');
    let picked = value == null ? null : Number(value);
    const min = Number(sub.min) || 1;
    const max = Number(sub.max) || 5;
    for (let v = min; v <= max; v += 1) {
      const btn = el('button', 'rating-btn', String(v));
      btn.type = 'button';
      if (picked === v) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        picked = v;
        row.querySelectorAll('.rating-btn').forEach((b) => b.classList.toggle('selected', b === btn));
        onChange(v);
        if (sub.anchor) anchor.classList.remove('hidden');
        onSubmit && onSubmit();
      });
      row.appendChild(btn);
    }
    wrap.appendChild(row);
    const anchor = el('div', 'sub-anchor', sub.anchor || '');
    if (!sub.anchor) anchor.classList.add('hidden');
    wrap.appendChild(anchor);
    return { node: wrap, getPayload: () => ({ value: picked }), isReady: () => picked != null };
  }
  if (sub.type === 'single' || sub.type === 'multi') {
    const multi = sub.type === 'multi';
    const picked = new Set(multi ? (Array.isArray(value) ? value : []) : (value == null ? [] : [Number(value)]));
    const row = el('div', 'opt-row' + (sub.options.length > 2 ? '' : ' one-col'));
    (sub.options || []).forEach((opt) => {
      const btn = el('button', 'option-btn', opt.label);
      btn.type = 'button';
      if (picked.has(opt.value)) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        if (multi) {
          if (picked.has(opt.value)) picked.delete(opt.value);
          else picked.add(opt.value);
          btn.classList.toggle('selected', picked.has(opt.value));
          onChange([...picked]);
          onSubmit && onSubmit();
        } else {
          picked.clear();
          picked.add(opt.value);
          row.querySelectorAll('.option-btn').forEach((b) => b.classList.toggle('selected', b === btn));
          onChange(opt.value);
          onSubmit && onSubmit();
        }
      });
      row.appendChild(btn);
    });
    wrap.appendChild(row);
    return {
      node: wrap,
      getPayload: () => (multi ? { values: [...picked] } : { value: [...picked][0] }),
      isReady: () => picked.size > 0
    };
  }
  if (sub.type === 'rank') {
    const order = Array.isArray(value) && value.length === sub.options.length ? [...value] : sub.options.map((o) => o.value);
    const list = el('div', 'rank-list');
    const rebuild = () => {
      list.innerHTML = '';
      order.forEach((v, idx) => {
        const row = el('div', 'rank-item');
        row.appendChild(el('span', 'rank-seq', String(idx + 1)));
        row.appendChild(el('span', 'rank-label', (sub.options.find((o) => o.value === v) || {}).label || ''));
        const up = el('button', 'mini-btn', '↑');
        up.type = 'button';
        up.disabled = idx === 0;
        up.addEventListener('click', () => { [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]]; onChange([...order]); rebuild(); });
        const down = el('button', 'mini-btn', '↓');
        down.type = 'button';
        down.disabled = idx === order.length - 1;
        down.addEventListener('click', () => { [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]]; onChange([...order]); rebuild(); });
        row.append(up, down);
        list.appendChild(row);
      });
    };
    rebuild();
    wrap.appendChild(list);
    return { node: wrap, getPayload: () => ({ order: [...order] }), isReady: () => order.length > 0 };
  }
  wrap.appendChild(el('div', 'sub-note', '（不支持的子题类型）'));
  return { node: wrap, getPayload: () => ({}), isReady: () => false };
}

// 渲染当前待作答题目卡片（内联）
function renderQuestionCard(action) {
  state.questionNodes.clear();
  state.deadlineFired = false;

  const card = el('div', 'qcard pending');
  card.dataset.itemId = action.itemId;
  const head = el('div', 'qcard-head');
  head.appendChild(el('span', 'qnum', `第 ${state.answeredCount + 1} 题`));
  head.appendChild(el('span', 'qtitle', action.title || ''));
  const timer = el('span', 'qcard-timer hidden');
  head.appendChild(timer);
  card.appendChild(head);

  const body = el('div', 'qcard-body');
  const draft = loadDraft(action.itemId);
  const controls = [];
  let submitBtn = null;

  const collect = () => {
    const payload = {};
    if (action.type === 'group') {
      payload.answers = controls.map((c) => c.getPayload());
    } else {
      Object.assign(payload, controls[0].getPayload());
    }
    return payload;
  };
  const ready = () => controls.every((c) => c.isReady());
  // 提交按钮启用条件：未在提交中 + 必答已完成 + 已过「作答前强制等待 / 最短提交时间」
  // 门控期间只置灰按钮，控件照常可填（issue 6）
  const gateOk = () => {
    const now = serverNow();
    if (action.availableAtMs && now < action.availableAtMs) return false;
    if (action.minSubmitAtMs && now < action.minSubmitAtMs) return false;
    return true;
  };
  const refresh = () => {
    if (submitBtn) submitBtn.disabled = state.busy || !ready() || !gateOk();
  };

  if (action.type === 'group') {
    if (action.text) body.appendChild(el('div', 'qtext', action.text));
    const wrap = el('div', 'subs' + (action.layout === 'row' ? ' row' : ''));
    action.subs.forEach((sub, i) => {
      const initial = draft[i] != null ? draft[i] : null;
      const ctl = buildSubControl(
        sub,
        initial,
        (v) => { state.draft[action.itemId] = state.draft[action.itemId] || {}; state.draft[action.itemId][i] = v; saveDraft(action.itemId, state.draft[action.itemId]); refresh(); },
        refresh
      );
      controls.push(ctl);
      wrap.appendChild(ctl.node);
    });
    body.appendChild(wrap);
  } else if (action.type === 'text') {
    const ctl = buildSubControl({ ...action, type: 'text' }, draft[0] != null ? draft[0] : '', (v) => {
      state.draft[action.itemId] = { 0: v };
      saveDraft(action.itemId, state.draft[action.itemId]);
      refresh();
    }, refresh, false);
    controls.push(ctl);
    body.appendChild(ctl.node);
  } else {
    // 打分局 / 单选 / 多选 / 排序：点选只做选中，统一由「确认提交」提交（issue 2）
    const ctl = buildSubControl(action, draft[0] != null ? draft[0] : null, (v) => {
      state.draft[action.itemId] = { 0: v };
    }, refresh, false);
    controls.push(ctl);
    body.appendChild(ctl.node);
  }

  // 门控与提示：所有题型统一手动提交
  const foot = el('div', 'qcard-foot');
  const hint = el('span', 'qfoot-hint');
  foot.appendChild(hint);
  submitBtn = el('button', 'primary-btn', action.type === 'group' ? '提交创作' : '确认提交');
  submitBtn.type = 'button';
  submitBtn.disabled = true;
  submitBtn.addEventListener('click', () => submit(action, collect()));
  foot.appendChild(submitBtn);
  card.append(body, foot);
  $stream.appendChild(card);

  const node = { card, hint, timer, submitBtn, action, controls, ready, refresh, collect };
  state.questionNodes.set(action.itemId, node);
  refresh();
  return node;
}

// 已作答题目：**保留原控件**并置为只读（选中态与输入内容就地保留），移除提交按钮，标题栏加「已提交」与折叠按钮
function finalizeQuestionCard(action, answerText) {
  const node = state.questionNodes.get(action.itemId);
  if (!node) return;
  const { card } = node;
  card.classList.remove('pending');
  card.classList.add('done');
  const bodyEl = card.querySelector('.qcard-body');
  if (bodyEl) {
    bodyEl.classList.add('readonly');
    bodyEl.querySelectorAll('input, textarea').forEach((input) => input.setAttribute('readonly', 'readonly'));
    bodyEl.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
  }
  card.querySelector('.qcard-foot')?.remove();
  card.querySelector('.qcard-timer')?.remove();      // 已提交：撤掉倒计时
  const head = card.querySelector('.qcard-head');
  if (head) head.appendChild(el('span', 'qdone-mark', '✓ 已提交'));
  const toggle = el('button', 'mini-btn qcard-toggle', '折叠');
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    const collapsed = card.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '展开' : '折叠';
  });
  card.querySelector('.qcard-head').appendChild(toggle);
  state.questionNodes.delete(action.itemId);
}

function setCollapseAll(flag) {
  state.collapseAll = flag;
  document.querySelectorAll('.qcard.done').forEach((card) => {
    card.classList.toggle('collapsed', flag);
    const t = card.querySelector('.qcard-toggle');
    if (t) t.textContent = flag ? '展开' : '折叠';
  });
  $btnCollapseAll.textContent = flag ? '展开全部' : '折叠已答题';
}

/* ---------------------------------------------------------------- 提交 */

async function postStep(payload) {
  const delays = [0, 400, 1200];
  let lastErr = null;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      return await api('/api/step', { method: 'POST', body: payload });
    } catch (err) {
      lastErr = err;
      const retriable = !err.code || ['server_error', 'body_too_large'].includes(err.code);
      if (!retriable) throw err;
    }
  }
  throw lastErr;
}

function echoOf(action, payload) {
  if (action.type === 'group') {
    return action.subs.map((sub, i) => {
      const one = (payload.answers || [])[i] || {};
      if (sub.type === 'text') return `${sub.title}：${one.text || '（未填写）'}`;
      if (sub.type === 'rating') return `${sub.title}：${one.value} 分`;
      if (sub.type === 'multi') return `${sub.title}：${(one.values || []).map((v) => (sub.options.find((o) => o.value === v) || {}).label).join('、')}`;
      if (one.order) return `${sub.title}：${one.order.map((v, k) => `${k + 1}. ${(sub.options.find((o) => o.value === v) || {}).label}`).join('  ')}`;
      return `${sub.title}：${(sub.options.find((o) => o.value === one.value) || {}).label || one.value}`;
    }).join('\n');
  }
  if (action.type === 'text') return `我的回答：「${payload.text || '（空）'}」`;
  if (action.type === 'multi') return `我的选择：${(payload.values || []).map((v) => (action.options.find((o) => o.value === v) || {}).label).join('、')}`;
  if (action.type === 'rank') return `我的排序：${(payload.order || []).map((v, i) => `${i + 1}. ${(action.options.find((o) => o.value === v) || {}).label}`).join('  ')}`;
  const opt = (action.options || []).find((o) => o.value === payload.value);
  return action.type === 'rating' ? `评分：${payload.value} 分` : `我的选择：${opt ? opt.label : payload.value}`;
}

async function submit(action, payload) {
  if (state.busy || state.completed || !state.sessionId) return;
  state.busy = true;
  const node = state.questionNodes.get(action.itemId);
  if (node && node.submitBtn) node.submitBtn.disabled = true;
  const elapsedMs = Math.round(performance.now() - (state.actionShownAt || performance.now()));
  const echo = echoOf(action, payload);
  finalizeQuestionCard(action, echo);            // 卡片立刻收起为「题干 + 答案」
  state.answeredCount += 1;
  delete state.draft[action.itemId];
  clearDraft(action.itemId);
  try {
    const res = await postStep({ sessionId: state.sessionId, ...payload, elapsedMs });
    await afterStep(action, echo, res);
  } catch (err) {
    if (err.code === 'session_closed') { state.completed = true; showFinalPage(action); return; }
    appendAiMessageStatic(err.code === 'too_early' ? '还没有到可以提交的时间，请稍候再试。' : '抱歉，连接似乎出现了问题，请稍后重试。');
  } finally {
    state.busy = false;
  }
}

/* ---------------------------------------------------------------- 负载应用 */

function applyPayload(payload) {
  if (payload.nowMs != null) state.serverOffsetMs = payload.nowMs - Date.now();
  if (payload.answeredCount != null) state.answeredCount = payload.answeredCount;
  if (payload.totalAnswers != null) state.totalAnswers = payload.totalAnswers;
  state.pendingAtMs = payload.pendingAt ? Date.parse(payload.pendingAt) : 0;

  if (state.pendingAtMs && state.pendingAtMs > serverNow()) {
    showWaitingRow();
    return;
  }
  state.pendingAtMs = 0;
  removeWaitingRow();

  const action = payload.action;
  state.action = action || null;
  state.actionShownAt = performance.now();
  if (!action) return;

  if (action.type === 'gate' || action.type === 'debrief') {
    showPage({
      title: action.title,
      text: action.text,
      check: action.type === 'gate' ? action.check : '',
      button: action.button,
      requireCheck: action.type === 'gate'
    });
    pageHandler = async () => {
      if (action.type === 'gate' && !$pageCheck.checked) return;
      hidePage();
      const res = await api('/api/step', {
        method: 'POST',
        body: { sessionId: state.sessionId, ...(action.type === 'gate' ? { consent: true } : { ack: true }), elapsedMs: 800 }
      });
      afterStep(action, '', res);
    };
    return;
  }

  const node = renderQuestionCard(action);
  scrollToNode(takeFirstNewNode(node.card));
}

// 提交后的统一处理：渲染新消息 → 推进到下一题 / 结束
async function afterStep(action, echo, res) {
  state.serverOffsetMs = (res.nowMs || Date.now()) - Date.now();
  markStepStart();
  for (const m of res.messages) {
    if (m.role === 'assistant') await appendAiMessageAnimated(m.content, { thinkMs: m.think_ms, typeMs: m.type_ms });
  }
  if (res.session.status === 'completed') {
    state.completed = true;
    state.action = null;
    removeWaitingRow();
    await sleep(320);
    showFinalPage(action);
    return;
  }
  applyPayload(res);
}

/* ---------------------------------------------------------------- 倒计时循环 */

// 题目右上角倒计时：门控期显示「N 秒后可提交」，门控结束后切换为作答倒计时「剩余 N 秒」
function setTimer(node, text, answering) {
  if (!node.timer) return;
  node.timer.textContent = text || '';
  node.timer.classList.toggle('hidden', !text);
  node.timer.classList.toggle('answering', !!text && !!answering);
}

setInterval(() => {
  const now = serverNow();

  // 等待 AI 回复：只显示「对方正在输入…」，不暴露还需要多久
  const action = state.action;
  if (!action || state.busy || state.completed) return;
  const node = state.questionNodes.get(action.itemId);
  if (!node) return;
  const { hint, card } = node;
  const shared = action.sharedWindow ? '共用窗口 · ' : '';
  const secs = (ms) => Math.ceil((ms - now) / 1000);

  // 作答前强制等待（控件可填，仅提交按钮置灰；倒计时在右上角）
  if (action.availableAtMs && now < action.availableAtMs) {
    card.classList.add('locked');
    setTimer(node, `阅读中 · ${secs(action.availableAtMs)} 秒后可提交`, false);
    hint.textContent = '';
    node.refresh();
    return;
  }
  if (card.classList.contains('locked')) {
    card.classList.remove('locked');
    node.refresh();
  }

  // 作答窗口：先是最短提交倒计时，到点后切换为作答倒计时
  if (action.minSubmitAtMs || action.deadlineMs) {
    if (action.minSubmitAtMs && now < action.minSubmitAtMs) {
      setTimer(node, `${shared}${secs(action.minSubmitAtMs)} 秒后可提交`, false);
      hint.textContent = '';
      node.refresh();                 // 控件可填，仅提交按钮置灰
      return;
    }
    if (action.deadlineMs) {
      const remain = action.deadlineMs - now;
      if (remain <= 0) {
        setTimer(node, '时间已到', true);
        hint.textContent = '时间已到';
        if (!state.deadlineFired) {
          state.deadlineFired = true;
          // 有内容的文本题 / 题组：到点自动提交；打分、单选等未选时提示先作答
          if (node.ready()) autoSubmitNow(node);
          else hint.textContent = '时间已到，请完成作答后提交';
        }
        node.refresh();
        return;
      }
      setTimer(node, `${shared}作答计时 · 剩余 ${secs(action.deadlineMs)} 秒`, true);
      hint.textContent = '';
      node.refresh();
      return;
    }
    setTimer(node, '', false);
    node.refresh();
    return;
  }
  setTimer(node, '', false);
  hint.textContent = '';
  node.refresh();
}, 250);

// 到点自动提交（无内容时也提交，由服务端接受空文本）
async function autoSubmitNow(node) {
  const action = node.action;
  if (state.busy || state.completed) return;
  state.busy = true;
  const payload = node.collect();
  const echo = echoOf(action, payload) + '\n（时间已到，自动提交）';
  finalizeQuestionCard(action, echo);
  state.answeredCount += 1;
  clearDraft(action.itemId);
  try {
    const res = await postStep({ sessionId: state.sessionId, ...payload, elapsedMs: null });
    await afterStep(action, echo, res);
  } catch (err) {
    appendAiMessageStatic('提交失败，请手动点击提交重试。');
  } finally {
    state.busy = false;
  }
}

// 定时消息到点后拉取增量
let refetching = false;
async function refetchAndAdvance() {
  if (refetching || state.busy || state.completed || !state.sessionId) return;
  refetching = true;
  try {
    const boot = await api(`/api/bootstrap?q=${encodeURIComponent(questionnaireCode)}&session=${encodeURIComponent(state.sessionId)}`);
    if (boot.nowMs != null) state.serverOffsetMs = boot.nowMs - Date.now();
    removeWaitingRow();
    markStepStart();
    const fresh = boot.messages.slice(state.renderedMessages);
    for (const m of fresh) {
      if (m.role === 'assistant') await appendAiMessageAnimated(m.content, { thinkMs: m.think_ms, typeMs: m.type_ms });
    }
    state.renderedMessages = boot.messages.length;
    if (boot.session && boot.session.status === 'completed') {
      state.completed = true;
      state.action = null;
      await sleep(320);
      showFinalPage(null);
      return;
    }
    applyPayload(boot);
  } catch { /* 网络抖动：下个 tick 重试 */ } finally {
    refetching = false;
  }
}

setInterval(() => {
  if (state.pendingAtMs && !state.busy && !state.completed && serverNow() >= state.pendingAtMs) refetchAndAdvance();
}, 300);

// 结束说明页（终态）
function showFinalPage(lastAction) {
  const isDebrief = lastAction && lastAction.type === 'debrief';
  showPage({
    title: isDebrief ? lastAction.title || '实验说明' : '感谢参与',
    text: isDebrief ? lastAction.text : '本次全部任务已完成，感谢您的参与！\n您可以关闭本页面。',
    button: '我是新被试，重新开始'
  });
  $pageCheckWrap.classList.add('hidden');
  // 结束页保留一个「换人」入口：同一台设备给下一位被试时清掉本机记录、重新开一份新会话
  pageHandler = () => {
    clearStoredSession();
    Object.keys(state.draft || {}).forEach((id) => clearDraft(id));
    location.replace(`${location.pathname}?q=${encodeURIComponent(questionnaireCode)}&fresh=1`);
  };
  $pageHint.textContent = '（同一台设备给下一位被试时点上面的按钮开新的一份；直接关闭也可以。）';
  $pageHint.classList.remove('hidden');
}

/* ---------------------------------------------------------------- 初始化 */

async function startSession() {
  const created = await api('/api/session', { body: { q: questionnaireCode } });
  state.sessionId = created.session.id;
  storeSession(created.session.id);
  if (created.questionnaireTitle && $brandSub) {
    $brandSub.textContent = created.questionnaireTitle;
    $brandSub.classList.remove('hidden');
  }
  markStepStart();
  state.renderedMessages = await renderMessages(created.messages, true);
  applyPayload(created);
}

async function init() {
  if (!questionnaireCode) {
    showError('链接无效：缺少问卷参数，请使用管理端复制的问卷链接进入。');
    return;
  }
  try {
    const sid = loadStoredSession();
    const boot = await api(`/api/bootstrap?q=${encodeURIComponent(questionnaireCode)}${sid ? `&session=${encodeURIComponent(sid)}` : ''}`);
    if (boot.questionnaireTitle && $brandSub) {
      $brandSub.textContent = boot.questionnaireTitle;
      $brandSub.classList.remove('hidden');
    }
    if (boot.session) {
      state.sessionId = boot.session.id;
      storeSession(boot.session.id);
      state.renderedMessages = await renderMessages(boot.messages, false);
      scrollToBottom(false);
      if (boot.session.status === 'completed') { state.completed = true; showFinalPage(null); return; }
      applyPayload(boot);
      return;
    }
    clearStoredSession();
    await startSession();
  } catch (err) {
    console.error('[chat] init failed:', err && err.message);
    showError(err.code === 'questionnaire_not_found'
      ? '该链接不存在或已被删除，请检查链接是否正确。'
      : '无法连接到服务，请稍后刷新页面重试。');
  }
}

$btnCollapseAll.addEventListener('click', () => setCollapseAll(!state.collapseAll));

init();
