// 被试端：统一题目模型 · 内联一问一答
// 呈现方式：消息（打字机）穿插题目卡片；每道题「一个问题一个答案」——
//   未作答：卡片内直接给出作答控件，全部题型都点「确认提交 / 提交创作」提交（门控期间控件可填，只有提交按钮置灰）
//   已作答：控件就地保留为只读（选中态 + ✓ 已提交），卡片可折叠（顶部一个按钮可折叠全部已答题目，便于回看材料）
// 计时门控以服务端时间为准：延迟发出（等待「对方正在输入…」）、作答前强制等待、作答窗口（最短提交 / 最长作答自动提交）。
'use strict';

const params = new URLSearchParams(location.search);
const questionnaireCode = (params.get('q') || '').trim();
// 预览模式：管理端手机预览用真 iframe 加载本页（?preview=<id>），走内存预览会话，
// 与真实被试端是同一份前端代码——所见即正式实验的样子。
const previewId = (params.get('preview') || '').trim();
const IS_PREVIEW = !!previewId;
// 预览倍速：既缩放「弹字 / 思考面板」的节奏，也缩放门控计时（门控由服务端按同一倍速缩短）。
// 管理端切换倍速时通过 __preview.setSpeed 直接改这个变量，不再重建会话。
let previewSpeed = IS_PREVIEW ? Math.max(1, Math.min(50, Math.round(Number(params.get('speed')) || 1))) : 1;
const forceFresh = params.get('fresh') === '1';
// fresh 只在本次进入时生效：用掉就把参数从地址栏去掉，
// 否则它会留在 URL 里，让之后每一次刷新都被当成「强制新开」。
if (forceFresh) {
  try { history.replaceState(null, '', `${location.pathname}?q=${encodeURIComponent(questionnaireCode)}`); } catch { /* 忽略 */ }
}

const $stream = document.getElementById('chat-stream');
const $scroll = document.getElementById('chat-scroll');
const $btnCollapseAll = document.getElementById('btn-collapse-all');
const $btnRedo = document.getElementById('btn-redo');
const $confirmMask = document.getElementById('confirm-mask');
const $confirmIcon = document.getElementById('confirm-icon');
const $confirmTitle = document.getElementById('confirm-title');
const $confirmText = document.getElementById('confirm-text');
const $confirmOk = document.getElementById('confirm-ok');
const $confirmCancel = document.getElementById('confirm-cancel');
const $pageScreen = document.getElementById('page-screen');
const $pageTitle = document.getElementById('page-title');
const $pageText = document.getElementById('page-text');
const $pageCheckWrap = document.getElementById('page-check-wrap');
const $pageCheck = document.getElementById('page-check');
const $pageCheckLabel = document.getElementById('page-check-label');
const $pageIdWrap = document.getElementById('page-id-wrap');
const $pageIdLabel = document.getElementById('page-id-label');
const $pageIdInput = document.getElementById('page-id-input');
const $pageHint = document.getElementById('page-hint');
const $pageBtn = document.getElementById('page-btn');
const $composer = document.getElementById('composer');
const $composerInput = document.getElementById('composer-input');
const $composerSend = document.getElementById('composer-send');
const $composerError = document.getElementById('composer-error');
const $composerHint = document.getElementById('composer-hint');
const $leaveMask = document.getElementById('leave-mask');
const $leaveText = document.getElementById('leave-text');
const $leaveOk = document.getElementById('leave-ok');
const $errorScreen = document.getElementById('error-screen');
const $errorText = document.getElementById('error-text');

const state = {
  sessionId: null,
  action: null,
  busy: false,
  completed: false,
  seenMsgs: 0,              // 已完整看过的消息数（重进时只补播没看完的部分）
  serverOffsetMs: 0,
  questionNodes: new Map(), // itemId -> { card, ... } 当前待作答卡片
  answeredCount: 0,
  totalAnswers: 0,
  totalQuestions: 0,        // 真实题数（进度条分母按题号来）
  currentQno: 0,            // 当前「第几题」
  timeScale: 1,             // 预览倍速：倒计时按「设定秒数 × 倍速」显示（真实会话恒为 1）
  showAnswered: true,       // 问答过程默认不隐藏（需求 4）：已答题降权呈现，需要时可手动折叠
  draft: {},                // itemId -> { subIndex: text }
  deadlineFired: false,
  redoing: null             // 打分题重做中：{ itemId, action, card, control, submitBtn, hint, busy }（最多一张卡片）
};

// 时间已到后的统一提示：停止作答，只能重做（被试端各处共用同一句，避免口径不一致）
const STOPPED_HINT = '作答时间已到，本题已停止作答。如需重新作答，请点击顶部的「重做」。';

// 聊天流世代号：任何「整屏换内容」（跳题 / 重开会话）都会 +1。
// 提交之后是一串异步续集（先逐字播消息、再渲染下一题），换屏时它可能还没跑完。
// 续集每次写屏前先对世代号，对不上立即收手——否则它会把自己没播完的消息、
// 以及旧那一步的下一题卡，追加进新的聊天流里（表现就是「跳到第 N 题作答后，
// 开场材料又在第六题下方重播一遍，还冒出一张等着作答的旧题卡」）。
let streamEpoch = 0;
function beginFreshStream() { streamEpoch += 1; return streamEpoch; }

const STORAGE_PREFIX = 'expchat_q_';
const DRAFT_PREFIX = 'expchat_draft_';
// 本机存储作用域：预览用独立的键，避免覆盖同一浏览器上真实被试的记录
const storageScope = IS_PREVIEW ? `preview_${previewId}` : questionnaireCode;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 防「选中 → 复制 → 搜索」：内容区不可选中 / 复制 / 右键 / 拖拽，打印一律空白。
// 输入框（被试自己的作答）例外，否则没法编辑答案。
const inEditable = (node) => !!(node && node.closest && node.closest('input, textarea, [contenteditable="true"]'));
for (const evt of ['copy', 'cut', 'contextmenu', 'dragstart']) {
  document.addEventListener(evt, (e) => { if (!inEditable(e.target)) e.preventDefault(); }, true);
}
document.addEventListener('selectstart', (e) => { if (!inEditable(e.target)) e.preventDefault(); }, true);
document.addEventListener('keydown', (e) => {
  const key = String(e.key || '').toLowerCase();
  if ((e.ctrlKey || e.metaKey) && (key === 'p' || key === 's' || key === 'u')) { e.preventDefault(); return; }
  if (key === 'printscreen') e.preventDefault();          // 尽力而为（多数浏览器拦不住系统截屏）
}, true);

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
    err.data = data;                     // 报错细节（如断言失败标记 assertionFailed）
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

/* ---------------------------------------------------------------- 富文本内容
   正文一律走这里：数据里的正文是清洗过的 HTML；历史数据可能是纯文本，统一兜底成 HTML。
   渲染前再清洗一遍（服务端保存时已清洗，双保险）。 */
function contentHtml(content) {
  const raw = String(content == null ? '' : content);
  if (!raw.trim()) return '';
  const looksHtml = /^\s*<(\/?)(p|h[1-6]|ul|ol|li|blockquote|span|strong|em|u|s|sub|sup|br|hr|a|div)\b/i.test(raw);
  const html = looksHtml ? raw.trim() : RichText.textToHtml(raw);
  return RichText.sanitizeHtml(html);
}
// 题目卡片 / 列表用的一行标题：取正文首行（去格式）
function contentTitle(content, fallback) {
  const t = RichText.htmlToText(contentHtml(content));
  const line = (t.split('\n').find((x) => x.trim()) || '').trim();
  return line || String(fallback || '');
}
// 页面（知情同意 / 确认页 / 终态页）：正文首行若是标题（h1/h2），拆出来当页面大标题
function splitLeadingHeading(html) {
  const m = /^\s*<h([12])[^>]*>([\s\S]*?)<\/h\1>\s*/i.exec(html);
  if (!m) return { title: '', titleHtml: '', body: html };
  return { title: RichText.htmlToText(m[2]).trim(), titleHtml: m[2], body: html.slice(m[0].length) };
}

// 预览模式下所有请求都打到内存预览会话（/api/preview/*），其余逻辑与真实端完全一致
const createSessionUrl = () => (IS_PREVIEW ? '/api/preview/session' : '/api/session');
const createSessionBody = () => (IS_PREVIEW ? { previewId } : { q: questionnaireCode });
const stepUrl = () => (IS_PREVIEW ? '/api/preview/step' : '/api/step');
// 每一步提交都带上「当前这题的 itemId」：服务端据此判断是不是重复/迟到的提交，
// 避免旧负载的提交被静默记到下一题上（表现就是「答完一题跳过了两题」）。
const stepBody = (payload) => {
  const base = state.action ? { itemId: state.action.itemId } : {};
  return IS_PREVIEW ? { previewId, ...base, ...payload } : { ...base, ...payload };
};
const finishUrl = () => (IS_PREVIEW ? '/api/preview/finish' : '/api/finish');
const bootstrapUrl = (sid) => (IS_PREVIEW
  ? `/api/preview/bootstrap?preview=${encodeURIComponent(previewId)}${sid ? `&session=${encodeURIComponent(sid)}` : ''}`
  : `/api/bootstrap?q=${encodeURIComponent(questionnaireCode)}${sid ? `&session=${encodeURIComponent(sid)}` : ''}`);

function scrollToBottom(smooth = true) {
  $scroll.scrollTo({ top: $scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}
// 流式输出期间的高频滚动合并到一帧里（每 4 个字滚一次会造成反复强制重排 → 掉帧）
let scrollRafPending = false;
function scheduleScrollToBottom() {
  if (scrollRafPending) return;
  scrollRafPending = true;
  requestAnimationFrame(() => { scrollRafPending = false; scrollToBottom(false); });
}
function serverNow() {
  return Date.now() + state.serverOffsetMs;
}

/* ---------------------------------------------------------------- 本机记录 */

function loadStoredSession() {
  if (forceFresh) return '';
  try { return localStorage.getItem(STORAGE_PREFIX + storageScope) || ''; } catch { return ''; }
}
function storeSession(id) {
  try { localStorage.setItem(STORAGE_PREFIX + storageScope, id); } catch { /* 忽略 */ }
}
function clearStoredSession() {
  try { localStorage.removeItem(STORAGE_PREFIX + storageScope); } catch { /* 忽略 */ }
}
// 终态记录存在 sessionStorage：同一标签页内刷新仍在，关掉标签页即消失。
// 于是「刷新」仍看到致谢页，「关掉重开」才回到开始页、把设备交给下一位被试。
// 作用域与其他本机记录一致（真实问卷 = 问卷短码；预览 = 那一次的预览会话）：
// 早先这里用的是问卷短码，而预览没有短码（空串）——于是**所有预览共用一个键**，
// 做完一份预览再去开另一组问卷的预览，会直接停在上一份的终态页（既进不去也刷不掉）。
const COMPLETED_PREFIX = 'expchat_done_';
function storeCompletedFinal(payload) {
  try { sessionStorage.setItem(COMPLETED_PREFIX + storageScope, JSON.stringify(payload)); } catch { /* 忽略 */ }
}
function loadCompletedFinal() {
  try {
    const raw = sessionStorage.getItem(COMPLETED_PREFIX + storageScope);
    return raw ? JSON.parse(raw) || null : null;
  } catch { return null; }
}
function clearCompletedFinal() {
  try { sessionStorage.removeItem(COMPLETED_PREFIX + storageScope); } catch { /* 忽略 */ }
}
// 草稿同样按 storageScope 分桶：真实问卷用短码互不串；预览用本次预览会话，
// 上一次预览里没提交的草稿不会跑到下一次预览（更不会跨问卷）。
function draftKey(itemId) { return `${DRAFT_PREFIX}${storageScope}_${itemId}`; }
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

function appendUserMessage(text, itemId) {
  const row = el('div', 'msg user answered');
  if (itemId) row.dataset.itemId = itemId;
  const bubble = el('div', 'bubble rich');
  bubble.innerHTML = contentHtml(text);
  row.appendChild(bubble);
  $stream.appendChild(row);
  scrollToBottom();
  return row;
}

// AI 消息左侧的系统圈圈图标（全流程对话化）
function aiAvatar() {
  return el('span', 'ai-avatar');
}

function appendAiMessageStatic(content, thinkingText, thinkMs) {
  const row = el('div', 'msg ai');
  row.appendChild(aiAvatar());
  const body = el('div', 'ai-body');
  if (thinkingText) {
    body.appendChild(appendThinkPanelStatic(thinkingText, thinkMs));
    body.appendChild(el('div', 'think-divider'));
    body.appendChild(el('div', 'think-done', '思考已完成'));       // 与流式渲染一致：回放 / 刷新也看得到
  }
  const text = el('div', 'ai-text');
  text.innerHTML = contentHtml(content);
  body.appendChild(text);
  row.appendChild(body);
  $stream.appendChild(row);
  return row;
}

function appendThinkingRow() {
  const row = el('div', 'msg ai');
  row.appendChild(aiAvatar());
  const body = el('div', 'ai-body thinking-line');
  body.appendChild(deepThinkBadge());
  body.appendChild(el('span', 'thinking-label', '正在深度思考...'));
  const typing = el('div', 'typing');
  typing.append(el('span'), el('span'), el('span'));
  body.appendChild(typing);
  row.appendChild(body);
  $stream.appendChild(row);
  scrollToBottom();
  return row;
}

// 「深度思考」徽标：黑色圆圈旋转弧线
function deepThinkBadge() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'think-badge');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '9');
  circle.setAttribute('stroke', 'var(--fg)');
  circle.setAttribute('stroke-width', '2.6');
  circle.setAttribute('stroke-linecap', 'round');
  circle.setAttribute('stroke-dasharray', '42 18');
  svg.appendChild(circle);
  return svg;
}

/* ---------------------------------------------------------------- 深度思考面板
   与正文同一行内呈现：头部（徽标 + 「已思考（用时 N 秒）」+ 箭头）→ 可折叠的思考内容 → 分割线 → 正文。
   折叠时箭头向右 ›，展开时向下 ∨；思考内容输出完自动折叠，点击头部可重新展开回看。 */

// 已完成态的静止徽标（四角星）
function sparkBadge() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'think-spark');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function chevronIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'chev');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 9l6 6 6-6');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

// 秒数文案：8 秒显示「8」，8.5 秒显示「8.5」
function thinkSecondsText(ms) {
  const s = Math.round(Number(ms) / 100) / 10;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

// 思考面板骨架（供静态渲染与流式渲染共用）
function buildThinkPanel(thinkingText, opts) {
  const think = el('div', 'think' + (opts && opts.open ? ' open' : ''));
  const head = el('button', 'think-head');
  head.type = 'button';
  const label = el('span', 'think-label', '');
  const body = el('div', 'think-body');
  const inner = el('div', 'think-inner');
  body.appendChild(inner);
  think.append(head, body);
  head.addEventListener('click', () => think.classList.toggle('open'));
  return { think, head, label, inner, body };
}

// 静态：已完成、默认折叠（用于恢复会话 / 非动画渲染）
function appendThinkPanelStatic(thinkingText, thinkMs) {
  const panel = buildThinkPanel(thinkingText);
  panel.head.append(sparkBadge(), panel.label, chevronIcon());
  panel.label.textContent = `已思考（用时 ${thinkSecondsText(thinkMs)} 秒）`;
  panel.inner.textContent = thinkingText;
  return panel.think;
}

// 流式：思考内容逐字输出 → 秒数计时 → 到点自动折叠；返回正文容器供调用方接着输出
async function appendThinkingPanelAnimated(thinkingText, totalMs) {
  const row = el('div', 'msg ai');
  row.appendChild(aiAvatar());
  const body = el('div', 'ai-body');
  const panel = buildThinkPanel(thinkingText, { open: true });
  const badge = deepThinkBadge();
  panel.head.append(badge, panel.label, chevronIcon());
  panel.label.textContent = '正在思考（0 秒）';
  const divider = el('div', 'think-divider');
  const answer = el('div', 'ai-text');
  body.append(panel.think, divider, answer);
  row.appendChild(body);
  $stream.appendChild(row);
  scrollToBottom();

  // 思考稿按目标时长**铺满**（不再「先铺 88%、再干等剩下的一截」）：
  // typewrite 的 pace 模式每步按「剩余毫秒 ÷ 剩余字数」决定延迟 —— 字数多就走得快、少就走得慢，
  // 到点正好写完。于是「AI 思考时长」这个参数改的其实是**弹出速度**（20 秒 / 15 秒 / 30 秒都只改它）。
  // 剩余时长按**当前倍速**实时消耗：切倍速时正在思考的这条也立刻跟着快/慢。
  let remainMs = Number(totalMs) || 0;
  let lastAt = performance.now();
  const drain = () => {
    const now = performance.now();
    remainMs -= (now - lastAt) * speedScale();
    lastAt = now;
    return Math.max(0, remainMs);
  };
  const tick = window.setInterval(() => {
    const left = drain();
    const shown = Math.max(0, Math.min(Math.floor(totalMs / 1000), Math.floor((totalMs - left) / 1000)));
    panel.label.textContent = `正在思考（${shown} 秒）`;
  }, 200);

  await typewrite(panel.inner, thinkingText, TYPE_MS_DEFAULT, 0, true, { remaining: drain });
  drain();
  window.clearInterval(tick);

  badge.replaceWith(sparkBadge());
  panel.label.textContent = `已思考（用时 ${thinkSecondsText(Number(totalMs))} 秒）`;
  panel.think.classList.remove('open');           // 输出完自动折叠
  // 思考结束 → 正文开始之间给一行明示（被试不用去猜「怎么还不出字」）
  body.insertBefore(el('div', 'think-done', '思考已完成'), answer);
  await sleep(240);
  return answer;
}

/* ---------------------------------------------------------------- 切屏 / 离开提醒（需求 8）
   移动端无法阻止用户切到其他应用，浏览器也没有这个权限。能做的只有两件：
   检测「页面被切到后台」（visibilitychange），并在回到页面时提醒。
   切走的那一瞬间页面已停止渲染，弹不出任何东西——所以提醒只可能出现在回来时。
   不叠加 beforeunload：那会在关闭标签页时多弹一次确认框，与「填完即释放设备」的流程打架。 */
let hiddenAt = 0;
// 切屏提醒：居中的遮罩弹窗（贴底浮层在手机上会被浏览器底栏 / 键盘盖住，只露一半）
function showLeaveNotice(awayMs) {
  const seconds = Math.max(1, Math.round(awayMs / 1000));
  $leaveText.textContent = `检测到你刚刚离开了约 ${seconds} 秒。实验过程中离开界面可能影响数据有效性，请保持在实验页面完成作答。`;
  if (!$leaveMask.classList.contains('hidden')) return;          // 已经弹着：只更新秒数
  $leaveMask.classList.remove('hidden');
  requestAnimationFrame(() => $leaveMask.classList.add('visible'));
}
function hideLeaveNotice() {
  $leaveMask.classList.remove('visible');
  window.setTimeout(() => $leaveMask.classList.add('hidden'), 200);
}
$leaveOk.addEventListener('click', hideLeaveNotice);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (!hiddenAt) return;
  const away = Date.now() - hiddenAt;
  hiddenAt = 0;
  if (state.completed || away < 1500) return;      // 短暂切换（系统弹窗、来电横幅）不打扰
  showLeaveNotice(away);
});

// 清空聊天流（呈现前清空）：屏内内容整体清掉。
// 清屏点同时记在服务端，刷新也不会让旧内容回来；清屏点之前的实际作答数据仍完整保留在管理端。
function clearStream() {
  $stream.replaceChildren();
  clearSeen();
  state.showAnswered = true;
  state.questionNodes.clear();
  state.redoing = null;                            // 屏都清了：不可能还有「未提交」的卡片
  notifyRedoSettled();                             // 保险：若有挂起的断言流程一并放行（世代号守卫会拦住旧续集）
  composerTarget = null;
  $composerInput.value = '';
  clearComposerError();
  refreshAnsweredBtn();
  scrollToBottom(false);
}

// 有未提交的重做时才拦浏览器刷新 / 关闭（平时不打扰「填完即释放设备」的流程）：
// 原生弹窗只能让被试选择留下或离开——留下就能先在卡片上提交/取消，然后再刷新。
window.addEventListener('beforeunload', (e) => {
  if (!state.redoing) return;
  e.preventDefault();
  e.returnValue = '';
});

// 打字机与思考节奏由服务端按消息下发（think_ms / type_ms；题目可覆盖，否则用内置默认）
// 标点在基础速度上额外停顿，读起来更像真实输入
const PUNCT_PAUSE = '，。；：！？、,.!?;:';
const PUNCT_EXTRA = 90;          // 标点额外停顿（毫秒）
const THINK_MS_DEFAULT = 420;    // 未配置时的思考时长
const TYPE_MS_DEFAULT = 30;      // 未配置时的流式速度（毫秒/字，正常 LLM 语速）
const TYPE_MS_MIN = 26;          // 旧问卷里存了过快速度时的下限钳制（0 = 立即整段显示）

// 预览倍速的当前值（真实会话恒为 1）
function speedScale() { return previewSpeed > 1 ? previewSpeed : 1; }
// 按「当前倍速」消耗指定毫秒数：中途切速会跟着变（用于「正在深度思考…」转圈提示）。
// 配了思考稿的消息不用它 —— 那一段由思考面板按「剩余毫秒 ÷ 剩余字数」调速铺满，没有干等。
async function sleepPaced(totalMs) {
  let remain = Number(totalMs) || 0;
  let last = performance.now();
  while (remain > 0) {
    await sleep(60);
    const now = performance.now();
    remain -= (now - last) * speedScale();
    last = now;
  }
}

// 流式输出（HTML 版）：先把完整的正文骨架挂上，再按文本节点逐字填充——
// 这样加粗 / 标题 / 颜色在流式过程中就是正确的，光标始终紧跟最后一个已输出的字。
// **未输出的部分不占高度**：骨架里还没轮到的换行（<br>）与块级容器先隐藏，写到那一行 / 那一段时才显形。
//   否则消息从第一帧起就占满最终高度（整片空白行），跟随底部的滚动会把视口顶到空白底部——
//   表现就是「刷屏变白、往下刷很多空格，内容从上方流下来」。写完时全部显形，终态与刷新后的静态渲染一致。
// minMs：速度下限（默认 TYPE_MS_MIN，防止旧问卷存了过快速度）；思考面板按目标时长铺满时传 0
// pace：{ remaining } —— 限期铺满（思考面板用，见 appendThinkingPanelAnimated）。
//   每步延迟 = 剩余毫秒 ÷ 剩余字数：字数多就走得快、字数少走得慢，正好在目标时长处写完；
//   改「AI 思考时长」即改弹出速度，中间不再有「先铺一段、再干等剩下的一截」。
// 倍速在**每一帧**重新读（typeMs 一律传「原始设定值」）——中途切倍速时，正在输出的这条也立刻跟着变快/变慢。
function typewrite(textEl, content, typeMs, minMs, plain, pace) {
  const paced = !!(pace && typeof pace.remaining === 'function');
  if (plain) textEl.textContent = String(content == null ? '' : content);   // 思考面板是纯文本（保留 pre-wrap 观感）
  else textEl.innerHTML = contentHtml(content);
  const raw = Number.isFinite(Number(typeMs)) ? Number(typeMs) : TYPE_MS_DEFAULT;
  const floor = minMs == null ? TYPE_MS_MIN : Number(minMs);
  if (raw <= 0 && !paced) { scrollToBottom(false); return Promise.resolve(); }
  // 浏览器对嵌套定时器有 ~4ms 的下限：只压缩「每字延迟」在快档会触底，
  // 所以按倍速把「每次吐的字数」一并放大，保证总时长真的按倍速缩短（1× 时仍是 1~2 字/步）。
  const RATE = 1.5 / TYPE_MS_DEFAULT;      // 1× 时的吐字速率（字 / 毫秒）
  const stepMs = () => Math.max(raw / speedScale(), floor / speedScale());   // 每帧按当前倍速算
  const chunkFor = (delayMs) => Math.max(1 + Math.floor(Math.random() * 2), Math.round(RATE * speedScale() * Math.max(delayMs, 4)));

  // 可显示单元（按文档顺序）：文本节点（有字数）+ 换行 / 块级容器（零字数，但占一行或一段的高度）
  const BLOCK_TAGS = { P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, LI: 1, BLOCKQUOTE: 1, UL: 1, OL: 1 };
  const nodes = [];
  const tails = [];            // { el, at }：at = 这个换行 / 容器之前已有多少字
  let chars = 0;
  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if (node.tagName === 'BR' || BLOCK_TAGS[node.tagName]) {
        node.style.display = 'none';
        tails.push({ el: node, at: chars });
      }
      continue;
    }
    const full = node.nodeValue;
    if (!full) continue;
    node.nodeValue = '';
    nodes.push({ node, full, start: chars });
    chars += full.length;
  }
  const totalChars = chars;
  const revealAll = () => { for (const t of tails) t.el.style.display = ''; };
  // 「写到了没有」：某一行 / 某一段的第一个字吐出来时，它前面的换行与容器才显形
  let ti = 0;
  const revealTail = (printed) => {
    while (ti < tails.length && tails[ti].at < printed) { tails[ti].el.style.display = ''; ti += 1; }
  };
  if (!nodes.length) { revealAll(); scrollToBottom(false); return Promise.resolve(); }

  const cursor = el('span', 'type-cursor');
  let ni = 0;                 // 当前文本节点
  let ci = 0;                 // 当前节点已输出的字数
  let steps = 0;
  let paceLeft = paced ? Math.max(0, Number(pace.remaining()) || 0) : 0;
  const charsLeft = () => Math.max(1, totalChars - nodes[ni].start - ci);
  return new Promise((resolve) => {
    const step = () => {
      if (ni >= nodes.length) { revealAll(); cursor.remove(); scrollToBottom(false); resolve(); return; }
      const cur = nodes[ni];
      // 每步都重新读一次剩余时间：与 typeMs 路径一样逐帧跟着倍速走（中途切速立刻生效）
      if (paced) paceLeft = Math.max(0, Number(pace.remaining()) || 0);
      const delay = paced ? Math.max(4, paceLeft / charsLeft()) : stepMs();
      // pace 模式同样受 4ms 定时器下限约束：剩余时间不够「一字一步」时，一次多吐几个字
      ci += paced
        ? Math.max(1, Math.ceil(charsLeft() / Math.max(1, Math.floor(paceLeft / 4))))
        : chunkFor(delay);
      if (ci > cur.full.length) ci = cur.full.length;
      cur.node.nodeValue = cur.full.slice(0, ci);
      const parent = cur.node.parentNode;
      if (parent) parent.insertBefore(cursor, cur.node.nextSibling);
      revealTail(cur.start + ci);
      steps += 1;
      if (steps % 4 === 0) scheduleScrollToBottom();
      const prev = cur.full[ci - 1] || '';
      const done = ci >= cur.full.length;
      if (done) { ni += 1; ci = 0; }
      // 标点额外停顿 / 随机抖动只在按 typeMs 走的时候加；限期铺满时按剩余时间严格控制，不加额外停顿
      let wait = delay;
      if (!paced) {
        wait += PUNCT_PAUSE.includes(prev) ? PUNCT_EXTRA / speedScale() : Math.random() * (14 / speedScale());
      }
      window.setTimeout(step, wait);
    };
    step();
  });
}

// 先「正在思考」（thinkMs = 0 则跳过），再流式输出（typeMs = 0 则立即整段显示）
// 倍速一律传「原始设定值」给下游：typewrite / 思考面板会**逐帧**按当前倍速折算，
// 所以中途切倍速时，这一条正在输出的消息也立刻跟着变快（而不是等下一条）。
async function appendAiMessageAnimated(content, rhythm, thinkingText) {
  const thinkMs0 = rhythm && Number.isFinite(Number(rhythm.thinkMs)) ? Number(rhythm.thinkMs) : THINK_MS_DEFAULT;
  const typeMs0 = rhythm && Number.isFinite(Number(rhythm.typeMs)) ? Number(rhythm.typeMs) : TYPE_MS_DEFAULT;
  const thinking = String(thinkingText || '').trim();

  // 配了思考内容：走「深度思考面板」（流式 → 计时 → 自动折叠），正文接在同一行内
  if (thinking && thinkMs0 > 0) {
    const answer = await appendThinkingPanelAnimated(thinking, thinkMs0);
    await typewrite(answer, content, typeMs0);
    scrollToBottom(false);          // 瞬时：与流式期间的跟随滚动同一节奏，不平滑动画抢位置
    return;
  }
  if (thinkMs0 > 0) {
    const thinkingRow = appendThinkingRow();
    await sleepPaced(thinkMs0);
    thinkingRow.remove();
  }
  const row = appendAiMessageStatic('');
  await typewrite(row.querySelector('.ai-text'), content, typeMs0);
  scrollToBottom(false);
  return row;
}


/* ---------------------------------------------------------------- 全屏页面（知情同意 / 结束说明） */

let pageHandler = null;
let pageHideTimer = null;

// 进入按钮的启用条件：可见的必填项都满足（勾选同意、编号非空），且倒计时已到
let pageReadyAt = 0;
function refreshPageBtn() {
  const needCheck = !$pageCheckWrap.classList.contains('hidden');
  const needId = !$pageIdWrap.classList.contains('hidden');
  const waiting = pageReadyAt > serverNow();
  $pageBtn.disabled = waiting
    || (needCheck && !$pageCheck.checked)
    || (needId && $pageIdInput.value.trim() === '');
}

// hideButton：终态页面（结束说明）不放按钮，只提示可以关闭
// idField：知情同意页的「含编号」形态，{ label, placeholder }；不传则不显示编号输入框
// countdownUntilMs：阅读确认页的「N 秒后可继续」——到点前按钮置灰并显示倒计时
// html：整页正文（富文本）。首行若是标题（h1/h2），拆出来当页面大标题；标题与正文都来自同一份可编辑正文。
let pageCountdownTimer = null;
function showPage({ title, html, text, check, button, hideButton, idField, countdownUntilMs }) {
  clearTimeout(pageHideTimer);
  clearInterval(pageCountdownTimer);
  const rich = contentHtml(html || text || '');
  const split = splitLeadingHeading(rich);
  $pageTitle.innerHTML = split.titleHtml ? RichText.sanitizeHtml(split.titleHtml) : RichText.escapeText(title || '');
  $pageTitle.classList.toggle('hidden', !$pageTitle.innerHTML);
  $pageText.innerHTML = split.body || (split.titleHtml ? '' : rich);
  $pageBtn.classList.toggle('hidden', !!hideButton);
  if (check) {
    $pageCheckWrap.classList.remove('hidden');
    $pageCheckLabel.textContent = check;
    $pageCheck.checked = false;
  } else {
    $pageCheckWrap.classList.add('hidden');
    $pageCheck.checked = false;
  }
  if (idField) {
    $pageIdWrap.classList.remove('hidden');
    $pageIdLabel.textContent = idField.label || '被试编号';
    $pageIdInput.placeholder = idField.placeholder || '';
    $pageIdInput.value = '';
  } else {
    $pageIdWrap.classList.add('hidden');
    $pageIdInput.value = '';
  }
  const label = button || '继续';
  $pageBtn.textContent = label;
  pageReadyAt = countdownUntilMs || 0;
  if (countdownUntilMs && countdownUntilMs > serverNow()) {
    const tick = () => {
      const left = Math.ceil((countdownUntilMs - serverNow()) / 1000);
      if (left <= 0) {
        clearInterval(pageCountdownTimer);
        pageCountdownTimer = null;
        $pageBtn.textContent = label;
        refreshPageBtn();
        return;
      }
      $pageBtn.textContent = `${left} 秒后可继续`;
    };
    tick();
    pageCountdownTimer = window.setInterval(tick, 250);
  }
  $pageHint.classList.add('hidden');
  refreshPageBtn();
  // 这块全屏容器在「知情同意页 / 致谢页」之间复用：必须每次回到最上方。
  // 浏览器会保留 display:none 元素的滚动偏移——知情同意页被滚过的位置（手机上填编号必然滚）
  // 会被沿用到致谢页，被 maxScroll 一夹就正好停在最下方（致谢页只看得见最后几行）。
  $pageScreen.classList.remove('hidden');
  $pageScreen.scrollTop = 0;
  requestAnimationFrame(() => {
    $pageScreen.scrollTop = 0;            // display:none → block 的首次布局在下一帧才算稳，这里再压一次
    $pageScreen.classList.add('visible');
  });
}

function hidePage() {
  clearInterval(pageCountdownTimer);
  pageCountdownTimer = null;
  $pageScreen.classList.remove('visible');
  clearTimeout(pageHideTimer);
  pageHideTimer = setTimeout(() => $pageScreen.classList.add('hidden'), 260);
}

$pageCheck.addEventListener('change', refreshPageBtn);
$pageIdInput.addEventListener('input', refreshPageBtn);
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
  if (sub.maxLen > 0) input.maxLength = Number(sub.maxLen); // 硬上限：超过后无法继续输入
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
      if (count) {
        count.textContent = `${input.value.length}/${sub.maxLen}`;
        count.classList.toggle('near', input.value.length >= Math.max(1, Number(sub.maxLen) - 20));
      }
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

/* ---------------------------------------------------------------- 底部常驻输入框
   与题卡并存：文本类作答在这里输入并「发送」；其余题型输入框仍在，但发不出去（只能做题）。
   两种题进输入框：① 单道文本题；② 两道文本子题的题组（如「广告语 + 创作说明」，
   第一行 = 第一项，其余行 = 第二项）——这正是本轮实验的创作题形态。 */
let composerTarget = null;
let composerMode = null;      // null = 不可用；'two' = 文本题 / 两段文本题组（消息式题面，在输入框作答）

// 「两段文本」的切分：第一行 = 第一项，其余行（合并）= 第二项
function splitComposerTwo(raw) {
  const lines = String(raw || '').split('\n');
  const head = lines.findIndex((l) => l.trim());
  if (head < 0) return ['', ''];
  return [lines[head].trim(), lines.slice(head + 1).join('\n').trim()];
}

function growComposer() {
  $composerInput.style.height = 'auto';
  $composerInput.style.height = `${Math.min(168, Math.max(42, $composerInput.scrollHeight))}px`;
}

// 「需输入指定内容」的文本题（二级形态）：被试还是在这条常驻输入框里作答，但点「发送」时
// 服务端会先做断言——内容为空或与题目要求不一致时，这一笔既不落库也不进聊天流，
// 只在输入框上方给出研究者自定义的提示（默认「答案错误」），输入内容原样保留让被试改。
const needsAnswerCheck = (action) => !!(action && action.type === 'text' && action.variant === 'match');

// 断言提示（挂在输入框上方）：改输入 / 换题 / 提交成功都会清掉
function setComposerError(text) {
  const msg = String(text || '').trim();
  $composerError.textContent = msg;
  $composerError.classList.toggle('hidden', !msg);
  if (!msg) return;
  const inner = $composer.querySelector('.composer-inner');
  if (inner) {
    inner.classList.remove('shake');       // 重放一次抖动：先摘掉类、强制重排，再加回来
    void inner.offsetWidth;
    inner.classList.add('shake');
  }
  $composerInput.focus();                  // 手机端顺手把键盘唤起来，方便直接改
}
function clearComposerError() { setComposerError(''); }

function refreshComposer() {
  const action = state.action;
  const node = action ? state.questionNodes.get(action.itemId) : null;
  // 已停止作答的题（node.closed）：输入框也停用——本题已结束，只能点顶部「重做」
  const usable = !!(action && composerMode && node && !state.completed && !node.closed);
  $composer.classList.toggle('usable', usable);
  $composerInput.disabled = !usable;
  if (!usable) $composerInput.value = '';
  if (usable) {
    $composerInput.placeholder = action.placeholder || '输入你的回答…';
    // 「需输入指定内容」的题：空内容也让点「发送」——断言由服务端做，点了才会得到提示
    const canSend = needsAnswerCheck(action) ? true : node.ready();
    $composerSend.disabled = state.busy || !canSend || !node.gateOk();
    $composerHint.textContent = needsAnswerCheck(action)
      ? '按「发送」提交你的回答；内容与题目要求不一致时不会发送，并在上方提示。'
      : '按「发送」提交你的回答；提交后不可修改。';
  } else {
    // 输入框常驻：任何时候都在原位；当前步骤用不上时不置灰、也不给长提示
    $composerSend.disabled = true;
    if (node && node.closed) {
      $composerInput.placeholder = '本题已停止作答';
      $composerHint.textContent = STOPPED_HINT;
    } else if (action && isMessageStyleAction(action) && !state.questionNodes.has(action.itemId)) {
      // 消息式题面：本题**已经交上去了**（答案已作为用户气泡进流、题卡也打上「✓ 已提交」）。
      // 输入框这时必须是空的且停用——内容留在框里会被当成「没发出去」；
      // 等系统把回应播完、下一题渲染出来，输入框再自动指向下一题。
      $composerInput.placeholder = state.completed ? '本次作答已完成' : '已提交，正在等待系统回应…';
      $composerHint.textContent = '';
    } else if (action && ['gate', 'confirm', 'debrief'].includes(action.type)) {
      $composerInput.placeholder = '请先在页面上完成当前步骤';
      $composerHint.textContent = '';
    } else if (action) {
      $composerInput.placeholder = '本题请在题卡中作答';
      $composerHint.textContent = '';
    } else {
      $composerInput.placeholder = '输入你的回答…';
      $composerHint.textContent = '';
    }
  }
}

// 发送成功（内容已交出去）后立刻把输入框清空、停用。
// 两种题两种时机：普通文本题点「发送」即算发出（立刻清）；「需输入指定内容」的题要等服务端点头
// （断言没过 = 没发出去，输入内容必须原样留给被试改）。提交点在 submit() 的 settle() 里。
function resetComposer() {
  composerTarget = null;
  composerMode = null;
  $composerInput.value = '';
  clearComposerError();
  growComposer();
  refreshComposer();
}

$composerInput.addEventListener('input', () => {
  if (!composerTarget) return;
  state.draft[composerTarget] = { 0: $composerInput.value };
  saveDraft(composerTarget, state.draft[composerTarget]);
  clearComposerError();                     // 一开始改输入，上一次的断言提示就撤掉
  growComposer();
  refreshComposer();
});
$composerSend.addEventListener('click', () => {
  const action = state.action;
  const node = action ? state.questionNodes.get(action.itemId) : null;
  if (!action || !node || !composerMode) return;
  if (state.busy || !node.ready() || !node.gateOk()) return;
  submit(action, node.collect());
});

/* ---------------------------------------------------------------- 会话活跃 / 退出重进 / 超时锁定
   · 心跳：页面开着的时候每分钟告诉服务端一声，免得慢慢读题被当成「太久没提交」而自动作废；
   · 退出重进：检测到未完成的会话时先给一张卡片（继续作答 / 重新开始），不再静默续做；
   · 时间已到（最长作答时间到）：直接停止作答并销毁本题的作答能力，提示可以点顶部「重做」。 */
let heartbeatTimer = null;
function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = window.setInterval(() => {
    if (!state.sessionId || state.completed) return;
    if (IS_PREVIEW) return;                     // 预览是内存会话，不需要心跳
    api('/api/heartbeat', { method: 'POST', body: { sessionId: state.sessionId } }).catch(() => { /* 忽略：断网不影响作答 */ });
  }, 60 * 1000);
}

// 退出重进的确认卡片：返回 'continue' | 'restart'（跳题打断时返回 'cancel'，见 cancelResumeCard）
let resumeResolve = null;
// 跳题会把整条聊天流换掉，重进卡片随之消失：此时必须把这次「继续作答？」作废，
// 否则 init 里的 await 永远不会返回，恢复流程会挂在半路。
function cancelResumeCard() {
  const done = resumeResolve;
  if (done) done('cancel');
}
function renderResumeCard(boot) {
  // 口径 = 题号（与卡面「第 N 题」一致）：知情同意 / 确认页 / 结束说明不占题号
  const current = Number(boot.currentQno) || 0;
  const total = Number(boot.totalQuestions) || 0;
  const card = el('div', 'resume-card');
  card.appendChild(el('div', 'resume-title', '检测到未完成的作答'));
  card.appendChild(el('div', 'resume-text',
    `上次进行到第 ${current} / ${total} 题。继续作答会接着上次的进度往下走；` +
    '重新开始会作废本次记录，从知情同意页重新填写。'));
  const actions = el('div', 'resume-actions');
  const goOn = el('button', 'primary-btn', '继续作答');
  goOn.type = 'button';
  const restart = el('button', 'ghost-btn', '重新开始');
  restart.type = 'button';
  actions.append(goOn, restart);
  card.appendChild(actions);
  $stream.appendChild(card);
  scrollToBottom(false);
  return new Promise((resolve) => {
    const done = (value) => { resumeResolve = null; resolve(value); };
    resumeResolve = done;
    goOn.onclick = () => { card.remove(); done('continue'); };
    restart.onclick = () => { restart.disabled = true; goOn.disabled = true; card.remove(); done('restart'); };
  });
}

// 作废当前会话并从头开始（重做 / 重进卡片里的「重新开始」共用）
async function abandonAndRestart() {
  beginFreshStream();                              // 整屏重来：上一步没播完的续集立即收手
  try {
    if (state.sessionId) {
      await api(finishUrl(), { method: 'POST', body: stepBody({ sessionId: state.sessionId, abandon: true }) });
    }
  } catch { /* 作废失败也继续重开：旧会话已留档 */ }
  hidePage();                                      // 终态页 / 知情同意页这类整页覆盖层：重开时一并撤掉
  clearStoredSession();
  clearSeen();
  clearCompletedFinal();                           // 上一份的终态记录作废（否则之后再刷新会把它翻出来）
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(`${DRAFT_PREFIX}${storageScope}_`))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* 忽略 */ }
  $stream.replaceChildren();
  state.sessionId = null;
  state.questionNodes.clear();
  state.redoing = null;                            // 整份重开：撤销任何未提交的卡片修改
  notifyRedoSettled();                             // 同上：放行可能挂起的断言流程（世代号守卫兜底）
  state.draft = {};
  state.answeredCount = 0;
  state.completed = false;
  state.showAnswered = true;
  refreshAnsweredBtn();
  await startSession();
}

// 「重做」入口（顶栏按钮 / 终态页按钮共用）：确认后作废当前会话，从知情同意页重新开始。
// fromFinal = 从终态页点的：此时本次作答已经完成落库，重做只是再开一份新记录，旧记录不会被动（作废只作用于进行中的会话）。
function requestRedo(fromFinal) {
  openConfirm({
    title: '重做本问卷',
    text: fromFinal
      ? '将从头开始一份新的作答（从知情同意页重新填写）；刚才那份已完成的记录会原样保留在数据页与导出里。确定重做吗？'
      : '本次作答会被标记为「作废」并从头开始（记录仍留档，但默认不出现在数据页与导出里）。确定要重做吗？',
    okLabel: '重做',
    onOk: async () => {
      $btnRedo.disabled = true;
      try { await abandonAndRestart(); } finally { $btnRedo.disabled = false; }
    }
  });
}

// 时间已到：直接停止作答，然后提示可以点顶部的「重做」。
// 停止即销毁本题的作答能力——控件与提交入口全部停用并撤掉、草稿清掉、节点标记 closed（倒计时循环不再碰它）；
// 不再自动提交、也不再给「重试」开新窗口：本题到此为止，要继续只能重做整份问卷。
function stopQuestionByDeadline(action) {
  const node = state.questionNodes.get(action.itemId);
  if (!node || node.closed) return;
  node.closed = true;                              // 销毁标记：refresh / 倒计时循环都据此停手
  node.card.classList.remove('pending', 'locked');
  node.card.classList.add('window-closed', 'stopped');
  node.card.querySelectorAll('input, textarea, button').forEach((n) => { n.disabled = true; });
  if (node.submitBtn) { node.submitBtn.disabled = true; node.submitBtn.remove(); }
  setTimer(node, '已停止作答', false);
  if (node.messageStyle) {
    // 消息式题面：状态写在气泡下方那行小字里（卡片内的 hint 没挂进 DOM），输入框一并停用
    if (node.meta && !node.meta.querySelector('.qstopped-hint')) node.meta.appendChild(el('span', 'qstopped-hint', STOPPED_HINT));
    $composerInput.disabled = true;
    $composerInput.value = '';
    $composerSend.disabled = true;
    $composerHint.textContent = STOPPED_HINT;
    clearComposerError();                            // 已停止作答：断言提示换成上面这条统一的停答说明
  } else if (node.hint) {
    node.hint.textContent = STOPPED_HINT;
  }
  clearDraft(action.itemId);                       // 未提交的草稿一并销毁
  delete state.draft[action.itemId];
}

/* ---------------------------------------------------------------- 回放：刷新 / 退出重进
   服务端下发的 replay 就是「聊天流应该长什么样」：消息 / 被试气泡 / 已作答卡片，按顺序重建。
   「已看完多少条消息」记在本机：重进时之前的内容秒显，没看完的那部分继续逐字补播（不重播、也不快进）。 */
const SEEN_PREFIX = 'expchat_seen_';
function loadSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_PREFIX + storageScope) || 'null');
    return raw && raw.sid === state.sessionId ? Math.max(0, Number(raw.count) || 0) : 0;
  } catch { return 0; }
}
function storeSeen(count) {
  state.seenMsgs = count;
  if (!state.sessionId) return;
  try { localStorage.setItem(SEEN_PREFIX + storageScope, JSON.stringify({ sid: state.sessionId, count })); } catch { /* 忽略 */ }
}
function clearSeen() {
  state.seenMsgs = 0;
  try { localStorage.removeItem(SEEN_PREFIX + storageScope); } catch { /* 忽略 */ }
}

// 消息式题面：文本题、以及「两个文本子题」的题组（如广告语 + 创作说明）——像 AI 消息那样提问，
// 被试在底部常驻输入框作答；其余题型仍是题卡。
function isMessageStyleAction(action) {
  if (!action) return false;
  if (action.type === 'text') return true;
  const subs = action.subs || [];
  return action.type === 'group' && subs.length === 2 && subs.every((sub) => sub.type === 'text');
}

// 已作答卡片（回放重建用）：题干 + 作答回显。活着的卡片会保留原控件，重进后只还原这一层信息。
function renderDoneCard(item, echo) {
  const root = el('div', 'qcard done');
  root.dataset.itemId = item.itemId;
  const head = el('div', 'qcard-head');
  if (item.qno) head.appendChild(el('span', 'qnum', `第 ${item.qno} 题`));
  const qtitle = el('div', 'qtitle rich');
  qtitle.innerHTML = contentHtml(item.html || item.title || '');
  head.appendChild(qtitle);
  head.appendChild(el('span', 'qdone-mark', '✓ 已提交'));
  const toggle = el('button', 'mini-btn qcard-toggle', '隐藏');
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    const hidden = root.classList.toggle('answered-hidden');
    toggle.textContent = hidden ? '显示' : '隐藏';
  });
  head.appendChild(toggle);
  root.appendChild(head);
  const body = el('div', 'qcard-body');
  const echoNode = el('div', 'qcard-echo rich');
  echoNode.innerHTML = contentHtml(echo || '（未填写）');
  body.appendChild(echoNode);
  root.appendChild(body);
  $stream.appendChild(root);
  return root;
}

// 按 replay 重建聊天流：seenMsgs 之前的消息秒显，之后（没看完的）继续逐字补播。
// 逐条对世代号：重建途中若被跳题 / 重开会话打断，立刻停手，剩下的交给新的那次渲染。
async function renderReplay(replay, seenMsgs) {
  const epoch = streamEpoch;
  let msgIndex = 0;
  for (const entry of replay || []) {
    if (epoch !== streamEpoch) return msgIndex;
    if (entry.kind === 'message') {
      if (msgIndex < seenMsgs) {
        appendAiMessageStatic(entry.content, entry.thinking, entry.thinkMs);
      } else {
        await appendAiMessageAnimated(entry.content, { thinkMs: entry.thinkMs, typeMs: entry.typeMs }, entry.thinking);
        storeSeen(msgIndex + 1);
      }
      msgIndex += 1;
    } else if (entry.kind === 'user') {
      appendUserMessage(entry.content, entry.itemId);
    } else if (entry.kind === 'card') {
      renderDoneCard(entry.item, entry.echo);
    }
  }
  storeSeen(msgIndex);
  return msgIndex;
}

// 当前待作答题目：消息式题面 or 题卡
function renderQuestion(action) {
  state.questionNodes.clear();
  state.deadlineFired = false;
  return isMessageStyleAction(action) ? renderQuestionMessage(action) : renderQuestionCard(action);
}

// 消息式题面：一条 AI 消息（头像 + 气泡正文）+ 气泡下方一行紧凑小字（题号 / 倒计时 / 字数），
// 作答在底部常驻输入框里完成；提交后这条回答以「用户气泡」出现在流里。
function renderQuestionMessage(action) {
  const root = el('div', 'qmsg pending');
  root.dataset.itemId = action.itemId;
  const row = el('div', 'msg ai');
  row.appendChild(aiAvatar());
  const bodyEl = el('div', 'ai-body');
  const text = el('div', 'ai-text rich');
  text.innerHTML = contentHtml(action.html || action.title || '');
  bodyEl.appendChild(text);

  const meta = el('div', 'qmsg-meta');
  if (action.qno) meta.appendChild(el('span', 'qnum', `第 ${action.qno} 题`));
  const timer = el('span', 'qcard-timer hidden');
  meta.appendChild(timer);
  const notes = [];
  if (action.maxLen) notes.push(`上限 ${action.maxLen} 字`);
  if (action.required === false) notes.push('选填');
  if (notes.length) meta.appendChild(el('span', 'qmsg-note', notes.join(' · ')));
  bodyEl.appendChild(meta);
  row.appendChild(bodyEl);
  root.appendChild(row);
  $stream.appendChild(root);

  const draft = loadDraft(action.itemId);
  composerTarget = action.itemId;
  composerMode = 'two';
  clearComposerError();                     // 进入新的一题：上一题的断言提示不跟过来
  $composerInput.value = draft[0] != null ? draft[0] : '';
  growComposer();

  const twoText = action.type === 'group';
  // 「需输入指定内容」的题：空内容也算「可发送」——对不对由服务端断言说了算（见 submit）
  const assertAnswer = needsAnswerCheck(action);
  const collect = () => {
    if (twoText) {
      const [a, b] = splitComposerTwo($composerInput.value);
      return { answers: [{ text: a }, { text: b }] };
    }
    return { text: $composerInput.value.trim() };
  };
  const ready = () => (assertAnswer
    ? true
    : (twoText ? splitComposerTwo($composerInput.value)[0].length > 0 : $composerInput.value.trim().length > 0));
  const gateOk = () => {
    const now = serverNow();
    if (action.availableAtMs && now < action.availableAtMs) return false;
    if (action.minSubmitAtMs && now < action.minSubmitAtMs) return false;
    return true;
  };
  const hint = el('span', 'qfoot-hint hidden');
  const node = {
    card: root, messageStyle: true, meta, hint, timer,
    submitBtn: null, action,
    controls: [{ node: bodyEl, getPayload: collect, isReady: ready, focus: () => $composerInput.focus() }],
    ready, refresh: () => refreshComposer(), collect, gateOk
  };
  state.questionNodes.set(action.itemId, node);
  refreshComposer();
  return node;
}

// 阅读确认页（内联）：内容作为聊天流里的一块正常呈现，下方给确认按钮 + 倒计时
function renderConfirmInline(action) {
  const card = el('div', 'qcard pending confirm-inline');
  card.dataset.itemId = action.itemId;
  const head = el('div', 'qcard-head');
  if (action.qno) head.appendChild(el('span', 'qnum', `第 ${action.qno} 题`));
  const timer = el('span', 'qcard-timer hidden');
  head.appendChild(timer);
  card.appendChild(head);

  const body = el('div', 'qcard-body');
  const rich = el('div', 'qtext rich');
  rich.innerHTML = contentHtml(action.html || action.title || '');
  body.appendChild(rich);
  card.appendChild(body);

  const foot = el('div', 'qcard-foot');
  const hint = el('span', 'qfoot-hint');
  const btn = el('button', 'primary-btn', action.button || '我已阅读完');
  btn.type = 'button';
  btn.disabled = true;
  foot.append(hint, btn);
  card.appendChild(foot);
  $stream.appendChild(card);

  const gateOk = () => {
    const now = serverNow();
    return !(action.availableAtMs && now < action.availableAtMs);
  };
  const refresh = () => { btn.disabled = state.busy || !gateOk(); };
  const node = {
    card, hint, timer, submitBtn: btn, action, controls: [],
    ready: () => true, refresh, collect: () => ({ ack: true }), gateOk
  };
  state.questionNodes.set(action.itemId, node);

  btn.addEventListener('click', async () => {
    if (state.busy || !gateOk()) return;
    state.busy = true;
    refresh();
    card.classList.remove('pending');
    card.classList.add('done');
    card.querySelector('.qcard-foot')?.remove();
    card.querySelector('.qcard-timer')?.remove();
    const h = card.querySelector('.qcard-head');
    if (h) h.appendChild(el('span', 'qdone-mark', '✓ 已提交'));
    state.questionNodes.delete(action.itemId);
    state.answeredCount += 1;
    refreshAnsweredBtn();
    const gen = streamEpoch;                 // 提交时的世代：期间被跳题打断就不再把旧结果写屏
    try {
      const res = await api(stepUrl(), {
        method: 'POST',
        body: stepBody({ sessionId: state.sessionId, ack: true, elapsedMs: Math.round(performance.now() - (state.actionShownAt || performance.now())) })
      });
      await afterStep(action, '', res, gen);
    } catch (err) {
      if (gen !== streamEpoch) return;
      if (err.code === 'session_closed') { state.completed = true; showFinalPage(action); return; }
      appendAiMessageStatic('提交失败，请稍后重试。');
    } finally {
      state.busy = false;
    }
  });
  refresh();
  return node;
}

// 渲染当前待作答题目卡片（内联）
function renderQuestionCard(action) {
  state.questionNodes.clear();
  state.deadlineFired = false;

  const card = el('div', 'qcard pending');
  card.dataset.itemId = action.itemId;
  const head = el('div', 'qcard-head');
  // 题号只数「需要被试作答的题目」：知情同意页 / 确认页 / 结束说明不占题号（与服务端 qno 同一口径）
  if (action.qno) head.appendChild(el('span', 'qnum', `第 ${action.qno} 题`));
  const qtitle = el('div', 'qtitle rich');
  qtitle.innerHTML = contentHtml(action.html || action.title || '');
  head.appendChild(qtitle);
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
    refreshComposer();
  };

  if (action.type === 'group') {
    if (action.html) {
      const gt = el('div', 'qtext rich');
      gt.innerHTML = contentHtml(action.html);
      body.appendChild(gt);
    }
    // 混合子题的题组仍在卡内作答（全文本子题的题组走消息式题面）
    const wrap = el('div', 'subs' + (action.layout === 'row' ? ' row' : ''));
    (action.subs || []).forEach((sub, i) => {
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
  } else {
    composerTarget = null;
    composerMode = null;
    // 打分局 / 单选 / 多选 / 排序：点选只做选中，统一由「确认提交」提交（issue 2）
    const ctl = buildSubControl(action, draft[0] != null ? draft[0] : null, (v) => {
      state.draft[action.itemId] = { 0: v };
    }, refresh, false);
    controls.push(ctl);
    body.appendChild(ctl.node);
  }

  // 门控与提示：题卡内统一放「确认提交」按钮（消息式题面在底部输入框「发送」）
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

  const node = { card, hint, timer, submitBtn, action, controls, ready, refresh, collect, gateOk };
  state.questionNodes.set(action.itemId, node);
  refresh();
  return node;
}

// 已作答题目：保留原控件并置为只读，但默认整体隐藏（不做“折叠留题干”）；
// 顶栏「显示已答题」可临时全部显示，卡片上的按钮可单独 隐藏/显示
// 交卷统一入口：消息式题面把回答作为用户气泡追加进聊天流；卡片式题目就地只读 + 回显
function finalizeQuestion(action, answerText) {
  const node = state.questionNodes.get(action.itemId);
  if (!node) return;
  if (node.messageStyle) {
    node.card.classList.remove('pending', 'locked');
    node.card.classList.add('done');
    if (node.timer) node.timer.classList.add('hidden');
    if (node.meta && !node.meta.querySelector('.qdone-mark')) node.meta.appendChild(el('span', 'qdone-mark', '✓ 已提交'));
    if (answerText) appendUserMessage(answerText, action.itemId);
  } else {
    finalizeQuestionCard(action, answerText);
  }
  state.questionNodes.delete(action.itemId);
  refreshAnsweredBtn();
}

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
    // 输入框驱动的题（消息式题面）：卡片里本来就没有作答控件，把回显补出来；
    // 卡内作答的题（打分 / 选项 / 排序 / 题组）控件就地只读，不需要再叠一层文字回显
    if (!bodyEl.querySelector('.answer-input, .option-btn, .rating-btn, .rank-list')) {
      const echoNode = el('div', 'qcard-echo rich');
      echoNode.innerHTML = contentHtml(answerText || '（空）');
      bodyEl.appendChild(echoNode);
    }
  }
  card.querySelector('.qcard-foot')?.remove();
  card.querySelector('.qcard-timer')?.remove();      // 已提交：撤掉倒计时
  const head = card.querySelector('.qcard-head');
  if (head) head.appendChild(el('span', 'qdone-mark', '✓ 已提交'));
  // 打分题（开了「允许重做」）的已答卡片：这里的按钮是「重做」——单独改这一题的分数，不影响后面的作答；
  // 其余题型仍是「隐藏 / 显示」折叠开关（顶栏「隐藏已答题」对两类卡片都有效）。
  // 刷新 / 重进后重建的已答卡片（renderDoneCard）不带重做：清屏点之前的题本就不再呈现，设计如此。
  const redoable = action.type === 'rating' && Number(action.allowRedo) === 1;
  const toggle = el('button', 'mini-btn qcard-toggle' + (redoable ? ' redo-entry' : ''), redoable ? '重做' : '隐藏');
  toggle.type = 'button';
  if (redoable) {
    toggle.addEventListener('click', () => startRedo(action, card));
  } else {
    toggle.addEventListener('click', () => {
      const hidden = card.classList.toggle('answered-hidden');
      toggle.textContent = hidden ? '显示' : '隐藏';
    });
  }
  head.appendChild(toggle);
}

// 顶栏「隐藏 / 显示已答题」的可用性：只有屏内真的有已答题卡时才可点
// （清屏之后不再被永久禁用，新答的题会让它重新可用）
function refreshAnsweredBtn() {
  const has = document.querySelectorAll('.qcard.done, .msg.user.answered').length > 0;
  $btnCollapseAll.disabled = !has;
  $btnCollapseAll.textContent = state.showAnswered ? '隐藏已答题' : '显示已答题';
}

// 顶栏按钮：临时显示全部已答题目 / 再次整体隐藏
// 打分题的「重做」按钮不是折叠开关：只改 answered-hidden，文字不动
function setAnsweredVisible(flag) {
  state.showAnswered = flag;
  const hidden = !flag;
  document.querySelectorAll('.qcard.done').forEach((card) => {
    card.classList.toggle('answered-hidden', hidden);
    const t = card.querySelector('.qcard-toggle:not(.redo-entry)');
    if (t) t.textContent = hidden ? '显示' : '隐藏';
  });
  // 作答回显的用户气泡也一起隐藏 / 显示（它们同样是「已答题」的一部分）
  document.querySelectorAll('.msg.user.answered').forEach((n) => n.classList.toggle('answered-hidden', hidden));
  refreshAnsweredBtn();
}

/* ---------------------------------------------------------------- 打分题单独重做
   已提交的打分题卡片上有一个「重做」按钮：点它只把这一张卡片临时变回可改状态——
   当前题、倒计时、进度、聊天流都不受影响；改完点「确认提交」才落库。
   没有取消路径：点了重做就必须提交（想保留原分数就重新选回原值再提交）。
   状态徽标只有两种：重做中（改动未落库）=「未提交」，其余 =「✓ 已提交」。
   同一时刻最多一张卡片处于修改中；刷新点 / 交卷前会先点名未提交的卡片，
   被试回卡片上提交后流程才继续——弹窗不替被试提交（settlePendingRedo）。 */

// 进入重做：卡片重建为可改状态（原分数保持选中），底部给「取消 / 确认提交」
function startRedo(action, card) {
  if (state.completed) return;
  if (state.redoing) {
    const cur = state.redoing.card;
    if (cur && cur !== card) {
      cur.scrollIntoView({ behavior: 'smooth', block: 'center' });   // 已有一张在改：带到它面前去处置
      cur.classList.remove('redo-nudge');
      void cur.offsetWidth;
      cur.classList.add('redo-nudge');
    }
    return;
  }
  if (state.busy) return;                          // 当前题正在提交：稍后再点（几秒内就会空闲）
  const bodyEl = card.querySelector('.qcard-body');
  const selected = bodyEl.querySelector('.rating-btn.selected');
  const original = selected ? Number(selected.textContent) : null;
  card.classList.add('redoing');
  card.classList.remove('answered-hidden');
  bodyEl.classList.remove('readonly');
  bodyEl.replaceChildren();
  const control = buildSubControl(action, original, () => {}, () => refreshRedoFoot(), false);
  bodyEl.appendChild(control.node);
  const foot = el('div', 'qcard-foot');
  const hint = el('span', 'qfoot-hint');
  const submitBtn = el('button', 'primary-btn', '确认提交');
  submitBtn.type = 'button';
  submitBtn.addEventListener('click', () => submitRedo());
  foot.append(hint, submitBtn);                    // 没有「取消」：点重做 = 必须提交（原值可选回再交）
  card.appendChild(foot);
  const mark = card.querySelector('.qdone-mark');
  if (mark) mark.textContent = '未提交';           // 改动还没落库：黄底「未提交」（.redoing 的 warn 配色）
  const toggle = card.querySelector('.qcard-toggle');
  if (toggle) toggle.disabled = true;
  state.redoing = { itemId: action.itemId, action, card, control, submitBtn, hint, busy: false };
  refreshRedoFoot();
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function refreshRedoFoot() {
  const r = state.redoing;
  if (!r || !r.submitBtn) return;
  r.submitBtn.disabled = r.busy || !r.control.isReady();
}

// 卡片被处置（确认提交）后的放行通知：settlePendingRedo 挂起的清屏 / 交卷流程据此继续
const redoSettleWaiters = [];
function notifyRedoSettled() {
  while (redoSettleWaiters.length) redoSettleWaiters.pop()();
}

// 重做提交成功后的收尾：把卡片重建为只读展示并恢复「✓ 已提交」与「重做」入口
// （不再有「已更新为 N 分」的一次性提示——那要靠定时器改回文案，卡片再次进入重做时会
//   被过期的定时器改回「已提交」字样、却套着 .redoing 的黄色配色；状态只有两种，定时器就不需要存在）
function rebuildDoneRatingCard(card, action, value) {
  card.classList.remove('redoing');
  const bodyEl = card.querySelector('.qcard-body');
  bodyEl.classList.add('readonly');
  bodyEl.replaceChildren();
  const control = buildSubControl(action, value, () => {}, () => {}, false);
  bodyEl.appendChild(control.node);
  bodyEl.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
  card.querySelector('.qcard-foot')?.remove();
  const mark = card.querySelector('.qdone-mark');
  if (mark) mark.textContent = '✓ 已提交';
  const toggle = card.querySelector('.qcard-toggle');
  if (toggle) toggle.disabled = false;             // 点击监听还在（闭包里就是这张卡和这道题），重新点亮即可
}

// 提交重做：POST /api/step { redo: true, itemId, value }——服务端只更新那一行，不推进进度。
// 返回是否成功（失败时原因写在卡片脚注里，弹窗场景会把提示带进弹窗文案）。
async function submitRedo() {
  const r = state.redoing;
  if (!r || r.busy) return false;
  const value = r.control.getPayload().value;
  if (value == null) return false;
  r.busy = true;
  refreshRedoFoot();
  try {
    const res = await api(stepUrl(), {
      method: 'POST',
      body: stepBody({ sessionId: state.sessionId, itemId: r.action.itemId, value, redo: true })
    });
    if (res.ignored) {
      if (r.hint) r.hint.textContent = '这次修改没有被接受，请重试。';
      return false;
    }
    if (res.nowMs != null) state.serverOffsetMs = res.nowMs - Date.now();
    const done = state.redoing;
    state.redoing = null;
    rebuildDoneRatingCard(done.card, done.action, value);
    notifyRedoSettled();                             // 若清屏 / 交卷正被这张卡挡着：放行
    return true;
  } catch (err) {
    if (r.hint) r.hint.textContent = err.message || '提交失败，请重试。';
    return false;
  } finally {
    r.busy = false;
    refreshRedoFoot();                               // 失败后把「确认提交」重新点亮（改动还在卡上）
  }
}

// 未提交重做的断言（刷新点 / 交卷共用）：不替被试提交、也不给取消——
// 先把页面带到未提交的那张卡片（居中 + 高亮晃动），再弹窗点名「还未提交的题目：第 N 题」；
// 被试必须回到卡片上「确认提交」，流程才会自动继续（弹窗的「确认」只是收起提示并再跳一次）。
function settlePendingRedo() {
  if (!state.redoing) return Promise.resolve();
  const jumpToRedoing = () => {
    const r = state.redoing;
    if (!r) return;
    r.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    r.card.classList.remove('redo-nudge');
    void r.card.offsetWidth;
    r.card.classList.add('redo-nudge');
  };
  jumpToRedoing();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    redoSettleWaiters.push(finish);
    const qno = state.redoing.action.qno ? `第 ${state.redoing.action.qno} 题` : '一道打分题';
    openConfirm({
      title: '还有题目未提交',
      text: `还未提交的题目：${qno}\n\n请先完成这道题：回到题卡作答后点「确认提交」。全部提交后才能继续。`,
      icon: '⚠',
      okLabel: '确认',
      cancelLabel: null,
      lockMask: true,
      onOk: jumpToRedoing
    });
  });
}

/* ---------------------------------------------------------------- 提交 */

async function postStep(payload) {
  const delays = [0, 400, 1200];
  let lastErr = null;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      return await api(stepUrl(), { method: 'POST', body: stepBody(payload) });
    } catch (err) {
      lastErr = err;
      const retriable = !err.code || ['server_error', 'body_too_large'].includes(err.code);
      if (!retriable) throw err;
    }
  }
  throw lastErr;
}

function echoOf(action, payload) {
  // 消息式题面（文本题 / 两段文本题组）：气泡里放被试的原话——与服务端落库的回显同一口径，
  // 刷新 / 重进后的回放不会变样
  if (isMessageStyleAction(action)) {
    if (action.type === 'group') {
      const rows = payload.answers || [];
      const joined = rows.map((r) => String((r && r.text) || '').trim()).filter(Boolean).join(String.fromCharCode(10));
      return joined || '（未填写内容）';
    }
    return String(payload.text || '').trim() || '（未填写内容）';
  }
  // 卡内作答的题组（混合子题）：逐子题回显
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
  if (action.type === 'multi') return `我的选择：${(payload.values || []).map((v) => (action.options.find((o) => o.value === v) || {}).label).join('、')}`;
  if (action.type === 'rank') return `我的排序：${(payload.order || []).map((v, i) => `${i + 1}. ${(action.options.find((o) => o.value === v) || {}).label}`).join('  ')}`;
  const opt = (action.options || []).find((o) => o.value === payload.value);
  return action.type === 'rating' ? `评分：${payload.value} 分` : `我的选择：${opt ? opt.label : payload.value}`;
}

async function submit(action, payload) {
  if (state.busy || state.completed || !state.sessionId) return;
  // 交卷断言：这一步就是最后一题、而上面还有没提交的重做 → 先提交或放弃，再交卷跳转结束页
  if (state.redoing && Number(state.totalAnswers) > 0 && state.answeredCount + 1 >= Number(state.totalAnswers)) {
    await settlePendingRedo();
    if (state.busy || state.completed || !state.sessionId) return;    // 断言期间状态变了就收手
  }
  state.busy = true;
  const node = state.questionNodes.get(action.itemId);
  if (node && node.submitBtn) node.submitBtn.disabled = true;
  const elapsedMs = Math.round(performance.now() - (state.actionShownAt || performance.now()));
  const echo = echoOf(action, payload);
  // 「需输入指定内容」的题：发送前先由服务端断言。与其余题型不同，这一类的收尾（用户气泡 / ✓ 已提交）
  // 要等服务端点头之后再做——断言没过时点「发送」等于没发出去：题卡照旧待答、输入内容原样保留。
  const asserting = needsAnswerCheck(action);
  const settle = () => {
    finalizeQuestion(action, echo);
    state.answeredCount += 1;
    delete state.draft[action.itemId];
    clearDraft(action.itemId);
    resetComposer();                             // 已经发出去了：输入框立刻清空（否则内容留在框里像没发出去）
  };
  if (!asserting) settle();
  const gen = streamEpoch;                       // 提交时的世代：期间被跳题打断就不再把旧结果写屏
  try {
    const res = await postStep({ sessionId: state.sessionId, ...payload, elapsedMs });
    if (asserting && !res.ignored) settle();     // 被服务端忽略的提交（错题/迟到）不算发出去
    await afterStep(action, echo, res, gen);
  } catch (err) {
    if (gen !== streamEpoch) return;
    // 断言没过：只在输入框上方提示（文案由题目配置，服务端带回），不落库、不进聊天流
    if (asserting && err.code === 'invalid_answer') { setComposerError(err.message); return; }
    if (err.code === 'session_closed') { state.completed = true; showFinalPage(action); return; }
    // 提交晚于服务端关闭的窗口：这一笔不会被记录，本题即停止作答（不再自动提交 / 不再开新窗口）
    if (err.code === 'window_closed') { appendAiMessageStatic(STOPPED_HINT); return; }
    appendAiMessageStatic(err.code === 'too_early' ? '还没有到可以提交的时间，请稍候再试。' : '抱歉，连接似乎出现了问题，请稍后重试。');
  } finally {
    state.busy = false;
    if (asserting) refreshComposer();             // 断言失败：把「发送」重新点亮（输入内容还在）
  }
}

/* ---------------------------------------------------------------- 负载应用 */

function applyPayload(payload) {
  if (payload.nowMs != null) state.serverOffsetMs = payload.nowMs - Date.now();
  if (payload.answeredCount != null) state.answeredCount = payload.answeredCount;
  if (payload.totalAnswers != null) state.totalAnswers = payload.totalAnswers;
  if (payload.totalQuestions != null) state.totalQuestions = payload.totalQuestions;
  if (payload.currentQno != null) state.currentQno = payload.currentQno;
  if (payload.timeScale != null && Number(payload.timeScale) > 0) state.timeScale = Number(payload.timeScale);
  refreshAnsweredBtn();

  const action = payload.action;
  state.action = action || null;
  state.actionShownAt = performance.now();
  composerTarget = null;
  composerMode = null;                         // 由 renderQuestion 按题型重新决定
  clearComposerError();
  refreshComposer();
  if (!action) return;

  // 知情同意页：勾选后才能继续；「含编号」形态还要填编号
  if (action.type === 'gate') {
    showPage({
      title: action.title,
      html: action.html,
      check: action.check,
      button: action.button,
      idField: action.variant === 'id' ? { label: action.idLabel, placeholder: action.idPlaceholder } : null
    });
    pageHandler = async () => {
      if ($pageCheck.checked === false && !$pageCheckWrap.classList.contains('hidden')) return;
      hidePage();
      const gen = streamEpoch;
      const res = await api(stepUrl(), {
        method: 'POST',
        body: stepBody({ sessionId: state.sessionId, consent: true, text: $pageIdInput.value.trim(), elapsedMs: 800 })
      });
      afterStep(action, '', res, gen);
    };
    return;
  }

  // 阅读确认页：内联块（不再全屏）——上面的反馈/材料保持可见可回看，确认按钮在下方
  if (action.type === 'confirm') {
    renderConfirmInline(action);
    scrollToBottom(true);
    return;
  }

  // 结束说明是终态页：没有按钮，自动确认收尾（会话转为已完成），再由 showFinalPage 渲染终态。
  // 交卷断言：自动确认之后会话就完成了、重做通道随之关闭——所以确认前先处置未提交的重做。
  if (action.type === 'debrief') {
    const gen = streamEpoch;
    settlePendingRedo().then(() => {
      if (gen !== streamEpoch || state.completed || !state.sessionId) return;
      api(stepUrl(), { method: 'POST', body: stepBody({ sessionId: state.sessionId, ack: true, elapsedMs: 800 }) })
        .then((res) => afterStep(action, '', res, gen))
        .catch(() => { if (gen === streamEpoch) showFinalPage(action); });
    });
    return;
  }

  const node = renderQuestion(action);
  scrollToBottom(false);  // 瞬时贴底：与进入动画同帧完成，不会「先闪一下再滚」
}

// 提交后的统一处理：渲染新消息 → 推进到下一题 / 结束。
// gen = 提交那一刻的聊天流世代号：跳题 / 重开会话会让它失效，此时这条续集必须原地收手
//（消息、下一题卡都不再写屏——新的一次渲染已经接管了聊天流）。
async function afterStep(action, echo, res, gen) {
  const epoch = gen == null ? streamEpoch : gen;
  const stale = () => epoch !== streamEpoch;
  // 重复 / 迟到的提交被服务端忽略：静默同步到最新进度即可，不要当成失败
  if (res.ignored) {
    if (stale()) return;
    applyPayload(res);
    scrollToBottom(true);
    return;
  }
  state.serverOffsetMs = (res.nowMs || Date.now()) - Date.now();
  let appended = 0;
  // 清屏点（题目上或消息上）：先清空聊天流，再呈现清屏点之后的新内容（顺序不能反）。
  // 上面的题还在重做中就先断言：提交或放弃这次修改，然后才清屏（清屏会连卡片一起清掉）。
  if (res.clearStream) {
    await settlePendingRedo();
    if (stale()) return;
    clearStream();
  }
  for (const m of res.messages) {
    if (stale()) return;
    if (m.role !== 'assistant') continue;
    await appendAiMessageAnimated(m.content, { thinkMs: m.think_ms, typeMs: m.type_ms }, m.thinking);
    appended += 1;
  }
  if (stale()) return;
  if (appended) storeSeen((state.seenMsgs || 0) + appended);
  if (res.session.status === 'completed') {
    state.completed = true;
    state.action = null;
    await sleep(320);
    if (stale()) return;
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

  const action = state.action;
  if (!action || state.busy || state.completed) return;
  const node = state.questionNodes.get(action.itemId);
  if (!node || node.closed) return;               // 已停止作答（本题已销毁，只剩提示）
  const { hint, card } = node;
  const shared = action.sharedWindow ? '共用 · ' : '';
  // 倒计时显示「设定的秒数」：预览里门控被服务端按倍速缩短，这里乘回倍速，
  // 于是作者看到的是「50 秒从 50 开始快速跳到 0」，而不是莫名其妙的 5 秒（真实会话 timeScale = 1）。
  const scale = Number(state.timeScale) > 0 ? Number(state.timeScale) : 1;
  const left = (ms) => {
    const sec = Math.max(0, Math.ceil(((ms - now) * scale) / 1000));
    return sec >= 60 ? Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') : sec + ' 秒';
  };

  // 作答前强制等待（控件可填，仅提交按钮置灰；倒计时在右上角）
  if (action.availableAtMs && now < action.availableAtMs) {
    card.classList.add('locked');
    setTimer(node, `${left(action.availableAtMs)}后可提交`, false);
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
      setTimer(node, `${shared}${left(action.minSubmitAtMs)}后可提交`, false);
      hint.textContent = '';
      node.refresh();                 // 控件可填，仅提交按钮置灰
      return;
    }
    if (action.deadlineMs) {
      const remain = action.deadlineMs - now;
      if (remain <= 0) {
        // 时间已到：直接停止作答（不自动提交、也不开新窗口），只提示可以「重做」
        if (!state.deadlineFired) {
          state.deadlineFired = true;
          stopQuestionByDeadline(action);
        }
        return;
      }
      setTimer(node, `${shared}剩余 ${left(action.deadlineMs)}`, true);
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

// 终态页渲染（无按钮、只提示可关闭）：showFinalPage 与「刷新复原」共用
function renderFinalPage(title, html) {
  showPage({
    title: title || '实验说明',
    html: html || '本次全部任务已完成，感谢您的参与！',
    button: '重做本问卷'
  });
  $pageCheckWrap.classList.add('hidden');
  // 终态页给一个「重做」入口：答完/预览走完后想再来一遍，不必依赖刷新或关标签页
  pageHandler = () => requestRedo(true);
  // 收尾小字（「本次实验已结束，您可以关闭本页面。」）已并入结束说明正文，由作者在管理端编辑，不再硬编码
  $pageHint.textContent = '';
  $pageHint.classList.add('hidden');
}

// 结束说明页（终态）：给一个「重做」按钮（本次记录已落库，重做另起一份新记录）。
// 同时清掉本机会话记录——填完即视为释放设备；终态内容另存 sessionStorage，
// 供同一标签页刷新时复原（关掉标签页后即消失，重开链接回到开始页）。
function showFinalPage(lastAction) {
  const isDebrief = lastAction && lastAction.type === 'debrief';
  const title = isDebrief ? lastAction.title || '实验说明' : '感谢参与';
  const debriefHtml = isDebrief ? String(lastAction.html || lastAction.text || '').trim() : '';
  const text = debriefHtml || '本次全部任务已完成，感谢您的参与！';
  renderFinalPage(title, text);
  clearStoredSession();
  storeCompletedFinal({ title, text });
  Object.keys(state.draft || {}).forEach((id) => clearDraft(id));
}

/* ---------------------------------------------------------------- 初始化 */

// 预览桥：管理端手机预览（同源 iframe）通过它改倍速、拖进度，而不用重建会话
// 跳题 = 整屏重来：先换代（让上一步没播完的续集收手），再把界面上的临时状态全部复位。
async function rerenderFromPayload(payload) {
  beginFreshStream();
  cancelResumeCard();                              // 重进卡片还挂着：作废（否则恢复流程的 await 永不返回）
  hidePage();                                      // 知情同意 / 结束说明这类整页覆盖层要撤掉（否则跳过去也点不到题）
  state.completed = false;                         // 从结束页跳回中间：服务端会话已被 seek 复活，客户端同步解除「已完成」
  $stream.replaceChildren();
  state.questionNodes.clear();
  state.draft = {};
  clearSeen();
  await renderReplay(payload.replay || [], 1e9);   // 全部秒显（预览里不需要重播动画）
  applyPayload(payload);
  scrollToBottom(false);
}
if (IS_PREVIEW) {
  window.__preview = {
    total: () => state.totalAnswers || 0,                     // 作答单元数（含知情同意 / 确认页 / 结束页）
    totalQuestions: () => state.totalQuestions || 0,          // 真实题数（进度条分母）
    currentQno: () => state.currentQno || 0,                  // 当前「第几题」
    answered: () => state.answeredCount || 0,
    speed: () => previewSpeed,
    // 改倍速：只改服务端门控缩放 + 本地呈现节奏，**不重画聊天流**（已填内容、未提交的选择都保留）。
    // 关键一步：服务端会把「剩余时间」按新倍速重算（强制等待 / 最短提交 / 最长作答三处），
    // 这里必须把重算后的时间基准取回来覆盖当前 action —— 否则屏幕上还是「旧剩余 × 新倍速」，
    // 会显示成 58:48、14:26 这种数（设定 180 秒的题实际只剩 9 秒，却按 176 秒 × 20 显示）。
    setSpeed: async (value) => {
      const n = Math.max(1, Math.min(50, Math.round(Number(value) || 1)));
      await api('/api/preview/speed', { method: 'POST', body: { previewId, speed: n } });
      previewSpeed = n;
      state.timeScale = n;
      // 正在输出消息 / 正在提交时**不要**动 action：开场消息还在逐字打的时候，
      // 客户端的 action 还停在上一题（比如知情同意），而服务端已经推进到第一题 ——
      // 这时候去「同步基准」会把屏幕上还没播完的内容清掉重来（用户看到的「改倍速就重新弹出文本和第一题」）。
      // 弹字与思考面板是逐帧读倍速的，所以这里直接返回就已经按新倍速继续输出了。
      if (state.busy) return true;
      try {
        const boot = await api(bootstrapUrl(state.sessionId));
        if (Number(boot.timeScale) > 0) state.timeScale = Number(boot.timeScale);
        if (boot.nowMs != null) state.serverOffsetMs = boot.nowMs - Date.now();
        const fresh = boot.action;
        // 只在「还是同一题」时把服务端重算后的时间基准覆盖过来。
        // 题号对不上说明服务端已经推进（而我们这边还在播消息）：什么都不做，
        // 交给当前流程自己的 afterStep → applyPayload 去同步，绝不重画聊天流。
        if (fresh && state.action && fresh.itemId === state.action.itemId) {
          Object.assign(state.action, {
            availableAtMs: fresh.availableAtMs,
            minSubmitAtMs: fresh.minSubmitAtMs,
            deadlineMs: fresh.deadlineMs,
            sharedWindow: fresh.sharedWindow,
            waitSec: fresh.waitSec,
            minSubmitSec: fresh.minSubmitSec,
            maxAnswerSec: fresh.maxAnswerSec,
            nowMs: fresh.nowMs
          });
          // 新基准下还没到点 → 允许重新判定（老基准可能已经把本题判成「时间已到」）
          if (!(state.action.deadlineMs && serverNow() >= state.action.deadlineMs)) state.deadlineFired = false;
          const node = state.questionNodes.get(state.action.itemId);
          if (node && node.refresh) node.refresh();
        }
      } catch { /* 取不到就保持现状：下一次提交会同步到最新基准 */ }
      return true;
    },
    // 进度跳转：按**题号**跳（与服务端/管理端同一口径：qno 就是卡面写的「第 N 题」）
    seekQuestion: async (qno) => {
      const res = await api('/api/preview/seek', { method: 'POST', body: { previewId, sessionId: state.sessionId, qno: Number(qno) } });
      await rerenderFromPayload(res);
      return true;
    },
    // 从头重做这次模拟（管理端预览栏的「重做」按钮）：作废当前会话、回到知情同意页重新开始
    restart: async () => {
      await abandonAndRestart();
      return true;
    },
    // 销毁本预览（管理端点「刷新预览」前会调）
    destroy: () => api('/api/preview/destroy', { method: 'POST', body: { previewId } }).catch(() => {})
  };
}

async function startSession() {
  const gen = beginFreshStream();                       // 换代：上一个会话没播完的续集就此收手
  const created = await api(createSessionUrl(), { body: createSessionBody() });
  if (gen !== streamEpoch) return;                      // 期间被跳题 / 重开打断：这次开局的负载已经过期
  state.sessionId = created.session.id;
  storeSession(created.session.id);
  startHeartbeat();
  clearSeen();                                            // 新会话：从零开始逐字呈现
  await renderReplay(created.replay || [], 0);
  if (gen !== streamEpoch) return;
  applyPayload(created);
}

async function init() {
  if (!questionnaireCode && !IS_PREVIEW) {          // 预览模式没有问卷短码，数据源是内存预览会话
    showError('链接无效：缺少问卷参数，请使用管理端复制的问卷链接进入。');
    return;
  }
  const gen = streamEpoch;
  try {
    const sid = loadStoredSession();
    // 本标签页刚做完：刷新仍看终态页（关掉标签页后 sessionStorage 清空，重开链接即回到开始页）。
    // 预览例外：预览是作者的试填工具，做完后再刷新 / 再进来一律**强制重进**（从头再走一遍），
    // 不能被上次的终态页锁住（那种「刷新也进不去」正是它引出来的）。
    if (IS_PREVIEW) clearCompletedFinal();
    const done = forceFresh || IS_PREVIEW ? null : loadCompletedFinal();
    if (!sid && done) {
      renderFinalPage(done.title, done.text);
      return;
    }
    const boot = await api(bootstrapUrl(sid));
    if (gen !== streamEpoch) return;
    if (boot.session) {
      state.sessionId = boot.session.id;
      storeSession(boot.session.id);
      startHeartbeat();
      if (boot.session.status === 'completed') {
        if (IS_PREVIEW) { clearStoredSession(); await startSession(); return; }   // 预览：已完成 → 整份重来
        state.completed = true;
        showFinalPage(null);
        return;
      }
      // 退出重进：先给一张卡片确认（继续作答 / 重新开始），不再静默续做
      const choice = await renderResumeCard(boot);
      if (choice === 'restart') { await abandonAndRestart(); return; }
      if (choice !== 'continue') return;             // 被跳题打断：界面已由那次跳转接管
      // 重建聊天流：已看完的秒显，没看完的继续逐字补播（已作答题目一并还原）
      await renderReplay(boot.replay || [], loadSeen());
      if (gen !== streamEpoch) return;               // 补播被打断：恢复流程作废，不再渲染过期负载
      scrollToBottom(false);
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

$btnCollapseAll.addEventListener('click', () => setAnsweredVisible(!state.showAnswered));

// 应用内确认弹窗（替代浏览器原生 confirm）
// 扩展项：cancelLabel/onCancel = 自定义取消按钮；lockMask = 点遮罩不关闭（断言弹窗必须二选一）；
//         manualClose = 点「确定」不自动收起，由 onOk 处理完自己调 closeConfirm（失败时留在弹窗里重试）
let confirmHandler = null;
let confirmCancelHandler = null;
let confirmLockMask = false;
let confirmManualClose = false;
function openConfirm({ title, text, okLabel, cancelLabel, icon, onOk, onCancel, lockMask, manualClose }) {
  $confirmTitle.textContent = title || '提示';
  $confirmText.textContent = text || '';
  $confirmOk.textContent = okLabel || '确定';
  if (icon) {
    $confirmIcon.textContent = icon;               // 顶部圆形徽标（如重做断言的 ⚠）
    $confirmIcon.classList.remove('hidden');
  } else {
    $confirmIcon.classList.add('hidden');
  }
  if (cancelLabel === null) {
    $confirmCancel.classList.add('hidden');        // 单按钮弹窗：处置动作都在别处（如题卡上），只留「确认」
  } else {
    $confirmCancel.classList.remove('hidden');
    $confirmCancel.textContent = cancelLabel || '取消';
  }
  confirmHandler = onOk || null;
  confirmCancelHandler = onCancel || null;
  confirmLockMask = !!lockMask;
  confirmManualClose = !!manualClose;
  $confirmMask.classList.remove('hidden');
  requestAnimationFrame(() => $confirmMask.classList.add('visible'));
}
function closeConfirm() {
  $confirmMask.classList.remove('visible');
  confirmHandler = null;
  confirmCancelHandler = null;
  confirmLockMask = false;
  confirmManualClose = false;
  $confirmCancel.classList.remove('hidden');
  $confirmIcon.classList.add('hidden');
  setTimeout(() => $confirmMask.classList.add('hidden'), 200);
}
$confirmCancel.addEventListener('click', () => {
  const fn = confirmCancelHandler;
  closeConfirm();
  if (fn) fn();
});
$confirmMask.addEventListener('click', (e) => {
  if (e.target !== $confirmMask || confirmLockMask) return;
  closeConfirm();
});
$confirmOk.addEventListener('click', async () => {
  const fn = confirmHandler;
  if (!fn) return;
  if (!confirmManualClose) closeConfirm();
  await fn();
});

// 重做：作废当前会话（数据留档、导出默认排除）、清除本机草稿，回到知情同意页重新开始
$btnRedo.addEventListener('click', () => requestRedo(false));

init();
