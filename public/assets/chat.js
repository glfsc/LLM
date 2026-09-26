// 被试端实验流程：AI 消息（思考动画 + 打字机流式）+ 底部决策/评分操作区
// 一致性说明：全部文本由服务端按阶段固定返回，前端只做展示节奏，不做任何内容加工。
// 问卷模式：链接为 /chat?q=<问卷短码>，同一浏览器自动恢复会话（localStorage 按问卷隔离）；
// 被试编号由服务端按进入顺序自动分配；?fresh=1 可强制开始新会话。
'use strict';

/* ---------------------------------------------------------------- 基础 */

const params = new URLSearchParams(location.search);
const questionnaireCode = (params.get('q') || '').trim();
const forceFresh = params.get('fresh') === '1';

const $stream = document.getElementById('chat-stream');
const $scroll = document.getElementById('chat-scroll');
const $actionArea = document.getElementById('action-area');
const $actionQuestion = document.getElementById('action-question');
const $actionOptions = document.getElementById('action-options');
const $actionAnchor = document.getElementById('action-anchor');
const $btnSubmit = document.getElementById('btn-submit');
const $actionHint = document.getElementById('action-hint');
const $errorScreen = document.getElementById('error-screen');
const $errorText = document.getElementById('error-text');
const $consentScreen = document.getElementById('consent-screen');
const $consentText = document.getElementById('consent-text');
const $consentCheckbox = document.getElementById('consent-checkbox');
const $consentError = document.getElementById('consent-error');
const $btnConsent = document.getElementById('btn-consent');
const $debriefScreen = document.getElementById('debrief-screen');
const $debriefTitle = document.getElementById('debrief-title');
const $debriefText = document.getElementById('debrief-text');
const $brandSub = document.getElementById('brand-sub');

const state = {
  sessionId: null,
  seq: null,
  action: null,
  selected: null,
  busy: false,
  completed: false,
  actionShownAt: 0
};

// 问卷级文案（来自服务端 bootstrap / 创建会话，均为快照内容）
let consentText = '';
let debriefText = '';
let consentBusy = false;

// 本机会话记录：按问卷短码隔离，仅用于刷新 / 重进时恢复；服务端失效时自动重建
const STORAGE_PREFIX = 'expchat_q_';

function loadStoredSession() {
  if (forceFresh) return '';
  try {
    return localStorage.getItem(STORAGE_PREFIX + questionnaireCode) || '';
  } catch {
    return '';
  }
}

function storeSession(id) {
  try {
    localStorage.setItem(STORAGE_PREFIX + questionnaireCode, id);
  } catch {
    /* 隐私模式下可能不可用：忽略，刷新后重新进入 */
  }
}

function clearStoredSession() {
  try {
    localStorage.removeItem(STORAGE_PREFIX + questionnaireCode);
  } catch {
    /* 忽略 */
  }
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
      // 实验结束：展示结束说明（未配置时用通用结束语），即为最终界面
      showFinal();
      return;
    }

    renderAction(res.action);
  } catch (err) {
    if (err.code === 'session_closed') {
      state.completed = true;
      showFinal(true);
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
  if (!questionnaireCode) {
    showError('链接无效：缺少问卷参数，请使用管理端复制的问卷链接进入。');
    return;
  }
  try {
    const sid = loadStoredSession();
    const boot = await api(
      `/api/bootstrap?q=${encodeURIComponent(questionnaireCode)}${sid ? `&session=${encodeURIComponent(sid)}` : ''}`
    );

    consentText = boot.consentText || '';
    debriefText = boot.debriefText || '';
    if (boot.questionnaireName && $brandSub) {
      $brandSub.textContent = boot.questionnaireName;
      $brandSub.classList.remove('hidden');
    }

    if (boot.session) {
      state.sessionId = boot.session.id;
      state.seq = boot.session.seq;
      storeSession(boot.session.id);
      await renderMessages(boot.messages, false);
      scrollToBottom(false);

      if (boot.session.status === 'completed') {
        state.completed = true;
        showFinal(true);
        return;
      }
      renderAction(boot.action);
      return;
    }

    // 无有效会话：清理本地记录，按问卷配置决定是否展示知情同意页
    clearStoredSession();
    if (consentText) {
      showConsent();
    } else {
      // 问卷未配置知情同意文案：直接创建会话进入实验
      await startSession();
    }
  } catch (err) {
    showError(
      err.code === 'questionnaire_not_found'
        ? '该问卷链接不存在或已被删除，请检查链接是否正确。'
        : '无法连接到服务，请稍后刷新页面重试。'
    );
  }
}

// 知情同意通过后创建会话，欢迎语与情境材料依次动画输出
async function startSession() {
  const created = await api('/api/session', {
    method: 'POST',
    body: { q: questionnaireCode }
  });
  state.sessionId = created.session.id;
  state.seq = created.session.seq;
  storeSession(created.session.id);
  consentText = created.consentText || consentText;
  debriefText = created.debriefText || debriefText;
  hideConsent();
  await renderMessages(created.messages, true);
  renderAction(created.action);
}

/* ---------------------------------------------------------------- 全屏页（伦理门槛） */

function showConsent() {
  $consentText.textContent = consentText;
  $consentCheckbox.checked = false;
  $btnConsent.disabled = true;
  $consentError.classList.add('hidden');
  $consentScreen.classList.remove('hidden');
  requestAnimationFrame(() => $consentScreen.classList.add('visible'));
}

function hideConsent() {
  $consentScreen.classList.remove('visible');
  setTimeout(() => $consentScreen.classList.add('hidden'), 280);
}

/* ---------------------------------------------------------------- 全屏页 */

// 结束说明（终态）：实验完成后展示，即为最终界面，不提供任何跳转；
// 配置了结束说明用配置文案，否则展示通用结束语。
function showFinal(instant) {
  if (debriefText) {
    $debriefTitle.textContent = '实验说明';
    $debriefText.textContent = debriefText;
  } else {
    $debriefTitle.textContent = '感谢您的参与';
    $debriefText.textContent = '本次实验任务已全部完成，感谢您的参与！\n您可以关闭本页面。';
  }
  $debriefScreen.classList.remove('hidden');
  if (instant) {
    $debriefScreen.classList.add('visible');
  } else {
    requestAnimationFrame(() => $debriefScreen.classList.add('visible'));
  }
}

function showError(message) {
  $errorText.textContent = message;
  $errorScreen.classList.remove('hidden');
  requestAnimationFrame(() => $errorScreen.classList.add('visible'));
}

/* ---------------------------------------------------------------- 事件绑定 */

$btnSubmit.addEventListener('click', submit);

// 知情同意：勾选后才可开始；创建会话失败时就地提示并允许重试
$consentCheckbox.addEventListener('change', () => {
  $btnConsent.disabled = !$consentCheckbox.checked;
});

$btnConsent.addEventListener('click', async () => {
  if (!$consentCheckbox.checked || consentBusy) return;
  consentBusy = true;
  $btnConsent.disabled = true;
  $consentError.classList.add('hidden');
  $btnConsent.textContent = '正在进入…';
  try {
    await startSession();
  } catch (err) {
    $consentError.textContent =
      err.code === 'questionnaire_not_found'
        ? '该问卷链接不存在或已被删除，请检查链接是否正确。'
        : '无法连接到服务，请稍后重试。';
    $consentError.classList.remove('hidden');
  } finally {
    consentBusy = false;
    $btnConsent.textContent = '开始实验';
    $btnConsent.disabled = !$consentCheckbox.checked;
  }
});

// 实验完成即结束：终态页面无任何操作按钮，被试可直接关闭页面

init();
