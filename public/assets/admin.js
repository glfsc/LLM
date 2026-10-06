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
const $sidebarTip = $('sidebar-tip');

const TOKEN_KEY = 'expchat_admin_token';

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  meta: null,             // { itemTypes, itemTypeLabels, itemLimits, timingMeta, itemDefaults, defaultQuestionnaireItems, resumeWindowHours }
  experiments: [],
  questionnaires: [],
  editingExp: null,       // 编辑中的实验模板（本地副本，保存时提交）
  editingQ: null,         // 编辑中的问卷
  selected: null,         // 当前选中的题目 id
  sidebarMode: 'menu',    // menu | outline
  previewSpeed: 1,        // 试填 / 预览的演示倍速（1 = 与正式实验一致）
  trial: null,            // { list, idx, answers }
  dragId: null,
  view: 'exp-list'
};

const TYPE = () => state.meta.itemTypes;
const TYPE_LABEL = (t) => (state.meta.itemTypeLabels[t] || t);
const TYPE_LIMITS = (t) => (state.meta.itemLimits[t] || []);
const TIMING_META = () => state.meta.timingMeta;
const TIMING_KEYS = () => state.meta.timingKeys;

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

function setHint(node, message, isError = false) {
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('err', Boolean(isError));
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
function autoGrowTextarea(textarea, minRows) {
  const minHeight = Math.max(1, Number(minRows) || 1) * 22 + 22;
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
  };
  textarea.style.overflow = 'hidden';
  textarea.style.resize = 'none';
  textarea.addEventListener('input', resize);
  window.setTimeout(resize, 0);
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

function openModal({ title, body, confirmLabel = '确定', danger = false, onConfirm }) {
  $modalTitle.textContent = title;
  $modalBody.innerHTML = '';
  if (body) $modalBody.appendChild(body);
  $modalError.classList.add('hidden');
  $modalConfirm.textContent = confirmLabel;
  $modalConfirm.classList.toggle('danger', Boolean(danger));
  $modalConfirm.disabled = false;
  modalOnConfirm = onConfirm || null;
  $modal.classList.remove('hidden');
}

function closeModal() {
  $modal.classList.add('hidden');
  modalOnConfirm = null;
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

/* ---------------------------------------------------------------- 登录 */

async function loadMeta() {
  state.meta = await api('/api/admin/meta');
}

async function enterAdmin() {
  initLayout();
  await Promise.all([loadMeta(), reloadExperiments(), reloadQuestionnaires()]);
  $('login-view').classList.add('hidden');
  $('admin-view').classList.remove('hidden');
  handleRoute();
}

async function boot() {
  if (!state.token) return;
  try { await enterAdmin(); } catch (err) {
    if (err.status === 401) { state.token = ''; sessionStorage.removeItem(TOKEN_KEY); }
  }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('login-password').value;
  if (!password) return;
  $('login-btn').disabled = true;
  try {
    const res = await api('/api/admin/login', { body: { password } });
    state.token = res.token;
    sessionStorage.setItem(TOKEN_KEY, res.token);
    $('login-error').classList.add('hidden');
    $('login-password').value = '';
    await enterAdmin();
  } catch (err) {
    $('login-error').textContent = err.message || '密码不正确，请重试。';
    $('login-error').classList.remove('hidden');
    $('login-password').select();
  } finally {
    $('login-btn').disabled = false;
  }
});

$('btn-logout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { body: {} }); } catch { /* 忽略 */ }
  state.token = '';
  sessionStorage.removeItem(TOKEN_KEY);
  location.reload();
});

function maybeSessionExpired(err) {
  if (err.status !== 401) return false;
  state.token = '';
  sessionStorage.removeItem(TOKEN_KEY);
  location.reload();
  return true;
}

/* ---------------------------------------------------------------- 路由 */
// #/exp、#/exp/:id
// #/q、#/q/:id、#/q/:id/data、#/q/:id/s/:sid

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [section, a, b, c] = raw.split('/');
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
  if (!location.hash) { location.replace('#/exp'); return; }
  const route = parseHash();
  if (!route) { location.replace('#/exp'); return; }

  document.querySelectorAll('.sidebar-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.nav === route.section);
  });

  const editing = route.view === 'editor';
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
    state.trial = null;
    location.hash = a.dataset.nav === 'exp' ? '#/exp' : '#/q';
  });
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
  $sidebarTip.textContent = editing
    ? '大纲与编辑器双向联动：点大纲跳到该题，点题卡高亮大纲；拖动题卡排序，大纲同步更新。'
    : '只有 9 种题目：量表 = 多道打分题，创作 = 一个题组（广告语 + 创作说明同屏作答）。实验是可复用的题目模板，问卷插入后即可逐条修改。';
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
  const btn = $('btn-side-expand');
  if (btn) btn.classList.toggle('hidden', !l.collapsed);
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
function initLayout() {
  applyLayout(loadLayout());
  const side = $('split-sidebar');
  if (side) {
    side.addEventListener('mousedown', (e) => startDrag(e, 'sidebar'));
    side.addEventListener('dblclick', () => { saveLayout({ sidebar: LAYOUT_DEF.sidebar }); toast('菜单栏宽度已复位'); });
  }
  $('btn-side-in').addEventListener('click', () => saveLayout({ sidebar: Math.min(460, loadLayout().sidebar + 40) }));
  $('btn-side-out').addEventListener('click', () => saveLayout({ sidebar: Math.max(180, loadLayout().sidebar - 40) }));
  $('btn-side-collapse').addEventListener('click', () => { saveLayout({ collapsed: true }); toast('菜单栏已折叠'); });
  $('btn-side-expand').addEventListener('click', () => { saveLayout({ collapsed: false }); toast('菜单栏已展开'); });
}

function renderOutline() {
  const target = currentEditing();
  if (!target || !$sidebarOutline) return;
  $sidebarOutline.innerHTML = '';

  for (const [label, anchor] of [
    [state.view === 'exp-editor' ? '模板信息' : '问卷信息', 'sec-basic'],
    ['计时默认值', 'sec-timing'],
    [`题目编排（${target.items.length} 道）`, 'sec-items']
  ]) {
    const sec = el('div', 'ol-sec', label);
    sec.onclick = () => {
      const node = $(anchor);
      if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    $sidebarOutline.appendChild(sec);
  }

  let lastBand = null;
  target.items.forEach((it, idx) => {
    if (it.fromTemplateId && it.fromTemplateId !== lastBand) {
      lastBand = it.fromTemplateId;
      const band = el('div', 'ol-band');
      band.append(el('span', '', '来自模板'), el('span', 'line'));
      $sidebarOutline.appendChild(band);
    } else if (!it.fromTemplateId) lastBand = null;

    const row = el('div', 'ol-item' + (state.selected === it.id ? ' on' : ''));
    row.appendChild(el('span', 'ol-num', String(idx + 1)));
    row.appendChild(el('span', 'ic', TYPE_ICON(it.type)));
    row.appendChild(el('span', 'tx', it.title || '（未命名）'));
    const n = limitBadges(it, target.timing).length;
    if (n) row.appendChild(el('span', 'lm', String(n)));
    row.title = `${TYPE_LABEL(it.type)} · ${it.title || ''}`;
    row.onclick = () => {
      state.selected = it.id;
      const card = document.querySelector(`.qcard[data-id="${it.id}"]`);
      if (card) { card.classList.remove('collapsed'); }
      renderEditorView();
      const card2 = document.querySelector(`.qcard[data-id="${it.id}"]`);
      if (card2) card2.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const on = document.querySelector('.ol-item.on');
      if (on) on.scrollIntoView({ block: 'nearest' });
    };
    $sidebarOutline.appendChild(row);
  });
}

function TYPE_ICON(type) {
  return { message: '▤', gate: '⛨', debrief: '◎', group: '▦', rating: '☆', single: '◉', multi: '☑', text: '▭', rank: '↕' }[type] || '·';
}

/* ---------------------------------------------------------------- 数据加载 */

async function reloadExperiments() {
  state.experiments = (await api('/api/admin/experiments')).experiments;
}
async function reloadQuestionnaires() {
  state.questionnaires = (await api('/api/admin/questionnaires')).questionnaires;
}

/* ---------------------------------------------------------------- 计时限制 */

function effLimit(item, key, timing) {
  const v = item.limits ? item.limits[key] : undefined;
  if (v !== undefined && v !== null) return Number(v) || 0;
  return Number((timing || {})[key]) || 0;
}

function limitBadges(item, timing) {
  const out = [];
  for (const k of TYPE_LIMITS(item.type)) {
    const v = effLimit(item, k, timing);
    if (v > 0) out.push(`${TIMING_META()[k].label} ${v}s${item.limits[k] != null ? '' : '（默认）'}`);
  }
  return out;
}

function itemSummary(item) {
  switch (item.type) {
    case 'message': return (item.text || '').split('\n')[0].slice(0, 64) || '（空 · 被试端跳过）';
    case 'gate': return '进入实验前的伦理门槛，勾选后开始';
    case 'debrief': return (item.text || '').split('\n')[0].slice(0, 64);
    case 'rating': return `${item.min}–${item.max} 分 · ${item.anchor || '无锚点'}`;
    case 'single': case 'multi': return `${(item.options || []).length} 个选项${item.correct ? ' · 正确答案 ' + 'ABCDEFGH'[item.correct - 1] : ''}`;
    case 'rank': return `${(item.options || []).length} 项排序`;
    case 'text': return `${item.required === false ? '选答' : '必答'} · ${item.rows || 1} 行${item.maxLen ? ' · 上限 ' + item.maxLen + ' 字' : ''}`;
    case 'group': return (item.subs || []).length
      ? `${item.subs.length} 道子题：${item.subs.map((x) => x.title || TYPE_LABEL(x.type)).join(' + ')}（同屏呈现、一次提交）`
      : '空题组 · 请展开后添加子题';
    default: return item.title || '';
  }
}

/* ---------------------------------------------------------------- 题目编辑器 */

function buildItemEditor(list, timing, opts = {}) {
  const wrap = el('div');
  let onChange = opts.onChange || (() => {});

  function rerender() { render(); }

  function render() {
    wrap.innerHTML = '';
    let lastBand = null;

    list.forEach((item, index) => {
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
      head.appendChild(el('span', 'qnum', `第 ${index + 1} 题`));
      head.appendChild(el('span', 'qtype', `${TYPE_ICON(item.type)} ${TYPE_LABEL(item.type)}`));
      head.appendChild(el('span', 'qtitle', item.title || '（未命名）'));
      const badges = el('div', 'qbadges');
      for (const b of limitBadges(item, timing)) badges.appendChild(el('span', 'qbadge limit', b));
      head.appendChild(badges);

      const tools = el('div', 'qtools');
      const mk = (label, title, fn) => {
        const b = el('button', 'mini-btn', label);
        b.title = title;
        b.onclick = (ev) => { ev.stopPropagation(); fn(); };
        return b;
      };
      tools.append(
        mk(item.collapsed ? '展开' : '折叠', '折叠 / 展开该题', () => { item.collapsed = !item.collapsed; render(); }),
        mk('复制', '复制该题', () => { const c = JSON.parse(JSON.stringify(item)); c.id = `copy${Date.now()}`; delete c.fromTemplateId; delete c.fromTemplateName; list.splice(list.indexOf(item) + 1, 0, c); toast('已复制'); render(); }),
        mk('删除', '删除该题', () => { list.splice(list.indexOf(item), 1); if (state.selected === item.id) state.selected = null; render(); })
      );
      head.appendChild(tools);
      card.appendChild(head);

      if (item.collapsed) {
        card.appendChild(el('p', 'qsum', itemSummary(item)));
      } else {
        const body = el('div', 'qbody');
        body.appendChild(buildItemFields(item, timing, rerender));
        card.appendChild(body);
      }

      head.addEventListener('click', () => {
        state.selected = item.id;
        item.collapsed = false;
        render();
      });
      wrap.appendChild(card);

      // 选中该题时，在其正下方给出「插入题目」入口（参考问卷星 / Notion 的就地插入）
      if (state.selected === item.id) {
        const ins = el('div', 'insert-row');
        // ① 插入单题
        ins.appendChild(el('span', 'lbl', '在此题下方插入题目：'));
        const sel = el('select', 'add-select');
        for (const t of TYPE()) {
          const o = el('option', '', `${TYPE_ICON(t)} ${TYPE_LABEL(t)}`);
          o.value = t;
          sel.appendChild(o);
        }
        const btn = el('button', 'mini-btn', '+ 插入');
        btn.onclick = () => {
          const base = JSON.parse(JSON.stringify(state.meta.itemDefaults[sel.value] || { type: sel.value }));
          const created = { ...base, id: `new${Date.now().toString(36)}`, limits: {}, collapsed: false, title: base.title || TYPE_LABEL(sel.value) };
          list.splice(list.indexOf(item) + 1, 0, created);
          state.selected = created.id;
          toast('已在该题下方插入：' + TYPE_LABEL(sel.value));
          render();
        };
        ins.append(sel, btn);
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
            Object.assign(timing, full.timing);
            state.selected = null;
            toast(`已在下方插入模板「${full.name}」的 ${copies.length} 道题`);
            render();
          };
          ins.append(tsel, tbtn);
        }
        wrap.appendChild(ins);
      }
    });

    // 插入区
    const addRow = el('div', 'add-row');
    addRow.appendChild(el('span', 'lbl', '插入题目：'));
    const sel = el('select', 'add-select');
    for (const t of TYPE()) {
      const o = el('option', '', `${TYPE_ICON(t)} ${TYPE_LABEL(t)}`);
      o.value = t;
      sel.appendChild(o);
    }
    const addBtn = el('button', 'mini-btn', '+ 插入');
    addBtn.onclick = () => {
      const base = JSON.parse(JSON.stringify(state.meta.itemDefaults[sel.value] || { type: sel.value }));
      const item = { ...base, id: `new${Date.now().toString(36)}`, limits: {}, collapsed: false, title: base.title || TYPE_LABEL(sel.value) };
      insertItem(list, item);
      state.selected = item.id;
      toast('已插入：' + TYPE_LABEL(sel.value));
      render();
    };
    addRow.append(sel, addBtn);

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
        items.push({
          id: `rate${Date.now().toString(36)}${i}`,
          type: 'rating',
          title: `打分题 ${i + 1}`,
          min: 1,
          max: 5,
          anchor: '1 = 完全不同意　·　5 = 完全同意',
          limits: {},
          collapsed: false
        });
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
        // 首次插入时把模板的计时默认值也带入（问卷默认值仍为 0 时）
        Object.assign(timing, full.timing);
        toast(`已插入模板「${full.name}」的 ${copies.length} 道题（可逐条修改）`);
        render();
      };
      addRow.append(tsel, tbtn);
    }
    wrap.appendChild(addRow);
    onChange(list);
  }

  render();
  return { wrap, render };
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

function buildItemFields(item, timing, rerender) {
  const frag = document.createDocumentFragment();
  const onInput = () => renderPhoneOnly();

  frag.appendChild(makeField('题目标题（仅管理端显示）', item.title, 1).wrap);
  const titleInput = frag.lastChild.querySelector('input');
  titleInput.addEventListener('input', () => {
    item.title = titleInput.value;
    const card = document.querySelector(`.qcard[data-id="${item.id}"] .qtitle`);
    if (card) card.textContent = item.title || '（未命名）';
    onInput();
  });

  if (item.type === 'message') {
    const f = makeField('消息正文（逐字呈现；留空则该题自动跳过）', item.text || '', 6);
    f.input.addEventListener('input', () => { item.text = f.input.value; onInput(); });
    frag.appendChild(f.wrap);
  } else if (item.type === 'gate') {
    for (const [label, key, rows] of [['正文', 'text', 6], ['勾选文案', 'check', 1], ['按钮文案', 'button', 1]]) {
      const f = makeField(label, item[key] || '', rows);
      f.input.addEventListener('input', () => { item[key] = f.input.value; onInput(); });
      frag.appendChild(f.wrap);
    }
  } else if (item.type === 'debrief') {
    const f = makeField('正文', item.text || '', 6);
    f.input.addEventListener('input', () => { item.text = f.input.value; onInput(); });
    frag.appendChild(f.wrap);
  } else if (item.type === 'rating') {
    const row = el('div', 'grid2');
    const min = makeNumberField('最低分', item.min, 0, 10);
    min.input.addEventListener('input', () => { item.min = Number(min.input.value) || 0; onInput(); });
    const max = makeNumberField('最高分', item.max, 1, 12);
    max.input.addEventListener('input', () => { item.max = Number(max.input.value) || 1; onInput(); });
    row.append(min.wrap, max.wrap);
    const anchor = makeField('锚点文字', item.anchor || '', 1);
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
    const row = el('div', 'grid2');
    const rows = makeNumberField('输入框高度（行数；1 = 单行）', item.rows || 1, 1, 12);
    rows.input.addEventListener('input', () => { item.rows = Math.max(1, Math.min(12, Number(rows.input.value) || 1)); onInput(); });
    const maxLen = makeNumberField('字数上限（0 = 不限）', item.maxLen || 0, 0, 5000);
    maxLen.input.addEventListener('input', () => { item.maxLen = Number(maxLen.input.value) || 0; onInput(); });
    row.append(rows.wrap, maxLen.wrap);
    const ph = makeField('输入框提示语', item.placeholder || '', 1);
    ph.input.addEventListener('input', () => { item.placeholder = ph.input.value; onInput(); });
    const req = el('label', 'inline-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = item.required !== false;
    cb.addEventListener('change', () => { item.required = cb.checked; onInput(); });
    req.append(cb, el('span', '', '必答'));
    frag.append(row, ph.wrap, req);
  }

  if (item.type === 'group') {
    const t = makeField('题组说明（可选，写在题组标题下方）', item.text || '', 2);
    t.input.addEventListener('input', () => { item.text = t.input.value; onInput(); });
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
    frag.append(t.wrap, layout);

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

        const ttl = makeField('子题题干', sub.title || '', 1);
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

  const limits = buildLimitsBox(item, timing, onInput);
  if (limits) frag.appendChild(limits);
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
    const ph = makeField('输入框提示语', sub.placeholder || '', 1);
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
    const anchor = makeField('锚点文字', sub.anchor || '', 1);
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

function buildLimitsBox(item, timing, onInput) {
  const keys = TYPE_LIMITS(item.type);
  if (!keys.length) return null;
  const box = el('div', 'limits');
  box.appendChild(el('p', 'limits-title', '计时限制（勾选即启用；未勾选的按问卷默认值生效）'));
  for (const k of keys) {
    const meta = TIMING_META()[k];
    const row = el('div', 'limit-row');
    const label = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = item.limits[k] != null;
    label.append(cb, el('span', '', `${meta.label}（${meta.unit}）`));
    const num = el('input');
    num.type = 'number';
    num.min = '0';
    num.value = item.limits[k] != null ? item.limits[k] : effLimit({ limits: {} }, k, timing);
    num.disabled = !cb.checked;
    num.title = meta.hint;
    cb.addEventListener('change', () => {
      if (cb.checked) item.limits[k] = Number(num.value) || 0;
      else delete item.limits[k];
      num.disabled = !cb.checked;
      num.value = item.limits[k] != null ? item.limits[k] : effLimit({ limits: {} }, k, timing);
      onInput();
    });
    num.addEventListener('input', () => {
      if (!cb.checked) return;
      item.limits[k] = Number(num.value) || 0;
      onInput();
    });
    const inherit = el('span', 'inherit', `默认 ${effLimit({ limits: {} }, k, timing)}s`);
    row.append(label, num, inherit);
    box.appendChild(row);
  }
  box.appendChild(el('p', 'limits-note', '「最短提交 / 最长作答」加在相邻题目上且数值相同时，它们共用一个作答窗口（用于「创作」这类跨多题的环节）。'));
  return box;
}

/* ---------------------------------------------------------------- 编辑页骨架 + 手机预览 */

let editorCtx = null;

function renderEditorView() {
  if (editorCtx && editorCtx.refresh) editorCtx.refresh();
  renderOutline();
}

function editorShell({ title, backHash, saveLabel, hint, body, phoneTitle, withTrial }) {
  $main.className = 'admin-main editing';
  $main.innerHTML = '';

  const head = el('div', 'editor-head');
  const back = el('button', 'ghost-btn', '← 返回列表');
  back.onclick = () => { state.trial = null; location.hash = backHash; };
  head.append(back, el('h2', '', title));
  $main.appendChild(head);

  const cols = el('div', 'editor-cols');
  const scroll = el('div', 'editor-scroll');
  const bodyWrap = el('div');
  bodyWrap.appendChild(body);
  scroll.appendChild(bodyWrap);
  cols.appendChild(scroll);

  const col = el('div', 'phone-col');
  const bar = el('div', 'phone-bar');
  const tag = el('span', 'pv-tag', '实时预览 · 跟随编辑');
  bar.appendChild(tag);
  if (withTrial) {
    const trialBtn = el('button', 'mini-btn', '▶ 从头试填');
    trialBtn.onclick = () => (state.trial ? exitTrial() : startTrial());
    bar.appendChild(trialBtn);
    // 演示倍速：试填与预览按真实节奏模拟，可加速查看（1× = 与正式实验完全一致）
    const speedSel = el('select', 'pv-speed');
    for (const [v, label] of [['1', '1× 真实节奏'], ['5', '5× 加速'], ['20', '20× 快速']]) {
      const o = el('option', '', label);
      o.value = v;
      speedSel.appendChild(o);
    }
    speedSel.value = String(state.previewSpeed || 1);
    speedSel.addEventListener('change', () => {
      state.previewSpeed = Number(speedSel.value) || 1;
      if (state.trial) renderTrial(); else toast('预览倍速：' + speedSel.value + '×');
    });
    bar.appendChild(speedSel);
  }
  col.appendChild(bar);
  col.appendChild(el('p', 'phone-note', withTrial
    ? '编辑左侧内容此处实时更新；点题卡任意处即选中该题。「从头试填」可在手机里完整走一遍（不保存）。'
    : '编辑左侧内容此处实时更新。'));
  const phone = el('div', 'phone');
  const screen = el('div', 'screen');
  const top = el('div', 'screen-top');
  top.append(el('span', 'dot'), el('span', 'name', phoneTitle));
  const screenBody = el('div', 'screen-body');
  screenBody.id = 'pv-body';
  screen.append(top, screenBody);
  phone.appendChild(screen);
  col.appendChild(phone);
  // 编辑栏与手机栏之间的分隔线：拖动调整手机栏宽度（双击复位）
  const split = el('div', 'splitter');
  split.title = '拖动调整手机预览宽度 · 双击复位';
  split.addEventListener('mousedown', (e) => startDrag(e, 'phone'));
  split.addEventListener('dblclick', () => { saveLayout({ phone: LAYOUT_DEF.phone }); toast('手机栏宽度已复位'); });
  cols.append(split, col);
  $main.appendChild(cols);

  const foot = el('div', 'editor-foot');
  foot.appendChild(el('span', 'hint', hint || ''));
  const save = el('button', 'primary-btn', saveLabel);
  foot.appendChild(save);
  $main.appendChild(foot);

  return { saveBtn: save, screenBody, tag, scroll };
}

function phoneCtx(list, timing) {
  return {
    list,
    timing,
    body: $('pv-body'),
    tag: document.querySelector('.pv-tag'),
    trialBtn: document.querySelector('.phone-bar .mini-btn')
  };
}

// 作答窗口提示（与真实被试端一致）
function effWindowText(item, timing, prev) {
  const mn = effLimit(item, "minSubmit", timing);
  const mx = effLimit(item, "maxAnswer", timing);
  const shared = prev && ["minSubmit", "maxAnswer"].every((k) => (prev.limits[k] ?? null) === (item.limits[k] ?? null) && item.limits[k] != null);
  if (shared) return "与上一题共用同一个作答窗口";
  if (!mn && !mx) return "";
  return `${mn ? `${mn}s 后可提交` : ""}${mn && mx ? " · " : ""}${mx ? `${mx}s 到点自动提交` : ""}`;
}

// 手机预览渲染：消息（可打字机）/ 全屏页 / 题目卡片（含量表、题组、作答窗口标注）
async function renderPhoneBody(ctx, { upTo, animateFrom, speed } = {}) {
  const { body, list, timing } = ctx;
  body.innerHTML = "";
  const end = upTo == null ? list.length : Math.min(upTo, list.length);
  for (let i = 0; i < end; i += 1) {
    const item = list[i];
    const prev = i > 0 ? list[i - 1] : null;
    if (item.type === "message") {
      if (!String(item.text || "").trim()) {
        body.appendChild(el("div", "pv-skip", `（${item.title || "消息"}为空 · 被试端跳过）`));
        continue;
      }
      const d = effLimit(item, "delay", timing);
      if (d > 0) body.appendChild(el("div", "pv-tagline", `系统将在 ${d} 秒后发出 ↓`));
      const node = el("div", "pv-msg");
      body.appendChild(node);
      if (animateFrom === i) {
        await thinkingMock(body, speed);
        await typewriteMock(node, item.text, speed);
      } else {
        node.textContent = item.text;
      }
    } else if (item.type === "gate") {
      const g = el("div", "screen-gate");
      g.append(el("h3", "", item.title || "知情同意说明"), el("div", "txt", item.text || ""));
      const c = el("div", "check");
      c.append(el("span", "box"), el("span", "", item.check || "我已阅读"));
      g.append(c, el("div", "go", item.button || "开始实验"));
      body.appendChild(g);
    } else if (item.type === "debrief") {
      const g = el("div", "screen-gate");
      g.append(el("h3", "", item.title || "实验说明"), el("div", "txt", item.text || ""));
      body.appendChild(g);
    } else if (item.type === "group") {
      const card = el("div", "pv-qcard");
      const head = el("div", "pv-qhead");
      head.append(el("span", "pv-qnum", `第 ${previewQNo(list, i)} 题`), el("span", "pv-qtitle", item.title || ""));
      card.appendChild(head);
      if (item.text) card.appendChild(el("div", "pv-qtext", item.text));
      const wrap = el("div", "pv-subs" + (item.layout === "row" ? " row" : ""));
      for (const sub of item.subs || []) {
        const box = el("div", "pv-sub");
        box.appendChild(el("div", "pv-subtitle", sub.title || ""));
        box.appendChild(previewControl(sub));
        wrap.appendChild(box);
      }
      card.appendChild(wrap);
      const win = effWindowText(item, timing, prev);
      if (win) card.appendChild(el("div", "pv-limit", win));
      const w = effLimit(item, "wait", timing);
      if (w > 0) card.appendChild(el("div", "pv-limit", `需先停留 ${w} 秒才能作答`));
      body.appendChild(card);
    } else {
      const card = el("div", "pv-qcard");
      const head = el("div", "pv-qhead");
      head.append(el("span", "pv-qnum", `第 ${previewQNo(list, i)} 题`), el("span", "pv-qtitle", item.title || ""));
      card.appendChild(head);
      card.appendChild(previewControl(item));
      const w = effLimit(item, "wait", timing);
      if (w > 0) card.appendChild(el("div", "pv-limit", `需先停留 ${w} 秒才能作答`));
      const win = effWindowText(item, timing, prev);
      if (win) card.appendChild(el("div", "pv-limit", win));
      body.appendChild(card);
    }
  }
}

// 预览中的题号：只数「需要作答的题目」（与真实被试端一致）
function previewQNo(list, index) {
  let n = 0;
  for (let i = 0; i <= index; i += 1) {
    const t = list[i].type;
    if (t !== 'message' && t !== 'gate' && t !== 'debrief') n += 1;
  }
  return n;
}

function previewControl(item) {
  const box = el("div", "pv-ctrl");
  if (item.type === "rating") {
    const row = el("div", "pv-scale");
    for (let v = Number(item.min) || 1; v <= (Number(item.max) || 5); v += 1) row.appendChild(el("span", "", String(v)));
    box.appendChild(row);
    if (item.anchor) box.appendChild(el("div", "pv-anchor", item.anchor));
  } else if (item.type === "single" || item.type === "multi") {
    const grid = el("div", "pv-opts" + (optList(item.options).length > 2 ? "" : " one"));
    optList(item.options).forEach((o) => grid.appendChild(el("div", "pv-opt", o.label)));
    box.appendChild(grid);
  } else if (item.type === "rank") {
    const grid = el("div", "pv-opts one");
    optList(item.options, false).forEach((o) => grid.appendChild(el("div", "pv-opt", o.label)));
    box.appendChild(grid);
  } else if (item.type === "text") {
    const input = el("div", "pv-input", item.placeholder || "请输入…");
    const rows = Math.max(1, Number(item.rows) || 1);
    if (rows > 1) input.style.minHeight = `${rows * 19}px`;
    box.appendChild(input);
    if (item.maxLen) box.appendChild(el("div", "pv-anchor", `最多 ${item.maxLen} 字`));
  }
  return box;
}

function renderPhoneOnly() {
  const editing = currentEditing();
  if (!editing) return;
  const ctx = phoneCtx(editing.items, editing.timing);
  if (!ctx.body) return;
  if (state.trial) return;
  if (ctx.tag) { ctx.tag.textContent = "实时预览 · 跟随编辑"; ctx.tag.classList.remove("trial"); }
  if (ctx.trialBtn) ctx.trialBtn.textContent = "▶ 从头试填";
  renderPhoneBody(ctx, { speed: state.previewSpeed || 1 });
}

/* ---------------------------------------------------------------- 预览模拟（思考 / 流式 / 计时） */
// 与真实被试端一致的节奏：思考停顿 ~0.42s、正文 11ms/字、标点 65ms；speed = 演示倍速
const MOCK_PUNCT = "，。；：！？、,.!?;:";
function sleepMs(ms, speed) { return new Promise((r) => setTimeout(r, Math.max(0, ms / (speed || 1)))); }

// 页面内滚动：打字过程中跟随底部；新题渲染后滚到该题顶部（见 mockScrollTop）
function mockScroll(node) {
  const screen = node.closest(".screen-body");
  if (screen) screen.scrollTop = screen.scrollHeight;
}

async function typewriteMock(node, text, speed, typeMs) {
  const base = Number.isFinite(Number(typeMs)) ? Number(typeMs) : 11;
  if (base <= 0) { node.textContent = text; mockScroll(node); return; }
  node.textContent = "";
  node.classList.add("typing-mock");
  for (let i = 0; i < text.length; i += 1) {
    node.textContent += text[i];
    await sleepMs(MOCK_PUNCT.includes(text[i]) ? base + 54 : base, speed);
    if (i % 12 === 0) mockScroll(node);
  }
  node.classList.remove("typing-mock");
  mockScroll(node);
}

// 「正在思考」动画：thinkMs 可覆盖（0 = 不显示）
async function thinkingMock(body, speed, thinkMs) {
  const ms = Number.isFinite(Number(thinkMs)) ? Number(thinkMs) : 420;
  if (ms <= 0) return;
  const row = el("div", "pv-msg pv-thinking");
  row.appendChild(el("span", "", "正在思考"));
  const t = el("span", "typing");
  t.append(el("span"), el("span"), el("span"));
  row.appendChild(t);
  body.appendChild(row);
  mockScroll(row);
  await sleepMs(ms, speed);
  row.remove();
}

async function countdownMock(node, seconds, speed, label) {
  if (!node || !seconds) return;
  node.classList.remove('hidden');
  for (let s = Math.max(1, Math.round(seconds)); s > 0; s -= 1) {
    node.textContent = label.replace('{n}', String(s));
    await sleepMs(1000, speed);
  }
  node.textContent = '';
  node.classList.add('hidden');
}


/* ---------------------------------------------------------------- 从头试填（手机内交互，与正式被试端一致） */

async function startTrial() {
  const editing = currentEditing();
  if (!editing) return;
  state.trial = { list: editing.items, timing: editing.timing, idx: 0, results: {}, running: true };
  toast('已进入试填：按真实节奏模拟（可调倍速）');
  await renderTrial();
}

function exitTrial() {
  state.trial = null;
  toast('已退出试填');
  renderPhoneOnly();
}

// 题号：只数需要作答的题目（与正式被试端一致）
function previewQNo(list, index) {
  let n = 0;
  for (let i = 0; i <= index; i += 1) {
    const t = list[i].type;
    if (t !== 'message' && t !== 'gate' && t !== 'debrief') n += 1;
  }
  return n;
}

// 该题的呈现节奏：题目覆盖优先，否则问卷默认（毫秒）
function trialRhythm(item, timing) {
  return { thinkMs: effLimit(item, 'thinkMs', timing), typeMs: effLimit(item, 'typeMs', timing) };
}

// 把一个作答控件渲染成「可选」或「只读展示」；返回取值/回显方法
// 选项归一化：题库里存的是纯文本数组（['表达不够精炼', …]），预览/试填统一转成 { value, label }
const OPTION_LETTERS = 'ABCDEFGHIJKL';
function optList(options, withLetter = true) {
  return (Array.isArray(options) ? options : []).map((raw, i) => {
    if (raw && typeof raw === 'object') return { value: raw.value != null ? raw.value : i + 1, label: String(raw.label ?? '') };
    return { value: i + 1, label: withLetter ? `${OPTION_LETTERS[i] ?? i + 1}．${raw}` : String(raw ?? '') };
  });
}

function trialControl(sub, value, active, onPick, withTitle = true) {
  const box = el('div', 'trial-sub');
  if (withTitle && sub.title) box.appendChild(el('div', 'trial-subtitle', sub.title));
  const opts = optList(sub.options, sub.type !== 'rank');
  const picked = new Set();
  if (value != null) {
    if (sub.type === 'multi') (Array.isArray(value) ? value : []).forEach((v) => picked.add(v));
    else if (sub.type === 'rating' && value.value != null) picked.add(value.value);
    else if (sub.type === 'single' && value.value != null) picked.add(value.value);
  }
  const echoOf = () => {
    if (sub.type === 'text') return inp ? `${sub.title ? sub.title + '：' : ''}「${inp.value || '（空）'}」` : '';
    if (sub.type === 'rating') return `${sub.title ? sub.title + '：' : ''}${[...picked][0]} 分`;
    if (sub.type === 'rank') return `${sub.title ? sub.title + '：' : ''}${order.map((v, i) => `${i + 1}. ${(opts.find((o) => o.value === v) || {}).label}`).join('  ')}`;
    return `${sub.title ? sub.title + '：' : ''}${[...picked].map((v) => (opts.find((o) => o.value === v) || {}).label).join('、')}`;
  };
  const payloadOf = () => {
    if (sub.type === 'text') return { text: (inp.value || '').trim() };
    if (sub.type === 'rating' || sub.type === 'single') return { value: [...picked][0] };
    if (sub.type === 'multi') return { values: [...picked] };
    if (sub.type === 'rank') return { order: [...order] };
    return {};
  };
  const empty = () => {
    if (sub.type === 'text') return sub.required !== false ? !(inp.value || '').trim() : false;
    if (sub.type === 'rank') return false;
    return picked.size === 0;
  };

  let inp = null;
  let order = null;
  if (sub.type === 'text') {
    const rows = Math.max(1, Number(sub.rows) || 1);
    inp = rows > 1 ? el('textarea') : el('input');
    if (rows > 1) inp.rows = Math.min(6, rows);
    else inp.type = 'text';
    inp.placeholder = sub.placeholder || '请输入…';
    inp.value = value && value.text ? value.text : '';
    if (!active) inp.setAttribute('readonly', 'readonly');
    else inp.addEventListener('input', () => onPick && onPick());
    box.appendChild(inp);
    if (sub.maxLen) box.appendChild(el('div', 'pv-anchor', `最多 ${sub.maxLen} 字`));
  } else if (sub.type === 'rating') {
    const row = el('div', 'trial-opts rating-row');
    for (let v = Number(sub.min) || 1; v <= (Number(sub.max) || 5); v += 1) {
      const btn = el('button', 'rating-btn', String(v));
      btn.type = 'button';
      if (picked.has(v)) btn.classList.add('selected');
      if (!active) btn.disabled = true;
      else btn.addEventListener('click', () => {
        picked.clear();
        picked.add(v);
        row.querySelectorAll('.rating-btn').forEach((b) => b.classList.toggle('selected', b === btn));
        onPick && onPick();
      });
      row.appendChild(btn);
    }
    box.appendChild(row);
    if (sub.anchor) box.appendChild(el('div', 'pv-anchor', sub.anchor));
  } else if (sub.type === 'single' || sub.type === 'multi') {
    const multi = sub.type === 'multi';
    const row = el('div', 'trial-opts' + (opts.length > 2 ? '' : ' one-col'));
    opts.forEach((opt) => {
      const btn = el('button', 'option-btn', opt.label);
      btn.type = 'button';
      if (picked.has(opt.value)) btn.classList.add('selected');
      if (!active) btn.disabled = true;
      else btn.addEventListener('click', () => {
        if (multi) {
          if (picked.has(opt.value)) picked.delete(opt.value);
          else picked.add(opt.value);
          btn.classList.toggle('selected', picked.has(opt.value));
        } else {
          picked.clear();
          picked.add(opt.value);
          row.querySelectorAll('.option-btn').forEach((b) => b.classList.toggle('selected', b === btn));
        }
        onPick && onPick();
      });
      row.appendChild(btn);
    });
    box.appendChild(row);
  } else if (sub.type === 'rank') {
    order = (value && Array.isArray(value.order) && value.order.length === opts.length)
      ? [...value.order]
      : opts.map((o) => o.value);
    const list = el('div', 'rank-list');
    const rebuild = () => {
      list.innerHTML = '';
      order.forEach((v, idx) => {
        const row = el('div', 'rank-item');
        row.appendChild(el('span', 'rank-seq', String(idx + 1)));
        row.appendChild(el('span', 'rank-label', (opts.find((o) => o.value === v) || {}).label || ''));
        const up = el('button', 'mini-btn', '↑');
        up.type = 'button';
        up.disabled = !active || idx === 0;
        up.addEventListener('click', () => { [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]]; rebuild(); onPick && onPick(); });
        const down = el('button', 'mini-btn', '↓');
        down.type = 'button';
        down.disabled = !active || idx === order.length - 1;
        down.addEventListener('click', () => { [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]]; rebuild(); onPick && onPick(); });
        row.append(up, down);
        list.appendChild(row);
      });
    };
    rebuild();
    box.appendChild(list);
  }
  return { node: box, payloadOf, echoOf, empty };
}

// 题目卡片：active = 可交互，否则为已提交的只读展示
function trialQuestionCard(ctx, item, index, active, result, handlers) {
  const card = el('div', 'pv-qcard' + (active ? ' active' : ' done'));
  const head = el('div', 'pv-qhead');
  head.append(el('span', 'pv-qnum', `第 ${previewQNo(ctx.list, index)} 题`), el('span', 'pv-qtitle', item.title || ''));
  if (!active) head.appendChild(el('span', 'pv-qdone', '✓ 已提交'));
  const timer = el('span', 'pv-timer hidden');            // 右上角倒计时（issue 1）
  head.appendChild(timer);
  if (!active) {
    const toggle = el('button', 'mini-btn pv-qtoggle', '折叠');   // 已答题的折叠按钮（issue 2）
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      const collapsed = card.classList.toggle('collapsed');
      toggle.textContent = collapsed ? '展开' : '折叠';
    });
    head.appendChild(toggle);
  }
  card.appendChild(head);
  if (item.text) card.appendChild(el('div', 'pv-qtext', item.text));
  const controls = [];
  const subs = item.type === 'group' ? (item.subs || []) : [item];
  subs.forEach((sub, si) => {
    const value = result ? (item.type === 'group' ? (result.answers || [])[si] : result) : null;
    const ctl = trialControl(sub, value, active, () => handlers && handlers.onPick && handlers.onPick(), item.type === 'group');
    controls.push(ctl);
    card.appendChild(ctl.node);
  });
  if (active) {
    const hint = el('div', 'pv-limit hidden');
    const submit = el('button', 'pv-submit', item.type === 'group' ? '提交创作' : '确认提交');
    submit.type = 'button';
    submit.disabled = true;
    submit.addEventListener('click', () => {
      if (controls.some((c) => c.empty())) { hint.textContent = '请先完成必答内容'; hint.classList.remove('hidden'); return; }
      const payload = item.type === 'group'
        ? { answers: controls.map((c) => c.payloadOf()) }
        : controls[0].payloadOf();
      handlers.onSubmit(payload, controls.map((c) => c.echoOf()).join('\n'));
    });
    card.append(hint, submit);
    handlers.refresh = () => { submit.disabled = controls.some((c) => c.empty()) || handlers.gated(); };
    handlers.hint = hint;
    handlers.submit = submit;
    handlers.timer = timer;
  }
  return card;
}

// 全屏页面（知情同意 / 结束说明）在手机屏内直接交互
function trialPageCard(item, active, handlers) {
  const page = el('div', 'screen-gate');
  page.append(el('h3', '', item.title || ''), el('div', 'txt', item.text || ''));
  const isGate = item.type === 'gate';
  const box = el('label', 'check');
  box.append(el('span', 'box'), el('span', '', isGate ? (item.check || '我已阅读') : '已阅读'));
  page.appendChild(box);
  const btn = el('div', 'go', isGate ? (item.button || '开始实验') : '我已阅读');
  if (!active) {
    box.classList.add('done');
    btn.classList.add('done-flag');
    btn.textContent = '✓ 已完成';
  } else {
    let checked = !isGate;
    btn.classList.add('disabled');
    box.onclick = (e) => {
      e.preventDefault();
      checked = !checked;
      box.classList.toggle('checked', checked);
      btn.classList.toggle('disabled', !checked);
    };
    btn.onclick = () => { if (checked) handlers.onSubmit(isGate ? { consent: true } : { ack: true }); };
  }
  page.appendChild(btn);
  return page;
}

async function renderTrial() {
  const trial = state.trial;
  const editing = currentEditing();
  if (!trial || !editing) return;
  const ctx = phoneCtx(trial.list, trial.timing);
  if (!ctx.body) return;
  const speed = state.previewSpeed || 1;
  if (ctx.tag) { ctx.tag.textContent = '试填中 · 与正式被试端一致'; ctx.tag.classList.add('trial'); }
  if (ctx.trialBtn) ctx.trialBtn.textContent = '■ 退出试填';

  // 空消息在被试端不渲染（正式流程会跳过）：试填里也直接跳过，否则会卡在空白屏
  while (trial.idx < trial.list.length) {
    const it = trial.list[trial.idx];
    if (it.type === 'message' && !String(it.text || '').trim()) {
      trial.results[trial.idx] = {};
      trial.idx += 1;
      continue;
    }
    break;
  }

  ctx.body.innerHTML = '';
  let activeCard = null;
  let activeHandlers = null;
  // 提交按钮的可用性：已作答 且 门控（阅读停留 / 最短提交）已到 —— 与正式被试端一致
  const gateItem = trial.list[trial.idx];
  const gateAnswerable = !!gateItem && !['message', 'gate', 'debrief'].includes(gateItem.type);
  let gateDone = !gateAnswerable
    || (effLimit(gateItem, 'wait', trial.timing) <= 0 && effLimit(gateItem, 'minSubmit', trial.timing) <= 0);

  const advance = async (payload, echo) => {
    trial.results[trial.idx] = payload || {};
    trial.idx += 1;
    trial.running = false;
    await renderTrial();
  };

  for (let i = 0; i <= trial.idx && i < trial.list.length; i += 1) {
    const item = trial.list[i];
    const active = i === trial.idx;
    if (item.type === 'message') {
      if (!String(item.text || '').trim()) continue;
      if (!active) { ctx.body.appendChild(el('div', 'pv-msg', item.text)); continue; }
      // 当前消息：延迟 → 等待（不显示剩余时间）；然后思考 + 流式
      const delaySec = effLimit(item, 'delay', trial.timing);
      if (delaySec > 0) {
        const row = el('div', 'pv-msg pv-thinking');
        row.appendChild(el('span', '', '对方正在输入…'));
        const dots = el('span', 'typing');
        dots.append(el('span'), el('span'), el('span'));
        row.appendChild(dots);
        ctx.body.appendChild(row);
        mockScrollTop(ctx.body, row);
        await sleepMs(delaySec * 1000, speed);
        row.remove();
      }
      const node = el('div', 'pv-msg');
      ctx.body.appendChild(node);
      const rhythm = trialRhythm(item, trial.timing);
      if (rhythm.thinkMs > 0) await thinkingMock(ctx.body, speed, rhythm.thinkMs, node);
      await typewriteMock(node, item.text, speed, rhythm.typeMs);
      // 消息播完自动推进（与正式流程一致）
      trial.idx += 1;
      trial.results[i] = {};
      await sleepMs(260, speed);
      return renderTrial();
    }
    if (item.type === 'gate' || item.type === 'debrief') {
      // 知情同意确认之后就与实验无关了：从屏内清掉（issue 4）；结束说明保留
      if (!active && item.type === 'gate') continue;
      const handlers = { onSubmit: (payload) => advance(payload) };
      const page = trialPageCard(item, active, handlers);
      ctx.body.appendChild(page);
      if (active) activeCard = page;
      continue;
    }
    // 题目卡片
    const handlers = {
      gated: () => !gateDone,
      onPick: () => { if (handlers.refresh) handlers.refresh(); },
      onSubmit: (payload, echo) => advance(payload, echo)
    };
    const card = trialQuestionCard(ctx, item, i, active, trial.results[i], handlers);
    ctx.body.appendChild(card);
    if (active) { activeCard = card; activeHandlers = handlers; }
  }

  if (trial.idx >= trial.list.length) {
    ctx.body.appendChild(el('div', 'pv-done', '试填结束 · 数据未保存'));
  }
  mockScrollTop(ctx.body, activeCard);

  // 当前题的计时门控：控件可填，仅提交按钮置灰；倒计时挂在卡片右上角，倒计时结束后切换为作答倒计时
  const item = trial.list[trial.idx];
  if (!item || item.type === 'message' || item.type === 'gate' || item.type === 'debrief') return;
  const card = activeCard;
  const hint = card.querySelector('.pv-limit');
  const timer = card.querySelector('.pv-timer');
  const wait = effLimit(item, 'wait', trial.timing);
  const mn = effLimit(item, 'minSubmit', trial.timing);
  const mx = effLimit(item, 'maxAnswer', trial.timing);

  if (wait > 0) {
    await countdownMock(timer, wait, speed, '阅读中 · {n} 秒后可提交');
  }
  if (trial.list[trial.idx] !== item) return;     // 期间已推进
  if (mn > 0) {
    await countdownMock(timer, mn, speed, '{n} 秒后可提交');
  }
  if (trial.list[trial.idx] !== item) return;     // 期间已推进
  gateDone = true;
  if (activeHandlers && activeHandlers.refresh) activeHandlers.refresh();
  if (mx > 0) {
    // 门控结束后切换为作答倒计时（试填不强制自动提交）
    countdownMock(timer, mx, speed, '作答计时 · 剩余 {n} 秒');
  }
}

function mockScrollTop(screenBody, node) {
  if (!screenBody) return;
  if (!node) { screenBody.scrollTop = screenBody.scrollHeight; return; }
  // 新题滚到可视区顶部，便于从上往下阅读（issue 5）；用 rect 计算，避免 offsetParent 不是滚动容器
  const top = node.getBoundingClientRect().top - screenBody.getBoundingClientRect().top + screenBody.scrollTop - 10;
  screenBody.scrollTop = Math.max(0, top);
}


/* ---------------------------------------------------------------- 实验模板列表 */

function renderExpList() {
  $main.className = 'admin-main';
  $main.innerHTML = '';
  const head = el('div', 'panel-head');
  const box = el('div', 'grow');
  box.append(
    el('h2', '', '实验管理'),
    el('p', 'panel-sub', '实验是可复用的题目模板：一套题目 + 计时默认值。问卷「插入实验」时整组复制其题目，复制后即可逐条修改。只有 9 种题目——量表是多道打分题，创作是一个题组（广告语 + 创作说明同屏作答、一次提交）。')
  );
  const btn = el('button', 'primary-btn', '+ 新建实验');
  btn.onclick = () => openExperimentModal({ mode: 'new' });
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
  for (const t of ['实验名称', '模板 ID', '题目数', '计时默认值', '被问卷引用', '操作']) tr.appendChild(el('th', '', t));
  thead.appendChild(tr);
  const tbody = el('tbody');
  for (const exp of state.experiments) {
    const row = el('tr');
    const td1 = el('td');
    td1.append(el('div', 'cell-strong', exp.name), el('code', 'cell-code', exp.id));
    row.appendChild(td1);
    row.appendChild(el('td', '', exp.id));
    row.appendChild(el('td', '', `${exp.itemCount} 道`));
    row.appendChild(el('td', '', `${exp.timing.delay}/${exp.timing.wait}/${exp.timing.minSubmit}/${exp.timing.maxAnswer}s`));
    row.appendChild(el('td', '', `${exp.usedBy} 份`));
    const td6 = el('td');
    const actions = el('div', 'row-actions');
    const bCopy = el('button', 'ghost-btn', '复制');
    bCopy.onclick = (e) => { e.stopPropagation(); openExperimentModal({ mode: 'copy', source: exp }); };
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
  state.editingExp = { id: experiment.id, name: experiment.name, timing: { ...experiment.timing }, items: experiment.items.map((it) => ({ ...it, collapsed: false })) };
  state.selected = null;
  state.trial = null;
  setSidebarMode('outline');       // 题目已就绪，切到题目大纲
  renderExpEditorBody();
}

function renderExpEditorBody() {
  const exp = state.editingExp;
  const body = el('div');

  const secBasic = sectionHead('模板信息', '实验是可复用的题目模板；问卷「插入实验」时整组复制其题目，复制后即可逐条修改。');
  secBasic.id = 'sec-basic';
  const nameField = makeField('实验名称', exp.name, 1);
  nameField.input.addEventListener('input', () => { exp.name = nameField.input.value; });
  secBasic.appendChild(nameField.wrap);
  body.appendChild(secBasic);

  const secTiming = sectionHead('计时与呈现（全局默认值）', '门控按秒计（0 = 无限制）；呈现节奏按毫秒计。题目里勾选了具体项就以题目为准，未勾选的按这里生效。');
  secTiming.id = 'sec-timing';
  const gateGrid = el('div', 'grid2');
  const rhythmGrid = el('div', 'grid2');
  for (const key of TIMING_KEYS()) {
    const meta = TIMING_META()[key];
    const isRhythm = meta.group === 'rhythm';
    const f = makeNumberField(`${meta.label}（${meta.unit}）`, exp.timing[key], 0, isRhythm ? 10000 : 86400, meta.hint);
    f.input.addEventListener('input', () => {
      exp.timing[key] = Number(f.input.value) || 0;
      renderPhoneOnly();
    });
    (isRhythm ? rhythmGrid : gateGrid).appendChild(f.wrap);
  }
  secTiming.append(
    el('p', 'section-hint', '作答门控（秒，默认 0 = 无限制）'), gateGrid,
    el('p', 'section-hint', '呈现节奏（毫秒）'), rhythmGrid
  );
  body.appendChild(secTiming);

  const secItems = sectionHead(`题目编排（${exp.items.length} 道 · 默认全部展开）`, '拖动左侧手柄排序；点题卡即选中并展开，点「折叠」收起。被试端按此顺序呈现。');
  secItems.id = 'sec-items';
  const editor = buildItemEditor(exp.items, exp.timing, {
    onChange: () => {
      secItems.querySelector('.section-title').textContent = `题目编排（${exp.items.length} 道 · 默认全部展开）`;
      renderPhoneOnly();
      renderOutline();
    }
  });
  secItems.appendChild(editor.wrap);
  body.appendChild(secItems);

  const shell = editorShell({
    title: `实验 · ${exp.name || '未命名'}`,
    backHash: '#/exp',
    saveLabel: '保存该实验',
    hint: `模板共 ${exp.items.length} 道题`,
    body,
    phoneTitle: '实验模板预览',
    withTrial: true
  });
  shell.saveBtn.onclick = async () => {
    if (!exp.name.trim()) return toast('请填写实验名称');
    shell.saveBtn.disabled = true;
    try {
      await api('/api/admin/experiment/update', {
        body: { id: exp.id, name: exp.name.trim(), timing: exp.timing, items: exp.items.map(stripLocal) }
      });
      await reloadExperiments();
      toast('已保存该实验模板');
      state.trial = null;
      location.hash = '#/exp';
    } catch (err) {
      toast(err.message || '保存失败，请重试');
    } finally {
      shell.saveBtn.disabled = false;
    }
  };
  renderPhoneOnly();
}

function stripLocal(item) {
  const out = JSON.parse(JSON.stringify(item));
  delete out.collapsed;
  return out;
}

function openExperimentModal({ mode, source }) {
  const isCopy = mode === 'copy';
  const nameField = makeField('实验名称', isCopy ? `${source.name} 副本` : '', 1);
  const body = el('div', 'modal-fields');
  body.appendChild(el('p', 'modal-note', isCopy
    ? `将完整复制「${source.name}」的题目与计时默认值。`
    : '创建后生成空白模板，请进入编辑页插入题目。'));
  body.appendChild(nameField.wrap);
  openModal({
    title: isCopy ? '复制实验模板' : '新建实验模板',
    body,
    confirmLabel: isCopy ? '复制并进入编辑' : '创建并进入编辑',
    onConfirm: async () => {
      const name = nameField.input.value.trim();
      if (!name) return showModalError('实验名称不能为空');
      let created;
      try {
        created = (await api('/api/admin/experiment/create', { body: { name, copyFrom: isCopy ? source.id : '' } })).experiment;
      } catch (err) {
        return showModalError(err.message || '创建失败，请重试');
      }
      await reloadExperiments();
      closeModal();
      toast(isCopy ? '已复制实验模板' : '已创建实验模板');
      location.hash = `#/exp/${created.id}`;
    }
  });
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
  const btn = el('button', 'primary-btn', '+ 新建问卷');
  btn.onclick = () => openQuestionnaireModal({ mode: 'new' });
  head.append(box, btn);
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
    input.value = `${location.origin}/chat?q=${q.id}`;
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
    const bEdit = el('button', 'ghost-btn', '编辑');
    bEdit.onclick = (e) => { e.stopPropagation(); location.hash = `#/q/${q.id}`; };
    const bData = el('button', 'ghost-btn', '数据');
    bData.onclick = (e) => { e.stopPropagation(); location.hash = `#/q/${q.id}/data`; };
    const bDel = el('button', 'ghost-btn danger', '删除');
    bDel.onclick = (e) => { e.stopPropagation(); removeQuestionnaire(q); };
    actions.append(bEdit, bData, bDel);
    td6.appendChild(actions);
    row.appendChild(td6);
    row.addEventListener('dblclick', () => { location.hash = `#/q/${q.id}`; });
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  $main.appendChild(wrap);
}

function openQuestionnaireModal({ mode, source }) {
  const isCopy = mode === 'copy';
  const nameField = makeField('问卷名称', isCopy ? `${source.title} 副本` : '', 1);
  const body = el('div', 'modal-fields');
  body.appendChild(el('p', 'modal-note', isCopy
    ? `将完整复制「${source.title}」的题目与计时设置（不含数据）。`
    : '新建问卷默认包含：欢迎语（空）、知情同意页、结束语（空）、结束说明页；可在编辑页增删改。'));
  body.appendChild(nameField.wrap);
  openModal({
    title: isCopy ? '复制问卷' : '新建问卷',
    body,
    confirmLabel: isCopy ? '复制并进入编辑' : '创建并进入编辑',
    onConfirm: async () => {
      const title = nameField.input.value.trim();
      if (!title) return showModalError('问卷名称不能为空');
      let created;
      try {
        created = (await api('/api/admin/questionnaire/create', { body: { title, copyFrom: isCopy ? source.id : '' } })).questionnaire;
      } catch (err) {
        return showModalError(err.message || '创建失败，请重试');
      }
      await reloadQuestionnaires();
      closeModal();
      toast(isCopy ? '已复制问卷' : '已创建问卷');
      location.hash = `#/q/${created.id}`;
    }
  });
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
    timing: { ...questionnaire.timing },
    items: questionnaire.items.map((it) => ({ ...it, collapsed: false }))
  };
  state.selected = null;
  state.trial = null;
  setSidebarMode('outline');       // 题目已就绪，切到题目大纲
  renderQEditorBody();
}

function renderQEditorBody() {
  const q = state.editingQ;
  const body = el('div');

  const secBasic = sectionHead('问卷信息', '问卷 = 一条链接 + 一列题目 + 计时默认值。链接自动生成（8 位不透明短码），被试打开即作答。');
  secBasic.id = 'sec-basic';
  const titleField = makeField('问卷名称', q.title, 1);
  titleField.input.addEventListener('input', () => { q.title = titleField.input.value; });
  secBasic.appendChild(titleField.wrap);
  const linkRow = el('div', 'link-row');
  const linkInput = el('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  linkInput.value = `${location.origin}/chat?q=${q.id}`;
  linkInput.addEventListener('click', () => linkInput.select());
  const copyBtn = el('button', 'ghost-btn', '复制链接');
  copyBtn.onclick = () => copyText(linkInput.value, '链接已复制');
  linkRow.append(linkInput, copyBtn);
  secBasic.appendChild(linkRow);
  body.appendChild(secBasic);

  const secTiming = sectionHead('计时与呈现（全局默认值）', '插入实验模板时会带入模板的默认值；单题可勾选覆盖，未勾选的按这里生效。门控按秒计（0 = 无限制），呈现节奏按毫秒计。');
  secTiming.id = 'sec-timing';
  const gateGrid = el('div', 'grid2');
  const rhythmGrid = el('div', 'grid2');
  for (const key of TIMING_KEYS()) {
    const meta = TIMING_META()[key];
    const isRhythm = meta.group === 'rhythm';
    const f = makeNumberField(`${meta.label}（${meta.unit}）`, q.timing[key], 0, isRhythm ? 10000 : 86400, meta.hint);
    f.input.addEventListener('input', () => {
      q.timing[key] = Number(f.input.value) || 0;
      renderPhoneOnly();
    });
    (isRhythm ? rhythmGrid : gateGrid).appendChild(f.wrap);
  }
  secTiming.append(
    el('p', 'section-hint', '作答门控（秒，默认 0 = 无限制）'), gateGrid,
    el('p', 'section-hint', '呈现节奏（毫秒）'), rhythmGrid
  );
  body.appendChild(secTiming);

  const secItems = sectionHead(`题目编排（${q.items.length} 道 · 默认全部展开）`, '问卷默认已含欢迎语（空）、知情同意页、结束语（空）、结束说明页，均可编辑或删除。可逐题插入、批量插入打分题，或整组插入实验模板后逐条修改。');
  secItems.id = 'sec-items';
  const editor = buildItemEditor(q.items, q.timing, {
    withTemplateInsert: true,
    onChange: () => {
      secItems.querySelector('.section-title').textContent = `题目编排（${q.items.length} 道 · 默认全部展开）`;
      renderPhoneOnly();
      renderOutline();
    }
  });
  secItems.appendChild(editor.wrap);
  body.appendChild(secItems);

  const shell = editorShell({
    title: `修改问卷 · ${q.title || '未命名'}`,
    backHash: '#/q',
    saveLabel: '保存问卷',
    hint: `共 ${q.items.length} 道题`,
    body,
    phoneTitle: q.title || '未命名问卷',
    withTrial: true
  });
  shell.saveBtn.onclick = async () => {
    if (!q.title.trim()) return toast('请填写问卷名称');
    shell.saveBtn.disabled = true;
    try {
      await api('/api/admin/questionnaire/update', {
        body: { id: q.id, title: q.title.trim(), timing: q.timing, items: q.items.map(stripLocal) }
      });
      await reloadQuestionnaires();
      toast('已保存问卷');
      state.trial = null;
      location.hash = '#/q';
    } catch (err) {
      toast(err.message || '保存失败，请重试');
    } finally {
      shell.saveBtn.disabled = false;
    }
  };
  renderPhoneOnly();
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
  const { questionnaire, sessions, answerable } = data;
  const totalAnswers = answerable == null ? questionnaire.itemCount : answerable;

  const panel = el('div', 'data-panel');
  const phead = el('div', 'panel-head');
  const box = el('div', 'grow');
  box.append(el('h2', '', `${questionnaire.title} · 数据`), el('p', 'panel-sub', `共 ${sessions.length} 位被试 · 问卷共 ${questionnaire.itemCount} 道题（其中 ${totalAnswers} 道需作答）。点击一行查看该被试的完整作答与对话。`));
  const exportBtn = el('button', 'primary-btn', '导出 Excel');
  exportBtn.onclick = () => exportXlsx(questionnaire);
  phead.append(box, exportBtn);
  panel.appendChild(phead);

  const linkRow = el('div', 'link-row');
  const linkInput = el('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  linkInput.value = `${location.origin}/chat?q=${questionnaire.id}`;
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

  const wrap = el('div', 'data-table-wrap');
  const table = el('table', 'data-table');
  const thead = el('thead');
  const tr = el('tr');
  for (const t of ['编号', '状态', '作答进度', '开始时间', '结束时间', '时长']) tr.appendChild(el('th', '', t));
  thead.appendChild(tr);
  const tbody = el('tbody');
  for (const s of sessions) {
    const row = el('tr');
    row.append(
      el('td', 'cell-strong', s.seq == null ? '—' : `#${s.seq}`),
      el('td', '', s.statusLabel),
      el('td', '', `${s.answerCount} / ${totalAnswers}`),
      el('td', '', formatTime(s.startedAt)),
      el('td', '', formatTime(s.endedAt)),
      el('td', '', formatDuration(s.durationSec))
    );
    row.onclick = () => { location.hash = `#/q/${questionnaire.id}/s/${s.id}`; };
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
  $main.appendChild(panel);
}

async function exportXlsx(questionnaire) {
  try {
    const res = await fetch(`/api/admin/questionnaire/export.xlsx?id=${encodeURIComponent(questionnaire.id)}`, {
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
    ['作答进度', `${responses.length} / ${session.totalAnswers}`],
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

  const secMsg = sectionHead('对话记录', '被试端界面中实际呈现的全部消息；定时消息（延迟发出）标注可见时间。');
  const timeline = el('div', 'msg-timeline');
  for (const m of messages) {
    const item = el('div', m.role === 'user' ? 'msg-item' : 'msg-item msg-ai');
    const h = el('div', 'msg-head');
    const delayed = m.visible_at && new Date(m.visible_at).getTime() > new Date(m.created_at).getTime() + 1000;
    h.append(
      el('span', 'msg-role', m.role === 'user' ? '被试' : '系统'),
      el('span', 'msg-time', formatTime(m.created_at) + (delayed ? ' · 延迟发出' : ''))
    );
    item.append(h, el('p', 'msg-content', m.content));
    timeline.appendChild(item);
  }
  secMsg.appendChild(timeline);
  panel.appendChild(secMsg);
  $main.appendChild(panel);
}

/* ---------------------------------------------------------------- 启动 */

boot();
