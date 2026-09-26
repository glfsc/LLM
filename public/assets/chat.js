// 被试端实验流程：AI 消息（思考动画 + 打字机流式）+ 底部决策/评分操作区
// 一致性说明：全部文本由服务端按阶段固定返回，前端只做展示节奏，不做任何内容加工。
'use strict';

/* ---------------------------------------------------------------- 基础 */

const params = new URLSearchParams(location.search);
const groupId = (params.get('group') || '').trim();
const uid = resolveUid();

const $stream = document.getElementById('chat-stream');
const $scroll = document.getElementById('chat-scroll');
const $actionArea = document.getElementById('action-area');
const $actionQuestion = document.getElementById('action-question');
const $actionOptions = document.getElementById('action-options');
const $actionAnchor = document.getElementById('action-anchor');
const $btnSubmit = document.getElementById('btn-submit');
const $actionHint = document.getElementById('action-hint');
const $doneScreen = document.getElementById('done-screen');
const $doneCode = document.getElementById('done-code');
const $btnRestart = document.getElementById('btn-restart');
const $btnHome = document.getElementById('btn-home');
const $errorScreen = document.getElementById('error-screen');
const $errorText = document.getElementById('error-text');

const state = {
  sessionId: null,
  action: null,
  selected: null,
  busy: false,
  completed: false,
  actionShownAt: 0
};

// 无 uid 参数时使用本地匿名编号（同一浏览器保持同一编号，刷新可恢复会话）
function resolveUid() {
  const fromUrl = (params.get('uid') || '').trim();
  if (fromUrl) return fromUrl;
  let value = localStorage.getItem('expchat_anon_uid') || '';
  if (!value) {
    value = 'anon-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('expchat_anon_uid', value);
  }
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
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

/* ---------------------------------------------------------------- 消息渲染 */

function appendUserMessage(text) {
  const row = el('div', 'msg user');
  row.appendChild(el('div', 'bubble', text));
  $stream.appendChild(row);
  scrollToBottom();
}

function appendAiMessageStatic(text) {
  const row = el('div', 'msg ai');
  const body = el('div', 'ai-body');
  const textEl = el('div', 'ai-text', text);
  body.appendChild(textEl);
  row.appendChild(body);
  $stream.appendChild(row);
  return row;
}

// 思考行：「正在思考」+ 三点动画
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

// 打字机：逐字输出固定文本（内容本身与服务端返回完全一致，仅控制展示节奏）
const PUNCT_PAUSE = '，。；：！？、,.!?;:';
const CHAR_SPEED = 17; // 毫秒/字

function typewrite(textEl, text) {
  return new Promise((resolve) => {
    let i = 0;
    textEl.classList.add('typing');
    const step = () => {
      if (i >= text.length) {
        textEl.classList.remove('typing');
        resolve();
        return;
      }
      const ch = text[i];
      textEl.textContent += ch;
      i += 1;
      if (i % 5 === 0 || i === text.length) scrollToBottom(false);
      window.setTimeout(step, PUNCT_PAUSE.includes(ch) ? 110 : CHAR_SPEED);
    };
    step();
  });
}

// “正在思考” → 打字机输出的一条 AI 消息
async function appendAiMessageAnimated(text) {
  const thinkingRow = appendThinkingRow();
  await sleep(620 + Math.random() * 320);
  thinkingRow.remove();
  const row = appendAiMessageStatic('');
  const textEl = row.querySelector('.ai-text');
  await typewrite(textEl, text);
  scrollToBottom();
  return row;
}

// 渲染历史消息（静态）；animate 为真时逐条动画输出
async function renderMessages(messages, animate) {
  for (const m of messages) {
    if (m.role === 'user') {
      appendUserMessage(m.content);
    } else if (animate) {
      await appendAiMessageAnimated(m.content);
    } else {
      appendAiMessageStatic(m.content);
    }
  }
}

/* ---------------------------------------------------------------- 操作区 */

function renderAction(action) {
  state.action = action || null;
  state.selected = null;

  if (!action) {
    $actionArea.classList.add('hidden');
    $btnSubmit.disabled = true;
    return;
  }

  $actionQuestion.textContent = action.question;
  $actionOptions.innerHTML = '';
  $actionOptions.className = `action-options type-${action.type}`;

  for (const opt of action.options) {
    const btn = el(
      'button',
      action.type === 'rating' ? 'rating-btn' : 'option-btn',
      action.type === 'rating' ? String(opt.value) : opt.label
    );
    btn.type = 'button';
    btn.dataset.value = String(opt.value);
    if (action.type === 'rating') btn.title = opt.label;
    btn.addEventListener('click', () => selectOption(opt.value, btn));
    $actionOptions.appendChild(btn);
  }

  $actionAnchor.textContent = action.anchor || '';
  $actionAnchor.classList.toggle('hidden', !action.anchor);
  $btnSubmit.disabled = true;
  $actionArea.classList.remove('hidden');
  $actionHint.classList.add('hidden');
  state.actionShownAt = performance.now();
  scrollToBottom();
}

function selectOption(value, btn) {
  if (state.busy || !state.action) return;
  state.selected = value;
  $actionOptions.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('selected', b === btn);
  });
  $btnSubmit.disabled = false;
}

function setOptionsDisabled(disabled) {
  $actionOptions.querySelectorAll('button').forEach((b) => {
    b.disabled = disabled;
  });
  $btnSubmit.disabled = disabled || state.selected == null;
}

/* ---------------------------------------------------------------- 提交作答 */

async function submit() {
  if (state.busy || state.completed || !state.sessionId) return;
  const action = state.action;
  if (!action || state.selected == null) return;

  const value = state.selected;
  const elapsedMs = Math.round(performance.now() - state.actionShownAt);

  state.busy = true;
  setOptionsDisabled(true);

  // 用户动作回显（与服务端落库文案一致）
  const echo =
    action.type === 'choice'
      ? `我选择：${action.options.find((o) => o.value === value).label}`
      : `相似度评分：${value} 分`;
  appendUserMessage(echo);

  // 收起操作区，等待服务端返回后续内容
  $actionArea.classList.add('hidden');

  try {
    const res = await api('/api/step', {
      method: 'POST',
      body: { sessionId: state.sessionId, value, elapsedMs }
    });

    for (const m of res.messages) {
      await appendAiMessageAnimated(m.content);
    }

    if (res.session.status === 'completed') {
      state.completed = true;
      state.action = null;
      $actionHint.classList.add('hidden');
      await sleep(420);
      showDone(res.session.code || '——');
      return;
    }

    renderAction(res.action);
  } catch (err) {
    if (err.code === 'session_closed') {
      state.completed = true;
      showDone('——');
      return;
    }
    appendAiMessageStatic('抱歉，连接似乎出现了问题，请稍后重试。');
    scrollToBottom();
    // 恢复操作区以便重试
    $actionArea.classList.remove('hidden');
    setOptionsDisabled(false);
  } finally {
    state.busy = false;
  }
}

/* ---------------------------------------------------------------- 初始化 */

async function init() {
  if (!groupId) {
    showError('链接缺少分组参数，请检查链接是否正确。');
    return;
  }
  try {
    const boot = await api(
      `/api/bootstrap?group=${encodeURIComponent(groupId)}&uid=${encodeURIComponent(uid)}`
    );

    if (boot.session) {
      state.sessionId = boot.session.id;
      await renderMessages(boot.messages, false);
      scrollToBottom(false);

      if (boot.session.status === 'completed') {
        state.completed = true;
        showDone(boot.session.code || '——', true);
        return;
      }
      renderAction(boot.action);
      return;
    }

    // 首次进入：创建会话，欢迎语与情境材料依次动画输出
    const created = await api('/api/session', {
      method: 'POST',
      body: { group: groupId, uid }
    });
    state.sessionId = created.session.id;
    await renderMessages(created.messages, true);
    renderAction(created.action);
  } catch (err) {
    showError(
      err.code === 'group_not_found'
        ? '该实验链接不存在或已关闭，请检查链接是否正确。'
        : '无法连接到服务，请稍后刷新页面重试。'
    );
  }
}

/* ---------------------------------------------------------------- 全屏页 */

function showDone(code, instant) {
  $doneCode.textContent = code;
  $doneScreen.classList.remove('hidden');
  if (instant) {
    $doneScreen.classList.add('visible');
  } else {
    requestAnimationFrame(() => $doneScreen.classList.add('visible'));
  }
}

function showError(message) {
  $errorText.textContent = message;
  $errorScreen.classList.remove('hidden');
  requestAnimationFrame(() => $errorScreen.classList.add('visible'));
}

/* ---------------------------------------------------------------- 事件绑定 */

$btnSubmit.addEventListener('click', submit);

// 完成页操作
// — “重新开始”：同一分组下开启一轮全新会话（生成新的演示编号）
// — “返回首页”：回到调试入口，可切换分组
$btnRestart.addEventListener('click', () => {
  const freshUid = 'demo-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  location.href = `/chat?group=${encodeURIComponent(groupId)}&uid=${encodeURIComponent(freshUid)}`;
});

$btnHome.addEventListener('click', () => {
  location.href = '/';
});

init();
