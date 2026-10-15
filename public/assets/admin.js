// 管理端：实验模板库 + 问卷管理（统一题目模型）
// 侧边栏在编辑态复用为「题目大纲」；编辑页 = 左侧题目编排 + 右侧手机实时预览（含从头试填）。
// 时间轴之外的一切都来自服务端：题目类型 / 可勾选的限制 / 默认题目（GET /api/admin/meta）。
'use strict';

/* ---------------------------------------------------------------- 元素与状态 */

const $ = (id) => document.getElementById(id);
const $main = $('admin-main');
const $toast = $('toast');
const $modal = $('modal');
const $modalTitle = $('modal-title');
const $modalBody = $('modal-body');
const $modalError = $('modal-error');
const $modalCancel = $('modal-cancel');
const $modalConfirm = $('modal-confirm');
const $sidebarMenu = $('sidebar-menu');
const $sidebarOutline = $('sidebar-outline');
const $segMenu = $('seg-menu');
const $segOutline = $('seg-outline');

const TOKEN_KEY = 'expchat_admin_token';
const TOKEN_REMEMBER_KEY = 'expchat_admin_token_remember';   // { token, username, expiresAt }：勾了「记住密码」才有
const LOGIN_REMEMBER_KEY = 'expchat_login_remember';         // { username, password, expiresAt }：登录卡片的「记住账号密码」

// 「记住密码」= 登录页勾选后签发的 30 天 token（存 localStorage，重开浏览器仍免登录）
function loadRememberedTokenRecord() {
  try {
    const rec = JSON.parse(localStorage.getItem(TOKEN_REMEMBER_KEY) || 'null');
    if (!rec || !rec.token) return null;
    if (Number(rec.expiresAt) && Number(rec.expiresAt) < Date.now()) { localStorage.removeItem(TOKEN_REMEMBER_KEY); return null; }
    return rec;
  } catch { return null; }
}
function loadRememberedToken() {
  const rec = loadRememberedTokenRecord();
  return rec ? rec.token : '';
}
function clearTokens() {
  sessionStorage.removeItem(TOKEN_KEY);
  try { localStorage.removeItem(TOKEN_REMEMBER_KEY); } catch { /* 忽略 */ }
}
// 记一次登录态（登录 / 改密换发新 token 时复用）：remember 为真则同步刷新 30 天记录
function storeToken(token, remember, ttlMs) {
  state.token = token;
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* 忽略 */ }
  if (!remember) return;
  try {
    localStorage.setItem(TOKEN_REMEMBER_KEY, JSON.stringify({
      token,
      username: state.user ? state.user.username : '',
      expiresAt: Date.now() + (Number(ttlMs) || 30 * 24 * 60 * 60 * 1000)
    }));
  } catch { /* 忽略 */ }
}

const initialToken = sessionStorage.getItem(TOKEN_KEY) || loadRememberedToken();
if (initialToken) { try { sessionStorage.setItem(TOKEN_KEY, initialToken); } catch { /* 忽略 */ } }

const state = {
  token: initialToken,
  user: null,             // 当前登录用户 { id, username, role, avatar }
  meta: null,             // { itemTypes, itemTypeLabels, itemVariants, itemLimits, limitMeta, limitDefaults, itemDefaults, ... }
  experiments: [],
  questionnaires: [],
  editingExp: null,       // 编辑中的实验模板（本地副本，保存时提交）
  editingQ: null,         // 编辑中的问卷
  selected: null,         // 当前选中的题目 id
  sidebarMode: 'menu',    // menu | outline
  previewSpeed: 1,        // 手机预览的演示倍速（1 = 与正式实验一致）
  dragId: null,
  view: 'exp-list'
};

const TYPE = () => state.meta.itemTypes;
const TYPE_LABEL = (t) => (state.meta.itemTypeLabels[t] || t);
const TYPE_LIMITS = (t) => (state.meta.itemLimits[t] || []);
// 题目条上的类型标签：文本题的二级形态「需输入指定内容」带一个后缀，列表 / 大纲上一眼能认出来
function itemTypeLabel(item) {
  return item && item.type === 'text' && item.variant === 'match'
    ? `${TYPE_LABEL('text')}·需输入指定内容`
    : TYPE_LABEL(item && item.type);
}
const LIMIT_META = () => state.meta.limitMeta;
const LIMIT_DEFAULTS = () => state.meta.limitDefaults;

/* ---------------------------------------------------------------- 基础工具 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function api(path, options = {}) {
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(message) {
  $toast.textContent = message;
  $toast.classList.remove('hidden');
  requestAnimationFrame(() => $toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $toast.classList.remove('show');
    setTimeout(() => $toast.classList.add('hidden'), 220);
  }, 2200);
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage || '已复制');
    return;
  } catch { /* 降级 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast(okMessage || '已复制'); } catch { toast('复制失败，请手动复制'); }
  ta.remove();
}

/* ---------------------------------------------------------------- 手机地址与二维码 */

// 二维码与被试链接都必须是手机能打开的地址：管理端用 localhost 打开时换成局域网 IP
// （由 /api/net-info 上报），用域名（含公网部署）打开时直接用当前 origin。结果缓存，只取一次。
let netInfoPromise = null;
function getNetInfo() {
  if (!netInfoPromise) netInfoPromise = api('/api/net-info').catch(() => null);
  return netInfoPromise;
}

async function participantBase() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') {
    const info = await getNetInfo();
    const first = info && Array.isArray(info.urls) ? info.urls[0] : '';
    if (first) return first;
  }
  return location.origin;
}

// 链接行：先立即显示 origin 版本，拿到局域网地址后原地替换（复制按钮读 input.value，无需额外处理）
async function fillParticipantLink(input, path) {
  input.value = location.origin + path;
  const base = await participantBase();
  input.value = base + path;
}

// 四宫格二维码图标（按钮用，跟随 currentColor）
function qrIconSvg(size = 14) {
  const holder = document.createElement('span');
  holder.innerHTML = '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'
    + '<path d="M14 14h3.5v3.5H14zM20.6 14.2v.1M14 20.6h3.5M20.6 17.5v3.1"/></svg>';
  return holder.firstChild;
}

function qrFileName(title) {
  const safe = String(title || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return '二维码-' + (safe || '未命名') + '.png';
}

// 二维码弹窗（不跳页面）：二维码 + 地址行（可复制）+ 备选地址提示；「保存图片」存海报式 PNG。
// 备选地址只在「localhost 打开、已换成局域网地址」时列出；公网部署（地址 = 域名）时不列，
// 否则会把服务器自己的内网 IP 列给被试，反而误导。
async function openQrModal({ title, posterTitle, path, note }) {
  const info = await getNetInfo();
  const base = await participantBase();
  const url = base + path;
  const lanSubstituted = base !== location.origin;
  const alts = lanSubstituted && info && Array.isArray(info.urls) ? info.urls.filter((u) => u !== base) : [];

  const body = el('div');
  const figure = el('div', 'qr-figure');
  const img = el('img');
  img.alt = '二维码';
  img.src = '/qr.svg?u=' + encodeURIComponent(url);
  figure.appendChild(img);
  body.appendChild(figure);
  if (note) body.appendChild(el('p', 'qr-note', note));
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
    body.appendChild(el('p', 'qr-warn', '未检测到局域网地址：请确认这台电脑已连上网络，否则手机打不开这个地址。'));
  }
  const row = el('div', 'link-row');
  const input = el('input');
  input.type = 'text';
  input.readOnly = true;
  input.value = url;
  input.addEventListener('click', () => input.select());
  const copy = el('button', 'ghost-btn', '复制');
  copy.onclick = () => copyText(input.value, '链接已复制');
  row.append(input, copy);
  body.appendChild(row);
  if (alts.length) {
    const altBox = el('p', 'qr-alts', '若上面的地址手机打不开，可改用备选地址：');
    for (const a of alts) altBox.appendChild(el('code', 'qr-alt-item', a + path));
    body.appendChild(altBox);
  }
  openModal({
    title,
    body,
    confirmLabel: '保存图片',
    onConfirm: () => saveQrPoster({ title: posterTitle || title, url, filename: qrFileName(posterTitle || title) }),
    extraLabel: '关闭',
    onExtra: closeModal,
    hideCancel: true
  });
}

// 保存海报式 PNG（标题 + 二维码 + 完整网址 + 一行说明）：fetch /qr.svg 后按 viewBox 整数倍栅格化，
// 保证二维码模块边缘清晰；纯浏览器实现，局域网与公网部署行为一致。
async function saveQrPoster({ title, url, filename }) {
  const res = await fetch('/qr.svg?u=' + encodeURIComponent(url));
  if (!res.ok) throw new Error('二维码生成失败，请重试');
  const raw = await res.text();
  const vb = /viewBox="0 0 ([0-9.]+) ([0-9.]+)"/.exec(raw);
  const box = vb ? Number(vb[1]) : 264;
  const qrPx = Math.max(320, Math.round(640 / box) * box);
  const svg = raw.replace('<svg ', '<svg width="' + qrPx + '" height="' + qrPx + '" ');
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();

  const pad = Math.round(qrPx * 0.09);
  const width = qrPx + pad * 2;
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const titleFont = '600 ' + Math.round(qrPx * 0.088) + 'px ' + family;
  const urlFont = '500 ' + Math.round(qrPx * 0.055) + 'px ' + family;
  const hintFont = '400 ' + Math.round(qrPx * 0.045) + 'px ' + family;

  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const wrap = (text, font) => {
    ctx.font = font;
    const lines = [];
    let line = '';
    for (const ch of String(text)) {
      if (line && ctx.measureText(line + ch).width > width - pad * 2) { lines.push(line); line = ch; }
      else line += ch;
    }
    lines.push(line);
    return lines;
  };
  const lineH = (font) => Math.round(parseFloat(font.split(' ')[1]) * 1.55);
  const titleLines = wrap(title, titleFont);
  const urlLines = wrap(url, urlFont);
  const hintLines = wrap('扫码开始作答', hintFont);
  const gapTitle = Math.round(qrPx * 0.1);
  const gapUrl = Math.round(qrPx * 0.09);
  const gapHint = Math.round(qrPx * 0.03);
  const top = Math.round(pad * 0.9);
  const height = top
    + titleLines.length * lineH(titleFont) + gapTitle
    + qrPx + gapUrl
    + urlLines.length * lineH(urlFont) + gapHint
    + hintLines.length * lineH(hintFont) + Math.round(pad * 0.9);

  cv.width = width;
  cv.height = height;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let y = top;
  const drawLines = (lines, font, color) => {
    ctx.font = font;
    ctx.fillStyle = color;
    const lh = lineH(font);
    for (const line of lines) { ctx.fillText(line, width / 2, y + lh / 2); y += lh; }
  };
  drawLines(titleLines, titleFont, '#111213');
  y += gapTitle;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, pad, y, qrPx, qrPx);
  y += qrPx + gapUrl;
  drawLines(urlLines, urlFont, '#3a3a3f');
  y += gapHint;
  drawLines(hintLines, hintFont, '#7a7a80');

  const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片生成失败，可改用右键「图片另存为」');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('图片已保存');
}

function formatTime(iso) {
  if (!iso) return '——';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '——';
  const m = Math.floor(n / 60);
  const s = n % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function sectionHead(title, hint) {
  const section = el('div', 'section');
  const head = el('div', 'section-head');
  head.appendChild(el('h3', 'section-title', title));
  section.appendChild(head);
  if (hint) section.appendChild(el('p', 'section-hint', hint));
  return section;
}

// 文本域自动增高：高度跟随内容（下限为 rows 对应高度），避免固定高度内部滚动（issue 9）
// 也允许手动往下拖：拖高后把当时的高度记成下限，继续输入不会被自动增高顶回去（issue 3）
function autoGrowTextarea(textarea, minRows) {
  const minHeight = Math.max(1, Number(minRows) || 1) * 22 + 22;
  const resize = () => {
    textarea.style.height = 'auto';
    const floor = Math.max(minHeight, Number(textarea.dataset.minH) || 0);
    textarea.style.height = `${Math.max(textarea.scrollHeight, floor)}px`;
  };
  textarea.style.overflow = 'auto';
  const applyResize = (v) => { textarea.dataset.minH = String(Math.max(minHeight, Number(v) || 0)); resize(); };
  textarea.addEventListener('input', resize);
  textarea.addEventListener('mouseup', () => {
    if (textarea.scrollHeight < textarea.clientHeight) applyResize(textarea.clientHeight);
  });
  window.setTimeout(() => { applyResize(textarea.dataset.minH); }, 0);
  return resize;
}

function makeField(labelText, value, rows) {
  const wrap = el('label', 'field');
  wrap.appendChild(el('span', '', labelText));
  let input;
  if (rows && rows > 1) {
    input = el('textarea');
    input.rows = rows;
    autoGrowTextarea(input, rows);
  } else {
    input = el('input');
    input.type = 'text';
  }
  input.value = value == null ? '' : String(value);
  wrap.appendChild(input);
  return { wrap, input };
}

/* ---------------------------------------------------------------- 富文本编辑控件（类 Word）
   正文一律用它编辑：正文 / 一至六级标题、字号、加粗 / 斜体 / 下划线 / 删除线、字体颜色、背景色、
   对齐、清除格式；从 Word 或网页粘贴保留格式（mso-* 之类垃圾样式在 richtext.js 里被丢掉）。
   被试端渲染的就是这里清洗后的 HTML——同一份 richtext.js。 */
function makeRichField(labelText, htmlValue, opts = {}) {
  // 注意：这里必须是 div，不能用 <label> —— label 会把点击转发给内部第一个表单控件（工具条的下拉），
  // 导致点正文区域编辑器拿不到焦点、输入不进去。
  const wrap = el('div', 'field rich-field');
  wrap.appendChild(el('span', '', labelText));
  const box = el('div', 'rich-box');
  const bar = el('div', 'rich-bar');

  const editor = el('div', 'rich-edit');
  editor.contentEditable = 'true';
  editor.spellcheck = false;
  // raw 模式（「显示全卷」视图用）：内容里带着「题目标识行」这类只在视图内成立的标记，
  // 不能每次同步都走一遍清洗（清洗会把 class / contenteditable 属性洗掉，标记就认不出来了）；
  // 统一在切回分题时按段清洗。界面上的富文本字段一律用默认（清洗）模式。
  const rawMode = !!opts.raw;
  const clean = (html) => (rawMode ? String(html == null ? '' : html) : RichText.sanitizeHtml(html));
  editor.innerHTML = clean(htmlValue || '');

  let lastHtml = typeof opts.initialHtml === 'string' ? opts.initialHtml : null;
  const sync = () => {
    const html = clean(editor.innerHTML);
    editor.dataset.empty = html ? '0' : '1';
    if (html === lastHtml) return;
    lastHtml = html;
    if (opts.onChange) opts.onChange(html, RichText.htmlToText(html));
  };

  const exec = (cmd, value) => {
    editor.focus();
    try { document.execCommand(cmd, false, value); } catch { /* 忽略 */ }
    sync();
  };
  const mkBtn = (label, title, fn, cls) => {
    const b = el('button', 'rich-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.title = title;
    // 别让按钮抢走选区，否则「选中文字再加粗」就失效了
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    return b;
  };

  const blockSel = el('select', 'rich-select');
  blockSel.title = '段落样式（把第一行设为标题就用它）';
  for (const [v, t] of [['p', '正文'], ['h1', '标题 1'], ['h2', '标题 2'], ['h3', '标题 3'], ['h4', '标题 4'], ['h5', '标题 5'], ['h6', '标题 6']]) {
    const o = el('option', '', t);
    o.value = v;
    blockSel.appendChild(o);
  }
  blockSel.addEventListener('mousedown', (e) => e.stopPropagation());
  blockSel.addEventListener('change', () => exec('formatBlock', blockSel.value));

  // 精确字号：先给选区套 span（保留行内结构）；跨段落时报废，退化为「对涉及的整段生效」（和 Word 一致）
  const BLOCK_SEL = 'P,H1,H2,H3,H4,H5,H6,LI,BLOCKQUOTE,DIV';
  // 本编辑器里最后一次「有效选区」。点字号下拉时，原生 select 会把 contenteditable 的选区抢走
  // （选区跑到编辑器外或塌成光标），应用之前必须把它放回去 —— 否则要么没反应、要么改到别的地方
  // （issue：选中一片文字改字号改不动 / 离开这题又变回去）。
  let lastRange = null;
  const liveRange = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const host = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentNode;
    return host && editor.contains(host) ? r : null;
  };
  const rememberRange = () => { const r = liveRange(); if (r) lastRange = r.cloneRange(); };
  // 应用目标：优先「还在编辑器里的选区」；已被下拉抢走（跑到外面 / 塌成光标）就用记着的那个
  const targetRange = () => {
    const live = liveRange();
    if (live && !live.collapsed) return live.cloneRange();
    if (lastRange && !lastRange.collapsed) return lastRange.cloneRange();
    return live ? live.cloneRange() : (lastRange ? lastRange.cloneRange() : null);
  };
  const applyFontSize = (value) => {
    const range = targetRange();          // 必须在 focus 之前取：focus 有时会把选区改成光标
    editor.focus();
    const sel = window.getSelection();
    if (range && sel) { try { sel.removeAllRanges(); sel.addRange(range); } catch { /* 忽略 */ } }
    if (!range) return;
    if (value === 'body') { clearFontSize(range); sync(); return; }
    clearFontSize(range);                      // 先清掉旧字号，避免一层层套 span
    // 选区涉及的「块」（p / h1-6 / li / blockquote / div）
    const blocks = [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.matches(BLOCK_SEL)) continue;
      if (!range.collapsed ? range.intersectsNode(n) : n.contains(range.startContainer)) blocks.push(n);
    }
    if (!blocks.length) {
      // 光标停在行内元素里：往上找最近的块
      let node = range.startContainer;
      while (node && node !== editor && !(node.nodeType === 1 && node.matches(BLOCK_SEL))) node = node.parentNode;
      if (node && node !== editor) blocks.push(node);
    }
    // 只涉及一个块（或只是光标）：用 span 包起来 —— 行内结构（加粗 / 颜色）原地保留
    if (blocks.length <= 1) {
      const span = document.createElement('span');
      span.style.fontSize = value;
      try {
        range.surroundContents(span);
        sync();
        return;
      } catch { /* 选区跨块：往下走，按块处理 */ }
    }
    // 跨多个块（含「全选」）：逐块设字号。
    // 不能用 span 包住整块 —— 「span 里放 p」是非法嵌套，存下来再渲染时浏览器会把 span 拆开、字号就丢了
    if (!blocks.length) return;                      // 找不到就不动（绝不改编辑器本身）
    blocks.forEach((b) => { b.style.fontSize = value; });
    sync();
  };
  // 「正文（默认）」= 去掉字号样式，回到容器默认字号（14px）。
  // 光标折叠时 intersectsNode 可能命中不到，这里补一条「沿祖先链找到所在块」的分支。
  const clearFontSize = (range) => {
    const hit = (n) => {
      try { return range.intersectsNode(n); } catch { return false; }
    };
    const targets = new Set();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.style || !n.style.fontSize) continue;
      if (hit(n)) targets.add(n);
    }
    if (range.collapsed) {
      let node = range.startContainer;
      if (node && node.nodeType !== 1) node = node.parentNode;
      while (node && node !== editor) {
        if (node.style && node.style.fontSize) targets.add(node);
        node = node.parentNode;
      }
    }
    targets.forEach((n) => {
      n.style.fontSize = '';
      if (!n.getAttribute('style')) n.removeAttribute('style');
    });
  };

  // 字号：只给 Word 那套中文号数（正文那档标出来，并且是默认值）
  const sizeSel = el('select', 'rich-select');
  // 「多种字号」：选区里字号不统一时（如首字小四、其余五号）显示它 —— 这样再点某一档值一定变了、
  // 一定触发 change，字号才真正应用得上（以前显示小四时再点小四：原生 select 不触发 change → 一点反应都没有）
  const MIXED_SIZE = '__mixed__';
  sizeSel.title = '字号（「正文」= 默认字号，不写入任何字号样式）；光标移到文字上会显示它当前是哪一号';
  // 档位表来自 RichText（与「粘贴时识别字号」共用同一张表，避免两处漂移）
  // 「正文（默认 16px）」= 不写入字号（回落编辑器默认）；其余按 Word 号数换算（pt × 4/3）
  {
    const om = el('option', '', '多种字号');
    om.value = MIXED_SIZE;
    om.hidden = true;                      // 只是回显态，不出现在下拉列表里
    sizeSel.appendChild(om);
    const o = el('option', '', `正文（默认 ${RichText.BODY_FONT_PX}px）`);
    o.value = 'body';
    sizeSel.appendChild(o);
    for (const p of RichText.FONT_SIZE_PRESETS) {
      const op = el('option', '', p.label);
      op.value = `${p.px}px`;
      sizeSel.appendChild(op);
    }
  }
  sizeSel.value = 'body';
  sizeSel.addEventListener('mousedown', (e) => e.stopPropagation());
  sizeSel.addEventListener('change', () => {
    const v = sizeSel.value;
    if (v === MIXED_SIZE) return;          // 回显态，不是可选的档位
    applyFontSize(v);
    sizeSel.value = v;                     // 直接回显刚落定的档位（不按光标二次推导，免得又跳回「正文」）
  });
  // 取某个节点的「实际字号」：先沿祖先链找内联 font-size，没有就看容器算出来的
  const sizePxOf = (node) => {
    const el2 = node.nodeType === 1 ? node : node.parentElement;
    let hasInline = false;
    let px = 0;
    for (let n = el2; n && n !== editor; n = n.parentElement) {
      if (n.style && n.style.fontSize) { px = parseFloat(n.style.fontSize) || 0; hasInline = true; break; }
    }
    if (!px && el2) px = parseFloat(getComputedStyle(el2).fontSize) || 0;
    return { px: Math.round(px), hasInline };
  };
  // 光标 / 选区一动，就把「当前字号」回显到下拉里（这样粘贴进来的字号能看出是哪一号）
  // 回显按**整个选区**算：一致 → 该档位；不一致 → 「多种字号」；
  // 没有任何内联字号且就是编辑器默认字号 → 「正文（默认）」
  const syncSizeSelToCaret = () => {
    const range = targetRange();
    if (!range) { sizeSel.value = 'body'; return; }
    const pxList = [];
    let hasInline = false;
    const take = (node) => { const s = sizePxOf(node); if (s.px) pxList.push(s.px); if (s.hasInline) hasInline = true; };
    if (range.collapsed) {
      take(range.startContainer);
    } else {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        if (!range.intersectsNode(n)) continue;
        take(n);
      }
      if (!pxList.length) take(range.startContainer);
    }
    const uniq = [...new Set(pxList)];
    if (uniq.length > 1) { sizeSel.value = MIXED_SIZE; return; }
    const px = uniq[0] || 0;
    if (!px || (!hasInline && px === RichText.BODY_FONT_PX)) { sizeSel.value = 'body'; return; }
    const preset = RichText.fontPresetOf(px);
    sizeSel.value = preset && preset.exact ? `${preset.px}px` : 'body';
  };
  // 只在本编辑器里监听光标变化（其它字段不动这个下拉）；选区跑到编辑器外面时保留上一次的（点下拉就不会丢）
  document.addEventListener('selectionchange', () => {
    const live = liveRange();
    if (!live) return;
    lastRange = live.cloneRange();
    syncSizeSelToCaret();
  });
  editor.addEventListener('mouseup', rememberRange);
  editor.addEventListener('keyup', rememberRange);

  bar.append(blockSel, sizeSel);
  bar.append(
    mkBtn('B', '加粗（Ctrl+B）', () => exec('bold'), 'b'),
    mkBtn('I', '斜体（Ctrl+I）', () => exec('italic'), 'i'),
    mkBtn('U', '下划线（Ctrl+U）', () => exec('underline'), 'u'),
    mkBtn('S', '删除线', () => exec('strikeThrough'), 'strike')
  );

  const fg = el('input', 'rich-color');
  fg.type = 'color';
  fg.value = '#111213';
  fg.title = '字体颜色';
  fg.addEventListener('input', () => exec('foreColor', fg.value));
  const bg = el('input', 'rich-color');
  bg.type = 'color';
  bg.value = '#fff3bf';
  bg.title = '字体背景色';
  bg.addEventListener('input', () => {
    editor.focus();
    let ok = false;
    try { ok = document.execCommand('hiliteColor', false, bg.value); } catch { ok = false; }
    if (!ok) { try { document.execCommand('backColor', false, bg.value); } catch { /* 忽略 */ } }
    sync();
  });
  // 颜色按钮：点按钮任意位置 = 应用当前预选色；点内部的小色块 = 打开取色器调整预选色
  const colorBtn = (input, tag, title, apply) => {
    const wrap = el('button', 'rich-color-wrap');
    wrap.type = 'button';
    wrap.title = `${title}：点按钮直接应用当前颜色；点左侧色块可换颜色`;
    wrap.append(input, el('span', 'rich-color-tag', tag));
    wrap.addEventListener('mousedown', (e) => e.preventDefault());     // 别抢走选区
    wrap.addEventListener('click', (e) => {
      if (e.target === input) return;                                  // 点色块 → 只开取色器
      e.preventDefault();
      apply(input.value);
    });
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    return wrap;
  };
  const fgWrap = colorBtn(fg, 'A', '字体颜色', (v) => exec('foreColor', v));
  const bgWrap = colorBtn(bg, '底色', '字体背景色', (v) => {
    editor.focus();
    let ok = false;
    try { ok = document.execCommand('hiliteColor', false, v); } catch { ok = false; }
    if (!ok) { try { document.execCommand('backColor', false, v); } catch { /* 忽略 */ } }
    sync();
  });
  bar.append(fgWrap, bgWrap);

  bar.append(
    mkBtn('左', '左对齐', () => exec('justifyLeft')),
    mkBtn('中', '居中', () => exec('justifyCenter')),
    mkBtn('清除格式', '清除选中文字的格式（回到正文默认）', () => exec('removeFormat'))
  );

  const onPaste = (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    e.preventDefault();
    const clean = html ? RichText.cleanWordPaste(html) : RichText.plainPasteToHtml(text);
    if (!clean) return;
    editor.focus();
    try { document.execCommand('insertHTML', false, clean); } catch { /* 忽略 */ }
    sync();
  };
  editor.addEventListener('paste', onPaste);
  editor.addEventListener('input', sync);
  editor.addEventListener('blur', sync);
  editor.addEventListener('focus', () => {
    try {
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch { /* 忽略 */ }
  });

  box.append(bar, editor);
  if (opts.hint) box.appendChild(el('p', 'field-hint', opts.hint));
  wrap.appendChild(box);
  sync();
  return { wrap, editor, sync, setHtml: (html) => { editor.innerHTML = clean(html); lastHtml = null; sync(); } };
}

function makeNumberField(labelText, value, min, max, hint) {
  const wrap = el('label', 'field');
  wrap.appendChild(el('span', '', labelText));
  const input = el('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.value = value == null ? '' : String(value);
  wrap.appendChild(input);
  if (hint) wrap.appendChild(el('em', 'field-hint', hint));
  return { wrap, input };
}

/* ---------------------------------------------------------------- 弹窗 */

let modalOnConfirm = null;
let modalOnExtra = null;

function openModal({ title, body, confirmLabel = '确定', danger = false, onConfirm, extraLabel, onExtra, hideCancel = false }) {
  $modalTitle.textContent = title;
  $modalBody.innerHTML = '';
  if (body) $modalBody.appendChild(body);
  $modalError.classList.add('hidden');
  $modalConfirm.textContent = confirmLabel;
  $modalConfirm.classList.toggle('danger', Boolean(danger));
  $modalConfirm.disabled = false;
  $modalCancel.classList.toggle('hidden', hideCancel);
  modalOnConfirm = onConfirm || null;
  modalOnExtra = onExtra || null;
  let extra = document.getElementById('modal-extra');
  if (extraLabel && onExtra) {
    if (!extra) {
      extra = el('button', 'ghost-btn');
      extra.id = 'modal-extra';
      extra.type = 'button';
      extra.addEventListener('click', async () => {
        if (!modalOnExtra) return;
        extra.disabled = true;
        try { await modalOnExtra(); } catch (err) { showModalError(err.message || '操作失败，请重试'); } finally { extra.disabled = false; }
      });
      $modalCancel.parentElement.insertBefore(extra, $modalCancel);
    }
    extra.textContent = extraLabel;
    extra.classList.remove('hidden');
  } else if (extra) {
    extra.classList.add('hidden');
  }
  $modal.classList.remove('hidden');
}

function closeModal() {
  $modal.classList.add('hidden');
  modalOnConfirm = null;
  modalOnExtra = null;
}

function showModalError(message) {
  $modalError.textContent = message;
  $modalError.classList.remove('hidden');
}

$modalCancel.addEventListener('click', closeModal);
$modal.addEventListener('click', (e) => { if (e.target === $modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$modal.classList.contains('hidden')) closeModal(); });
$modalConfirm.addEventListener('click', async () => {
  if (!modalOnConfirm) return;
  $modalConfirm.disabled = true;
  try { await modalOnConfirm(); } catch (err) { showModalError(err.message || '操作失败，请重试'); } finally { $modalConfirm.disabled = false; }
});

/* ---------------------------------------------------------------- 登录（未登录视图） */

const KICKED_MSG = '该账号已在其他设备登录或已修改密码，本设备登录已失效，请重新登录。';
const LAST_USER_KEY = 'expchat_last_user';                   // 上次登录的账号：登录卡片用来预填

async function loadMeta() {
  state.meta = await api('/api/admin/meta');
}

async function enterAdmin() {
  initLayout();
  const me = await api('/api/auth/me');
  state.user = me.user;
  await Promise.all([loadMeta(), reloadExperiments(), reloadQuestionnaires()]);
  $('login-view').classList.add('hidden');
  $('admin-view').classList.remove('hidden');
  handleRoute();
}

// 切到未登录视图：管理端整页换成一屏「登录卡片 + 问卷入口 + 备案号」
function showLogin(message) {
  $('admin-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  showBlock('login');
  hideLoginError();
  if (message) showLoginError(message);
  prefillLogin();
}

// 401：登录已失效（被其他设备顶下线 / 已改密 / 已过期）→ 清掉本机登录态，原地切回登录卡片
function backToLogin(err) {
  state.token = '';
  state.user = null;
  clearTokens();
  showLogin(err && err.code === 'kicked' ? KICKED_MSG : '登录已失效，请重新登录。');
}

async function boot() {
  // 老链接 / 旧书签可能带 ?kicked=1（被顶下线的提示参数）：清掉参数，并在登录卡片上说明原因
  const kicked = new URLSearchParams(location.search).get('kicked') === '1';
  if (kicked) { try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* 忽略 */ } }
  if (!state.token) { showLogin(kicked ? KICKED_MSG : ''); return; }
  try {
    await enterAdmin();
  } catch (err) {
    if (err.status === 401) backToLogin(err);
    else showLogin('无法加载管理端数据，请刷新页面重试。');
  }
}

function maybeSessionExpired(err) {
  if (err.status !== 401) return false;
  backToLogin(err);
  return true;
}

/* ---- 登录卡片 -------------------------------------------------------- */

// 登录 / 注册 / 重置说明三块互斥显示
function showBlock(name) {
  ['login-block', 'register-block', 'reset-block'].forEach((id) => {
    $(id).classList.toggle('hidden', id !== name + '-block');
  });
}

function showLoginError(msg) { const p = $('login-error'); p.textContent = msg; p.classList.remove('hidden'); }
function hideLoginError() { $('login-error').classList.add('hidden'); }
function showRegError(msg) { const p = $('reg-error'); p.textContent = msg; p.classList.remove('hidden'); }
function hideRegError() { $('reg-error').classList.add('hidden'); }

// 「记住账号密码」：勾选后把账号密码与 30 天 token 存在本机（localStorage），重开浏览器免登录
function readRememberRecord() {
  try {
    const rec = JSON.parse(localStorage.getItem(LOGIN_REMEMBER_KEY) || 'null');
    if (!rec || !rec.username) return null;
    if (Number(rec.expiresAt) && Number(rec.expiresAt) < Date.now()) { localStorage.removeItem(LOGIN_REMEMBER_KEY); return null; }
    return rec;
  } catch { return null; }
}
function saveRememberRecord(username, password) {
  try {
    localStorage.setItem(LOGIN_REMEMBER_KEY, JSON.stringify({
      username, password, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
    }));
  } catch { /* 忽略 */ }
}
function clearRememberRecord() {
  try { localStorage.removeItem(LOGIN_REMEMBER_KEY); } catch { /* 忽略 */ }
}
// 预填：优先「记住的账号密码」→ 其次「上次登录的账号」；并清掉浏览器可能自动填进来的别的账号
function prefillLogin() {
  const rec = readRememberRecord();
  let last = '';
  try { last = localStorage.getItem(LAST_USER_KEY) || ''; } catch { /* 忽略 */ }
  const userEl = $('login-username');
  const pwdEl = $('login-password');
  const want = rec ? rec.username : last;
  if (want && userEl.value !== want) userEl.value = want;
  if (rec && rec.password && pwdEl.value !== rec.password) pwdEl.value = rec.password;
  $('login-remember').checked = !!rec;
}

async function submitLogin(e) {
  e.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  const remember = $('login-remember').checked;
  if (!username || !password) { showLoginError('请输入账号和密码'); return; }
  hideLoginError();
  const btn = $('login-btn');
  btn.disabled = true;
  try {
    const res = await api('/api/auth/login', { body: { username, password, remember } });
    state.user = res.user || null;                 // storeToken 记 30 天记录时要写账号名
    storeToken(res.token, remember, res.ttlMs);
    try { localStorage.setItem(LAST_USER_KEY, username); } catch { /* 忽略 */ }
    if (remember) saveRememberRecord(username, password);
    else clearRememberRecord();
    await enterAdmin();
  } catch (err) {
    showLoginError(err.message || '登录失败，请重试');
    btn.disabled = false;
  }
}

async function submitRegister(e) {
  e.preventDefault();
  const username = $('reg-username').value.trim();
  const password = $('reg-password').value;
  if (!username) { showRegError('请输入账号'); return; }
  if (password.length < 6) { showRegError('密码至少 6 位'); return; }
  if (password !== $('reg-password2').value) { showRegError('两次输入的密码不一致'); return; }
  hideRegError();
  const btn = $('reg-btn');
  btn.disabled = true;
  try {
    const res = await api('/api/auth/register', { body: { username, password } });
    state.user = res.user || null;
    storeToken(res.token, false);
    await enterAdmin();
  } catch (err) {
    showRegError(err.message || '注册失败，请重试');
    btn.disabled = false;
  }
}

// 问卷入口：支持粘贴完整链接（提取 q= 参数）或直接输入短码
function submitSurveyEntry(e) {
  e.preventDefault();
  const raw = $('survey-code').value.trim();
  if (!raw) return;
  let code = raw;
  try {
    const url = new URL(raw);
    const q = url.searchParams.get('q') || url.searchParams.get('c');
    if (q) code = q.trim();
  } catch { /* 不是 URL：当作短码 */ }
  if (!code) return;
  location.href = '/chat?q=' + encodeURIComponent(code);
}

$('login-form').addEventListener('submit', submitLogin);
$('register-form').addEventListener('submit', submitRegister);
$('survey-form').addEventListener('submit', submitSurveyEntry);
// 这一行没有提交按钮，回车就是唯一的提交方式：显式绑一次，不依赖浏览器的隐式提交
$('survey-code').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  submitSurveyEntry(e);
});
$('show-register').addEventListener('click', () => showBlock('register'));
$('show-reset').addEventListener('click', () => showBlock('reset'));
$('back-login').addEventListener('click', () => showBlock('login'));
$('back-login2').addEventListener('click', () => showBlock('login'));

// 浏览器自带的账号填充可能晚一拍落地：登录卡片可见时再覆盖一次
window.addEventListener('load', () => {
  if (!$('login-view').classList.contains('hidden')) setTimeout(prefillLogin, 300);
});

/* ---------------------------------------------------------------- 路由 */
// #/exp、#/exp/:id
// #/q、#/q/:id、#/q/:id/data、#/q/:id/s/:sid
// #/settings（个人设置）、#/users（用户管理，仅管理员）

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [section, a, b, c] = raw.split('/');
  if (section === 'settings') return { section, view: 'settings' };
  if (section === 'users') return { section, view: 'users' };
  if (section === 'exp') return a ? { section, view: 'editor', id: a } : { section, view: 'list' };
  if (section === 'q') {
    if (!a) return { section, view: 'list' };
    if (b === 'data') return { section, view: 'data', id: a };
    if (b === 's' && c) return { section, view: 'session', id: a, sid: c };
    return { section, view: 'editor', id: a };
  }
  return null;
}

function currentEditing() {
  return state.view === 'exp-editor' ? state.editingExp : state.view === 'q-editor' ? state.editingQ : null;
}

function handleRoute() {
  if ($('admin-view').classList.contains('hidden')) return;
  // 切页：先释放上一个编辑页的资源（进度轮询 / 预览会话）
  if (editorShellDispose) {
    try { editorShellDispose(); } catch { /* 忽略 */ }
    editorShellDispose = null;
  }
  if (!location.hash) { location.replace('#/q'); return; }
  const route = parseHash();
  if (!route) { location.replace('#/q'); return; }

  document.querySelectorAll('.sidebar-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.nav === route.section);
  });

  const editing = route.view === 'editor';
  if (route.view === 'settings' || route.view === 'users') {
    state.view = route.view;
    setSidebarMode('menu');
    if (route.view === 'settings') renderSettings();
    else renderUsers();
    window.scrollTo(0, 0);
    return;
  }
  state.view = route.section === 'exp' ? (editing ? 'exp-editor' : 'exp-list') : route.view === 'list' ? 'q-list' : route.view === 'editor' ? 'q-editor' : route.view === 'data' ? 'q-data' : 'q-session';

  // 进入编辑页默认切到大纲；回到列表 / 数据页切回菜单
  // 列表 / 数据页切回菜单；编辑页在题目加载完成后再切到大纲（见 renderExpEditor / renderQEditor）
  if (!editing) setSidebarMode('menu');

  if (state.view === 'exp-list') renderExpList();
  else if (state.view === 'exp-editor') renderExpEditor(route.id);
  else if (state.view === 'q-list') renderQList();
  else if (state.view === 'q-editor') renderQEditor(route.id);
  else if (state.view === 'q-data') renderQData(route.id);
  else if (state.view === 'q-session') renderQSession(route.id, route.sid);
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', handleRoute);

document.querySelectorAll('.sidebar-item').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = a.dataset.nav === 'exp' ? '#/exp' : '#/q';
  });
});

$('btn-settings').addEventListener('click', () => {
  location.hash = '#/settings';
});

/* ---------------------------------------------------------------- 侧边栏（菜单 / 大纲） */

function setSidebarMode(mode) {
  const editing = !!currentEditing();
  if (mode === 'outline' && !editing) mode = 'menu';
  state.sidebarMode = mode;
  const isOutline = mode === 'outline';
  $sidebarMenu.classList.toggle('hidden', isOutline);
  $sidebarOutline.classList.toggle('hidden', !isOutline);
  $segMenu.classList.toggle('on', !isOutline);
  $segOutline.classList.toggle('on', isOutline);
  $segOutline.disabled = !editing;
  if (isOutline) renderOutline();
}

$segMenu.addEventListener('click', () => setSidebarMode('menu'));
$segOutline.addEventListener('click', () => setSidebarMode('outline'));

/* ---------------------------------------------------------------- 三栏布局：拖动分隔线 / 菜单栏折叠与缩放 */

const LAYOUT_KEY = 'expchat_layout';
const LAYOUT_DEF = { sidebar: 246, phone: 348, collapsed: false };

function loadLayout() {
  try { return { ...LAYOUT_DEF, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') }; } catch { return { ...LAYOUT_DEF }; }
}
function saveLayout(patch) {
  const next = { ...loadLayout(), ...patch };
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
  applyLayout(next);
}
function applyLayout(l) {
  const root = document.documentElement.style;
  root.setProperty('--sidebar-w', `${l.sidebar}px`);
  root.setProperty('--phone-w', `${l.phone}px`);
  document.body.classList.toggle('side-collapsed', !!l.collapsed);
  const btn = $('btn-side-collapse');
  if (btn) btn.textContent = l.collapsed ? '»' : '«';
  if (typeof fitPhoneScale === 'function') fitPhoneScale();   // 拖动改动手机栏宽度时同步缩放
}
function startDrag(ev, which) {
  ev.preventDefault();
  const startX = ev.clientX;
  const start = loadLayout();
  const move = (e) => {
    const dx = e.clientX - startX;
    if (which === 'sidebar') saveLayout({ sidebar: Math.min(460, Math.max(180, start.sidebar + dx)) });
    else saveLayout({ phone: Math.min(680, Math.max(280, start.phone - dx)) });
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('col-dragging');
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  document.body.classList.add('col-dragging');
}
let layoutInited = false;
function initLayout() {
  // 退出登录后再登录会二次进入管理端：这些监听只能绑一次，否则会出现双份提示
  if (layoutInited) return;
  layoutInited = true;
  applyLayout(loadLayout());
  const side = $('split-sidebar');
  if (side) {
    side.addEventListener('mousedown', (e) => startDrag(e, 'sidebar'));
    side.addEventListener('dblclick', () => { saveLayout({ sidebar: LAYOUT_DEF.sidebar }); toast('菜单栏宽度已复位'); });
  }
  $('btn-side-collapse').addEventListener('click', () => {
    const next = !loadLayout().collapsed;
    saveLayout({ collapsed: next });
    toast(next ? '菜单栏已折叠' : '菜单栏已展开');
  });
}

// 大纲：层级树（高级包含低级）+ 折叠箭头 + 跟随编辑区滚动的高亮
// 层级 0 = 默认（顶层）；1–4 = 依次缩进。「紧跟其后、层级更深」的题目视为下属。
// 折叠状态与「看到哪儿了」都记在本机（见下面的 OUTLINE_KEY_PREFIX 一段）：
//   进入编辑页默认**折叠到最高层**（只显示最大级别，下属不显示），点行 / 滚到某一题会自动展开它的上级。
const outlineCollapsed = new Set();      // 大纲里被折叠的题目 id（进入时按本机记录恢复，没记录 = 只显示最高层）
let outlineActiveId = null;              // 大纲里当前高亮的那一行（滚动跟随 / 点击都改它）
let outlineSyncing = false;
let outlineSyncRaf = null;

/* ---- 大纲状态本机记忆 ------------------------------------------------
   键：expchat_outline_<q|exp>_<实体 id>（按问卷 / 模板分开记，互不串）。
   值：{ collapsed: [被折叠的题 id], selected: 当前题 id, scrollTop: 编辑区滚动位置, outlineScroll: 大纲滚动位置 }。
   为什么要记：编辑一份 40 道题的问卷，中途离开（返回列表 / 关掉页面）后再进来，
   除了「大纲长什么样」要还原，还应该直接落回上次看到的那道题，而不是回到第一题。 */
const OUTLINE_KEY_PREFIX = 'expchat_outline_';
function outlineStorageKey() {
  const target = currentEditing();
  if (!target || !target.id) return '';
  return `${OUTLINE_KEY_PREFIX}${state.view === 'exp-editor' ? 'exp' : 'q'}_${target.id}`;
}
function loadOutlineState() {
  const key = outlineStorageKey();
  if (!key) return null;
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) || null : null; } catch { return null; }
}
// 没有历史记录时的默认：所有「有下属」的题都折叠 → 大纲只剩最高层那几行
function outlineDefaultCollapsed(items) {
  const out = [];
  for (let i = 0; i < items.length; i += 1) if (outlineHasChildren(items, i)) out.push(items[i].id);
  return out;
}
// 写回本机记录：折叠集合 + 当前题 + 两处滚动位置（都已不在题里的 id 会被丢掉）
function saveOutlineState() {
  const key = outlineStorageKey();
  const target = currentEditing();
  if (!key || !target) return;
  const items = target.items || [];
  const ids = new Set(items.map((x) => x.id));
  const sc = document.querySelector('.editor-scroll');
  const payload = {
    collapsed: [...outlineCollapsed].filter((id) => ids.has(id)),
    selected: ids.has(state.selected) ? state.selected : '',
    // 「看到哪儿了」= 编辑区可见顶部的那一题（滚动跟随的高亮行）；没滚过就用选中的那一题
    at: ids.has(outlineActiveId) ? outlineActiveId : (ids.has(state.selected) ? state.selected : ''),
    scrollTop: Math.round((sc && sc.scrollTop) || 0),
    outlineScroll: Math.round(($sidebarOutline && $sidebarOutline.scrollTop) || 0)
  };
  try { localStorage.setItem(key, JSON.stringify(payload)); } catch { /* 忽略 */ }
}
let outlineSaveTimer = null;
function scheduleSaveOutlineState() {
  window.clearTimeout(outlineSaveTimer);
  outlineSaveTimer = window.setTimeout(saveOutlineState, 260);
}
// 进入编辑页：装回折叠状态 → 把上次看的那道题瞬时落回原处 → 高亮跟上。
// 题卡在这一步已经挂载（各编辑器 body 渲染完调用），所以可以直接定位。
function restoreOutlineOnEnter() {
  const target = currentEditing();
  if (!target) return;
  const saved = loadOutlineState();
  const items = target.items || [];
  const known = new Set(items.map((x) => x.id));
  outlineCollapsed.clear();
  const ids = saved && Array.isArray(saved.collapsed) ? saved.collapsed : outlineDefaultCollapsed(items);
  for (const id of ids) if (known.has(id)) outlineCollapsed.add(id);
  renderOutline();
  const wantId = saved && saved.selected && known.has(saved.selected) ? saved.selected : '';
  const atId = saved && saved.at && known.has(saved.at) ? saved.at : '';
  if (wantId) {
    state.selected = wantId;
    outlineActiveId = wantId;
    if (editorCtx && typeof editorCtx.select === 'function') editorCtx.select(wantId);
    const card = document.querySelector(`.qcard[data-id="${wantId}"]`);
    if (card) scrollEditorTo(card, false);      // 瞬时（不再是「滑过去」）：进来就该已在原处
  } else if (atId) {
    // 上次只是滚到了某一题（没有选中态）：把那一题落回可见顶部，不动选中态
    const card = document.querySelector(`.qcard[data-id="${atId}"]`);
    if (card) scrollEditorTo(card, false);
  } else if (saved && Number.isFinite(saved.scrollTop)) {
    const sc = document.querySelector('.editor-scroll');
    if (sc) sc.scrollTop = Math.max(0, saved.scrollTop);
  }
  if ($sidebarOutline && saved && Number.isFinite(saved.outlineScroll)) {
    $sidebarOutline.scrollTop = Math.max(0, saved.outlineScroll);
  }
  syncOutlineActive();
  saveOutlineState();                            // 恢复过程本身（自动展开上级）也记一笔
}
// 关页面 / 切到后台前把最后的位置落下来（滚动记录是节流的，可能还差最后一笔）
window.addEventListener('pagehide', saveOutlineState);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveOutlineState(); });

function outlineHasChildren(items, i) {
  return i + 1 < items.length && levelRank(itemLevel(items[i + 1])) < levelRank(itemLevel(items[i]));
}
// 折叠之后仍然可见的行（被折叠父题的下属全部隐藏）
function outlineVisibleIndexes(items) {
  const rows = [];
  let hideLowerThan = null;
  for (let i = 0; i < items.length; i += 1) {
    const rank = levelRank(itemLevel(items[i]));
    if (hideLowerThan != null && rank < hideLowerThan) continue;      // 更小的级别 = 下属 → 藏起来
    hideLowerThan = null;
    rows.push(i);
    if (outlineCollapsed.has(items[i].id) && outlineHasChildren(items, i)) hideLowerThan = rank;
  }
  return rows;
}
// 某题的全部上级（用于「滚动到某题时自动展开它的上级」）
function outlineAncestors(items, index) {
  const chain = [];
  let rank = levelRank(itemLevel(items[index]));
  for (let i = index - 1; i >= 0 && rank < 4; i -= 1) {
    const up = levelRank(itemLevel(items[i]));
    if (up > rank) { chain.push(items[i]); rank = up; }
  }
  return chain;
}
// 编辑区滚到某道题的「开头」：
//   ① 只滚编辑区自身（不用 scrollIntoView —— 它会把外层 .admin-main 一起滚，整页一移，右边手机栏就只剩最下面一条）
//   ② 顶部要让开粘性操作条（否则题卡顶被压在操作条下面，看着像「跳到了题目下面」）
//   ③ 窄屏（≤980px）编辑区不自己滚（overflow: visible），这时改滚整页
//   ④ 默认平滑下滑（smooth），点一下就「滑」过去而不是瞬间闪过去
// 只把某一行「保持在可视区内」：超出才动，且动得最少（用户手动滚大纲时不会被拽回去）
function keepRowVisible(container, node, gap) {
  if (!container || !node) return;
  const gapPx = gap == null ? 10 : gap;
  const cRect = container.getBoundingClientRect();
  const nRect = node.getBoundingClientRect();
  if (nRect.top < cRect.top + gapPx) container.scrollTop += nRect.top - cRect.top - gapPx;
  else if (nRect.bottom > cRect.bottom - gapPx) container.scrollTop += nRect.bottom - cRect.bottom + gapPx;
}
function editorStickyPad() {
  const bar = document.querySelector('.editor-scroll .editor-actionbar');
  return (bar ? bar.getBoundingClientRect().height : 0) + 10;
}
// 平滑滚动：不用浏览器自带 behavior:'smooth'（长距离时它的时长不可控，几万像素要滑好几秒，
// 途中大纲高亮会一直跟着路过中间那些题）。这里自己做一段短缓动：150–300ms，落点精确。
let editorScrollAnim = null;
function animateScrollTop(el, target) {
  if (!el) return 0;
  if (editorScrollAnim) { window.cancelAnimationFrame(editorScrollAnim.raf); editorScrollAnim = null; }
  const from = el.scrollTop;
  const dist = target - from;
  const dur = Math.max(150, Math.min(300, 130 + Math.abs(dist) / 60));
  if (Math.abs(dist) < 2) { el.scrollTop = target; return 0; }
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / dur);
    el.scrollTop = from + dist * ease(p);
    if (p < 1) editorScrollAnim = { raf: window.requestAnimationFrame(step) };
    else { editorScrollAnim = null; el.scrollTop = target; }
  };
  editorScrollAnim = { raf: window.requestAnimationFrame(step) };
  return dur;
}
// 动画结束后按最终布局校正落点：只留最后一次（连点几下不再排出好几个迟到的校正，越点越晃）
let editorScrollFix = null;
function cancelEditorScrollFix() {
  if (editorScrollFix) { window.clearTimeout(editorScrollFix); editorScrollFix = null; }
}
// 用户一动手就停掉正在跑的滚动动画与待校正，并解除高亮钉住（立刻恢复「滚到哪高亮哪」）
function cancelEditorScrollAnim() {
  if (editorScrollAnim) { window.cancelAnimationFrame(editorScrollAnim.raf); editorScrollAnim = null; }
  cancelEditorScrollFix();
  outlinePin = null;
}
function scrollEditorTo(node, smooth = true) {
  const sc = document.querySelector('.editor-scroll');
  if (!sc || !node) return 0;
  const pad = editorStickyPad();
  // 目标位置：把这道题的开头放到「粘性操作条下面」
  const targetOf = (el) => {
    const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - pad;
    return Math.max(0, Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + delta));
  };
  // 选中态 / 「就地插入」行会让上方内容高度变化 → 动画结束后按最终布局校正一次（瞬时 ±几像素，不再是第二段动画）
  const correctLater = (el, dur) => {
    cancelEditorScrollFix();
    editorScrollFix = window.setTimeout(() => {
      editorScrollFix = null;
      const d = node.getBoundingClientRect().top - el.getBoundingClientRect().top - pad;
      if (Math.abs(d) > 4) el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + d));
    }, (dur || 200) + 60);
  };
  if (sc.scrollHeight > sc.clientHeight + 1) {
    if (!smooth) { cancelEditorScrollFix(); sc.scrollTop = targetOf(sc); return 0; }
    const dur = animateScrollTop(sc, targetOf(sc));
    correctLater(sc, dur);
    return dur;
  }
  // 编辑区不滚（窄屏堆叠）：滚整页
  const docEl = document.scrollingElement || document.documentElement;
  if (smooth) {
    const dur = animateScrollTop(docEl, targetOf(docEl));
    correctLater(docEl, dur);
    return dur;
  }
  cancelEditorScrollFix();
  for (let i = 0; i < 2; i += 1) {
    const d2 = node.getBoundingClientRect().top - (pad + 8);
    if (Math.abs(d2) < 2) break;
    window.scrollTo(0, Math.max(0, window.scrollY + d2));
  }
  return 0;
}
// 程序化滚动（平滑）期间把大纲高亮钉在目标题上：否则滚动途中跟随逻辑会把高亮甩到中途的题
let outlinePin = null;
let outlinePinTimer = null;
function pinOutlineHighlight(id, ms = 900) {
  outlinePin = { id, until: Date.now() + ms };
  // 钉住结束后自动重算一次：万一这期间用户滚过（高亮被钉住没跟），这里补上
  window.clearTimeout(outlinePinTimer);
  outlinePinTimer = window.setTimeout(() => { outlinePin = null; syncOutlineActive(); }, ms + 30);
}

// 大纲高亮：只有「高亮的那一行」真的换了才碰 DOM。
// 滚动跟随时每帧都会走到这里，连点大纲切换题目时也不该全表扫一遍。
let outlineActiveRow = null;
function paintOutlineActive(id) {
  const next = id ? $sidebarOutline.querySelector(`.ol-item[data-id="${id}"]`) : null;
  if (next !== outlineActiveRow) {
    if (outlineActiveRow) outlineActiveRow.classList.remove('on');
    if (next) next.classList.add('on');
    outlineActiveRow = next;
  }
  return next;
}

// 编辑区滚到哪一题，大纲里对应那一行就背景高亮（必要时自动展开它的上级）
function syncOutlineActive() {
  if (outlineSyncing || state.sidebarMode !== 'outline' || !$sidebarOutline) return;
  const sc = document.querySelector('.editor-scroll');
  if (!sc) return;
  // 平滑滚动进行中：高亮钉在目标题上（等滚完了再恢复按位置跟随），
  // 钉住期间不必扫位置——滚动每帧都会走到这里，省掉整列测量。
  let activeId = null;
  if (outlinePin && Date.now() < outlinePin.until) {
    activeId = outlinePin.id;
  } else {
    outlinePin = null;
    const top = sc.getBoundingClientRect().top;
    const topGap = editorStickyPad();      // 粘性操作条以下的区域才算「可见顶部」
    for (const card of sc.querySelectorAll('.qcard[data-id]')) {
      if (card.getBoundingClientRect().bottom - top > topGap) { activeId = card.dataset.id; break; }
    }
  }
  const target = currentEditing();
  let forceKeep = false;                     // 刚自动展开过上级 → 行位置全变了，这一行必须重新拉进视野
  if (activeId && target) {
    const idx = target.items.findIndex((x) => x.id === activeId);
    if (idx >= 0) {
      let changed = false;
      for (const parent of outlineAncestors(target.items, idx)) {
        if (outlineCollapsed.delete(parent.id)) changed = true;
      }
      if (changed) {
        outlineSyncing = true;
        try { renderOutline(); } finally { outlineSyncing = false; }
        forceKeep = true;
        // 不 return：重画后继续往下走，把高亮落到当前这一题上
        // （重画时 outlineSyncing 为真，里面那次 syncOutlineActive 会跳过）
      }
    }
  }
  const prevActiveId = outlineActiveId;
  outlineActiveId = activeId;
  const activeRow = paintOutlineActive(activeId);
  // 只「保持可见」：不把这一行硬拽到顶部 —— 否则用户手动滚大纲会被一次次拽回去（像是滚不动）。
  // 而且只在**高亮行真的换了**时才保持可见：跟随编辑区滚动时高亮会换行 → 大纲跟着走；
  // 用户自己滚大纲时编辑区没动、高亮行没换 → 一个字都不碰，往上往下都滚得动（issue：选完题后大纲锁住）。
  if (activeRow && (forceKeep || activeId !== prevActiveId)) keepRowVisible($sidebarOutline, activeRow, 10);
}
// 点大纲 / 点题卡共用的一条路：选中该题 → 就地更新选中态（含「就地插入」行）→ 平滑滑到它的开头。
// 滑动期间把大纲高亮钉在这一行上（否则跟随逻辑会把高亮甩到路过的题），滑动时长由滚动动画给出。
function focusItem(id) {
  const target = currentEditing();
  if (!target || !target.items.some((x) => x.id === id)) return;
  state.selected = id;
  outlineActiveId = id;
  if (editorCtx && typeof editorCtx.select === 'function') editorCtx.select(id);
  const card = document.querySelector(`.qcard[data-id="${id}"]`);
  const dur = card ? scrollEditorTo(card, true) : 0;
  pinOutlineHighlight(id, dur + 140);
  syncOutlineActive();       // 立刻把高亮落到这一行；钉住期间跟随逻辑不会把它甩走
  scheduleSaveOutlineState();   // 「看到哪一题」也记在本机（平滑滚动期间节流写，落定后再写一次）
  window.setTimeout(() => { if (state.selected === id) saveOutlineState(); }, dur + 260);
}

// 用户自己滚动 / 点按编辑区时，立即停掉程序化滚动动画（不和用户抢）
document.addEventListener('wheel', cancelEditorScrollAnim, { capture: true, passive: true });
document.addEventListener('touchstart', cancelEditorScrollAnim, { capture: true, passive: true });
document.addEventListener('mousedown', (e) => { if (e.target && e.target.closest && e.target.closest('.editor-scroll')) cancelEditorScrollAnim(); }, true);

// 捕获阶段的 scroll 不冒泡，但用 capture 能收到所有后代的滚动（编辑区每次渲染都是新元素）
document.addEventListener('scroll', () => {
  if (outlineSyncRaf) return;
  outlineSyncRaf = window.requestAnimationFrame(() => {
    outlineSyncRaf = null;
    syncOutlineActive();
    scheduleSaveOutlineState();      // 编辑区 / 大纲滚到哪儿了，节流记一笔
  });
}, true);

function renderOutline() {
  const target = currentEditing();
  if (!target || !$sidebarOutline) return;
  const items = target.items;
  const outlineScroll = $sidebarOutline.scrollTop;
  $sidebarOutline.innerHTML = '';
  outlineActiveRow = null;          // 整表重画：原来记着的高亮行已随旧 DOM 一起丢掉

  for (const [label, anchor] of [
    [state.view === 'exp-editor' ? '模板信息' : '问卷信息', 'sec-basic'],
    [`题目编排（${questionCount(items)} 道）`, 'sec-items']
  ]) {
    const sec = el('div', 'ol-sec', label);
    sec.onclick = () => {
      const node = $(anchor);
      if (node) scrollEditorTo(node);
    };
    $sidebarOutline.appendChild(sec);
  }

  const qnos = questionNos(items);
  let lastBand = null;
  for (const idx of outlineVisibleIndexes(items)) {
    const it = items[idx];
    if (it.fromTemplateId && it.fromTemplateId !== lastBand) {
      lastBand = it.fromTemplateId;
      const band = el('div', 'ol-band');
      band.append(el('span', '', '来自模板'), el('span', 'line'));
      $sidebarOutline.appendChild(band);
    } else if (!it.fromTemplateId) lastBand = null;

    const lv = itemLevel(it);
    const qno = qnos.get(it.id);
    const row = el('div', 'ol-item d' + levelDepth(lv) + (qno ? '' : ' no-q'));
    row.dataset.id = it.id;

    // 有下属（紧跟其后、层级更深的题目）→ 左边给折叠箭头
    if (outlineHasChildren(items, idx)) {
      const folded = outlineCollapsed.has(it.id);
      const fold = el('button', 'ol-fold', folded ? '▸' : '▾');
      fold.type = 'button';
      fold.title = folded ? '展开下属题目' : '折叠下属题目';
      fold.addEventListener('click', (e) => {
        e.stopPropagation();
        if (folded) outlineCollapsed.delete(it.id); else outlineCollapsed.add(it.id);
        renderOutline();
        saveOutlineState();          // 折叠状态记在本机：下次进来还是这个样子
      });
      row.appendChild(fold);
    } else {
      row.appendChild(el('span', 'ol-fold-space'));
    }

    row.appendChild(el('span', 'ol-num', qno ? String(qno) : '·'));
    row.appendChild(el('span', 'ic', TYPE_ICON(it.type)));
    row.appendChild(el('span', 'tx', it.title || '（未命名）'));
    // 行里不再显示「x 级」与参数数量：层级靠缩进一眼可见，参数在题卡上另有徽标，
    // 这两块挤掉的是标题的显示宽度（大纲能看到更多标题字）
    row.title = `${itemTypeLabel(it)} · ${it.title || ''}`;
    // 点大纲：选中该题并「平滑滑」到该题开头（不是瞬间跳过去）。
    // 只就地更新选中态与高亮，不整列重建题卡、也不重画大纲——否则点一下就要为每道题重造一次正文编辑器。
    row.onclick = () => focusItem(it.id);
    $sidebarOutline.appendChild(row);
  }
  $sidebarOutline.scrollTop = outlineScroll;
  syncOutlineActive();
}

function TYPE_ICON(type) {
  return { message: '▤', gate: '⛨', confirm: '▣', debrief: '◎', group: '▦', rating: '☆', single: '◉', multi: '☑', text: '▭', rank: '↕' }[type] || '·';
}

// 大纲里的标题就地更新：改「大纲标题」输入框（或正文首行自动回填标题）时调用。
// 不整表重画 —— 重画会把大纲的滚动位置、折叠状态与高亮再算一遍，输入时每敲一个字都跳一下。
function updateOutlineTitle(id) {
  const target = currentEditing();
  if (!target || !$sidebarOutline) return;
  const it = target.items.find((x) => x.id === id);
  if (!it) return;
  const row = $sidebarOutline.querySelector(`.ol-item[data-id="${id}"]`);
  if (!row) return;                                   // 菜单模式 / 该题被折叠：不用管
  const tx = row.querySelector('.tx');
  if (tx) tx.textContent = it.title || '（未命名）';
  row.title = `${itemTypeLabel(it)} · ${it.title || ''}`;
}

/* ---------------------------------------------------------------- 「插入题目」二级选择
   一级列出题型；鼠标悬停到有二级形态的题型（目前只有知情同意页）时，右侧展开二级栏再选。
   触屏没有 hover，所以点一级项同样能展开。 */

let openInsertPicker = null;
document.addEventListener('click', (e) => {
  if (openInsertPicker && !openInsertPicker.contains(e.target)) {
    openInsertPicker.close();
    openInsertPicker = null;
  }
});

function buildInsertPicker(labelText, onPick) {
  const wrap = el('div', 'ins-picker');
  const btn = el('button', 'mini-btn', labelText || '＋ 插入题目');
  btn.type = 'button';
  const panel = el('div', 'ins-panel hidden');
  const sub = el('div', 'ins-sub hidden');
  const variantsOf = (t) => (state.meta.itemVariants || {})[t] || null;

  const close = () => { panel.classList.add('hidden'); sub.classList.add('hidden'); };
  const openSub = (type, row) => {
    const variants = variantsOf(type);
    if (!variants) { sub.classList.add('hidden'); return; }
    sub.innerHTML = '';
    for (const v of variants) {
      const b = el('button', 'ins-item', v.label);
      b.type = 'button';
      b.onclick = (e) => { e.stopPropagation(); close(); onPick(v.key, v.label); };
      sub.appendChild(b);
    }
    sub.style.top = `${row.offsetTop}px`;
    sub.classList.remove('hidden');
  };

  for (const t of TYPE()) {
    const hasSub = !!variantsOf(t);
    const row = el('button', 'ins-item' + (hasSub ? ' has-sub' : ''), `${TYPE_ICON(t)} ${TYPE_LABEL(t)}`);
    row.type = 'button';
    if (hasSub) {
      row.addEventListener('mouseenter', () => openSub(t, row));
      row.onclick = (e) => { e.stopPropagation(); openSub(t, row); };
    } else {
      row.addEventListener('mouseenter', () => sub.classList.add('hidden'));
      row.onclick = (e) => { e.stopPropagation(); close(); onPick(t, TYPE_LABEL(t)); };
    }
    panel.appendChild(row);
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    const willOpen = panel.classList.contains('hidden');
    close();
    if (willOpen) { panel.classList.remove('hidden'); openInsertPicker = wrap; }
    else openInsertPicker = null;
  };
  wrap.close = close;
  // 二级栏挂在一级面板内部：这样它的定位基准是一级面板，紧贴其右缘（挂在外层会以按钮为基准而重叠）
  panel.appendChild(sub);
  wrap.append(btn, panel);
  return wrap;
}

/* ---------------------------------------------------------------- 数据加载 */

async function reloadExperiments() {
  state.experiments = (await api('/api/admin/experiments')).experiments;
}
async function reloadQuestionnaires() {
  state.questionnaires = (await api('/api/admin/questionnaires')).questionnaires;
}

/* ---------------------------------------------------------------- 题目参数 */

// 生效的参数值：题目配了就用题目的，没配回落到内置默认值（与服务端 effLimit 同逻辑）
function effLimit(item, key) {
  const v = item.limits ? item.limits[key] : undefined;
  if (v !== undefined && v !== null) return Number(v) || 0;
  return Number(LIMIT_DEFAULTS()[key]) || 0;
}

/* ---------------------------------------------------------------- 「题目」口径（与服务端 units.qno 一致）
   只有需要被试作答的题型才计入题号：消息 / 知情同意页 / 确认页 / 结束说明都只是页面，不占题号。 */

function questionTypes() {
  const fromMeta = state.meta && state.meta.questionTypes;
  return Array.isArray(fromMeta) && fromMeta.length
    ? fromMeta
    : ['group', 'rating', 'single', 'multi', 'text', 'rank'];
}
function isQuestionType(type) { return questionTypes().includes(type); }
function questionNos(list) {
  const map = new Map();
  let n = 0;
  for (const it of list) {
    if (!isQuestionType(it.type)) continue;
    n += 1;
    map.set(it.id, n);
  }
  return map;
}
function questionCount(list) {
  return list.reduce((n, it) => n + (isQuestionType(it.type) ? 1 : 0), 0);
}
// 层级（只影响管理端大纲，被试端无感知）：
//   1 = 最高级（不缩进，适合当"消息反馈公平性"这类小标题）、2/3/4 依次降低、0 = 最低级（默认，缩进最深）。
//   排序（从大到小）：1 → 2 → 3 → 4 → 0。
function itemLevel(item) {
  return Math.min(4, Math.max(0, Math.round(Number(item && item.level) || 0)));
}
// 「大小」序：1 最大（4）、0 最小（0）—— 用于判断从属关系（紧跟其后、更小的算下属）
function levelRank(level) {
  const lv = Math.min(4, Math.max(0, Math.round(Number(level) || 0)));
  return lv === 0 ? 0 : 5 - lv;
}
// 缩进档位：1 级 0 档（最靠左）… 4 级 3 档、0 级 4 档（最深）
function levelDepth(level) {
  const lv = Math.min(4, Math.max(0, Math.round(Number(level) || 0)));
  return lv === 0 ? 4 : lv - 1;
}

function limitBadges(item) {
  const out = [];
  for (const k of TYPE_LIMITS(item.type)) {
    if (item.limits[k] == null) continue;                 // 未添加的参数不显示徽标
    const meta = LIMIT_META()[k];
    if (k === 'refresh') { out.push(meta.label); continue; }
    const v = effLimit(item, k);
    if (v > 0) out.push(`${meta.label} ${v}${meta.unit === '秒' ? 's' : ''}`);
  }
  return out;
}

function itemSummary(item) {
  switch (item.type) {
    case 'message': return (item.text || '').split('\n')[0].slice(0, 64) || '（空 · 被试端跳过）';
    case 'gate': return '进入实验前的伦理门槛，勾选后开始';
    case 'confirm': return (item.text || '').split('\n')[0].slice(0, 64) || '读完点确认继续';
    case 'debrief': return (item.text || '').split('\n')[0].slice(0, 64);
    case 'rating': return `${item.min}–${item.max} 分 · ${item.anchor || '无锚点'}${effLimit(item, 'redo') === 1 ? ' · 可重做' : ''}`;
    case 'single': case 'multi': return `${(item.options || []).length} 个选项${item.correct ? ' · 正确答案 ' + 'ABCDEFGH'[item.correct - 1] : ''}`;
    case 'rank': return `${(item.options || []).length} 项排序`;
    case 'text': {
      if (item.variant === 'match') {
        const lines = String(item.answer || '').split('\n').map((x) => x.trim()).filter(Boolean);
        const shown = lines.length ? lines.map((x) => `「${x}」`).join(' / ') : '';
        return shown
          ? `需输入指定内容 · 答案 ${shown}`
          : '⚠ 尚未设置标准答案 · 当前等同自由作答（被试输入任何内容都能发送）';
      }
      return `${item.required === false ? '选答' : '必答'} · ${item.rows || 1} 行${item.maxLen ? ' · 上限 ' + item.maxLen + ' 字' : ''}`;
    }
    case 'group': return (item.subs || []).length
      ? `${item.subs.length} 道子题：${item.subs.map((x) => x.title || TYPE_LABEL(x.type)).join(' + ')}（同屏呈现、一次提交）`
      : '空题组 · 请展开后添加子题';
    default: return item.title || '';
  }
}

/* ---------------------------------------------------------------- 题目编辑器 */

// 新建消息默认带上「思考过程」参数（可删）：「思考中提示」从此是题目上的一个显式参数，
// 没写思考稿、也没显式配时长时，被试端不会再凭空冒出「正在思考」。
function applyNewItemDefaults(item) {
  if (!item) return item;
  // 大纲标题留空 = 自动取正文首行（正文才是被试看到的内容，标题只服务于管理端列表 / 大纲）
  item.title = '';
  item.html = item.html || '';
  if (item.type === 'message' && item.thinking == null && !item.__thinkingOn) {
    item.__thinkingOn = true;
    if (!item.limits) item.limits = {};
    if (item.limits.thinkMs == null) item.limits.thinkMs = 20000;    // 思考时长默认 20 秒
  }
  return item;
}

// 层级控件（题卡右上角、折叠按钮左边）：下拉可选，也可以双击输入数字。
// 0 = 默认（与顶层同级）；1–4 = 依次缩进。无效输入（a / 9 / 空）一律不改动、保持原值。
function buildLevelControl(item, rerender) {
  const wrap = el('span', 'lv-ctl');
  wrap.appendChild(el('span', 'lv-label', '层级'));
  const input = el('input', 'lv-input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.value = String(itemLevel(item));
  input.title = '题目层级：1 = 最高级（不缩进，适合当小标题）、2/3/4 依次降低、0 = 最低级（默认，缩进最深）。只影响管理端大纲，被试端无感知';
  const commit = (raw) => {
    const text = String(raw == null ? '' : raw).trim();
    if (!/^\d+$/.test(text)) { input.value = String(itemLevel(item)); return; }   // 非数字（如 a）→ 保持原值
    const n = Number(text);
    if (n < 0 || n > 4) { input.value = String(itemLevel(item)); return; }        // 越界（如 9）→ 保持原值
    if (n > 0) item.level = n; else delete item.level;
    input.value = String(n);
    renderOutline();
  };
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => commit(input.value));
  input.addEventListener('blur', () => commit(input.value));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { commit(input.value); input.blur(); }
    if (e.key === 'Escape') { input.value = String(itemLevel(item)); input.blur(); }
  });
  input.addEventListener('dblclick', (e) => { e.stopPropagation(); input.select(); });

  const caret = el('button', 'mini-btn lv-caret', '▾');
  caret.type = 'button';
  caret.title = '选择层级';
  const panel = el('div', 'lv-panel hidden');
  // 从高到低：1 级 … 4 级，最后是 0（默认·最低级）
  for (const lv of [1, 2, 3, 4, 0]) {
    const text = lv === 0 ? '0 · 默认（最低级）' : lv + ' 级' + (lv === 1 ? '（最高级）' : '');
    const b = el('button', 'mini-btn', text);
    b.type = 'button';
    b.onclick = (e) => { e.stopPropagation(); panel.classList.add('hidden'); commit(String(lv)); };
    panel.appendChild(b);
  }
  caret.addEventListener('mousedown', (e) => e.stopPropagation());
  caret.onclick = (e) => { e.stopPropagation(); panel.classList.toggle('hidden'); };
  wrap.append(input, caret, panel);
  return wrap;
}

function buildItemEditor(list, opts = {}) {
  const wrap = el('div');
  let onChange = opts.onChange || (() => {});

  function rerender() { render(); }

  // 头部工具条上的小按钮（点它别把「选中该题」也一起触发）
  function miniTool(label, title, fn) {
    const b = el('button', 'mini-btn', label);
    b.title = title;
    b.onclick = (ev) => { ev.stopPropagation(); fn(); };
    return b;
  }

  // 选中题卡正下方的「插入题目」入口。它跟着选中项走，所以单独建：
  // 点大纲 / 点题卡时只把这一行搬过去（先撤掉旧的），不必重建整列题卡。
  function buildInsertRow(item) {
    const ins = el('div', 'insert-row');
    // ① 插入单题
    ins.appendChild(el('span', 'lbl', '在此题下方插入题目：'));
    ins.appendChild(buildInsertPicker('＋ 选择题型', (key, label) => {
      const base = JSON.parse(JSON.stringify(state.meta.itemDefaults[key] || { type: key }));
      const created = applyNewItemDefaults({ ...base, id: `new${Date.now().toString(36)}`, limits: {}, collapsed: false, title: base.title || label || TYPE_LABEL(key) });
      list.splice(list.indexOf(item) + 1, 0, created);
      state.selected = created.id;
      toast('已在该题下方插入：' + (label || TYPE_LABEL(key)));
      render();
    }));
    // ② 插入整组实验模板（与「+ 插入整组」等价，但落在选中题下方）
    if (state.experiments.length) {
      ins.appendChild(el('span', 'lbl', '　或插入实验模板：'));
      const tsel = el('select', 'add-select');
      for (const e of state.experiments) {
        const o = el('option', '', e.name);
        o.value = e.id;
        tsel.appendChild(o);
      }
      const tbtn = el('button', 'mini-btn', '+ 插入整组');
      tbtn.onclick = async () => {
        const exp = state.experiments.find((x) => x.id === tsel.value);
        if (!exp) return;
        const full = (await api(`/api/admin/experiment?id=${encodeURIComponent(exp.id)}`)).experiment;
        const stamp = Date.now().toString(36);
        const copies = full.items.map((it2, i) => ({
          ...JSON.parse(JSON.stringify(it2)),
          id: `${stamp}_${i}_${it2.id}`,
          fromTemplateId: full.id,
          fromTemplateName: full.name
        }));
        list.splice(list.indexOf(item) + 1, 0, ...copies);
        state.selected = null;
        toast(`已在下方插入模板「${full.name}」的 ${copies.length} 道题`);
        render();
      };
      ins.append(tsel, tbtn);
    }
    return ins;
  }

  // 单张题卡。结构没变时复用它（整列重建会为每道题重造一次正文编辑器，几十道题连点几下就卡）。
  function buildCard(item, qnos) {
    const card = el('div', 'qcard' + (state.selected === item.id ? ' selected' : '') + (item.collapsed ? ' collapsed' : ''));
    card.dataset.id = item.id;

    const head = el('div', 'qcard-head');
    const handle = el('span', 'drag', '⠿');
    handle.title = '拖动排序';
    handle.draggable = true;
    handle.addEventListener('dragstart', (e) => {
      state.dragId = item.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
    });
    handle.addEventListener('dragend', () => {
      state.dragId = null;
      card.classList.remove('dragging');
      wrap.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    });
    card.addEventListener('dragover', (e) => {
      if (!state.dragId || state.dragId === item.id) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      card.classList.toggle('drop-before', !after);
      card.classList.toggle('drop-after', after);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      moveItem(list, state.dragId, item.id, after);
      state.dragId = null;
      toast('已调整顺序');
      render();
    });

    head.appendChild(handle);
    const qno = qnos.get(item.id);
    if (qno) head.appendChild(el('span', 'qnum', `第 ${qno} 题`));
    head.appendChild(el('span', 'qtype', `${TYPE_ICON(item.type)} ${itemTypeLabel(item)}`));
    head.appendChild(el('span', 'qtitle', item.title || '（未命名）'));
    const badges = el('div', 'qbadges');
    for (const b of limitBadges(item)) badges.appendChild(el('span', 'qbadge limit', b));
    head.appendChild(badges);

    const tools = el('div', 'qtools');
    tools.append(
      buildLevelControl(item, render),
      miniTool(item.collapsed ? '展开' : '折叠', '折叠 / 展开该题', () => { item.collapsed = !item.collapsed; render(); }),
      miniTool('复制', '复制该题', () => { const c = JSON.parse(JSON.stringify(item)); c.id = `copy${Date.now()}`; delete c.fromTemplateId; delete c.fromTemplateName; list.splice(list.indexOf(item) + 1, 0, c); toast('已复制'); render(); }),
      miniTool('删除', '删除该题', () => { list.splice(list.indexOf(item), 1); if (state.selected === item.id) state.selected = null; render(); })
    );
    head.appendChild(tools);
    card.appendChild(head);

    if (item.collapsed) {
      card.appendChild(el('p', 'qsum', itemSummary(item)));
    } else {
      const body = el('div', 'qbody');
      body.appendChild(buildItemFields(item, rerender));
      card.appendChild(body);
    }

    // 点题卡头部 = 与点大纲同一条路：选中 + 平滑滑到开头 + 大纲高亮跟着过去
    head.addEventListener('click', () => focusItem(item.id));
    return card;
  }

  // 只更新「选中态」：切 .selected、把「就地插入」行搬过去、必要时展开这一张卡。
  // O(1) 更新——旧实现每次点大纲都整列重建（每道题重造一次正文编辑器 + 重画两遍大纲），连点几下就卡。
  function select(id) {
    const item = list.find((x) => x.id === id);
    if (!item) return false;
    if (item.collapsed) {
      item.collapsed = false;
      const old = wrap.querySelector(`.qcard[data-id="${id}"]`);
      if (old) old.replaceWith(buildCard(item, questionNos(list)));
    }
    wrap.querySelectorAll('.qcard').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
    wrap.querySelectorAll('.insert-row').forEach((n) => n.remove());
    const card = wrap.querySelector(`.qcard[data-id="${id}"]`);
    if (card) card.insertAdjacentElement('afterend', buildInsertRow(item));
    return true;
  }

  function render() {
    // 保留滚动位置：增删 / 选择 / 拖动后的重渲染不做视觉跳动
    const sc = wrap.closest('.editor-scroll');
    const scrollTop = sc ? sc.scrollTop : 0;
    wrap.innerHTML = '';
    let lastBand = null;
    const qnos = questionNos(list);

    list.forEach((item) => {
      if (item.fromTemplateId && item.fromTemplateId !== lastBand) {
        lastBand = item.fromTemplateId;
        const band = el('div', 'group-band');
        band.append(el('span', 'label', '来自模板：' + (item.fromTemplateName || item.fromTemplateId)), el('span', 'line'));
        const del = el('button', 'mini-btn', '整组删除');
        del.onclick = () => {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            if (list[i].fromTemplateId === item.fromTemplateId) list.splice(i, 1);
          }
          toast('已删除该模板插入的整组题目');
          render();
        };
        band.appendChild(del);
        wrap.appendChild(band);
      } else if (!item.fromTemplateId) lastBand = null;

      wrap.appendChild(buildCard(item, qnos));

      // 选中该题时，在其正下方给出「插入题目」入口（参考问卷星 / Notion 的就地插入）
      if (state.selected === item.id) wrap.appendChild(buildInsertRow(item));
    });

    // 插入区
    const addRow = el('div', 'add-row');
    addRow.appendChild(el('span', 'lbl', '插入题目：'));
    addRow.appendChild(buildInsertPicker('＋ 选择题型', (key, label) => {
      const base = JSON.parse(JSON.stringify(state.meta.itemDefaults[key] || { type: key }));
      const item = applyNewItemDefaults({ ...base, id: `new${Date.now().toString(36)}`, limits: {}, collapsed: false, title: base.title || label || TYPE_LABEL(key) });
      insertItem(list, item);
      state.selected = item.id;
      toast('已插入：' + (label || TYPE_LABEL(key)));
      render();
    }));

    // 批量插入打分题（量表就是多道打分题）
    addRow.appendChild(el('span', 'lbl', '　批量打分题：'));
    const num = el('input', 'add-num');
    num.type = 'number';
    num.value = '5';
    num.min = '1';
    const bulk = el('button', 'mini-btn', '+ 插入 N 道');
    bulk.onclick = () => {
      const n = Math.max(1, Math.min(30, Number(num.value) || 1));
      const items = [];
      for (let i = 0; i < n; i += 1) {
        // 题干进正文（title 置空后由正文首行自动回填），与「插入题目」的默认项同一口径
        const text = `打分题 ${i + 1}`;
        items.push(applyNewItemDefaults({
          id: `rate${Date.now().toString(36)}${i}`,
          type: 'rating',
          title: text,
          html: RichText.textToHtml(text),
          min: 1,
          max: 5,
          anchor: '1 = 完全不同意　·　5 = 完全同意',
          limits: {},
          collapsed: false
        }));
      }
      insertItem(list, ...items);
      toast(`已插入 ${n} 道打分题`);
      render();
    };
    addRow.append(num, bulk);

    if (opts.withTemplateInsert) {
      addRow.appendChild(el('span', 'lbl', '　插入实验模板：'));
      const tsel = el('select', 'add-select');
      for (const e of state.experiments) {
        const o = el('option', '', e.name);
        o.value = e.id;
        tsel.appendChild(o);
      }
      const tbtn = el('button', 'mini-btn', '+ 插入整组');
      tbtn.onclick = async () => {
        const exp = state.experiments.find((x) => x.id === tsel.value);
        if (!exp) return;
        const full = (await api(`/api/admin/experiment?id=${encodeURIComponent(exp.id)}`)).experiment;
        const stamp = Date.now().toString(36);
        const copies = full.items.map((it, i) => ({
          ...JSON.parse(JSON.stringify(it)),
          id: `${stamp}_${i}_${it.id}`,
          fromTemplateId: full.id,
          fromTemplateName: full.name
        }));
        insertItem(list, ...copies);
        toast(`已插入模板「${full.name}」的 ${copies.length} 道题（可逐条修改）`);
        render();
      };
      addRow.append(tsel, tbtn);
    }
    wrap.appendChild(addRow);
    onChange(list);
    if (sc) sc.scrollTop = scrollTop;
  }

  /* ---------------------------------------------------------------- 显示全卷
     把每道题的正文按顺序拼成**一个大编辑器**：题与题之间一条分割线（<hr>），每题正文上方一行
     不可编辑的题目标识（第 N 题 · 题型 · 大纲标题）。
     用途：通读全卷文本、整卷统一改排版（全选 → 改字号 / 加粗）。
     切回分题：按 <hr> 切分（分割线是唯一的分界，标识行自动忽略），段数必须等于题目数。
     字号 / 加粗再怎么改都不影响切分 —— 分割线是元素、不是文字，改不动它。
     只呈现每题的正文（题干）：选项 / 标准答案 / 锚点等字段不进来，不会被批量改字号破坏。 */
  let fullEl = null;
  let fullRich = null;
  let fullActive = false;
  let fullDirty = false;                    // 全卷视图里改过、还没写回分题
  // 分割线带一个 class：题目正文自己若也含 <hr>（粘贴进来的），不会跟分界混为一谈
  const FULL_SEP_CLASS = 'fullv-sep';
  const isFullSep = (node) => !!node.classList && node.classList.contains(FULL_SEP_CLASS);

  const fullLocatorText = (item) => {
    const qno = questionNos(list).get(item.id);
    return `${qno ? `第 ${qno} 题 · ` : ''}${itemTypeLabel(item)} · ${item.title || '（未命名）'}`;
  };
  const buildFullHtml = () => list.map((it) => {
    const loc = `<div class="fullv-head" contenteditable="false">${RichText.escapeText(fullLocatorText(it))}</div>`;
    return `${loc}${it.html || ''}`;
  }).join(`<hr class="${FULL_SEP_CLASS}">`);

  // 按分割线切分编辑器 DOM（浏览器可能把分割线套进段落里，所以递归处理）；
  // isSep 决定哪些 <hr> 算分割线；返回每段的内 HTML 字符串数组 —— 只读原 DOM，不改它。
  const splitByHr = (root, isSep) => {
    const sections = [];
    let curRoot = null;
    let curStack = [];
    let ancestors = [];                       // 当前所在的原 DOM 祖先链（不含 root）
    const openSection = () => {
      curRoot = document.createElement('div');
      sections.push(curRoot);
      curStack = [curRoot];
      for (const a of ancestors) {            // 切段后重建外壳（保留标签与样式）
        const shell = a.cloneNode(false);
        curStack[curStack.length - 1].appendChild(shell);
        curStack.push(shell);
      }
    };
    const walk = (el2) => {
      for (const child of Array.from(el2.childNodes)) {
        if (child.nodeType === 1 && child.tagName === 'HR' && isSep(child)) { openSection(); continue; }
        if (child.nodeType === 1 && child.querySelector && child.querySelector('hr')) {
          const nested = Array.from(child.querySelectorAll('hr')).some(isSep);
          if (!nested) {                       // 里面的分割线不算分界（题目正文自带的）→ 原样搬过去
            curStack[curStack.length - 1].appendChild(child.cloneNode(true));
            continue;
          }
          ancestors.push(child);
          const shell = child.cloneNode(false);
          curStack[curStack.length - 1].appendChild(shell);
          curStack.push(shell);
          walk(child);
          curStack.pop();
          ancestors.pop();
          continue;
        }
        curStack[curStack.length - 1].appendChild(child.cloneNode(true));
      }
    };
    openSection();
    walk(root);
    return sections.map((s) => s.innerHTML);
  };

  // 一段 → item.html：去掉视图内的题目标识行，再走一遍标准清洗
  const cleanSection = (html) => {
    const box = document.createElement('div');
    box.innerHTML = html;
    box.querySelectorAll('.fullv-head, [contenteditable="false"]').forEach((n) => n.remove());
    return RichText.sanitizeHtml(box.innerHTML);
  };

  // 全卷 → 逐题：成功返回 true；分割线数量对不上时返回 { got, want }（不写回任何东西）
  const applyFullView = () => {
    if (!fullActive || !fullRich) return true;
    const root = fullRich.editor;
    // 先按「带 class 的分割线」切；段数不对再退一步按「所有分割线」切（用户删掉再加回来时分界会丢 class）
    let sections = splitByHr(root, isFullSep);
    if (sections.length !== list.length) {
      const all = splitByHr(root, () => true);
      if (all.length === list.length) sections = all;
    }
    if (sections.length !== list.length) return { got: sections.length, want: list.length };
    list.forEach((it, i) => {
      const html = cleanSection(sections[i]);
      if (html === it.html) return;
      it.html = html;
      it.text = RichText.htmlToText(html);            // 正文一改，「正文为空」的判定跟着更新
      if (!String(it.title || '').trim()) it.title = RichText.firstLine(html, 40);
    });
    fullDirty = false;                                 // 已写回分题：不再是「未保存的全卷改动」
    onChange(list);
    return true;
  };

  const fullFailMsg = (res) => `分割线数量不对：识别到 ${res.got} 段 / 应为 ${res.want} 题。`
    + '每题之间要留一条分割线（不要增删），改好再返回。';

  const exitFullView = (opts2 = {}) => {
    if (!fullActive) return true;
    if (!opts2.discard) {
      const res = applyFullView();
      if (res !== true) { toast(fullFailMsg(res)); return false; }
    }
    fullActive = false;
    if (fullEl) fullEl.classList.add('hidden');
    wrap.classList.remove('hidden');
    render();                                  // 用（写回后的）item.html 重画题目列
    setSidebarMode('outline');
    toast(opts2.discard ? '已放弃全卷修改' : '已切回分题编辑');
    return true;
  };

  const buildFullView = () => {
    fullEl = el('div', 'fullview');
    const bar = el('div', 'fullview-bar');
    bar.appendChild(el('span', 'fullview-tip',
      '全卷视图：每道题的正文按顺序排列，题与题之间是一条分割线。'
      + '上方灰色那行是题目标识（不可编辑、不参与切分）；'
      + '分割线是唯一的分界，请不要增删 —— 改完点「返回分题编辑」或直接「保存问卷」。'));
    const backBtn = el('button', 'primary-btn', '返回分题编辑');
    backBtn.type = 'button';
    backBtn.onclick = () => exitFullView();
    const discardBtn = el('button', 'ghost-btn', '放弃修改');
    discardBtn.type = 'button';
    discardBtn.onclick = () => openModal({
      title: '放弃全卷修改',
      body: el('p', 'modal-note', '本次在全卷视图里的改动都不会写回（题目回到进入全卷前的样子）。'),
      confirmLabel: '放弃修改',
      danger: true,
      onConfirm: () => { closeModal(); exitFullView({ discard: true }); }
    });
    bar.append(backBtn, discardBtn);
    fullEl.appendChild(bar);
    fullRich = makeRichField('全卷正文（每道题的正文按顺序排列；分割线 = 题目分界）', '', {
      raw: true, hint: '',
      onChange: () => { fullDirty = true; markPreviewStale(); }   // 全卷里改过 = 有未保存内容（返回时会被问）
    });
    fullEl.appendChild(fullRich.wrap);
    fullEl.appendChild(el('p', 'fullview-note',
      `共 ${list.length} 题。这里只呈现每题的正文（题干）：选项、标准答案、锚点、参数等字段不进入全卷视图，改动不会牵连它们。`));
  };

  // 全卷工具条吸顶的落点：量「顶部操作条」的高度写进 .rich-bar 的 style.top。
  // 操作条自己 sticky 在 top:0（z-index 更高），工具条要吸在它下面，不然会被盖住。
  const stickFullToolbar = () => {
    if (!fullRich) return;
    const barEl = fullRich.wrap.querySelector('.rich-bar');
    if (!barEl) return;
    const ab = document.querySelector('.editor-scroll .editor-actionbar');
    barEl.style.top = `${ab ? Math.round(ab.offsetHeight) : 0}px`;
  };
  window.addEventListener('resize', () => { if (fullActive) stickFullToolbar(); });

  const showFullView = () => {
    if (fullActive) return true;
    if (!fullEl) buildFullView();
    if (!fullEl.parentNode) wrap.insertAdjacentElement('afterend', fullEl);   // 与题目列并列，render() 不会清掉它
    fullRich.setHtml(buildFullHtml());
    fullDirty = false;                         // 装载本身不算改动（setHtml 会触发一次 onChange）
    fullActive = true;
    wrap.classList.add('hidden');
    fullEl.classList.remove('hidden');
    setSidebarMode('menu');                    // 全卷视图里点大纲没有落点，先切回菜单，免得误跳
    stickFullToolbar();                        // 滚动时工具条（字号 / 加粗…）跟着吸在顶部
    toast('已切到全卷视图：可以全选后统一改字号 / 加粗');
    return true;
  };

  render();
  return { wrap, render, select, showFullView, exitFullView, applyFullView, inFullView: () => fullActive, fullDirty: () => fullActive && fullDirty };
}

function moveItem(list, dragId, targetId, after) {
  const from = list.findIndex((x) => x.id === dragId);
  const to = list.findIndex((x) => x.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const [item] = list.splice(from, 1);
  let at = list.findIndex((x) => x.id === targetId);
  if (after) at += 1;
  list.splice(at, 0, item);
}

// 插入位置：跳过开头的欢迎语 / 知情同意与结尾的结束语 / 结束说明
function insertItem(list, ...items) {
  let at = list.length;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const t = list[i].type;
    if (t === 'debrief' || (t === 'message' && /结束语/.test(list[i].title || ''))) at = i;
    else break;
  }
  let min = 0;
  if (list[0] && list[0].type === 'message') min = 1;
  if (list[min] && list[min].type === 'gate') min += 1;
  list.splice(Math.max(at, min), 0, ...items);
}

function buildItemFields(item, rerender) {
  const frag = document.createDocumentFragment();
  const onInput = () => markPreviewStale();
  let syncClearNote = null;      // 「呈现前清空」的说明行：正文变化时也要重算（空正文 = 清屏不会生效）

  const syncCardTitle = () => {
    const card = document.querySelector(`.qcard[data-id="${item.id}"] .qtitle`);
    if (card) card.textContent = item.title || '（未命名）';
  };

  // 大纲标题：只用于管理端列表 / 大纲（被试看不到这一项）；留空 = 自动取正文首行
  const ttlField = makeField('大纲标题（仅管理端列表 / 大纲显示；留空 = 自动取正文首行）', item.title, 2);
  const titleInput = ttlField.input;
  titleInput.addEventListener('input', () => {
    item.title = titleInput.value;
    syncCardTitle();
    updateOutlineTitle(item.id);      // 左侧大纲那一行的标题跟着改（以前要等重画才更新）
    onInput();
  });
  frag.appendChild(ttlField.wrap);

  // 正文（被试可见）：类 Word 编辑。第一行想当标题，就选中它、在工具条点「标题 1」。
  const BODY_LABEL = {
    message: '消息正文（被试可见；留空则该题自动跳过）',
    gate: '正文（含标题；被试勾选同意后才能开始）',
    confirm: '正文（含标题；被试读完点按钮继续）',
    debrief: '正文（含标题；实验结束后的说明）',
    group: '题组正文（含标题与题组说明）'
  };
  // 正文区不再有任何说明文字（历史上的「被试端逐字流式呈现…」这类提示全部去掉）
  const rich = makeRichField(BODY_LABEL[item.type] || '题干 / 正文（被试可见）', item.html, {
    hint: '',
    onChange: (html) => {
      item.html = html;
      item.text = RichText.htmlToText(html);      // 让「正文为空」的判定跟着更新
      if (syncClearNote) syncClearNote();
      if (!String(item.title || '').trim()) {
        item.title = RichText.firstLine(html, 40);
        titleInput.value = item.title;
        syncCardTitle();
        updateOutlineTitle(item.id);
      }
      onInput();
    }
  });
  frag.appendChild(rich.wrap);

  if (item.type === 'message') {
    // 思考过程是消息题的一个参数（正文区下方「参数」里），不在这里编辑
  } else if (item.type === 'confirm') {
    const b = makeField('按钮文案', item.button || '', 1);
    b.input.addEventListener('input', () => { item.button = b.input.value; onInput(); });
    frag.appendChild(b.wrap);
  } else if (item.type === 'gate') {
    // 形态（仅勾选 / 需填编号）在「插入题目」时已经选定，这里不再重复给一个下拉：
    // 需要换形态就删掉这一题、用另一种形态重新插入。
    // 「需填编号」形态的说明也不再显示（插入时已选过形态，字段名/提示语本身够清楚）
    for (const [label, key, rows] of [['勾选文案（正文下方的同意项）', 'check', 2], ['按钮文案', 'button', 1]]) {
      const f = makeField(label, item[key] || '', rows);
      f.input.addEventListener('input', () => { item[key] = f.input.value; onInput(); });
      frag.appendChild(f.wrap);
    }
    if (item.variant === 'id') {
      for (const [label, key] of [['编号字段名（页面上显示）', 'idLabel'], ['编号输入框提示语', 'idPlaceholder']]) {
        const f = makeField(label, item[key] || '', 1);
        f.input.addEventListener('input', () => { item[key] = f.input.value; onInput(); });
        frag.appendChild(f.wrap);
      }
    }
  } else if (item.type === 'rating') {
    const row = el('div', 'grid2');
    const min = makeNumberField('最低分', item.min, 0, 10);
    min.input.addEventListener('input', () => { item.min = Number(min.input.value) || 0; onInput(); });
    const max = makeNumberField('最高分', item.max, 1, 12);
    max.input.addEventListener('input', () => { item.max = Number(max.input.value) || 1; onInput(); });
    row.append(min.wrap, max.wrap);
    const anchor = makeField('锚点文字', item.anchor || '', 2);
    anchor.input.addEventListener('input', () => { item.anchor = anchor.input.value; onInput(); });
    frag.append(row, anchor.wrap);
  } else if (item.type === 'single' || item.type === 'multi') {
    const f = makeField('选项（一行一个）', (item.options || []).join('\n'), 5);
    f.input.addEventListener('input', () => {
      item.options = f.input.value.split('\n').map((s) => s.trim()).filter(Boolean);
      onInput();
    });
    frag.appendChild(f.wrap);
    if (item.type === 'single') {
      const c = makeNumberField('正确答案序号（1 = A；0 = 不计对错）', item.correct || 0, 0, 8);
      c.input.addEventListener('input', () => { item.correct = Number(c.input.value) || 0; onInput(); });
      frag.appendChild(c.wrap);
    }
  } else if (item.type === 'rank') {
    const f = makeField('排序项（一行一个）', (item.options || []).join('\n'), 5);
    f.input.addEventListener('input', () => {
      item.options = f.input.value.split('\n').map((s) => s.trim()).filter(Boolean);
      onInput();
    });
    frag.appendChild(f.wrap);
  } else if (item.type === 'text') {
    if (item.variant === 'match') {
      // 二级形态「需输入指定内容」：被试在底部输入框里输入，点「发送」先由服务端断言——
      // 内容为空或不一致时不发送（不落库、不进聊天流），只在输入框上方给出下面这条提示。
      const ans = makeField('标准答案（一行一个；任一行匹配即通过）', item.answer || '', 2);
      ans.input.addEventListener('input', () => { item.answer = ans.input.value; onInput(); });
      const err = makeField('匹配失败时的提示（被试可见；留空 = 答案错误）', item.errorText || '', 1);
      err.input.addEventListener('input', () => { item.errorText = err.input.value; onInput(); });
      const ph = makeField('输入框提示语', item.placeholder || '', 1);
      ph.input.addEventListener('input', () => { item.placeholder = ph.input.value; onInput(); });
      frag.append(ans.wrap, err.wrap, ph.wrap);
    } else {
      const row = el('div', 'grid2');
      const rows = makeNumberField('输入框高度（行数；1 = 单行）', item.rows || 1, 1, 12);
      rows.input.addEventListener('input', () => { item.rows = Math.max(1, Math.min(12, Number(rows.input.value) || 1)); onInput(); });
      const maxLen = makeNumberField('字数上限（0 = 不限）', item.maxLen || 0, 0, 5000);
      maxLen.input.addEventListener('input', () => { item.maxLen = Number(maxLen.input.value) || 0; onInput(); });
      row.append(rows.wrap, maxLen.wrap);
      const ph = makeField('输入框提示语', item.placeholder || '', 2);
      ph.input.addEventListener('input', () => { item.placeholder = ph.input.value; onInput(); });
      const req = el('label', 'inline-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = item.required !== false;
      cb.addEventListener('change', () => { item.required = cb.checked; onInput(); });
      req.append(cb, el('span', '', '必答'));
      frag.append(row, ph.wrap, req);
    }
  }

  if (item.type === 'group') {
    const layout = el('label', 'field');
    layout.appendChild(el('span', '', '子题排布'));
    const lsel = el('select');
    for (const [v, label] of [['column', '竖排（逐行）'], ['row', '横排（并排）']]) {
      const o = el('option', '', label);
      o.value = v;
      lsel.appendChild(o);
    }
    lsel.value = item.layout === 'row' ? 'row' : 'column';
    lsel.addEventListener('change', () => { item.layout = lsel.value; onInput(); });
    layout.appendChild(lsel);
    frag.appendChild(layout);

    const subsWrap = el('div', 'subs-editor');
    const rebuild = () => {
      subsWrap.innerHTML = '';
      (item.subs || []).forEach((sub, si) => {
        const box = el('div', 'sub-editor');
        const head = el('div', 'sub-editor-head');
        head.appendChild(el('span', 'qnum', `子题 ${si + 1}`));
        head.appendChild(el('span', 'qtype', `${TYPE_ICON(sub.type)} ${TYPE_LABEL(sub.type)}`));
        const tools = el('div', 'qtools');
        const mk = (label2, title2, fn, disabled) => {
          const b = el('button', 'mini-btn', label2);
          b.type = 'button';
          b.title = title2;
          b.disabled = !!disabled;
          b.onclick = fn;
          return b;
        };
        tools.append(
          mk('↑', '上移', () => { if (si > 0) { [item.subs[si - 1], item.subs[si]] = [item.subs[si], item.subs[si - 1]]; onInput(); rebuild(); } }, si === 0),
          mk('↓', '下移', () => { if (si < item.subs.length - 1) { [item.subs[si + 1], item.subs[si]] = [item.subs[si], item.subs[si + 1]]; onInput(); rebuild(); } }, si === item.subs.length - 1),
          mk('删除', '删除子题', () => { item.subs.splice(si, 1); onInput(); rebuild(); }, item.subs.length <= 1)
        );
        head.appendChild(tools);
        box.appendChild(head);

        const ttl = makeField('子题题干', sub.title || '', 2);
        ttl.input.addEventListener('input', () => { sub.title = ttl.input.value; onInput(); });
        box.appendChild(ttl.wrap);
        box.appendChild(buildSubFields(sub, onInput));
        subsWrap.appendChild(box);
      });
      const addRow = el('div', 'add-row');
      addRow.appendChild(el('span', 'lbl', '添加子题：'));
      const sel = el('select', 'add-select');
      for (const t2 of ['text', 'rating', 'single', 'multi', 'rank']) {
        const o = el('option', '', `${TYPE_ICON(t2)} ${TYPE_LABEL(t2)}`);
        o.value = t2;
        sel.appendChild(o);
      }
      const add = el('button', 'mini-btn', '+ 添加');
      add.onclick = () => {
        const base = JSON.parse(JSON.stringify(state.meta.itemDefaults[sel.value] || { type: sel.value }));
        const sub = { ...base, id: `s${Date.now().toString(36)}`, title: base.title || TYPE_LABEL(sel.value), limits: {} };
        delete sub.limits;
        item.subs = item.subs || [];
        item.subs.push(sub);
        onInput();
        rebuild();
      };
      addRow.append(sel, add);
      subsWrap.appendChild(addRow);
    };
    rebuild();
    frag.appendChild(subsWrap);
  }

  // 「呈现前清空」那行的说明要跟着正文变（正文空了 → 清屏不生效），所以把登记函数交下去
  const params = buildParamSection(item, onInput, rerender, (fn) => { syncClearNote = fn; });
  if (params) frag.appendChild(params);
  return frag;
}

// 计时限制：勾选即启用并填数值；未勾选用问卷默认值
// 子题字段：按题型给出必需配置（与顶层题目一致，但不含计时限制与嵌套）
function buildSubFields(sub, onInput) {
  const frag = document.createDocumentFragment();
  if (sub.type === 'text') {
    const row = el('div', 'grid2');
    const rows = makeNumberField('输入框高度（行数）', sub.rows || 1, 1, 12);
    rows.input.addEventListener('input', () => { sub.rows = Math.max(1, Math.min(12, Number(rows.input.value) || 1)); onInput(); });
    const maxLen = makeNumberField('字数上限（0 = 不限）', sub.maxLen || 0, 0, 5000);
    maxLen.input.addEventListener('input', () => { sub.maxLen = Number(maxLen.input.value) || 0; onInput(); });
    row.append(rows.wrap, maxLen.wrap);
    const ph = makeField('输入框提示语', sub.placeholder || '', 2);
    ph.input.addEventListener('input', () => { sub.placeholder = ph.input.value; onInput(); });
    const req = el('label', 'inline-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = sub.required !== false;
    cb.addEventListener('change', () => { sub.required = cb.checked; onInput(); });
    req.append(cb, el('span', '', '必答'));
    frag.append(row, ph.wrap, req);
  } else if (sub.type === 'rating') {
    const row = el('div', 'grid2');
    const min = makeNumberField('最低分', sub.min, 0, 10);
    min.input.addEventListener('input', () => { sub.min = Number(min.input.value) || 0; onInput(); });
    const max = makeNumberField('最高分', sub.max, 1, 12);
    max.input.addEventListener('input', () => { sub.max = Number(max.input.value) || 1; onInput(); });
    row.append(min.wrap, max.wrap);
    const anchor = makeField('锚点文字', sub.anchor || '', 2);
    anchor.input.addEventListener('input', () => { sub.anchor = anchor.input.value; onInput(); });
    frag.append(row, anchor.wrap);
  } else if (sub.type === 'single' || sub.type === 'multi' || sub.type === 'rank') {
    const opts = makeField('选项 / 项目（一行一个）', (sub.options || []).join('\n'), 4);
    opts.input.addEventListener('input', () => { sub.options = opts.input.value.split('\n').map((x) => x.trim()).filter(Boolean); onInput(); });
    frag.appendChild(opts.wrap);
    if (sub.type === 'single') {
      const c = makeNumberField('正确答案序号（1 = A；0 = 不计对错）', sub.correct || 0, 0, 8);
      c.input.addEventListener('input', () => { sub.correct = Number(c.input.value) || 0; onInput(); });
      frag.appendChild(c.wrap);
    }
  }
  return frag;
}

/* ---------------------------------------------------------------- 题目参数区
   与题目同框、横线分隔、下方标注「参数」。没有添加任何参数时该区域不出现，
   只留一个「＋ 添加参数」入口；添加后按行列出（名称 + 值 + 删除），支持增删改。
   思考过程是消息题的一个特殊参数（内容项、被试可见），也在这里添加。 */

// 参数预设：常用组合，选了直接填入数值、仍可微调。只是「一组命名好的数值」，不引入新存储。
const PARAM_PRESETS = [
  // 思考时长不在这里：它挂在「思考过程」行里（就一个入口，别出现两个「AI 思考时长」）
  { key: 'typeMs', label: '流式输出 · 标准', value: 11 },
  { key: 'typeMs', label: '流式输出 · 慢', value: 30 },
  { key: 'typeMs', label: '流式输出 · 整段直出', value: 0 },
  { key: 'wait', label: '强制阅读 40 秒', value: 40 },
  { key: 'wait', label: '强制阅读 10 秒', value: 10 },
  { key: 'minSubmit', label: '创作窗口 · 最短 180 秒', value: 180 },
  { key: 'maxAnswer', label: '创作窗口 · 最长 300 秒', value: 300 }
];

// 参数行：名称 + 数值 + 单位 + 删除（开关型参数用勾选框，没有数值）
// onSyncClearNote：把「呈现前清空」那行的说明同步函数交回题目编辑器——
// 正文一改（空 ↔ 非空）就要重算那句话，所以它得由 buildItemFields 持有。
function buildParamRow(item, key, onInput, rerender, onSyncClearNote) {
  const meta = LIMIT_META()[key];
  const spec = (state.meta.limitSpec || {})[key] || { min: 0, max: 86400 };
  const row = el('div', 'param-row');
  row.appendChild(el('span', 'param-name', meta.label));
  // 说明行挂在「参数行外面」（param-cell）：勾选框那一行的布局不受说明出现 / 消失的影响，
  // 勾上前后勾选框的位置一模一样。
  const cell = el('div', 'param-cell');
  let note = null;
  if (meta.unit === '开关') {
    // 开关用真正的勾选框：之前固定显示「已启用」但存的是默认值 0，导致清屏点永远不生效（issue 7）
    const cb = el('input', 'param-check');
    cb.type = 'checkbox';
    cb.checked = Number(item.limits[key]) === 1;
    cb.title = meta.hint;
    // 只有「正文为空 → 这条消息被试端会跳过、清屏不会生效」这种会踩坑的情况才提示一句；
    // 正常开启不写任何说明（以前那句「已开启：……记得刷新预览」太啰嗦，已去掉）
    if (key === 'refresh') {
      note = el('p', 'param-note param-clear-note hidden', '');
      const syncNote = () => {
        const on = Number(item.limits.refresh) === 1;
        const blankMsg = on && item.type === 'message' && !String(item.text || '').trim();
        note.classList.toggle('hidden', !blankMsg);
        note.classList.toggle('warn', blankMsg);
        note.textContent = blankMsg
          ? '⚠ 这条消息的正文是空的 —— 被试端会跳过它，清屏不会生效。请先写正文，或把「呈现前清空」配到题目上。'
          : '';
      };
      cb.addEventListener('change', () => { item.limits[key] = cb.checked ? 1 : 0; syncNote(); onInput(); });
      row.appendChild(cb);
      row.appendChild(el('span', 'param-unit', meta.switchText || meta.label));
      if (onSyncClearNote) onSyncClearNote(syncNote);
      syncNote();
    } else {
      cb.addEventListener('change', () => { item.limits[key] = cb.checked ? 1 : 0; onInput(); });
      row.appendChild(cb);
      row.appendChild(el('span', 'param-unit', meta.switchText || meta.label));
    }
  } else {
    const num = el('input', 'param-num');
    num.type = 'number';
    num.min = String(spec.min);
    num.max = String(spec.max);
    num.value = String(item.limits[key]);
    num.title = meta.hint;
    num.addEventListener('input', () => {
      const raw = Number(num.value) || 0;
      item.limits[key] = Math.min(spec.max, Math.max(spec.min, raw));
      onInput();
    });
    row.appendChild(num);
    row.appendChild(el('span', 'param-unit', meta.unit));
  }
  const del = el('button', 'mini-btn', '删除');
  del.type = 'button';
  del.onclick = () => { delete item.limits[key]; rerender(); };
  row.appendChild(del);
  cell.appendChild(row);
  if (note) cell.appendChild(note);        // 说明行独立一行（不在参数行的 flex 里）
  return cell;
}

// 思考过程行：内容项（被试可见），不是数值；行内含「思考时长」（毫秒）——
// 就是 thinkMs 参数本身，所以不再需要单独添加「AI 思考时长」。
function buildThinkingRow(item, onInput, rerender) {
  const row = el('div', 'param-row param-row-think');
  const head = el('div', 'param-head');
  head.appendChild(el('span', 'param-name', '思考过程（被试可见）'));
  const del = el('button', 'mini-btn', '删除');
  del.type = 'button';
  del.onclick = () => {
    delete item.thinking;
    delete item.__thinkingOn;
    if (item.limits) delete item.limits.thinkMs;   // 删掉这个参数 = 被试端不再有思考提示
    rerender();
  };
  head.appendChild(del);
  row.appendChild(head);
  const ta = el('textarea', 'param-think');
  ta.rows = 6;
  ta.placeholder = '以「AI 的内心推演」口吻写：先复述任务要求，再对照评价标准逐条推演，最后收敛到下方正文的结论。\n留空则不显示思考面板（若配了时长，只显示一段「正在思考」提示）。';
  ta.value = item.thinking || '';
  autoGrowTextarea(ta, 6);
  ta.addEventListener('input', () => { item.thinking = ta.value; onInput(); });
  row.appendChild(ta);

  const spec = (state.meta.limitSpec || {}).thinkMs || { min: 0, max: 60000 };
  const msToSec = (ms) => Math.round((Number(ms) || 0) / 100) / 10;      // 毫秒 → 秒，保留一位小数
  const secToMs = (sec) => Math.min(spec.max, Math.max(spec.min, Math.round((Number(sec) || 0) * 10) * 100));
  const durRow = el('div', 'param-think-dur');
  durRow.appendChild(el('span', 'param-unit', '思考时长'));
  const dur = el('input', 'param-num');
  dur.type = 'number';
  dur.min = '0';
  dur.max = String(spec.max / 1000);
  dur.step = '0.1';
  dur.title = '思考面板 / 「正在思考」提示的时长（秒，最多一位小数，例如 15 / 30）。0 = 不显示';
  dur.value = String(msToSec(item.limits && item.limits.thinkMs != null ? item.limits.thinkMs : effLimit(item, 'thinkMs')));
  const writeDur = (sec) => {
    const v = secToMs(sec);
    if (!item.limits) item.limits = {};
    item.limits.thinkMs = v;
    dur.value = String(msToSec(v));
    onInput();
  };
  dur.addEventListener('input', () => { if (dur.value !== '') writeDur(dur.value); });
  // 失焦回显「当前生效值」：没配过 thinkMs 时回落默认（与输入框初始化同一口径，别显示成 0）
  dur.addEventListener('blur', () => {
    dur.value = String(msToSec(item.limits && item.limits.thinkMs != null ? item.limits.thinkMs : effLimit(item, 'thinkMs')));
  });
  durRow.appendChild(dur);
  durRow.appendChild(el('span', 'param-unit', '秒'));
  for (const [label, v] of [['5 秒', 5000], ['10 秒', 10000], ['20 秒', 20000], ['30 秒', 30000]]) {
    const b = el('button', 'mini-btn', label);
    b.type = 'button';
    b.onclick = () => writeDur(v / 1000);
    durRow.appendChild(b);
  }
  row.appendChild(durRow);
  row.appendChild(el('p', 'param-note', '被试端在正文之前以可折叠面板逐字呈现，输出完自动折叠、点击可回看；没写思考稿时只显示短暂的「正在思考」提示（0 = 完全跳过）。'));
  return row;
}

// 「＋ 添加参数」：一级列可用参数，下面列常用预设
function buildAddParam(item, onInput, rerender) {
  const keys = TYPE_LIMITS(item.type);
  const canThink = item.type === 'message';
  const thinkingOn = canThink && (item.thinking != null || item.__thinkingOn);
  const wrap = el('div', 'param-add');
  const btn = el('button', 'mini-btn', '＋ 添加参数');
  btn.type = 'button';
  const panel = el('div', 'param-panel hidden');

  const close = () => panel.classList.add('hidden');
  const pick = (key, value) => {
    if (key === 'thinking') item.__thinkingOn = true;      // 允许「先添加、再写内容」，标记不落库
    else item.limits[key] = value;
    close();
    rerender();
  };

  for (const k of keys) {
    if (item.limits[k] != null) continue;                       // 已添加的不再列出
    if (k === 'thinkMs' && thinkingOn) continue;                // 时长已在「思考过程」行里
    const meta = LIMIT_META()[k];
    // 开关型参数添加即启用：refresh 默认值 0（不启用就永远不生效），redo 的默认值本身就是 1
    const def = k === 'refresh' ? 1 : (Number(LIMIT_DEFAULTS()[k]) || 0);
    const b = el('button', 'param-opt', `${meta.label}（${meta.unit}）`);
    b.type = 'button';
    b.title = meta.hint;
    b.onclick = (e) => { e.stopPropagation(); pick(k, def); };
    panel.appendChild(b);
  }
  if (canThink && item.thinking == null && !item.__thinkingOn) {
    const b = el('button', 'param-opt', '思考过程（被试可见）');
    b.type = 'button';
    b.title = '在反馈正文之前先输出一段「AI 的思考过程」，输出完自动折叠；行内含思考时长';
    b.onclick = (e) => { e.stopPropagation(); pick('thinking'); };
    panel.appendChild(b);
  }
  const usable = PARAM_PRESETS.filter((p) => keys.includes(p.key) && item.limits[p.key] == null && !(thinkingOn && p.key === 'thinkMs'));
  if (usable.length) {
    panel.appendChild(el('p', 'param-group', '常用预设'));
    for (const p of usable) {
      const b = el('button', 'param-opt param-opt-preset', p.label);
      b.type = 'button';
      b.onclick = (e) => { e.stopPropagation(); pick(p.key, p.value); };
      panel.appendChild(b);
    }
  }
  if (!panel.childElementCount) {
    panel.appendChild(el('p', 'param-group', '该题型没有可添加的参数'));
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) openParamPanel = wrap;
  };
  wrap.close = close;
  wrap.append(btn, panel);
  return wrap;
}

// 参数区整体：无参数时只返回「＋ 添加参数」；有参数时补横线 + 区域名 + 各行
function buildParamSection(item, onInput, rerender, onSyncClearNote) {
  const keys = TYPE_LIMITS(item.type);
  const canThink = item.type === 'message';
  if (!keys.length && !canThink) return null;

  const wrap = el('div', 'params');
  const hasThinking = canThink && (item.thinking != null || item.__thinkingOn);
  // thinkMs 只在「思考过程」行里改 —— 开了那一行就不要再单独渲染「AI 思考时长」（否则同一参数出现两次）
  const activeKeys = keys.filter((k) => item.limits[k] != null && !(k === 'thinkMs' && hasThinking));
  if (activeKeys.length || hasThinking) {
    const band = el('div', 'param-band');
    band.append(el('span', 'label', '参数'), el('span', 'line'));
    wrap.appendChild(band);
    for (const k of activeKeys) wrap.appendChild(buildParamRow(item, k, onInput, rerender, onSyncClearNote));
    if (hasThinking) wrap.appendChild(buildThinkingRow(item, onInput, rerender));
  }
  wrap.appendChild(buildAddParam(item, onInput, rerender));
  return wrap;
}

// 点击别处收起「添加参数」面板（全局只装一次监听）
let openParamPanel = null;
document.addEventListener('click', (e) => {
  if (openParamPanel && !openParamPanel.contains(e.target)) {
    openParamPanel.close();
    openParamPanel = null;
  }
});

/* ---------------------------------------------------------------- 编辑页骨架 + 手机预览 */

let editorCtx = null;
let previewCtl = null;          // 手机预览：{ url, markStale }（由 editorShell 装配）
let editorShellDispose = null;  // 当前编辑页的清理函数（切页时调用：停轮询 + 销毁预览会话）

// 编辑内容变化时：提示「预览需要刷新」，而不是实时重渲染
// （预览是真页面、真会话，重渲染会把正在试填的进度打断）
function markPreviewStale() {
  if (previewCtl && previewCtl.markStale) previewCtl.markStale();
}

// 手机预览缩放：真机 393 × 852 等比缩放到手机栏的可用空间
// （内部仍是真机视口 → 预览与真机是 1:1 的布局，只是整体缩小以便一屏看全）
// 关键：宽屏下可用高度按「主区域底边」算（不是窗口高）——否则手机壳会把主区域撑出可滚动高度，
// 一旦发生滚动，手机栏就被顶出视口，只剩最下面一条（用户报的「手机界面无法模拟」）。
const PHONE_W = 393;
const PHONE_H = 852;
function fitPhoneScale() {
  const col = document.querySelector('.phone-col');
  const holder = col && col.querySelector('.phone-holder');
  const phone = holder && holder.querySelector('.phone');
  if (!col || !holder || !phone) return;
  const cols = document.querySelector('.editor-cols');
  const stacked = !!(cols && getComputedStyle(cols).flexDirection === 'column');   // 窄屏：上下堆叠，整页滚动
  const availW = Math.max(240, col.clientWidth);
  let availH;
  if (stacked) {
    availH = Math.max(320, window.innerHeight - 90);
  } else {
    const main = document.querySelector('.admin-main');
    const mainRect = (main || document.documentElement).getBoundingClientRect();
    const bottom = Math.min(window.innerHeight, mainRect.bottom);
    availH = Math.max(300, bottom - holder.getBoundingClientRect().top - 14);
  }
  const scale = Math.min(1, availW / PHONE_W, availH / PHONE_H);
  phone.style.setProperty('--phone-scale', String(scale));
  holder.style.width = `${Math.round(PHONE_W * scale)}px`;
  holder.style.height = `${Math.round(PHONE_H * scale)}px`;
  // 兜底：万一还有别的原因把主区域顶出滚动，把它归零（否则右侧手机栏会整体上移）
  const main = document.querySelector('.admin-main');
  if (main && main.scrollTop) main.scrollTop = 0;
}
window.addEventListener('resize', () => fitPhoneScale());

// 编辑页骨架：头部（返回）+ 中间编辑区（顶部操作条：标题 + 保存）+ 右侧手机预览（真 iframe）
function editorShell({ title, backHash, saveLabel, hint, body, phoneTitle, withTrial, onSave, isDirty, barButtons }) {
  $main.className = 'admin-main editing';
  $main.innerHTML = '';

  const head = el('div', 'editor-head');
  const back = el('button', 'ghost-btn', '← 返回列表');
  // 未修改直接返回；有修改才弹确认（保存 / 不保存返回）
  back.onclick = () => {
    if (isDirty && !isDirty()) {
      location.hash = backHash;
      return;
    }
    openModal({
      title: '返回列表',
      body: el('p', 'modal-note', '当前内容尚未保存，是否保存后返回？'),
      confirmLabel: '保存',
      extraLabel: '不保存返回',
      hideCancel: true,
      onExtra: async () => {
        closeModal();
        location.hash = backHash;
      },
      onConfirm: async () => {
        if (onSave) await onSave({ exit: true, modal: true });
      }
    });
  };
  head.append(back);                 // 标题与保存按钮移进中间列顶部（见下），头部只留返回
  $main.appendChild(head);

  const cols = el('div', 'editor-cols');
  const scroll = el('div', 'editor-scroll');
  // 中间板块顶部的操作条：左边问卷标题、右边「保存问卷」。
  // 不再钉在整页右上角——相对位置 = 手机预览的左上角 / 问卷标题的右边（issue 8）。
  const actionBar = el('div', 'editor-actionbar');
  actionBar.appendChild(el('span', 'editor-actionbar-title', title));
  const barRight = el('div', 'editor-actionbar-right');
  if (hint) barRight.appendChild(el('span', 'hint', hint));
  for (const extra of (barButtons || [])) barRight.appendChild(extra);   // 自定义按钮一律排在「保存」左边
  const save = el('button', 'primary-btn', saveLabel);
  save.type = 'button';
  save.onclick = () => onSave && onSave({ exit: false });
  barRight.appendChild(save);
  actionBar.appendChild(barRight);
  scroll.appendChild(actionBar);
  const bodyWrap = el('div');
  bodyWrap.appendChild(body);
  scroll.appendChild(bodyWrap);
  cols.appendChild(scroll);

  const col = el('div', 'phone-col');
  const bar = el('div', 'phone-bar');
  bar.appendChild(el('span', 'pv-tag', '预览'));
  const refreshBtn = el('button', 'mini-btn', '⟳ 刷新预览');
  refreshBtn.type = 'button';
  refreshBtn.title = '同步编辑内容并从头试填（预览不落库）';
  bar.appendChild(refreshBtn);
  // 重做：不等整页刷新，直接把这次模拟从头再走一遍（作废当前预览会话，回到知情同意页）
  const redoPvBtn = el('button', 'mini-btn', '↺ 重做');
  redoPvBtn.type = 'button';
  redoPvBtn.title = '把这次模拟从头再走一遍（作废当前预览会话，回到知情同意页；题目内容不变）';
  redoPvBtn.addEventListener('click', async () => {
    warnIfStale();
    const b = previewCtl.bridge();
    if (!b) { toast('预览还没就绪，稍等一下再重做'); return; }
    try {
      if (b.restart) await b.restart();
      else { const u = previewCtl.url || frame.src; if (u) frame.src = u; }   // 老版本桥：退化成重载
      previewCtl.syncScrub();
    } catch (err) {
      toast(err.message || '重做失败，请重试');
    }
  });
  bar.appendChild(redoPvBtn);
  if (withTrial) {
    // 倍速：弹字 / 思考面板 / 门控计时**一起**按倍速加速，切换时只改速度、不重建会话
    const speedSel = el('select', 'pv-speed');
    for (const [v, label] of [['1', '1× 真实节奏'], ['5', '5× 加速'], ['10', '10× 加速'], ['20', '20× 快速']]) {
      const o = el('option', '', label);
      o.value = v;
      speedSel.appendChild(o);
    }
    speedSel.value = String(state.previewSpeed || 1);
    speedSel.addEventListener('change', () => {
      state.previewSpeed = Number(speedSel.value) || 1;
      applyPreviewSpeed(state.previewSpeed);        // 不重建会话：已填的作答、未提交的选择都保留
    });
    bar.appendChild(speedSel);
    var previewSpeedSel = speedSel;
  }
  col.appendChild(bar);
  col.appendChild(el('p', 'phone-note', withTrial
    ? '这里是真实的被试端页面（iframe）：所见、所点就是正式实验的样子。改完题目点「⟳ 刷新预览」同步；下面的进度条 / 题号框可直接跳到某道题开始试填。'
    : '这里是真实的被试端页面（iframe）：所见、所点就是正式实验的样子。'));
  // 进度条：拖动直接跳到第 N 题（题号与卡面一致；知情同意 / 确认页这类不占题号）
  const scrubWrap = el('div', 'pv-scrub hidden');
  const scrub = el('input', 'pv-scrub-range');
  scrub.type = 'range';
  scrub.min = '1';
  scrub.max = '1';
  scrub.value = '1';
  const scrubLabel = el('span', 'pv-scrub-label', '第 1 / 1 题');
  // 题号输入框：手输题号回车直接跳（等同拖进度条，方便跳到很靠后的题目）
  const jumpInput = el('input', 'pv-scrub-jump');
  jumpInput.type = 'number';
  jumpInput.min = '1';
  jumpInput.step = '1';
  jumpInput.placeholder = '题号';
  jumpInput.title = '输入题号后回车，直接跳到该题（等同拖动进度条）';
  const doJumpByNumber = async () => {
    warnIfStale();
    const b = previewCtl.bridge();
    if (!b) { toast('预览还没就绪，稍等一下再跳'); return; }
    const total = Math.max(1, (b.totalQuestions ? b.totalQuestions() : b.total()) || 1);
    const n = Math.round(Number(jumpInput.value));
    if (!Number.isFinite(n) || n < 1 || n > total) {
      toast(`请输入 1–${total} 之间的题号`);
      jumpInput.value = '';
      return;
    }
    try {
      await seekToQuestion(b, n);      // 按题号跳：前 n-1 题合成已作答，直接停在第 n 题
      jumpInput.value = '';
      previewCtl.syncScrub();
    } catch (err) {
      toast(err.message || '跳转失败，请重试');
    }
  };
  jumpInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); doJumpByNumber(); }
    if (e.key === 'Escape') jumpInput.value = '';
  });
  jumpInput.addEventListener('blur', () => { if (String(jumpInput.value).trim() !== '') doJumpByNumber(); });
  scrubWrap.append(scrub, scrubLabel, jumpInput);
  if (withTrial) col.appendChild(scrubWrap);
  // 手机壳：按真机尺寸（393 × 852）渲染，再用 transform 等比缩放塞进这一栏
  const holder = el('div', 'phone-holder');
  const phone = el('div', 'phone');
  const frame = document.createElement('iframe');
  frame.className = 'phone-frame';
  frame.title = '被试端预览';
  phone.appendChild(frame);
  holder.appendChild(phone);
  col.appendChild(holder);

  // 预览会话：把编辑器里（可能还没保存）的题目发给服务端建一个内存会话，iframe 就是这个会话的页面
  const ctl = {
    url: '',
    markStale: () => {
      if (!previewCtl.url) return;
      refreshBtn.textContent = '⟳ 有改动，点此刷新';
      refreshBtn.classList.add('stale');
    },
    // 预览页里暴露的桥（同源 iframe）：改倍速 / 拖进度都不重建会话
    bridge: () => {
      try { return frame.contentWindow && frame.contentWindow.__preview ? frame.contentWindow.__preview : null; } catch { return null; }
    },
    syncScrub: () => {
      const b = previewCtl.bridge();
      if (!b) return;
      // 进度按「题号」报：分母是真实题数，当前值 = 当前是第几题（与卡面写法一致）
      const total = Math.max(1, (b.totalQuestions ? b.totalQuestions() : b.total()) || 1);
      const cur = Math.min(total, Math.max(1, (b.currentQno ? b.currentQno() : (b.answered() || 0) + 1) || 1));
      scrub.max = String(total);
      if (document.activeElement !== scrub) scrub.value = String(cur);
      scrubLabel.textContent = `第 ${cur} / ${total} 题`;
      const wasHidden = scrubWrap.classList.contains('hidden');
      scrubWrap.classList.remove('hidden');
      if (wasHidden) fitPhoneScale();      // 进度条出现会占掉一行高度 → 重新按可用高度缩放，别让手机被裁掉
    }
  };
  previewCtl = ctl;
  // 预览是「点刷新那一刻」的题目快照：有未同步的改动时提醒一句，
  // 否则用户改了「呈现前清空」这类参数却以为已经生效（真机链接同理，用的是已保存的问卷）
  const warnIfStale = () => {
    if (refreshBtn.classList.contains('stale')) toast('预览还没同步改动：点「⟳ 刷新预览」后，改动（含「呈现前清空」）才会在预览里生效');
  };

  // 按题号跳（老版本桥只有 seek(单元序号)，这里做兼容）
  const seekToQuestion = (b, qno) => (b.seekQuestion ? b.seekQuestion(qno) : b.seek(qno - 1));
  // 倍速：优先走 iframe 里的桥（只改速度、不重建会话）；桥还没就绪就先记下来，等 iframe 加载完补发
  let pendingSpeed = null;
  const applyPreviewSpeed = (speed) => {
    warnIfStale();
    const b = previewCtl.bridge();
    if (b && b.setSpeed) { b.setSpeed(speed).catch(() => toast('倍速设置失败')); return; }
    if (!previewCtl.url) { pendingSpeed = speed; return; }        // 首次加载中：URL 已带 speed，无需重建
    pendingSpeed = speed;                                          // iframe 正在换页：load 后补发，不重建
  };
  let scrubTimer = null;
  scrub.addEventListener('input', () => { scrubLabel.textContent = `第 ${scrub.value} 题（松手后跳转）`; });
  scrub.addEventListener('change', async () => {
    warnIfStale();
    const b = previewCtl.bridge();
    if (!b) return;
    try {
      await seekToQuestion(b, Number(scrub.value));
      previewCtl.syncScrub();
    } catch (err) {
      toast(err.message || '跳转失败');
    }
  });
  frame.addEventListener('load', () => {
    window.setTimeout(() => {
      if (previewCtl !== ctl) return;         // 已离开编辑页：不再触碰预览
      previewCtl.syncScrub();
      // iframe 换页期间改过倍速：现在补发（只改速度，不重建会话）
      if (pendingSpeed != null) {
        const b = previewCtl.bridge();
        const want = pendingSpeed;
        pendingSpeed = null;
        if (b && b.setSpeed) b.setSpeed(want).catch(() => toast('倍速设置失败'));
      }
    }, 400);
    window.clearInterval(scrubTimer);
    scrubTimer = window.setInterval(() => previewCtl.syncScrub(), 1500);
  });
  const reloadPreview = async () => {
    refreshBtn.disabled = true;
    try {
      // 点「刷新预览」= 丢弃这一次模拟：先把旧预览会话销毁（不等 30 分钟空闲回收），再建新的
      const oldUrl = previewCtl.url || '';
      const oldId = (oldUrl.match(/preview=([^&]+)/) || [])[1];
      if (oldId) api('/api/preview/destroy', { body: { previewId: decodeURIComponent(oldId) } }).catch(() => {});
      const editing = currentEditing();
      const items = ((editing && editing.items) || []).map(stripLocal);
      const speed = previewSpeedSel ? Number(previewSpeedSel.value) : 1;
      const res = await api('/api/admin/preview', { body: { items, speed: speed > 1 ? speed : 1 } });
      pendingSpeed = null;
      previewCtl.url = `${res.url}&speed=${speed > 1 ? speed : 1}`;   // 倍速随 URL 一起带上：首次加载就生效
      frame.src = previewCtl.url;
      refreshBtn.textContent = '⟳ 刷新预览';
      refreshBtn.classList.remove('stale');
    } catch (err) {
      toast(err.message || '预览失败，请重试');
    } finally {
      refreshBtn.disabled = false;
    }
  };
  refreshBtn.onclick = () => reloadPreview();
  window.setTimeout(() => { fitPhoneScale(); reloadPreview(); }, 0);
  requestAnimationFrame(fitPhoneScale);
  // 编辑栏与手机栏之间的分隔线  // 编辑栏与手机栏之间的分隔线：拖动调整手机栏宽度（双击复位）
  const split = el('div', 'splitter');
  split.title = '拖动调整手机预览宽度 · 双击复位';
  split.addEventListener('mousedown', (e) => startDrag(e, 'phone'));
  split.addEventListener('dblclick', () => { saveLayout({ phone: LAYOUT_DEF.phone }); toast('手机栏宽度已复位'); });
  cols.append(split, col);
  $main.appendChild(cols);
  // 编辑区内容渲染完之后同步一次大纲高亮（否则首次进入时大纲不会跟随定位）
  requestAnimationFrame(() => syncOutlineActive());

  // 离开编辑页时释放资源：停止进度轮询 + 销毁这次预览会话（服务端还有 TTL/LRU 兜底）。
  // 以前 scrubTimer 会一直空转，反复进出编辑页会累积一堆指向废 iframe 的定时器。
  const dispose = () => {
    window.clearInterval(scrubTimer);
    scrubTimer = null;
    const m = ((previewCtl && previewCtl.url) || '').match(/preview=([^&]+)/);
    if (m) api('/api/preview/destroy', { body: { previewId: decodeURIComponent(m[1]) } }).catch(() => {});
    if (previewCtl === ctl) previewCtl = null;
  };
  editorShellDispose = dispose;

  // setTitle：保存后不退出编辑页时，用来把顶部标题同步成新名字
  const setTitle = (text) => { actionBar.querySelector('.editor-actionbar-title').textContent = text; };
  return { saveBtn: save, scroll, reloadPreview, dispose, setTitle };
}

/* ---------------------------------------------------------------- 实验模板列表 */

function renderExpList() {
  $main.className = 'admin-main';
  $main.innerHTML = '';
  const head = el('div', 'panel-head');
  const box = el('div', 'grow');
  box.append(
    el('h2', '', '实验管理'),
    el('p', 'panel-sub', '实验是可复用的题目模板：一套题目 + 计时默认值。问卷「插入实验」时整组复制其题目，复制后即可逐条修改。')
  );
  const btn = el('button', 'primary-btn', '+ 新建实验');
  btn.onclick = () => createExperimentDirect({ copyFrom: null });
  head.append(box, btn);
  $main.appendChild(head);

  if (!state.experiments.length) {
    $main.appendChild(el('p', 'data-empty', '还没有实验模板。点击右上角「+ 新建实验」，或先复制一份既有模板再修改。'));
    return;
  }
  const wrap = el('div', 'data-table-wrap');
  const table = el('table', 'data-table');
  const thead = el('thead');
  const tr = el('tr');
  for (const t of ['实验名称', '模板 ID', '题目数', '被问卷引用', '操作']) tr.appendChild(el('th', '', t));
  thead.appendChild(tr);
  const tbody = el('tbody');
  for (const exp of state.experiments) {
    const row = el('tr');
    const td1 = el('td');
    td1.append(el('div', 'cell-strong', exp.name), el('code', 'cell-code', exp.id));
    row.appendChild(td1);
    row.appendChild(el('td', '', exp.id));
    row.appendChild(el('td', '', `${exp.itemCount} 道`));
    row.appendChild(el('td', '', `${exp.usedBy} 份`));
    const td6 = el('td');
    const actions = el('div', 'row-actions');
    const bCopy = el('button', 'ghost-btn', '复制');
    bCopy.onclick = (e) => { e.stopPropagation(); createExperimentDirect({ copyFrom: exp }); };
    const bDel = el('button', 'ghost-btn danger', '删除');
    bDel.onclick = (e) => { e.stopPropagation(); removeExperiment(exp); };
    const bEdit = el('button', 'ghost-btn', '进入编辑');
    bEdit.onclick = (e) => { e.stopPropagation(); location.hash = `#/exp/${exp.id}`; };
    actions.append(bCopy, bDel, bEdit);
    td6.appendChild(actions);
    row.appendChild(td6);
    row.onclick = () => { location.hash = `#/exp/${exp.id}`; };
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  $main.appendChild(wrap);
}

async function renderExpEditor(id) {
  let experiment;
  try {
    experiment = (await api(`/api/admin/experiment?id=${encodeURIComponent(id)}`)).experiment;
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $main.className = 'admin-main';
    $main.innerHTML = '';
    $main.appendChild(el('p', 'data-empty', err.message || '实验不存在'));
    return;
  }
  state.editingExp = { id: experiment.id, name: experiment.name, items: experiment.items.map((it) => ({ ...it, collapsed: false })) };
  state.selected = null;
  state.expBaseline = JSON.stringify({ n: experiment.name, i: experiment.items.map(stripLocal) });
  setSidebarMode('outline');       // 题目已就绪，切到题目大纲
  renderExpEditorBody();
}

// 未命名占位名：编辑器里显示为空，保存 / 返回保存时强制填写
const UNNAMED_EXP = '未命名实验';
const UNNAMED_Q = '未命名问卷';

function renderExpEditorBody() {
  editorCtx = null;               // 页面重建期间先失效，构建完由 buildItemEditor 重新挂上
  const exp = state.editingExp;
  const body = el('div');

  const secBasic = sectionHead('模板信息', '实验是可复用的题目模板：一套题目。问卷「插入实验」时整组复制其题目，复制后即可逐条修改。');
  secBasic.id = 'sec-basic';
  const nameField = makeField('实验名称', exp.name === UNNAMED_EXP ? '' : exp.name, 1);
  nameField.input.placeholder = '请填写实验名称';
  nameField.input.addEventListener('input', () => { exp.name = nameField.input.value; });
  secBasic.appendChild(nameField.wrap);
  body.appendChild(secBasic);

  const secItems = sectionHead(`题目编排（${questionCount(exp.items)} 道 · 默认全部展开）`, '拖动左侧手柄排序；点题卡即选中并展开，点「折叠」收起。被试端按此顺序呈现。');
  secItems.id = 'sec-items';
  const editor = buildItemEditor(exp.items, {
    onChange: () => {
      secItems.querySelector('.section-title').textContent = `题目编排（${questionCount(exp.items)} 道 · 默认全部展开）`;
      markPreviewStale();
      renderOutline();
    }
  });
  secItems.appendChild(editor.wrap);
  body.appendChild(secItems);
  editorCtx = editor;          // 关键：点大纲 / 点题卡时靠它就地更新选中态（否则编辑区不会跟着选中）

  // 保存：名称必填。按钮保存留在编辑页（与问卷编辑器同一套行为）；
  // 只有「返回列表」确认弹窗里的保存（opts.exit）才保存完直接回列表。
  const doSave = async (opts = {}) => {
    const name = (exp.name || '').trim();
    if (!name || name === UNNAMED_EXP) {
      const msg = '请先填写实验名称';
      if (opts.modal) { showModalError(msg); return false; }
      toast(msg);
      nameField.input.focus();
      return false;
    }
    shell.saveBtn.disabled = true;
    try {
      await api('/api/admin/experiment/update', {
        body: { id: exp.id, name, items: exp.items.map(stripLocal) }
      });
      await reloadExperiments();
      state.expBaseline = JSON.stringify({ n: name, i: exp.items.map(stripLocal) });
      toast('已保存该实验模板');
      if (opts.modal) closeModal();
      if (opts.exit) location.hash = '#/exp';
      else shell.setTitle(`实验 · ${name}`);           // 留在编辑页：改了名字标题也立刻跟着变
      return true;
    } catch (err) {
      toast(err.message || '保存失败，请重试');
      return false;
    } finally {
      shell.saveBtn.disabled = false;
    }
  };

  const shell = editorShell({
    title: `实验 · ${(exp.name && exp.name !== UNNAMED_EXP) ? exp.name : '未命名'}`,
    backHash: '#/exp',
    saveLabel: '保存该实验',
    hint: `模板共 ${exp.items.length} 道题`,
    body,
    phoneTitle: '实验模板预览',
    withTrial: true,
    onSave: doSave,
    isDirty: () => JSON.stringify({ n: exp.name, i: exp.items.map(stripLocal) }) !== state.expBaseline
  });
  markPreviewStale();
  // 题卡已挂载：装回大纲状态（默认折叠到最高层 / 恢复上次退出的展开状态与所在题目）
  restoreOutlineOnEnter();
}

function stripLocal(item) {
  const out = JSON.parse(JSON.stringify(item));
  delete out.collapsed;
  delete out.__thinkingOn;      // 「刚添加、还没写内容」的本地标记，不落库
  return out;
}

// 复制命名：在原名末尾加编号（1）（2）…，取第一个未占用的
function numberedCopyTitle(base, existingTitles) {
  const used = new Set((existingTitles || []).map((t) => String(t || '').trim()));
  for (let n = 1; ; n += 1) {
    const t = `${base}（${n}）`;
    if (!used.has(t)) return t;
  }
}

// 直接创建（免填名）：新建立即进入编辑器；复制停留在列表页（自动编号（1）（2）…）
async function createExperimentDirect({ copyFrom }) {
  let created;
  try {
    const name = copyFrom
      ? numberedCopyTitle(copyFrom.name, state.experiments.map((e) => e.name))
      : UNNAMED_EXP;
    created = (await api('/api/admin/experiment/create', { body: { name, copyFrom: copyFrom ? copyFrom.id : '' } })).experiment;
  } catch (err) {
    toast(err.message || '创建失败，请重试');
    return;
  }
  await reloadExperiments();
  if (copyFrom) {
    toast(`已复制为「${created.name}」，点击「进入编辑」修改`);
    renderExpList();
    return;
  }
  toast('已创建实验模板，进入编辑');
  location.hash = `#/exp/${created.id}`;
}

function removeExperiment(exp) {
  openModal({
    title: '删除实验模板',
    body: el('p', 'modal-note', `确定删除实验模板「${exp.name}」？删除不影响已插入到问卷里的题目（插入即复制）。`),
    confirmLabel: '确认删除',
    danger: true,
    onConfirm: async () => {
      try {
        await api('/api/admin/experiment/delete', { body: { id: exp.id } });
      } catch (err) {
        return showModalError(err.message || '删除失败，请重试');
      }
      await reloadExperiments();
      closeModal();
      toast('已删除实验模板');
      renderExpList();
    }
  });
}

/* ---------------------------------------------------------------- 问卷列表 */

function renderQList() {
  $main.className = 'admin-main';
  $main.innerHTML = '';
  const head = el('div', 'panel-head');
  const box = el('div', 'grow');
  box.append(
    el('h2', '', '问卷管理'),
    el('p', 'panel-sub', '每份问卷 = 一条链接 + 一列题目 + 计时默认值。可逐题插入、批量插入打分题，或整组插入实验模板后逐条修改；数据按问卷隔离，被试编号按进入顺序自动分配。')
  );
  const headActions = el('div', 'head-actions');
  const btn = el('button', 'primary-btn', '+ 新建问卷');
  btn.onclick = () => createQuestionnaireDirect({ copyFrom: null });
  headActions.append(btn);
  head.append(box, headActions);
  $main.appendChild(head);

  if (!state.questionnaires.length) {
    $main.appendChild(el('p', 'data-empty', '还没有问卷。点击右上角「+ 新建问卷」创建：默认含欢迎语（空）、知情同意页、结束语（空）、结束说明页。'));
    return;
  }
  const wrap = el('div', 'data-table-wrap');
  const table = el('table', 'data-table');
  const thead = el('thead');
  const tr = el('tr');
  for (const t of ['问卷名称', '被试链接', '题目数', '数据量', '创建时间', '操作']) tr.appendChild(el('th', '', t));
  thead.appendChild(tr);
  const tbody = el('tbody');
  for (const q of state.questionnaires) {
    const row = el('tr');
    const td1 = el('td');
    td1.append(el('div', 'cell-strong', q.title), el('code', 'cell-code', q.id));
    row.appendChild(td1);

    const td2 = el('td', 'q-link-cell');
    const linkRow = el('div', 'link-row');
    const input = el('input');
    input.type = 'text';
    input.readOnly = true;
    fillParticipantLink(input, `/chat?q=${q.id}`);
    input.addEventListener('click', () => input.select());
    const copy = el('button', 'ghost-btn', '复制');
    copy.onclick = (e) => { e.stopPropagation(); copyText(input.value, '链接已复制'); };
    linkRow.append(input, copy);
    td2.appendChild(linkRow);
    row.appendChild(td2);

    row.appendChild(el('td', '', `${q.itemCount} 道`));
    row.appendChild(el('td', '', `${q.sessionCount} 份`));
    row.appendChild(el('td', '', formatTime(q.createdAt)));

    const td6 = el('td');
    const actions = el('div', 'row-actions');
    const bQr = el('button', 'ghost-btn qr-icon-btn');
    bQr.type = 'button';
    bQr.title = '二维码（扫码直达本问卷）';
    bQr.appendChild(qrIconSvg(14));
    bQr.onclick = (e) => {
      e.stopPropagation();
      openQrModal({
        title: `问卷二维码 · ${q.title}`,
        posterTitle: q.title,
        path: `/chat?q=${q.id}`,
        note: '被试扫码直达本问卷的作答页。可保存图片后打印张贴或发到群里，被试扫一扫即可开始，不用再粘贴链接。'
      });
    };
    const bEdit = el('button', 'ghost-btn', '编辑');
    bEdit.onclick = (e) => { e.stopPropagation(); location.hash = `#/q/${q.id}`; };
    const bData = el('button', 'ghost-btn', '数据');
    bData.onclick = (e) => { e.stopPropagation(); location.hash = `#/q/${q.id}/data`; };
    const bCopy = el('button', 'ghost-btn', '复制');
    bCopy.onclick = (e) => { e.stopPropagation(); createQuestionnaireDirect({ copyFrom: q }); };
    const bDel = el('button', 'ghost-btn danger', '删除');
    bDel.onclick = (e) => { e.stopPropagation(); removeQuestionnaire(q); };
    actions.append(bQr, bEdit, bData, bCopy, bDel);
    td6.appendChild(actions);
    row.appendChild(td6);
    row.addEventListener('dblclick', () => { location.hash = `#/q/${q.id}`; });
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  $main.appendChild(wrap);
}

// 直接创建（免填名）：新建立即进入编辑器；复制停留在列表页（自动编号（1）（2）…）
async function createQuestionnaireDirect({ copyFrom }) {
  let created;
  try {
    const title = copyFrom
      ? numberedCopyTitle(copyFrom.title, state.questionnaires.map((q) => q.title))
      : UNNAMED_Q;
    created = (await api('/api/admin/questionnaire/create', { body: { title, copyFrom: copyFrom ? copyFrom.id : '' } })).questionnaire;
  } catch (err) {
    toast(err.message || '创建失败，请重试');
    return;
  }
  await reloadQuestionnaires();
  if (copyFrom) {
    toast(`已复制为「${created.title}」，点击「编辑」修改`);
    renderQList();
    return;
  }
  toast('已创建问卷，进入编辑');
  location.hash = `#/q/${created.id}`;
}

function removeQuestionnaire(q) {
  let force = q.sessionCount > 0;
  openModal({
    title: '删除问卷',
    body: el('p', 'modal-note', force
      ? `「${q.title}」已有 ${q.sessionCount} 份被试数据，删除将连同全部作答与对话记录一并清空，且不可恢复。`
      : `确定删除问卷「${q.title}」？该操作不可恢复。`),
    confirmLabel: '确认删除',
    danger: true,
    onConfirm: async () => {
      try {
        await api('/api/admin/questionnaire/delete', { body: { id: q.id, force } });
      } catch (err) {
        if (err.code === 'has_sessions') force = true;
        return showModalError(err.message || '删除失败，请重试');
      }
      await reloadQuestionnaires();
      closeModal();
      toast('已删除问卷');
      renderQList();
    }
  });
}

/* ---------------------------------------------------------------- 问卷编辑页 */

async function renderQEditor(id) {
  let questionnaire;
  try {
    questionnaire = (await api(`/api/admin/questionnaire?id=${encodeURIComponent(id)}`)).questionnaire;
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $main.className = 'admin-main';
    $main.innerHTML = '';
    $main.appendChild(el('p', 'data-empty', err.message || '问卷不存在'));
    return;
  }
  state.editingQ = {
    id: questionnaire.id,
    title: questionnaire.title,
    items: questionnaire.items.map((it) => ({ ...it, collapsed: false }))
  };
  state.selected = null;
  state.qBaseline = JSON.stringify({ n: questionnaire.title, i: questionnaire.items.map(stripLocal) });
  setSidebarMode('outline');       // 题目已就绪，切到题目大纲
  renderQEditorBody();
}

function renderQEditorBody() {
  editorCtx = null;               // 页面重建期间先失效，构建完由 buildItemEditor 重新挂上
  const q = state.editingQ;
  const body = el('div');

  const secBasic = sectionHead('问卷信息', '问卷 = 一条链接 + 一列题目 + 计时默认值。链接自动生成（8 位不透明短码），被试打开即作答。');
  secBasic.id = 'sec-basic';
  const titleField = makeField('问卷名称', q.title === UNNAMED_Q ? '' : q.title, 1);
  titleField.input.placeholder = '请填写问卷名称';
  titleField.input.addEventListener('input', () => { q.title = titleField.input.value; });
  secBasic.appendChild(titleField.wrap);
  const linkRow = el('div', 'link-row');
  const linkInput = el('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  fillParticipantLink(linkInput, `/chat?q=${q.id}`);
  linkInput.addEventListener('click', () => linkInput.select());
  const copyBtn = el('button', 'ghost-btn', '复制链接');
  copyBtn.onclick = () => copyText(linkInput.value, '链接已复制');
  const qrBtn = el('button', 'ghost-btn qr-btn', '二维码');
  qrBtn.type = 'button';
  qrBtn.title = '二维码（扫码直达本问卷）';
  qrBtn.prepend(qrIconSvg(14));
  qrBtn.onclick = () => openQrModal({
    title: `问卷二维码 · ${q.title}`,
    posterTitle: q.title,
    path: `/chat?q=${q.id}`,
    note: '被试扫码直达本问卷的作答页。'
  });
  linkRow.append(linkInput, copyBtn, qrBtn);
  secBasic.appendChild(linkRow);
  body.appendChild(secBasic);

  const secItems = sectionHead(`题目编排（${questionCount(q.items)} 道 · 默认全部展开）`, '问卷默认已含欢迎语（空）、知情同意页、结束语（空）、结束说明页，均可编辑或删除。可逐题插入、批量插入打分题，或整组插入实验模板后逐条修改。');
  secItems.id = 'sec-items';
  const editor = buildItemEditor(q.items, {
    withTemplateInsert: true,
    onChange: () => {
      secItems.querySelector('.section-title').textContent = `题目编排（${questionCount(q.items)} 道 · 默认全部展开）`;
      markPreviewStale();
      renderOutline();
    }
  });
  secItems.appendChild(editor.wrap);
  body.appendChild(secItems);
  editorCtx = editor;          // 关键：点大纲 / 点题卡时靠它就地更新选中态（否则编辑区不会跟着选中）

  // 「显示全卷」：把每道题的正文拼成一份全文，通读 + 整卷统一改排版（字号 / 加粗等）。
  // 按钮就放在「保存问卷」左边；进全卷后文案变成「返回分题编辑」。
  const fullBtn = el('button', 'ghost-btn', '显示全卷');
  fullBtn.type = 'button';
  fullBtn.title = '把每道题的正文拼成一份全文：通读全卷、整卷统一改字号 / 加粗（每题之间用分割线分开）';
  fullBtn.onclick = () => {
    if (editor.inFullView()) {
      if (editor.exitFullView()) fullBtn.textContent = '显示全卷';
      return;
    }
    editor.showFullView();
    fullBtn.textContent = '返回分题编辑';
  };

  // 保存：名称必填。按钮保存留在编辑页（继续改，不想改了由用户自己点「← 返回列表」）；
  // 只有「返回列表」确认弹窗里的保存（opts.exit）才保存完直接回列表。
  const doSave = async (opts = {}) => {
    const title = (q.title || '').trim();
    if (!title || title === UNNAMED_Q) {
      const msg = '请先填写问卷名称';
      if (opts.modal) { showModalError(msg); return false; }
      toast(msg);
      titleField.input.focus();
      return false;
    }
    // 在全卷视图里点保存：先按分割线切分写回分题（切分不合法就中止，别把整卷写成一道题）
    const applied = editor.applyFullView();
    if (applied !== true) {
      const msg = `分割线数量不对：识别到 ${applied.got} 段 / 应为 ${applied.want} 题。每题之间要留一条分割线（不要增删），改好再保存。`;
      if (opts.modal) { showModalError(msg); return false; }
      toast(msg);
      return false;
    }
    shell.saveBtn.disabled = true;
    try {
      await api('/api/admin/questionnaire/update', {
        body: { id: q.id, title, items: q.items.map(stripLocal) }
      });
      await reloadQuestionnaires();
      state.qBaseline = JSON.stringify({ n: title, i: q.items.map(stripLocal) });
      toast('已保存问卷');
      if (opts.modal) closeModal();
      if (opts.exit) location.hash = '#/q';
      else shell.setTitle(`修改问卷 · ${title}`);      // 留在编辑页：改了名字标题也立刻跟着变
      return true;
    } catch (err) {
      toast(err.message || '保存失败，请重试');
      return false;
    } finally {
      shell.saveBtn.disabled = false;
    }
  };

  const shell = editorShell({
    title: `修改问卷 · ${(q.title && q.title !== UNNAMED_Q) ? q.title : '未命名'}`,
    backHash: '#/q',
    saveLabel: '保存问卷',
    hint: `共 ${questionCount(q.items)} 道题`,
    body,
    phoneTitle: q.title || '未命名问卷',
    withTrial: true,
    onSave: doSave,
    barButtons: [fullBtn],
    isDirty: () => (editor.inFullView() && editor.fullDirty()) || JSON.stringify({ n: q.title, i: q.items.map(stripLocal) }) !== state.qBaseline
  });
  markPreviewStale();
  // 题卡已挂载：装回大纲状态（默认折叠到最高层 / 恢复上次退出的展开状态与所在题目）
  restoreOutlineOnEnter();
}

/* ---------------------------------------------------------------- 数据页 */

async function renderQData(id) {
  $main.className = 'admin-main';
  $main.innerHTML = '';
  const head = el('div', 'editor-head');
  const back = el('button', 'ghost-btn', '← 返回问卷列表');
  back.onclick = () => { location.hash = '#/q'; };
  head.appendChild(back);
  $main.appendChild(head);

  let data;
  try {
    data = await api(`/api/admin/questionnaire/sessions?id=${encodeURIComponent(id)}`);
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $main.appendChild(el('p', 'data-empty', err.message || '数据加载失败'));
    return;
  }
  // 口径 = 题号（与编辑器的「题目编排（N 道）」一致）：材料消息与页面环节（知情同意 / 确认 / 结束说明）不占题号
  const { questionnaire, sessions, totalQuestions } = data;
  const qCount = questionCount(questionnaire.items);

  const panel = el('div', 'data-panel');
  const phead = el('div', 'panel-head');
  const box = el('div', 'grow');
  box.append(el('h2', '', `${questionnaire.title} · 数据`), el('p', 'panel-sub', `共 ${sessions.length} 位被试 · 问卷共 ${qCount} 道题（另有 ${questionnaire.itemCount - qCount} 条材料与页面环节）。点击一行查看该被试的完整作答与对话。`));
  // 状态筛选先建好：下面的「导出 Excel」要读它的当前值（此前它在空数据集分支里不会被初始化，点导出会报错）
  const statusSel = el('select', 'filter-select');
  // 默认不含「已作废」（重做 / 太久没提交被系统作废的会话）——需要时选「全部（含已作废）」
  [['', '默认（不含已作废）'], ['in_progress', '进行中'], ['completed', '已完成'], ['abandoned', '已作废'], ['all', '全部（含已作废）']].forEach(([v, label]) => {
    const o = el('option', '', label);
    o.value = v;
    statusSel.appendChild(o);
  });
  const exportBtn = el('button', 'ghost-btn', '导出 Excel');
  // 导出跟随当前状态筛选：默认不含已作废（选了「已作废 / 全部（含已作废）」才导出它们）
  exportBtn.onclick = () => {
    const v = statusSel.value;
    exportXlsx(questionnaire, v === 'abandoned' || v === 'all');
  };
  const delBtn = el('button', 'ghost-btn danger', '删除数据');
  phead.append(box, exportBtn, delBtn);
  panel.appendChild(phead);

  const linkRow = el('div', 'link-row');
  const linkInput = el('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  fillParticipantLink(linkInput, `/chat?q=${questionnaire.id}`);
  linkInput.addEventListener('click', () => linkInput.select());
  const copyBtn = el('button', 'ghost-btn', '复制链接');
  copyBtn.onclick = () => copyText(linkInput.value, '链接已复制');
  linkRow.append(linkInput, copyBtn);
  panel.appendChild(linkRow);

  if (!sessions.length) {
    panel.appendChild(el('p', 'data-empty', '暂无被试数据。把链接发给被试，提交后这里会实时汇总。'));
    $main.appendChild(panel);
    return;
  }

  // 筛选：状态 / 最短时长（分钟）；statusSel 已在上面创建（导出按钮要读它），这里只挂进筛选行
  const filterRow = el('div', 'data-filters');
  filterRow.appendChild(el('span', 'lbl', '筛选：'));
  const minDur = el('input', 'filter-num');
  minDur.type = 'number';
  minDur.min = '0';
  minDur.placeholder = '时长≥(分钟)';
  const resetBtn = el('button', 'mini-btn', '重置');
  resetBtn.type = 'button';
  resetBtn.onclick = () => { statusSel.value = ''; minDur.value = ''; applyFilters(); };
  filterRow.append(statusSel, minDur, resetBtn);
  panel.appendChild(filterRow);

  const wrap = el('div', 'data-table-wrap');
  const countBar = el('p', 'filter-count');
  const table = el('table', 'data-table');
  const thead = el('thead');
  const tr = el('tr');
  const checkTh = el('th', 'check-col hidden');
  const checkAll = el('input');
  checkAll.type = 'checkbox';
  checkTh.appendChild(checkAll);
  tr.appendChild(checkTh);
  for (const t of ['编号', '状态', '作答进度', '开始时间', '结束时间', '时长']) tr.appendChild(el('th', '', t));
  thead.appendChild(tr);
  const tbody = el('tbody');
  table.append(thead, tbody);
  wrap.appendChild(table);
  wrap.appendChild(countBar);
  panel.appendChild(wrap);
  $main.appendChild(panel);

  // 勾选删除模式
  let deleteMode = false;
  const selectedIds = new Set();

  const syncActionButtons = () => {
    checkTh.classList.toggle('hidden', !deleteMode);
    checkAll.checked = selectedIds.size > 0 && selectedIds.size === visibleRows().length;
    delBtn.textContent = deleteMode ? `删除所选（${selectedIds.size}）` : '删除数据';
    delBtn.classList.toggle('danger', true);
    if (deleteMode && selectedIds.size) delBtn.textContent = `删除所选（${selectedIds.size}）`;
  };

  const visibleRows = () => sessions.filter((s) => {
    // 默认（空值）不含「已作废」；'all' = 全部；其余按状态精确筛选
    if (statusSel.value === 'all') { /* 全部 */ }
    else if (statusSel.value) { if (s.status !== statusSel.value) return false; }
    else if (s.status === 'abandoned') return false;
    const minMinutes = Number(minDur.value) || 0;
    if (minMinutes > 0 && (s.durationSec == null || s.durationSec < minMinutes * 60)) return false;
    return true;
  });

  function renderRows() {
    const rows = visibleRows();
    tbody.innerHTML = '';
    countBar.textContent = `显示 ${rows.length} / ${sessions.length} 条记录`;
    for (const s of rows) {
      const row = el('tr', deleteMode ? 'delete-mode' : '');
      const checkTd = el('td', 'check-col' + (deleteMode ? '' : ' hidden'));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = selectedIds.has(s.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(s.id);
        else selectedIds.delete(s.id);
        syncActionButtons();
      });
      checkTd.appendChild(cb);
      row.appendChild(checkTd);
      row.append(
        el('td', 'cell-strong', s.seq == null ? '—' : `#${s.seq}`),
        el('td', '', s.statusLabel),
        el('td', '', `${s.answeredQuestions} / ${totalQuestions}`),
        el('td', '', formatTime(s.startedAt)),
        el('td', '', formatTime(s.endedAt)),
        el('td', '', formatDuration(s.durationSec))
      );
      row.onclick = (e) => {
        if (deleteMode) {
          if (e.target.tagName !== 'INPUT') cb.checked = !cb.checked;
          if (cb.checked) selectedIds.add(s.id);
          else selectedIds.delete(s.id);
          syncActionButtons();
          return;
        }
        location.hash = `#/q/${questionnaire.id}/s/${s.id}`;
      };
      tbody.appendChild(row);
    }
    syncActionButtons();
  }

  function applyFilters() {
    selectedIds.clear();
    renderRows();
  }
  statusSel.addEventListener('change', applyFilters);
  minDur.addEventListener('input', applyFilters);
  checkAll.addEventListener('change', () => {
    const rows = visibleRows();
    if (checkAll.checked) rows.forEach((s) => selectedIds.add(s.id));
    else selectedIds.clear();
    renderRows();
  });

  delBtn.onclick = () => {
    if (!deleteMode) {
      deleteMode = true;
      selectedIds.clear();
      renderRows();
      return;
    }
    if (!selectedIds.size) { toast('请先勾选要删除的记录'); return; }
    openModal({
      title: '删除数据',
      body: el('p', 'modal-note', `确定删除所选的 ${selectedIds.size} 条被试记录吗？连同其全部作答与对话记录一并清空，且不可恢复。`),
      confirmLabel: '确认删除',
      danger: true,
      onConfirm: async () => {
        try {
          await api('/api/admin/questionnaire/sessions/delete', { body: { id: questionnaire.id, ids: [...selectedIds] } });
        } catch (err) {
          return showModalError(err.message || '删除失败，请重试');
        }
        closeModal();
        toast(`已删除 ${selectedIds.size} 条记录`);
        // 重新加载本页数据
        renderQData(id);
      }
    });
  };

  renderRows();
}

async function exportXlsx(questionnaire, includeAbandoned) {
  try {
    const qs = `id=${encodeURIComponent(questionnaire.id)}${includeAbandoned ? '&includeAbandoned=1' : ''}`;
    const res = await fetch(`/api/admin/questionnaire/export.xlsx?${qs}`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `导出失败（${res.status}）`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${questionnaire.title}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast(`已开始下载：${questionnaire.title}.xlsx`);
  } catch (err) {
    toast(err.message || '导出失败，请重试');
  }
}

async function renderQSession(id, sid) {
  $main.className = 'admin-main';
  $main.innerHTML = '';
  const head = el('div', 'editor-head');
  const back = el('button', 'ghost-btn', '← 返回数据列表');
  back.onclick = () => { location.hash = `#/q/${id}/data`; };
  head.appendChild(back);
  $main.appendChild(head);

  let data;
  try {
    data = await api(`/api/admin/questionnaire/session?id=${encodeURIComponent(id)}&sid=${encodeURIComponent(sid)}`);
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $main.appendChild(el('p', 'data-empty', err.message || '会话加载失败'));
    return;
  }
  const { questionnaire, session, messages, responses } = data;

  const panel = el('div', 'data-panel');
  const ph = el('div', 'panel-head');
  const box = el('div', 'grow');
  box.append(el('h2', '', `${questionnaire.title} · 被试 #${session.seq == null ? '—' : session.seq}`));
  ph.appendChild(box);
  panel.appendChild(ph);

  const secMeta = sectionHead('会话信息');
  const grid = el('div', 'meta-grid');
  for (const [label, value] of [
    ['状态', session.statusLabel],
    ['开始时间', formatTime(session.startedAt)],
    ['结束时间', formatTime(session.endedAt)],
    ['时长', formatDuration(session.durationSec)],
    ['作答进度', `${session.answeredQuestions} / ${session.totalQuestions} 题`],
    ['浏览器', (session.userAgent || '').slice(0, 60) || '——']
  ]) {
    const item = el('div', 'meta-item');
    item.append(el('span', 'meta-label', label), el('span', 'meta-value', value));
    grid.appendChild(item);
  }
  secMeta.appendChild(grid);
  panel.appendChild(secMeta);

  const secResp = sectionHead('作答明细', '按题目顺序排列；呈现/作答时间为服务端记录，耗时为前端上报。');
  const tw = el('div', 'data-table-wrap');
  const table = el('table', 'data-table');
  const thead = el('thead');
  const tr = el('tr');
  for (const t of ['题目', '题型', '作答', '对错', '呈现时间', '作答时间', '耗时']) tr.appendChild(el('th', '', t));
  thead.appendChild(tr);
  const tbody = el('tbody');
  for (const r of responses) {
    const row = el('tr');
    row.append(
      el('td', 'cell-strong', r.itemLabel),
      el('td', '', r.itemTypeLabel),
      el('td', '', r.itemType === 'text' ? r.text : r.optionLabel || '—'),
      el('td', '', r.isCorrect || '—'),
      el('td', '', formatTime(r.presentedAt)),
      el('td', '', formatTime(r.answeredAt)),
      el('td', '', r.elapsedMs == null ? '—' : `${Math.round(r.elapsedMs / 100) / 10} 秒`)
    );
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  tw.appendChild(table);
  secResp.appendChild(tw);
  panel.appendChild(secResp);

  const secMsg = sectionHead('对话记录', '被试端界面中实际呈现的全部消息（正文为其清洗后的富文本）。');
  const timeline = el('div', 'msg-timeline');
  for (const m of messages) {
    const item = el('div', m.role === 'user' ? 'msg-item' : 'msg-item msg-ai');
    const h = el('div', 'msg-head');
    // 「延迟发出」参数已从平台移除：这里只对历史数据（旧库里带 visible_at 的消息）显示
    const delayed = m.visible_at && new Date(m.visible_at).getTime() > new Date(m.created_at).getTime() + 1000;
    h.append(
      el('span', 'msg-role', m.role === 'user' ? '被试' : '系统'),
      el('span', 'msg-time', formatTime(m.created_at) + (delayed ? ' · 延迟发出' : ''))
    );
    item.append(h);
    // 思考过程：被试端在正文之前以此面板呈现（默认折叠），此处同样可折叠展开核对
    if (m.thinking) {
      const det = el('details', 'msg-think');
      const thinkSec = Math.round(Number(m.think_ms) / 100) / 10;
      det.appendChild(el('summary', '', `深度思考面板（用时 ${Number.isInteger(thinkSec) ? thinkSec : thinkSec.toFixed(1)} 秒）`));
      det.appendChild(el('p', 'msg-content msg-content-think', m.thinking));
      item.appendChild(det);
    }
    const contentNode = el('div', 'msg-content rich');
    contentNode.innerHTML = RichText.sanitizeHtml(m.content);
    item.appendChild(contentNode);
    timeline.appendChild(item);
  }
  secMsg.appendChild(timeline);
  panel.appendChild(secMsg);
  $main.appendChild(panel);
}

/* ---------------------------------------------------------------- 个人设置页（#/settings） */

function avatarNode(user, size) {
  const wrap = el('div', 'avatar' + (user.avatar ? '' : ' empty'));
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  if (user.avatar) {
    const img = el('img');
    img.src = user.avatar;
    img.alt = '头像';
    wrap.appendChild(img);
  } else {
    wrap.textContent = (user.username || '?').slice(0, 1).toUpperCase();
  }
  return wrap;
}

async function saveMyAvatar(dataUrl) {
  const res = await api('/api/auth/avatar', { body: { avatar: dataUrl } });
  state.user.avatar = res.avatar;
}

// 头像裁剪弹窗：圆形视窗内拖动照片 / 滚轮缩放，确认后按可视区裁成 256×256
function openAvatarCropper(src, onDone) {
  const SIZE = 220;
  const body = el('div', 'crop-wrap');
  const viewport = el('div', 'crop-viewport');
  const img = el('img', 'crop-img');
  img.src = src;
  img.draggable = false;
  viewport.appendChild(img);
  body.appendChild(viewport);
  body.appendChild(el('p', 'crop-hint', '拖动照片调整位置 · 滚轮缩放'));

  let baseScale = 1;
  let scale = 1;
  let x = 0;
  let y = 0;
  const apply = () => {
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.left = `${(SIZE - w) / 2 + x}px`;
    img.style.top = `${(SIZE - h) / 2 + y}px`;
  };
  const clampXY = () => {
    const maxX = Math.max(0, (img.naturalWidth * scale - SIZE) / 2);
    const maxY = Math.max(0, (img.naturalHeight * scale - SIZE) / 2);
    x = Math.min(maxX, Math.max(-maxX, x));
    y = Math.min(maxY, Math.max(-maxY, y));
  };
  img.onload = () => {
    baseScale = Math.max(SIZE / img.naturalWidth, SIZE / img.naturalHeight);
    scale = baseScale;
    apply();
  };

  let drag = null;
  viewport.addEventListener('pointerdown', (e) => {
    drag = { sx: e.clientX, sy: e.clientY, ox: x, oy: y };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('grabbing');
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!drag) return;
    x = drag.ox + (e.clientX - drag.sx);
    y = drag.oy + (e.clientY - drag.sy);
    clampXY();
    apply();
  });
  const endDrag = () => { drag = null; viewport.classList.remove('grabbing'); };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    scale = Math.min(baseScale * 4, Math.max(baseScale, scale * (e.deltaY < 0 ? 1.12 : 0.89)));
    clampXY();
    apply();
  }, { passive: false });

  openModal({
    title: '裁剪头像',
    body,
    confirmLabel: '使用这张',
    onConfirm: async () => {
      const out = document.createElement('canvas');
      out.width = out.height = 256;
      out.getContext('2d').drawImage(img, -x / scale, -y / scale, SIZE / scale, SIZE / scale, 0, 0, 256, 256);
      await onDone(out.toDataURL('image/jpeg', 0.88));
    }
  });
}

function renderSettings() {
  $main.innerHTML = '';
  const panel = el('div', 'page-panel');

  // 左上角返回
  const back = el('button', 'ghost-btn settings-back', '← 返回');
  back.type = 'button';
  back.addEventListener('click', () => { location.hash = '#/exp'; });
  panel.appendChild(back);

  const head = el('div', 'settings-head');
  head.appendChild(el('h2', 'page-title', '个人设置'));
  head.appendChild(el('p', 'page-sub', '管理您的账号信息与登录密码。'));
  panel.appendChild(head);

  // 全局设置（仅管理员）：未完成会话的自动作废时限 / 恢复窗口
  if (state.user && state.user.role === 'admin') {
    const secGlobal = sectionHead('全局设置（仅管理员）', '影响所有问卷的会话生命周期。');
    const grid = el('div', 'grid2');
    const abandonField = makeNumberField('未完成会话自动作废时限（分钟）', '', 0, 1440,
      '超过这个时长没有任何活动（答题 / 刷新 / 心跳）的进行中会话，下次打开时会被标记为「已作废」并释放设备；0 = 不自动作废');
    const resumeField = makeNumberField('中途退出可恢复窗口（小时）', '', 0, 720,
      '超出窗口后重新打开链接会从知情同意页重新开始（旧会话仍留档）；0 = 不限制');
    grid.append(abandonField.wrap, resumeField.wrap);
    const saveRow = el('div', 'avatar-btns');
    const saveBtn = el('button', 'primary-btn', '保存全局设置');
    saveBtn.type = 'button';
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        const res = await api('/api/admin/settings', {
          body: {
            abandonAfterMinutes: Number(abandonField.input.value) || 0,
            resumeWindowHours: Number(resumeField.input.value) || 0
          }
        });
        toast('全局设置已保存');
        abandonField.input.value = String(res.settings.abandonAfterMinutes);
        resumeField.input.value = String(res.settings.resumeWindowHours);
      } catch (err) {
        toast(err.message || '保存失败，请重试');
      } finally {
        saveBtn.disabled = false;
      }
    };
    saveRow.appendChild(saveBtn);
    secGlobal.append(grid, saveRow);
    panel.appendChild(secGlobal);
    api('/api/admin/settings').then((res) => {
      abandonField.input.value = String(res.settings.abandonAfterMinutes);
      resumeField.input.value = String(res.settings.resumeWindowHours);
    }).catch(() => { /* 非管理员或未登录：忽略 */ });
  }

  // 头像
  const secAvatar = sectionHead('头像', '支持 PNG / JPG / WebP，自动压缩后保存。');
  const avatarRow = el('div', 'avatar-row');
  const avatarBox = avatarNode(state.user, 72);
  avatarRow.appendChild(avatarBox);
  const fileBtn = el('button', 'ghost-btn', '上传新头像');
  fileBtn.type = 'button';
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.classList.add('hidden');
  const removeBtn = el('button', 'ghost-btn', '移除头像');
  removeBtn.type = 'button';
  const btnRow = el('div', 'avatar-btns');
  btnRow.append(fileBtn, removeBtn);
  avatarRow.appendChild(btnRow);
  secAvatar.appendChild(avatarRow);
  panel.appendChild(secAvatar);

  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      // 圆形裁剪预览：拖动调整位置、滚轮缩放，确认后输出 256×256
      openAvatarCropper(reader.result, async (dataUrl) => {
        try {
          await saveMyAvatar(dataUrl);
          const fresh = avatarNode(state.user, 72);
          avatarBox.replaceWith(fresh);
          toast('头像已更新');
        } catch (err) {
          if (!maybeSessionExpired(err)) toast(err.message || '头像保存失败');
        }
      });
    };
    reader.readAsDataURL(file);
  });
  removeBtn.addEventListener('click', async () => {
    try {
      await saveMyAvatar('');
      const fresh = avatarNode(state.user, 72);
      avatarBox.replaceWith(fresh);
      toast('已移除头像');
    } catch (err) {
      if (!maybeSessionExpired(err)) toast(err.message || '操作失败');
    }
  });
  panel.appendChild(fileInput);

  // 账号信息
  const secInfo = sectionHead('账号信息');
  const infoRow = el('div', 'kv-row');
  infoRow.appendChild(el('span', 'kv-key', '用户账号'));
  infoRow.appendChild(el('span', 'kv-val', state.user.username));
  secInfo.appendChild(infoRow);
  const roleRow = el('div', 'kv-row');
  roleRow.appendChild(el('span', 'kv-key', '角色'));
  roleRow.appendChild(el('span', 'kv-val', state.user.role === 'admin' ? '管理员' : '普通主试'));
  secInfo.appendChild(roleRow);
  if (state.user.role === 'admin') {
    const usersBtn = el('button', 'ghost-btn', '用户管理');
    usersBtn.type = 'button';
    usersBtn.addEventListener('click', () => { location.hash = '#/users'; });
    secInfo.appendChild(usersBtn);
  }
  panel.appendChild(secInfo);

  // 修改密码
  const secPwd = sectionHead('修改密码', '修改后其他设备上的登录会立即失效（需用新密码重新登录），本设备继续使用。');
  const oldField = makeField('当前密码', '');
  oldField.input.type = 'password';
  const newField = makeField('新密码（至少 6 位）', '');
  newField.input.type = 'password';
  const newField2 = makeField('确认新密码', '');
  newField2.input.type = 'password';
  secPwd.append(oldField.wrap, newField.wrap, newField2.wrap);
  const pwdBtn = el('button', 'primary-btn', '保存新密码');
  pwdBtn.type = 'button';
  pwdBtn.addEventListener('click', async () => {
    const oldPassword = oldField.input.value;
    const newPassword = newField.input.value;
    if (!oldPassword || newPassword.length < 6) { toast('请填写当前密码，新密码至少 6 位'); return; }
    if (newPassword !== newField2.input.value) { toast('两次输入的新密码不一致'); return; }
    pwdBtn.disabled = true;
    // 改密会让旧 token 全部失效（踢下线），当前设备用服务端换发的新 token 继续
    const remembered = !!loadRememberedTokenRecord();
    try {
      const res = await api('/api/auth/password', { body: { oldPassword, newPassword, remember: remembered } });
      if (res && res.token) storeToken(res.token, remembered);
      // 「记住账号密码」里存的是旧密码：同步成新密码，下次自动填充才能登录
      try {
        const rec = JSON.parse(localStorage.getItem(LOGIN_REMEMBER_KEY) || 'null');
        if (rec && rec.username) {
          rec.password = newPassword;
          rec.expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
          localStorage.setItem(LOGIN_REMEMBER_KEY, JSON.stringify(rec));
        }
      } catch { /* 忽略 */ }
      oldField.input.value = newField.input.value = newField2.input.value = '';
      toast('密码已修改，其他设备上的登录已失效');
    } catch (err) {
      if (!maybeSessionExpired(err)) toast(err.message || '密码修改失败');
    } finally {
      pwdBtn.disabled = false;
    }
  });
  secPwd.appendChild(pwdBtn);
  panel.appendChild(secPwd);

  // 退出登录
  const secOut = sectionHead('登录状态');
  const outBtn = el('button', 'ghost-btn danger', '退出登录');
  outBtn.type = 'button';
  outBtn.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { body: {} }); } catch { /* 忽略 */ }
    state.token = '';
    state.user = null;
    clearTokens();
    showLogin('');
  });
  secOut.appendChild(outBtn);
  panel.appendChild(secOut);

  $main.appendChild(panel);
}

/* ---------------------------------------------------------------- 用户管理页（#/users，管理员） */

async function renderUsers() {
  if (!state.user || state.user.role !== 'admin') {
    location.replace('#/exp');
    return;
  }
  $main.innerHTML = '';
  const panel = el('div', 'page-panel');

  const head = el('div', 'settings-head');
  head.appendChild(el('h2', 'page-title', '用户管理'));
  head.appendChild(el('p', 'page-sub', '查看与维护系统用户：新增账号、修改资料、重置密码、删除用户。'));
  panel.appendChild(head);

  const addBtn = el('button', 'primary-btn', '＋ 新增用户');
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => openUserEditor(null));
  panel.appendChild(addBtn);

  const box = el('div', 'users-list');
  panel.appendChild(box);
  $main.appendChild(panel);

  let users = [];
  try {
    users = (await api('/api/admin/users')).users;
  } catch (err) {
    if (!maybeSessionExpired(err)) toast(err.message || '用户列表加载失败');
    return;
  }

  const table = el('table', 'users-table');
  const thead = el('thead');
  thead.appendChild(el('tr', '', '')).append(
    el('th', '', '用户'), el('th', '', '角色'), el('th', '', '创建时间'), el('th', '', '操作')
  );
  const tbody = el('tbody');
  for (const u of users) {
    const tr = el('tr');
    const nameCell = el('td');
    const nameWrap = el('div', 'user-cell');
    nameWrap.appendChild(avatarNode(u, 34));
    nameWrap.appendChild(el('span', '', u.username));
    nameCell.appendChild(nameWrap);
    tr.appendChild(nameCell);
    tr.appendChild(el('td', '', u.role === 'admin' ? '管理员' : '普通主试'));
    tr.appendChild(el('td', '', formatTime(u.createdAt)));
    const ops = el('td');
    const bEdit = el('button', 'mini-btn', '编辑');
    bEdit.type = 'button';
    bEdit.addEventListener('click', () => openUserEditor(u));
    const bDel = el('button', 'mini-btn', '删除');
    bDel.type = 'button';
    if (u.id === state.user.id) bDel.disabled = true;
    bDel.addEventListener('click', () => {
      openModal({
        title: '删除用户',
        body: el('p', 'modal-text', `确定删除用户「${u.username}」吗？该操作不可恢复。`),
        confirmLabel: '删除',
        danger: true,
        onConfirm: async () => {
          await api('/api/admin/users/delete', { body: { id: u.id } });
          toast('已删除');
          renderUsers();
        }
      });
    });
    ops.append(bEdit, bDel);
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  box.appendChild(table);
}

// 新增 / 编辑用户弹窗
function openUserEditor(user) {
  const isEdit = !!user;
  const body = el('div', 'form-grid');
  const nameField = makeField('用户账号', isEdit ? user.username : '');
  const roleField = el('label', 'field');
  roleField.appendChild(el('span', '', '角色'));
  const roleSel = el('select');
  ['user', 'admin'].forEach((r) => {
    const opt = el('option', '', r === 'admin' ? '管理员' : '普通主试');
    opt.value = r;
    roleSel.appendChild(opt);
  });
  roleSel.value = isEdit ? user.role : 'user';
  roleField.appendChild(roleSel);
  const pwdLabel = isEdit ? '重置密码（留空则不修改）' : '初始密码（至少 6 位）';
  const pwdField = makeField(pwdLabel, '');
  pwdField.input.type = 'password';
  body.append(nameField.wrap, roleField, pwdField.wrap);

  openModal({
    title: isEdit ? `编辑用户 · ${user.username}` : '新增用户',
    body,
    onConfirm: async () => {
      if (isEdit) {
        await api('/api/admin/users/update', {
          body: {
            id: user.id,
            username: nameField.input.value.trim(),
            role: roleSel.value,
            password: pwdField.input.value || undefined
          }
        });
        toast('已保存');
      } else {
        await api('/api/admin/users/create', {
          body: { username: nameField.input.value.trim(), role: roleSel.value, password: pwdField.input.value }
        });
        toast('已创建');
      }
      renderUsers();
    }
  });
}

/* ---------------------------------------------------------------- 启动 */

boot();
