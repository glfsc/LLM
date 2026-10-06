// 通用问卷 · 填写端：对话式逐题作答（单选/多选/填空/评分/排序/问答/实验）
// 一致性说明：用户气泡文案、本地校验规则与服务端 validateSurveyAnswer 完全镜像，
// 服务端为最终仲裁；服务端失效/不同步时自动提示刷新。
// 会话恢复：localStorage 按问卷短码隔离（'expsurvey_c_<code>'），?fresh=1 强制新开会话。
// 预览模式（?preview=1，管理端 iframe）：不建会话、不落库；
//   通过 postMessage 接收 { type:'survey-follow', questionIndex } / { type:'survey-trial' } /
//   { type:'survey-exit-trial' }，消息可携带 survey 对象（用于未保存编辑的实时预览）。
'use strict';

/* ---------------------------------------------------------------- 参数与状态 */

const params = new URLSearchParams(location.search);
const surveyCode = (params.get('c') || '').trim();
const previewMode = params.get('preview') === '1';
const forceFresh = params.get('fresh') === '1';
const urlSessionId = (params.get('session') || '').trim(); // 可选：显式指定会话（换设备恢复）

const $ = (id) => document.getElementById(id);
const $stream = $('chat-stream');
const $scroll = $('chat-scroll');
const $composerWrap = $('composer-wrap');
const $card = $('s-card');
const $tag = $('s-tag');
const $hint = $('s-hint');
const $collapse = $('s-collapse');
const $sTitle = $('s-title');
const $controls = $('s-controls');
const $foot = $('s-foot');
const $anchor = $('s-anchor');
const $btnSkip = $('btn-skip');
const $btnSubmit = $('btn-submit');
const $tip = $('s-tip');
const $err = $('s-err');
const $doneScreen = $('done-screen');
const $doneText = $('done-text');
const $errorScreen = $('error-screen');
const $errorText = $('error-text');
const $brandSub = $('brand-sub');
const $brandTag = $('brand-tag');

const state = {
  survey: null,
  sessionId: null,
  action: null, // 当前作答单元（服务端 action 或本地构建的单元）
  mode: 'live', // live 正式填写 | follow 实时预览 | trial 本地试填
  busy: false,
  completed: false,
  shownAt: 0,
  picked: [], // 当前题的选择（选项索引或评分值）
  otherText: '',
  units: [], // 本地构建的作答单元（预览 / 试填用）
  followIndex: 0,
  trialIdx: 0,
  refreshControls: null // 由 renderControl 注入：重算控件交互状态
};

const STORAGE_PREFIX = 'expsurvey_c_';

const TYPE_LABELS = {
  single: '单选',
  multi: '多选',
  text: '填空',
  rating: '评分',
  rank: '排序',
  qa: '问答',
  experiment: '实验'
};

/* ---------------------------------------------------------------- 基础工具 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

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

function scrollToBottom(smooth = true) {
  $scroll.scrollTo({ top: $scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function loadStoredSession() {
  if (forceFresh) return '';
  try {
    return localStorage.getItem(STORAGE_PREFIX + surveyCode) || '';
  } catch {
    return '';
  }
}

function storeSession(id) {
  try {
    localStorage.setItem(STORAGE_PREFIX + surveyCode, id);
  } catch {
    /* 隐私模式下可能不可用：忽略，刷新后重新创建 */
  }
}

function clearStoredSession() {
  try {
    localStorage.removeItem(STORAGE_PREFIX + surveyCode);
  } catch {
    /* 忽略 */
  }
}

/* ---------------------------------------------------------------- 消息渲染 */

function appendUserMessage(text) {
  const row = el('div', 'msg user');
  row.appendChild(el('div', 'bubble', text));
  $stream.appendChild(row);
  scrollToBottom();
  return row;
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

async function renderMessages(messages, animate) {
  for (const m of messages || []) {
    if (m.role === 'user') {
      appendUserMessage(m.content);
    } else if (animate) {
      await appendAiMessageAnimated(m.content);
    } else {
      appendAiMessageStatic(m.content);
    }
  }
}

// 实验材料图片（聊天流内，位于背景消息之后）
function appendImage(url) {
  const row = el('div', 's-img');
  const img = document.createElement('img');
  img.src = url;
  img.alt = '实验材料';
  img.loading = 'lazy';
  row.appendChild(img);
  $stream.appendChild(row);
  scrollToBottom();
  return row;
}

/* ---------------------------------------------------------------- 作答单元（镜像服务端 buildSurveyUnits） */

function buildLocalUnits(questions) {
  const units = [];
  (questions || []).forEach((q, qi) => {
    if (q.type === 'experiment') {
      const subs = (q.config && q.config.subs) || [];
      if (!subs.length) return; // 空实验跳过
      subs.forEach((sub, si) => {
        units.push({
          questionId: q.id,
          subIndex: si,
          questionIndex: qi,
          isSub: true,
          type: sub.type,
          typeLabel: TYPE_LABELS[sub.type] || sub.type,
          title: sub.title,
          required: sub.required !== false,
          options: sub.options || [],
          config: sub.config || {},
          intro: si === 0
            ? {
                title: q.title,
                background: String((q.config && q.config.background) || '').trim(),
                images: (q.config && q.config.images) || []
              }
            : null
        });
      });
    } else {
      units.push({
        questionId: q.id,
        subIndex: 0,
        questionIndex: qi,
        isSub: false,
        type: q.type,
        typeLabel: TYPE_LABELS[q.type] || q.type,
        title: q.title,
        required: q.required !== false,
        options: q.options || [],
        config: q.config || {},
        intro: null
      });
    }
  });
  return units;
}

function introText(intro) {
  return intro.title ? `${intro.title}\n\n${intro.background}` : intro.background;
}

function unitTag(unit) {
  const label = unit.typeLabel || TYPE_LABELS[unit.type] || unit.type;
  if (unit.isSub) return `实验 ${unit.questionIndex + 1}.${unit.subIndex + 1} · ${label}`;
  return `第 ${unit.questionIndex + 1} 题 · ${label}`;
}

/* ------------------------------------------------- 回显文案与校验（镜像服务端 validateSurveyAnswer） */

function answerTextOf(unit, payload) {
  const labels = (unit.options || []).map(String);
  const otherIndex = labels.length;
  if (payload.skip) return '（跳过）';
  if (unit.type === 'single') {
    if (payload.value === otherIndex) return `我选择：其他（${payload.otherText}）`;
    return `我选择：${labels[payload.value]}`;
  }
  if (unit.type === 'multi') {
    const picked = payload.values.filter((v) => v !== otherIndex).map((v) => labels[v]);
    if (payload.values.includes(otherIndex)) picked.push(`其他（${payload.otherText}）`);
    return `我选择：${picked.join('、')}（共 ${picked.length} 项）`;
  }
  if (unit.type === 'text' || unit.type === 'qa') {
    return payload.text ? `我的回答：${payload.text}` : '（空）';
  }
  if (unit.type === 'rating') return `评分：${payload.value} 分`;
  if (unit.type === 'rank') {
    return '排序：' + payload.order.map((v, i) => `${i + 1}. ${labels[v]}`).join('  ');
  }
  return '';
}

function localError(unit, payload) {
  const cfg = unit.config || {};
  if (payload.skip) {
    if (unit.required !== false) return '本题为必答题，不能跳过';
    return '';
  }
  if (unit.type === 'single') {
    const value = payload.value;
    if (!Number.isInteger(value) || value < 0 || value > (unit.options || []).length) return '作答值不合法';
    if (value === (unit.options || []).length && !String(payload.otherText || '').trim()) {
      return '请填写「其他」的内容';
    }
    return '';
  }
  if (unit.type === 'multi') {
    const minSel = Math.max(1, Number(cfg.minSel) || 0);
    const maxSel = Number(cfg.maxSel) || 0;
    if (payload.values.length < minSel) return minSel > 1 ? `请至少选择 ${minSel} 项` : '请至少选择 1 项';
    if (maxSel > 0 && payload.values.length > maxSel) return `最多选择 ${maxSel} 项`;
    if (payload.values.includes((unit.options || []).length) && !String(payload.otherText || '').trim()) {
      return '请填写「其他」的内容';
    }
    return '';
  }
  if (unit.type === 'text' || unit.type === 'qa') {
    const text = String(payload.text || '');
    const limit = unit.type === 'qa' ? 5000 : 1000;
    if (!text.trim() && unit.required !== false) return '请填写内容后再提交';
    if (text.length > limit) return `内容过长（最多 ${limit} 字）`;
    return '';
  }
  if (unit.type === 'rating') {
    const min = Number(cfg.min ?? 1);
    const max = Number(cfg.max ?? 5);
    if (!Number.isInteger(payload.value) || payload.value < min || payload.value > max) return '评分值不合法';
    return '';
  }
  if (unit.type === 'rank') {
    const n = (unit.options || []).length;
    const sorted = payload.order.slice().sort((a, b) => a - b).join(',');
    const expect = Array.from({ length: n }, (_, i) => i).join(',');
    if (payload.order.length !== n || sorted !== expect) return '请给出完整的排序结果';
    return '';
  }
  return '未知题型';
}

/* ---------------------------------------------------------------- 控件渲染辅助 */

// 评分按钮字号自适应：按每行按钮个数分档
function rateFontSize(cols) {
  if (cols >= 13) return ['9px', '6.5px'];
  if (cols >= 11) return ['10px', '7px'];
  if (cols >= 9) return ['11px', '7.5px'];
  if (cols >= 7) return ['12px', '8.5px'];
  if (cols >= 5) return ['13px', '9.5px'];
  return ['14.5px', '10px'];
}

function showTip(t) {
  $tip.textContent = t;
  $tip.classList.remove('hidden');
}

function hideTip() {
  $tip.textContent = '';
  $tip.classList.add('hidden');
}

function showErr(t) {
  $err.textContent = t;
  $err.classList.remove('hidden');
}

function hideErr() {
  $err.textContent = '';
  $err.classList.add('hidden');
}

function setBusy(flag) {
  if (flag) {
    $btnSubmit.disabled = true;
    $btnSkip.disabled = true;
    $controls.querySelectorAll('button, input, textarea').forEach((b) => {
      b.disabled = true;
    });
  } else {
    $btnSkip.disabled = false;
    $controls.querySelectorAll('button, input, textarea').forEach((b) => {
      b.disabled = false;
    });
    if (state.refreshControls) state.refreshControls();
  }
}

// 排序题：读取当前 DOM 顺序 → 选项索引数组
function rankOrder() {
  const box = $controls.querySelector('.s-rank');
  if (!box) return [];
  return Array.prototype.map.call(box.querySelectorAll('.item'), (it) => Number(it.dataset.i));
}

function currentPayload(unit) {
  const otherIndex = (unit.options || []).length;
  if (unit.type === 'single') {
    if (state.picked.length !== 1) return null;
    const p = { value: state.picked[0] };
    if (p.value === otherIndex) p.otherText = state.otherText.trim();
    return p;
  }
  if (unit.type === 'multi') {
    if (!state.picked.length) return null;
    const values = state.picked.slice().sort((a, b) => a - b);
    const p = { values };
    if (values.includes(otherIndex)) p.otherText = state.otherText.trim();
    return p;
  }
  if (unit.type === 'rating') {
    if (state.picked.length !== 1) return null;
    return { value: state.picked[0] };
  }
  if (unit.type === 'rank') {
    return { order: rankOrder() };
  }
  return null;
}

/* 渲染当前单元的作答控件；提交统一经 dispatch(payload) */
function renderControl(unit) {
  $controls.innerHTML = '';
  hideErr();
  hideTip();
  $anchor.textContent = '';
  $btnSubmit.classList.remove('hidden');
  $btnSubmit.disabled = true;
  $btnSkip.classList.toggle('hidden', unit.required !== false);
  state.picked = [];
  state.otherText = '';
  state.refreshControls = null;

  const cfg = unit.config || {};
  const options = (unit.options || []).map(String);
  const otherIndex = options.length;

  if (unit.type === 'single' || unit.type === 'multi') {
    const grid = el('div', 's-opts');
    grid.style.setProperty('--cols', String(Math.min(Math.max(Number(cfg.layout) || 1, 1), 8)));
    const maxSel = Number(cfg.maxSel) || 0;
    const minSel = Math.max(1, Number(cfg.minSel) || 0);
    const btns = [];

    options.forEach((label, ix) => {
      const b = el('button', 's-opt', label);
      b.type = 'button';
      b.dataset.value = String(ix);
      b.addEventListener('click', () => toggle(ix));
      btns.push(b);
      grid.appendChild(b);
    });

    let otherBtn = null;
    let otherInput = null;
    if (cfg.other) {
      otherBtn = el('button', 's-opt', '其他（请注明）');
      otherBtn.type = 'button';
      otherBtn.dataset.value = String(otherIndex);
      otherBtn.addEventListener('click', () => toggle(otherIndex));
      grid.appendChild(otherBtn);
      const row = el('div', 's-other-row hidden');
      otherInput = document.createElement('input');
      otherInput.type = 'text';
      otherInput.placeholder = '请填写您的答案…';
      otherInput.maxLength = 200;
      otherInput.addEventListener('input', () => {
        state.otherText = otherInput.value;
        update();
      });
      row.appendChild(otherInput);
      grid.appendChild(row);
    }
    $controls.appendChild(grid);

    function update() {
      const all = otherBtn ? btns.concat([otherBtn]) : btns;
      all.forEach((b) => {
        b.classList.toggle('sel', state.picked.includes(Number(b.dataset.value)));
      });
      if (otherInput) {
        const on = state.picked.includes(otherIndex);
        otherInput.parentElement.classList.toggle('hidden', !on);
        if (!on) otherInput.value = '';
      }
      if (unit.type === 'multi' && maxSel > 0) {
        const full = state.picked.length >= maxSel;
        all.forEach((b) => {
          b.disabled = full && !state.picked.includes(Number(b.dataset.value));
        });
      }
      const otherOk = !state.picked.includes(otherIndex) || !!(otherInput && otherInput.value.trim());
      const ok = unit.type === 'single'
        ? state.picked.length === 1 && otherOk
        : state.picked.length >= minSel && otherOk;
      $btnSubmit.disabled = !ok;
      if (unit.type === 'multi') {
        $anchor.textContent = maxSel
          ? `可多选 · 最多 ${maxSel} 项`
          : minSel > 1
            ? `可多选 · 至少 ${minSel} 项`
            : '可多选';
      } else {
        $anchor.textContent = '';
      }
    }

    function toggle(ix) {
      if (state.busy) return;
      if (unit.type === 'single') {
        state.picked = [ix];
      } else {
        const pos = state.picked.indexOf(ix);
        if (pos >= 0) state.picked.splice(pos, 1);
        else state.picked.push(ix);
      }
      hideErr();
      update();
    }

    state.refreshControls = update;
    update();
  } else if (unit.type === 'rating') {
    const min = Number(cfg.min ?? 1);
    const max = Number(cfg.max ?? 5);
    const nBtns = max - min + 1;
    const cols = Number(cfg.cols) > 0 ? Math.min(Number(cfg.cols), nBtns) : nBtns;
    const all = cfg.display === 'all';
    const labels = cfg.labels || {};
    const grid = el('div', 's-rate' + (all ? ' all' : ''));
    grid.style.setProperty('--cols', String(cols));
    const sizes = rateFontSize(cols);
    grid.style.setProperty('--fs', sizes[0]);
    grid.style.setProperty('--fs2', sizes[1]);
    const btns = [];

    function setAnchor(v) {
      if (v != null && labels[v]) {
        $anchor.textContent = `${v} = ${labels[v]}`;
        return;
      }
      if (all) {
        $anchor.textContent = '每档均已标注说明';
        return;
      }
      if (cfg.anchor) {
        $anchor.textContent = String(cfg.anchor);
        return;
      }
      const a = labels[min] ? `${min} = ${labels[min]}` : '';
      const b = labels[max] ? `${max} = ${labels[max]}` : '';
      $anchor.textContent = [a, b].filter(Boolean).join(' · ') || '点击数字完成评分';
    }

    for (let v = min; v <= max; v++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.appendChild(el('span', 'num', String(v)));
      if (all) b.appendChild(el('span', 'txt', labels[v] || ''));
      b.addEventListener('click', () => {
        if (state.busy) return;
        state.picked = [v];
        btns.forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
        $btnSubmit.disabled = false;
        setAnchor(v);
        hideErr();
      });
      btns.push(b);
      grid.appendChild(b);
    }
    $controls.appendChild(grid);
    setAnchor(null);

    state.refreshControls = () => {
      btns.forEach((x) => {
        x.disabled = false;
      });
      $btnSubmit.disabled = state.picked.length !== 1;
    };
  } else if (unit.type === 'rank') {
    const box = el('div', 's-rank');
    options.forEach((label, i) => {
      const item = el('div', 'item');
      item.dataset.i = String(i);
      item.appendChild(el('span', 'idx', String(i + 1)));
      item.appendChild(el('span', 'label', label));
      const grip = el('span', 'grip', '⠿');
      grip.setAttribute('aria-hidden', 'true');
      item.appendChild(grip);
      box.appendChild(item);
    });
    $controls.appendChild(box);
    initRankDrag(box, (t) => {
      $anchor.textContent = t;
    });
    $anchor.textContent = '长按拖动排序';
    $btnSubmit.disabled = false;
    state.refreshControls = () => {
      $btnSubmit.disabled = false;
    };
  } else if (unit.type === 'text' || unit.type === 'qa') {
    $btnSubmit.classList.add('hidden');
    const row = el('div', 's-inputrow');
    const ta = document.createElement('textarea');
    ta.rows = 1;
    ta.placeholder = unit.type === 'qa' ? '输入您的回答，Enter 发送…' : '请输入…';
    ta.maxLength = unit.type === 'qa' ? 5000 : 1000;
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 's-send';
    send.disabled = true;
    send.setAttribute('aria-label', '发送');
    send.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>';

    function grow() {
      ta.style.height = 'auto';
      ta.style.height = Math.min(96, ta.scrollHeight) + 'px';
    }
    function sync() {
      send.disabled = !ta.value.trim() || state.busy;
    }
    function sendNow() {
      const text = ta.value.trim();
      if (!text || state.busy) return;
      dispatch({ text });
    }
    ta.addEventListener('input', () => {
      grow();
      sync();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendNow();
      }
    });
    send.addEventListener('click', sendNow);
    row.appendChild(ta);
    row.appendChild(send);
    $controls.appendChild(row);
    $anchor.textContent = unit.type === 'qa' ? '输入后按 Enter 发送' : '输入内容后发送（Enter 提交）';
    state.refreshControls = () => {
      ta.disabled = false;
      sync();
    };
    // 桌面环境自动聚焦（移动端不聚焦，避免键盘弹出遮挡题目）
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      window.setTimeout(() => {
        if (state.action === unit) ta.focus({ preventScroll: true });
      }, 80);
    }
  }
}

/* ---------------------------------------------------------------- 排序题：长按拖动 + 平滑让位动画 */

function initRankDrag(box, setHint) {
  if (!box) return;
  let dragEl = null;
  let startY = 0;
  let lastY = 0;
  let itemH = 0;
  let pressTimer = null;
  let active = false;
  let pid = null;

  box.addEventListener('contextmenu', (e) => e.preventDefault());
  box.addEventListener('pointerdown', (e) => {
    if (active || state.busy) return;
    const item = e.target.closest('.item');
    if (!item) return;
    dragEl = item;
    startY = lastY = e.clientY;
    pid = e.pointerId;
    if (e.pointerType === 'mouse') begin();
    else pressTimer = window.setTimeout(begin, 190); // 触屏长按 190ms 进入拖动
  });

  function begin() {
    pressTimer = null;
    if (active || !dragEl) return;
    active = true;
    try {
      dragEl.setPointerCapture(pid);
    } catch {
      /* 忽略 */
    }
    itemH = dragEl.getBoundingClientRect().height + 7; // 7 = 列表 gap
    dragEl.classList.add('dragging');
    setHint('拖动中……松手落位');
  }

  box.addEventListener('pointermove', (e) => {
    if (!active) {
      // 长按等待期间发生明显位移 → 视为滚动意图，取消拖动
      if (pressTimer && Math.abs(e.clientY - startY) > 8) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      return;
    }
    e.preventDefault();
    lastY = e.clientY;
    const dy = lastY - startY;
    dragEl.style.transform = `translateY(${dy}px)`;
    const next = dragEl.nextElementSibling;
    if (next && dy > itemH * 0.45) swapItem(next, 1);
    else if (dragEl.previousElementSibling && dy < -itemH * 0.45) swapItem(dragEl.previousElementSibling, -1);
  });

  // FLIP：其它条目平滑让位
  function swapItem(other, dir) {
    const first = new Map();
    box.querySelectorAll('.item').forEach((node) => first.set(node, node.getBoundingClientRect().top));
    if (dir === 1) box.insertBefore(other, dragEl);
    else box.insertBefore(dragEl, other);
    box.querySelectorAll('.item').forEach((node) => {
      if (node === dragEl) return;
      const d = first.get(node) - node.getBoundingClientRect().top;
      if (!d) return;
      node.style.transition = 'none';
      node.style.transform = `translateY(${d}px)`;
      requestAnimationFrame(() => {
        node.style.transition = 'transform .18s cubic-bezier(.21,.9,.35,1)';
        node.style.transform = '';
      });
    });
    startY += dir === 1 ? itemH : -itemH;
    dragEl.style.transform = `translateY(${lastY - startY}px)`;
    box.querySelectorAll('.item .idx').forEach((node, ix) => {
      node.textContent = String(ix + 1);
    });
  }

  function end() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    if (!active) {
      dragEl = null;
      return;
    }
    active = false;
    const node = dragEl;
    dragEl = null;
    node.classList.add('returning');
    node.style.transform = '';
    window.setTimeout(() => node.classList.remove('dragging', 'returning'), 230);
    setHint('已更新顺序');
  }

  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

/* ---------------------------------------------------------------- 提交流程 */

function dispatch(payload) {
  const unit = state.action;
  if (!unit || state.busy || state.completed) return;
  const err = localError(unit, payload);
  if (err) {
    showErr(err);
    return;
  }
  hideErr();
  if (state.mode === 'live') submitLive(payload);
  else if (state.mode === 'trial') submitTrial(payload);
  else submitFollow(payload);
}

async function submitLive(payload) {
  const unit = state.action;
  const echo = answerTextOf(unit, payload);
  const elapsedMs = Math.round(performance.now() - state.shownAt);
  state.busy = true;
  setBusy(true);
  const echoRow = appendUserMessage(echo);
  $composerWrap.classList.add('hidden');
  scrollToBottom();
  try {
    const res = await api('/api/survey/step', {
      method: 'POST',
      body: Object.assign(
        {
          sessionId: state.sessionId,
          questionId: unit.questionId,
          subIndex: unit.subIndex == null ? 0 : unit.subIndex,
          elapsedMs
        },
        payload
      )
    });
    for (const m of res.messages || []) await appendAiMessageAnimated(m.content);
    if (!res.action) {
      await finishSurvey();
      return;
    }
    await renderAction(res.action, true);
  } catch (err) {
    echoRow.remove(); // 提交失败：撤回本机回显，保持与服务端一致
    if (err.code === 'out_of_sync') {
      appendAiMessageStatic('页面状态与服务器不同步，正在为您刷新，请稍候…');
      window.setTimeout(() => location.reload(), 1200);
      return;
    }
    if (err.code === 'session_closed') {
      showDone();
      return;
    }
    appendAiMessageStatic('抱歉，连接似乎出现了问题，您的答案未提交，请重试。');
    $composerWrap.classList.remove('hidden');
    setBusy(false);
  } finally {
    state.busy = false;
  }
}

function submitTrial(payload) {
  const unit = state.action;
  appendUserMessage(answerTextOf(unit, payload));
  scrollToBottom();
  state.trialIdx += 1;
  window.setTimeout(() => advanceTrial(), 260);
}

function submitFollow(payload) {
  const unit = state.action;
  appendUserMessage(answerTextOf(unit, payload));
  scrollToBottom();
  showTip('预览为本地效果（不保存）。点管理端「▶ 从头试填」可完整走一遍流程。');
}

/* 渲染一个作答单元：题干消息（+实验背景/图片）→ 底部题卡控件 */
async function renderAction(unit, animate, localIntro) {
  state.action = unit;
  state.picked = [];
  state.otherText = '';
  state.shownAt = performance.now();
  if (unit.intro) {
    if (localIntro && unit.intro.background) appendAiMessageStatic(introText(unit.intro));
    (unit.intro.images || []).forEach((url) => appendImage(url));
  }
  if (animate) await appendAiMessageAnimated(unit.title);
  else appendAiMessageStatic(unit.title);

  $tag.textContent = unitTag(unit);
  $hint.textContent = unit.required === false ? '选答 · 可跳过' : '必答';
  $sTitle.textContent = unit.title || '';
  renderControl(unit);
  $card.classList.remove('collapsed');
  $composerWrap.classList.remove('hidden');
  scrollToBottom();
}

/* ---------------------------------------------------------------- 预览模式：跟随编辑 / 从头试填 */

function renderFollow(questionIndex) {
  state.mode = 'follow';
  state.followIndex = questionIndex;
  state.units = buildLocalUnits((state.survey && state.survey.questions) || []);
  $stream.innerHTML = '';
  hideErr();
  hideTip();
  $brandTag.textContent = '实时预览';
  $brandTag.classList.remove('hidden');
  const unit = state.units.find((u) => u.questionIndex === questionIndex) || null;
  if (!unit) {
    state.action = null;
    $tag.textContent = '预览';
    $hint.textContent = '';
    $sTitle.textContent = '';
    $controls.innerHTML = '<div class="s-empty">添加题目后，这里会实时显示填写端效果。</div>';
    $anchor.textContent = '';
    $foot.classList.add('hidden');
    $composerWrap.classList.remove('hidden');
    return;
  }
  $foot.classList.remove('hidden');
  renderAction(unit, false, true);
  if (unit.isSub) {
    showTip('该题包含多个子题，此处预渲染第 1 个子题；点管理端「▶ 从头试填」可逐个体验。');
  } else {
    showTip('编辑左侧内容会即时更新此处；「▶ 从头试填」可完整走一遍流程（不落库）。');
  }
}

function startTrial() {
  state.mode = 'trial';
  state.trialIdx = 0;
  state.units = buildLocalUnits((state.survey && state.survey.questions) || []);
  $stream.innerHTML = '';
  hideErr();
  hideTip();
  $brandTag.textContent = '试填中 · 未保存';
  $brandTag.classList.remove('hidden');
  if (!state.units.length) {
    appendAiMessageStatic('该问卷尚未配置题目。');
    $composerWrap.classList.add('hidden');
    return;
  }
  const startText = String((state.survey && state.survey.startText) || '').trim();
  if (startText) appendAiMessageStatic(startText);
  advanceTrial();
}

// 聊天流内居中小字提示（试填结束等）
function appendNote(text) {
  const row = el('div', 'msg ai');
  const body = el('div', 'ai-body');
  body.appendChild(el('div', 's-note', text));
  row.appendChild(body);
  $stream.appendChild(row);
  scrollToBottom();
}

async function advanceTrial() {
  const unit = state.units[state.trialIdx];
  if (!unit) {
    trialFinish();
    return;
  }
  await renderAction(unit, true, true);
}

function trialFinish() {
  state.action = null;
  $composerWrap.classList.add('hidden');
  const endText = String((state.survey && state.survey.endText) || '').trim();
  appendAiMessageStatic(endText || '本次问卷已全部完成，感谢您的参与！');
  appendNote('— 试填结束（未保存任何数据） —');
}

/* ---------------------------------------------------------------- 完成 / 异常 */

async function finishSurvey() {
  state.completed = true;
  await sleep(420);
  showDone();
}

function showDone() {
  state.completed = true;
  $composerWrap.classList.add('hidden');
  const endText = String((state.survey && state.survey.endText) || '').trim();
  $doneText.textContent = endText || '本次问卷已全部完成，感谢您的参与！\n您可以关闭本页面。';
  $doneScreen.classList.remove('hidden');
  requestAnimationFrame(() => $doneScreen.classList.add('visible'));
}

function showError(message) {
  $errorText.textContent = message;
  $errorScreen.classList.remove('hidden');
  requestAnimationFrame(() => $errorScreen.classList.add('visible'));
}

/* ---------------------------------------------------------------- 会话恢复：按服务端消息序列重建对话流 */

// 消息序列结构确定：开始语? → (intro? → 用户答案) × 已完成单元 → 结束语?；
// 结合 units（本地镜像）可精确重建「题干 + 答案」的完整时间线。
function rebuildFlow(survey, units, messages, completed) {
  const rows = [];
  const list = Array.isArray(messages) ? messages : [];
  let mi = 0;
  const startText = String((survey && survey.startText) || '').trim();
  if (startText && list[mi] && list[mi].role === 'assistant') {
    rows.push({ kind: 'ai', text: list[mi].content });
    mi += 1;
  }
  for (let u = 0; u < completed && u < units.length; u++) {
    const unit = units[u];
    if (unit.intro && unit.intro.background && list[mi] && list[mi].role === 'assistant') {
      rows.push({ kind: 'ai', text: list[mi].content });
      mi += 1;
    }
    if (unit.intro) (unit.intro.images || []).forEach((url) => rows.push({ kind: 'img', url }));
    rows.push({ kind: 'ai', text: unit.title });
    if (list[mi] && list[mi].role === 'user') {
      rows.push({ kind: 'user', text: list[mi].content });
      mi += 1;
    }
  }
  for (; mi < list.length; mi++) {
    rows.push({ kind: list[mi].role === 'user' ? 'user' : 'ai', text: list[mi].content });
  }
  return rows;
}

function renderRowsStatic(rows) {
  rows.forEach((r) => {
    if (r.kind === 'user') appendUserMessage(r.text);
    else if (r.kind === 'img') appendImage(r.url);
    else appendAiMessageStatic(r.text);
  });
}

/* ---------------------------------------------------------------- 预览模式入口（管理端 iframe） */

async function initPreview() {
  $brandTag.textContent = '实时预览';
  $brandTag.classList.remove('hidden');
  try {
    const boot = await api(`/api/survey/bootstrap?c=${encodeURIComponent(surveyCode)}&preview=1`);
    state.survey = boot.survey;
  } catch (err) {
    showError(
      err.code === 'survey_not_found'
        ? '该问卷不存在或已被删除。'
        : '无法连接到服务，请稍后刷新页面重试。'
    );
    return;
  }
  if (state.survey && state.survey.title) {
    $brandSub.textContent = state.survey.title;
    $brandSub.classList.remove('hidden');
  }
  renderFollow(0);
  setupPreviewBridge();
}

function setupPreviewBridge() {
  if (window.parent === window) return; // 非 iframe 直接预览时无需桥
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const d = e.data || {};
    if (d.survey && typeof d.survey === 'object') {
      state.survey = d.survey;
      if (state.survey.title) {
        $brandSub.textContent = state.survey.title;
        $brandSub.classList.remove('hidden');
      }
    }
    if (d.type === 'survey-follow') {
      const qi = Number.isInteger(Number(d.questionIndex)) ? Number(d.questionIndex) : 0;
      renderFollow(qi);
    } else if (d.type === 'survey-trial') {
      startTrial();
    } else if (d.type === 'survey-exit-trial') {
      renderFollow(Number.isInteger(state.followIndex) ? state.followIndex : 0);
    }
  });
  try {
    window.parent.postMessage({ type: 'survey-ready' }, location.origin);
  } catch {
    /* 忽略 */
  }
}

/* ---------------------------------------------------------------- 初始化（正式填写） */

async function init() {
  if (!surveyCode) {
    showError('链接无效：缺少问卷参数，请使用管理端复制的填写链接进入。');
    return;
  }
  if (previewMode) {
    await initPreview();
    return;
  }
  try {
    const sid = urlSessionId || loadStoredSession();
    const boot = await api(
      `/api/survey/bootstrap?c=${encodeURIComponent(surveyCode)}${sid ? `&session=${encodeURIComponent(sid)}` : ''}`
    );
    state.survey = boot.survey;
    if (boot.survey.title) {
      $brandSub.textContent = boot.survey.title;
      $brandSub.classList.remove('hidden');
      document.title = `${boot.survey.title} · 智能问卷助手`;
    }

    if (boot.session) {
      state.sessionId = boot.session.id;
      storeSession(boot.session.id);
      const units = buildLocalUnits(boot.survey.questions);
      renderRowsStatic(rebuildFlow(boot.survey, units, boot.messages, boot.completedUnits || 0));
      scrollToBottom(false);
      if (boot.session.status === 'completed' || !boot.action) {
        showDone();
        return;
      }
      await renderAction(boot.action, false);
      return;
    }

    clearStoredSession();
    await startSession();
  } catch (err) {
    showError(
      err.code === 'survey_not_found'
        ? '该问卷链接不存在或已被删除，请检查链接是否正确。'
        : '无法连接到服务，请稍后刷新页面重试。'
    );
  }
}

async function startSession() {
  const created = await api('/api/survey/session', {
    method: 'POST',
    body: { c: surveyCode }
  });
  state.sessionId = created.session.id;
  storeSession(created.session.id);
  if (created.survey) state.survey = created.survey;
  await renderMessages(created.messages, true);
  if (created.action) {
    await renderAction(created.action, true);
  } else {
    showDone();
  }
}

/* ---------------------------------------------------------------- 事件绑定 */

$btnSubmit.addEventListener('click', () => {
  const unit = state.action;
  if (!unit || state.busy || state.completed) return;
  const payload = currentPayload(unit);
  if (!payload) {
    showErr('请先完成作答');
    return;
  }
  dispatch(payload);
});

$btnSkip.addEventListener('click', () => {
  const unit = state.action;
  if (!unit || state.busy || state.completed) return;
  if (unit.required !== false) return;
  dispatch({ skip: true });
});

$collapse.addEventListener('click', () => {
  $card.classList.toggle('collapsed');
});

init();
