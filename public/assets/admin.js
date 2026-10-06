// 管理端逻辑：登录鉴权 + hash 路由（问卷管理 / 流程页面 / 研究2 / 研究3）
// 问卷是独立空间：固定组别 + 实验编排（研究2 / 研究3 可多个混排）+ 独立流程文案快照；
// 「流程页面」保存的是新建问卷的默认文案模板；被试端链接为 /chat?q=<问卷短码>。
'use strict';

/* ---------------------------------------------------------------- 元素 */

const $ = (id) => document.getElementById(id);

const $loginView = $('login-view');
const $adminView = $('admin-view');
const $loginForm = $('login-form');
const $loginPassword = $('login-password');
const $loginBtn = $('login-btn');
const $loginError = $('login-error');
const $btnLogout = $('btn-logout');
const $qList = $('q-list');
const $btnNewQuestionnaire = $('btn-new-questionnaire');
const $qEditor = $('q-editor');
const $qEditorTitle = $('q-editor-title');
const $qEditorHint = $('q-editor-hint');
const $qEditorSave = $('q-editor-save');
const $qDetailHead = $('q-detail-head');
const $qDetailTitle = $('q-detail-title');
const $qDetailToolbar = $('q-detail-toolbar');
const $qDetailSummary = $('q-detail-summary');
const $qDetailList = $('q-detail-list');
const $qSession = $('q-session');
const $qSessionTitle = $('q-session-title');
const $r2List = $('r2-list');
const $r2Editor = $('r2-editor');
const $r2EditorTitle = $('r2-editor-title');
const $r2EditorHint = $('r2-editor-hint');
const $r2EditorSave = $('r2-editor-save');
const $r3List = $('r3-list');
const $r3Editor = $('r3-editor');
const $r3EditorTitle = $('r3-editor-title');
const $r3EditorHint = $('r3-editor-hint');
const $r3EditorSave = $('r3-editor-save');
const $flowForm = $('flow-form');
const $flowHint = $('flow-hint');
const $flowSave = $('flow-save');
const $toast = $('toast');
const $sidebar = document.querySelector('.sidebar');
const $btnSidebarToggle = $('btn-sidebar-toggle');
const $btnNewScenario = $('btn-new-scenario');
const $modal = $('modal');
const $modalTitle = $('modal-title');
const $modalBody = $('modal-body');
const $modalError = $('modal-error');
const $modalCancel = $('modal-cancel');
const $modalConfirm = $('modal-confirm');
// 通用问卷（sv）
const $adminMain = document.querySelector('.admin-main');
const $svList = $('sv-list');
const $btnNewSurvey = $('btn-new-survey');
const $svEditor = $('sv-editor');
const $svEditorTitle = $('sv-editor-title');
const $svEditorLink = $('sv-editor-link');
const $svEditorHint = $('sv-editor-hint');
const $svEditorSave = $('sv-editor-save');
const $svEditorScroll = $('sv-editor-scroll');
const $svPreview = $('sv-preview');
const $svPvTag = $('sv-pv-tag');
const $svPvTrial = $('sv-pv-trial');
const $svDataHead = $('sv-data-head');
const $svDataTitle = $('sv-data-title');
const $svDataToolbar = $('sv-data-toolbar');
const $svDataSummary = $('sv-data-summary');
const $svDataList = $('sv-data-list');
const $svSession = $('sv-session');
const $svSessionTitle = $('sv-session-title');

const TOKEN_KEY = 'expchat_admin_token';
const SIDEBAR_KEY = 'expchat_admin_sidebar_collapsed';
const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  scenarios: [],
  settings: null,
  questionnaires: []
};

// 任务类型：play_count 1 = 单次博弈，100 = 多次博弈
const PLAY_LABEL = { 1: '单次博弈', 100: '多次博弈' };
// 实验类型与组别展示文案
const KIND_LABEL = { r2: '研究2', r3: '研究3' };
const ROLE_LABEL = { control: '控制组', treat: '干预组' };

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
    method: options.method || 'GET',
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
    setTimeout(() => $toast.classList.add('hidden'), 240);
  }, 2200);
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage || '已复制');
    return;
  } catch {
    /* 降级方案 */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast(successMessage || '已复制');
  } catch {
    toast('复制失败，请手动选择文本复制');
  }
  ta.remove();
}

// 单行输入（rows 为空或 1）或多行文本域
function makeField(labelText, value, rows) {
  const wrap = el('label', 'field');
  wrap.appendChild(el('span', '', labelText));
  let input;
  if (rows && rows > 1) {
    input = el('textarea');
    input.rows = rows;
  } else {
    input = el('input');
    input.type = 'text';
  }
  input.value = value || '';
  wrap.appendChild(input);
  return { wrap, input };
}

function setHint(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle('err', Boolean(isError));
}

// 编辑页区块：标题 + 可选全局标签 / 说明 + 分割线（样式见 admin.css .editor-section）
function sectionHead(title, options = {}) {
  const section = el('section', 'editor-section');
  const head = el('div', 'editor-section-head');
  head.appendChild(el('h3', 'editor-section-title', title));
  if (options.global) {
    head.appendChild(el('span', 'tag-global', '全局 · 修改后对所有情景生效'));
  }
  section.appendChild(head);
  if (options.hint) section.appendChild(el('p', 'editor-section-hint', options.hint));
  return section;
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

/* ---------------------------------------------------------------- 登录与进入 */

async function enterAdmin() {
  await loadAll();
  $loginView.classList.add('hidden');
  $adminView.classList.remove('hidden');
  handleRoute();
}

async function boot() {
  if (!state.token) return;
  try {
    await enterAdmin();
  } catch (err) {
    if (err.status === 401) {
      state.token = '';
      sessionStorage.removeItem(TOKEN_KEY);
    }
  }
}

$loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $loginPassword.value;
  if (!password) return;

  $loginBtn.disabled = true;
  try {
    const res = await api('/api/admin/login', { method: 'POST', body: { password } });
    state.token = res.token;
    sessionStorage.setItem(TOKEN_KEY, res.token);
    $loginError.classList.add('hidden');
    $loginPassword.value = '';
    await enterAdmin();
  } catch (err) {
    $loginError.textContent = err.message || '密码不正确，请重试。';
    $loginError.classList.remove('hidden');
    $loginPassword.select();
  } finally {
    $loginBtn.disabled = false;
  }
});

$btnLogout.addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch {
    /* 忽略退出接口错误，本地清理即可 */
  }
  state.token = '';
  sessionStorage.removeItem(TOKEN_KEY);
  location.reload();
});

/* ---------------------------------------------------------------- 侧边栏折叠 */

function applySidebarCollapsed(collapsed) {
  $sidebar.classList.toggle('collapsed', collapsed);
  $btnSidebarToggle.textContent = collapsed ? '›' : '‹';
  $btnSidebarToggle.title = collapsed ? '展开侧边栏' : '折叠侧边栏';
}

$btnSidebarToggle.addEventListener('click', () => {
  const collapsed = !$sidebar.classList.contains('collapsed');
  applySidebarCollapsed(collapsed);
  localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
});

applySidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === '1');

/* ---------------------------------------------------------------- hash 路由 */

function findScenario(id) {
  return state.scenarios.find((s) => s.id === id) || null;
}

// #/q、#/q/new、#/q/:id、#/q/:id/edit、#/q/:id/s/:sid
// #/r2、#/r2/:id、#/r3、#/r3/:id、#/flow
// #/sv、#/sv/:id（编辑）、#/sv/:id/data（数据）、#/sv/:id/s/:sid（个案）
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [section, a, b, c] = raw.split('/');

  if (section === 'q') {
    if (!a) return { section, view: 'list', id: '', sid: '' };
    if (a === 'new') return { section, view: 'editor', id: '', sid: '' };
    if (b === 'edit') return { section, view: 'editor', id: a, sid: '' };
    if (b === 's' && c) return { section, view: 'session', id: a, sid: c };
    return { section, view: 'detail', id: a, sid: '' };
  }
  if (section === 'sv') {
    if (!a || a === 'new') return { section, view: 'list', id: '', sid: '' };
    if (b === 'data') return { section, view: 'data', id: a, sid: '' };
    if (b === 's' && c) return { section, view: 'session', id: a, sid: c };
    return { section, view: 'editor', id: a, sid: '' };
  }
  if (section === 'r2' || section === 'r3') return { section, view: a ? 'editor' : 'list', id: a || '', sid: '' };
  if (section === 'flow') return { section, view: 'flow', id: '', sid: '' };
  return null;
}

// 视图层级：列表 → 编辑 / 详情 / 个案为「前进」，反向为「后退」，同级切换为淡入
function animForTransition(prevViewId, nextViewId) {
  const forward = [
    ['view-q-list', 'view-q-editor'],
    ['view-q-list', 'view-q-detail'],
    ['view-q-detail', 'view-q-session'],
    ['view-r2-list', 'view-r2-editor'],
    ['view-r3-list', 'view-r3-editor'],
    ['view-sv-list', 'view-sv-editor'],
    ['view-sv-list', 'view-sv-data'],
    ['view-sv-data', 'view-sv-session']
  ];
  const backward = forward.map(([a, b]) => [b, a]);
  if (forward.some(([a, b]) => a === prevViewId && b === nextViewId)) return 'anim-right';
  if (backward.some(([a, b]) => a === prevViewId && b === nextViewId)) return 'anim-left';
  return 'anim-fade';
}

let currentViewId = '';

function handleRoute() {
  if ($adminView.classList.contains('hidden')) return;

  if (!location.hash) {
    location.replace('#/q');
    return;
  }
  const route = parseHash();
  if (!route) {
    location.replace('#/q');
    return;
  }
  if ((route.section === 'r2' || route.section === 'r3') && route.id && !findScenario(route.id)) {
    location.replace(`#/${route.section}`);
    return;
  }

  document.querySelectorAll('.sidebar-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.nav === route.section);
  });

  let viewId = 'view-q-list';
  if (route.section === 'q') {
    if (route.view === 'editor') viewId = 'view-q-editor';
    else if (route.view === 'detail') viewId = 'view-q-detail';
    else if (route.view === 'session') viewId = 'view-q-session';
    else viewId = 'view-q-list';
  } else if (route.section === 'sv') {
    if (route.view === 'editor') viewId = 'view-sv-editor';
    else if (route.view === 'data') viewId = 'view-sv-data';
    else if (route.view === 'session') viewId = 'view-sv-session';
    else viewId = 'view-sv-list';
  } else if (route.section === 'r2') viewId = route.id ? 'view-r2-editor' : 'view-r2-list';
  else if (route.section === 'r3') viewId = route.id ? 'view-r3-editor' : 'view-r3-list';
  else if (route.section === 'flow') viewId = 'view-flow';

  // 通用问卷编辑器：加宽主区并让两栏撑满视口（左独立滚动 + 右手机常驻）
  $adminMain.classList.toggle('sv-editing', viewId === 'view-sv-editor');

  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('hidden', view.id !== viewId);
  });

  // 播放进入动画（重置类名以重启动画）
  const targetView = $(viewId);
  targetView.classList.remove('anim-right', 'anim-left', 'anim-fade');
  void targetView.offsetWidth;
  targetView.classList.add(animForTransition(currentViewId, viewId));
  currentViewId = viewId;

  if (viewId === 'view-q-list') renderQList();
  else if (viewId === 'view-q-editor') renderQEditor(route.id);
  else if (viewId === 'view-q-detail') renderQDetail(route.id);
  else if (viewId === 'view-q-session') renderQSession(route.id, route.sid);
  else if (viewId === 'view-r2-list') renderR2List();
  else if (viewId === 'view-r2-editor') renderR2Editor(findScenario(route.id));
  else if (viewId === 'view-r3-list') renderR3List();
  else if (viewId === 'view-r3-editor') renderR3Editor(findScenario(route.id));
  else if (viewId === 'view-flow') renderFlowForm();
  else if (viewId === 'view-sv-list') renderSvList();
  else if (viewId === 'view-sv-editor') renderSvEditor(route.id);
  else if (viewId === 'view-sv-data') renderSvData(route.id);
  else if (viewId === 'view-sv-session') renderSvSession(route.id, route.sid);

  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', handleRoute);

$('r2-editor-back').addEventListener('click', () => {
  location.hash = '#/r2';
});
$('r3-editor-back').addEventListener('click', () => {
  location.hash = '#/r3';
});
$('q-editor-back').addEventListener('click', () => {
  location.hash = '#/q';
});
$('q-detail-back').addEventListener('click', () => {
  location.hash = '#/q';
});
$('q-session-back').addEventListener('click', () => {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  location.hash = parts[1] ? `#/q/${parts[1]}` : '#/q';
});
$('sv-editor-back').addEventListener('click', () => {
  location.hash = '#/sv';
});
$('sv-data-back').addEventListener('click', () => {
  location.hash = '#/sv';
});
$('sv-session-back').addEventListener('click', () => {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  location.hash = parts[1] ? `#/sv/${parts[1]}/data` : '#/sv';
});

/* ---------------------------------------------------------------- 数据加载 */

async function loadAll() {
  const [scenariosData, settingsData] = await Promise.all([
    api('/api/admin/scenarios'),
    api('/api/admin/settings')
  ]);
  state.scenarios = scenariosData.scenarios;
  state.settings = settingsData.settings;
}

/* ---------------------------------------------------------------- 任务清单编辑器 */

// 每项含类型标签 + 上移 / 下移 / 移除；同类型任务不可重复添加
function buildTaskEditor(tasks) {
  const wrap = el('div', 'task-editor');
  const list = el('div', 'task-list');
  const addRow = el('div', 'task-add-row');
  addRow.appendChild(el('span', 'task-add-label', '添加任务：'));
  const btnOnce = el('button', 'mini-btn', '+ 单次博弈');
  const btnMulti = el('button', 'mini-btn', '+ 多次博弈');
  [btnOnce, btnMulti].forEach((b) => {
    b.type = 'button';
  });
  addRow.append(btnOnce, btnMulti);

  function refresh() {
    const items = [...list.children];
    items.forEach((item, i) => {
      item.querySelector('.task-seq').textContent = `任务 ${i + 1}`;
      item.querySelector('.btn-move-up').disabled = i === 0;
      item.querySelector('.btn-move-down').disabled = i === items.length - 1;
      item.querySelector('.btn-remove').disabled = items.length <= 1;
    });
    const plays = items.map((n) => Number(n.dataset.play));
    btnOnce.disabled = plays.includes(1);
    btnMulti.disabled = plays.includes(100);
  }

  function addItem(play) {
    const item = el('div', 'task-item');
    item.dataset.play = String(play);

    const seq = el('span', 'task-seq', '');
    const label = el('span', 'task-label', PLAY_LABEL[play]);
    const tools = el('div', 'reply-tools');
    const btnUp = el('button', 'mini-btn btn-move-up', '↑');
    const btnDown = el('button', 'mini-btn btn-move-down', '↓');
    const btnDel = el('button', 'mini-btn btn-remove', '移除');
    [btnUp, btnDown, btnDel].forEach((b) => {
      b.type = 'button';
    });
    btnUp.title = '上移';
    btnDown.title = '下移';
    tools.append(btnUp, btnDown, btnDel);

    btnUp.addEventListener('click', () => {
      const prev = item.previousElementSibling;
      if (prev) {
        list.insertBefore(item, prev);
        refresh();
      }
    });
    btnDown.addEventListener('click', () => {
      const next = item.nextElementSibling;
      if (next) {
        list.insertBefore(next, item);
        refresh();
      }
    });
    btnDel.addEventListener('click', () => {
      if (list.children.length <= 1) {
        toast('至少保留一个任务');
        return;
      }
      item.remove();
      refresh();
    });

    item.append(seq, label, tools);
    list.appendChild(item);
  }

  for (const play of tasks) addItem(play);
  btnOnce.addEventListener('click', () => {
    addItem(1);
    refresh();
  });
  btnMulti.addEventListener('click', () => {
    addItem(100);
    refresh();
  });

  wrap.append(list, addRow);
  refresh();
  return { wrap, list };
}

/* ---------------------------------------------------------------- 研究2 */

function taskSummary(tasks) {
  return tasks.map((t) => PLAY_LABEL[t] || String(t)).join(' → ');
}

// 列表行卡：名称 + id + 概要 + 操作（研究2 列表额外带复制 / 删除）
function researchRow(scenario, research) {
  const row = el('article', 'scenario-row');
  const info = el('div', 'scenario-row-info');
  const title = el('div', 'scenario-row-title');
  title.append(el('span', 'scenario-row-name', scenario.name), el('code', 'group-id', scenario.id));
  info.appendChild(title);

  let sub;
  if (research === 'r2') {
    sub = `任务清单：${taskSummary(scenario.tasks)}`;
  } else {
    sub = `分组：${scenario.groups.map((g) => g.name).join(' / ')}`;
  }
  info.appendChild(el('p', 'scenario-row-sub', sub));

  const actions = el('div', 'scenario-row-actions');
  if (research === 'r2') {
    const btnCopy = el('button', 'ghost-btn', '复制');
    btnCopy.type = 'button';
    btnCopy.addEventListener('click', () => openScenarioModal({ mode: 'copy', source: scenario }));
    const btnDel = el('button', 'ghost-btn danger', '删除');
    btnDel.type = 'button';
    btnDel.addEventListener('click', () => removeScenario(scenario));
    actions.append(btnCopy, btnDel);
  }

  const btn = el('button', 'primary-btn', '进入编辑');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    location.hash = `#/${research}/${scenario.id}`;
  });
  actions.appendChild(btn);
  row.append(info, actions);
  return row;
}

function renderR2List() {
  $r2List.innerHTML = '';
  for (const scenario of state.scenarios) {
    $r2List.appendChild(researchRow(scenario, 'r2'));
  }
}

function renderR2Editor(scenario) {
  $r2EditorTitle.textContent = `研究2 · ${scenario.name}`;
  setHint($r2EditorHint, '');
  $r2Editor.innerHTML = '';

  // 1 基础信息
  const secBasic = sectionHead('基础信息');
  const nameField = makeField('情景名称（管理端显示）', scenario.name, 1);
  secBasic.appendChild(nameField.wrap);

  // 2 情境材料与提问
  const secMaterial = sectionHead('情境材料与提问', {
    hint: '进入任务时完整呈现；被试阅读后完成第一次决策。'
  });
  const contextField = makeField('情境材料', scenario.contextText, 6);
  const onceQuestion = makeField('单次博弈提问', scenario.onceQuestion, 3);
  const multiQuestion = makeField('多次博弈提问', scenario.multiQuestion, 3);
  secMaterial.append(contextField.wrap, onceQuestion.wrap, multiQuestion.wrap);

  // 3 决策选择卡片（全局）
  const secChoice = sectionHead('决策选择卡片', {
    global: true,
    hint: '被试第一次决策时看到的选项卡片（4 个），对被试端所有情景统一生效。'
  });
  const optionFields = [0, 1, 2, 3].map((i) =>
    makeField(`选项 ${i + 1}`, state.settings.choiceOptions[i] ? state.settings.choiceOptions[i].label : '', 1)
  );
  for (const f of optionFields) secChoice.appendChild(f.wrap);

  // 4 研究2 匹配文本
  const secR2 = sectionHead('研究2 匹配文本', {
    hint: '被试完成第一次决策后，按「决策方向 × 任务类型」呈现对应文本，随后对该文本与自身思考过程的相似度评分。'
  });
  const r2OnceA = makeField('单次 · 选择方案A', scenario.r2OnceA, 5);
  const r2OnceB = makeField('单次 · 选择方案B', scenario.r2OnceB, 5);
  const r2MultiA = makeField('多次 · 选择方案A', scenario.r2MultiA, 5);
  const r2MultiB = makeField('多次 · 选择方案B', scenario.r2MultiB, 5);
  const r2Row1 = el('div', 'form-row form-row-split');
  r2Row1.append(r2OnceA.wrap, r2OnceB.wrap);
  const r2Row2 = el('div', 'form-row form-row-split');
  r2Row2.append(r2MultiA.wrap, r2MultiB.wrap);
  secR2.append(r2Row1, r2Row2);

  // 5 相似度评分
  const secRating = sectionHead('相似度评分', {
    hint: '评分锚点（1 / 7 端点文字）为全局设置，修改后对被试端所有情景的评分刻度生效。'
  });
  const ratingField = makeField('相似度评分题目（7 点量表）', scenario.ratingQuestion, 2);
  const anchorField = makeField('评分锚点（1 / 7 端点文字 · 全局）', state.settings.ratingAnchor, 1);
  secRating.append(ratingField.wrap, anchorField.wrap);

  // 6 任务清单
  const secTasks = sectionHead('任务清单（被试按顺序完成）', {
    hint: '每个任务在研究2 中为「决策 → 匹配文本 → 评分」，与研究3 相互独立；此处只配置任务类型与顺序。'
  });
  const taskEditor = buildTaskEditor(scenario.tasks);
  secTasks.appendChild(taskEditor.wrap);

  $r2Editor.append(secBasic, secMaterial, secChoice, secR2, secRating, secTasks);

  // 保存：整页一次性提交（含全局选项卡片与评分锚点，同事务生效）
  $r2EditorSave.onclick = async () => {
    const payload = {
      id: scenario.id,
      name: nameField.input.value.trim(),
      contextText: contextField.input.value,
      onceQuestion: onceQuestion.input.value,
      multiQuestion: multiQuestion.input.value,
      r2OnceA: r2OnceA.input.value,
      r2OnceB: r2OnceB.input.value,
      r2MultiA: r2MultiA.input.value,
      r2MultiB: r2MultiB.input.value,
      ratingQuestion: ratingField.input.value,
      tasks: [...taskEditor.list.children].map((n) => Number(n.dataset.play)),
      groups: scenario.groups.map((g) => ({ id: g.id, name: g.name, r3Once: g.r3Once, r3Multi: g.r3Multi })),
      globalTexts: {
        choiceOption1: optionFields[0].input.value.trim(),
        choiceOption2: optionFields[1].input.value.trim(),
        choiceOption3: optionFields[2].input.value.trim(),
        choiceOption4: optionFields[3].input.value.trim(),
        ratingAnchor: anchorField.input.value.trim()
      }
    };

    const checks = [
      [payload.name, '请填写情景名称'],
      [payload.contextText, '情境材料不能为空'],
      [payload.onceQuestion, '单次博弈提问不能为空'],
      [payload.multiQuestion, '多次博弈提问不能为空'],
      [payload.r2OnceA, '单次·选A 文本不能为空'],
      [payload.r2OnceB, '单次·选B 文本不能为空'],
      [payload.r2MultiA, '多次·选A 文本不能为空'],
      [payload.r2MultiB, '多次·选B 文本不能为空'],
      [payload.ratingQuestion, '相似度评分题目不能为空'],
      [payload.globalTexts.choiceOption1, '选项 1 文案不能为空'],
      [payload.globalTexts.choiceOption2, '选项 2 文案不能为空'],
      [payload.globalTexts.choiceOption3, '选项 3 文案不能为空'],
      [payload.globalTexts.choiceOption4, '选项 4 文案不能为空'],
      [payload.globalTexts.ratingAnchor, '评分锚点不能为空']
    ];
    for (const [value, message] of checks) {
      if (!String(value).trim()) return setHint($r2EditorHint, message, true);
    }
    if (payload.tasks.length === 0) return setHint($r2EditorHint, '任务清单至少包含一个任务', true);

    setHint($r2EditorHint, '保存中…');
    $r2EditorSave.disabled = true;
    try {
      const res = await api('/api/admin/scenario', { method: 'POST', body: payload });
      Object.assign(scenario, res.scenario);
      // 同步全局文案（选项卡片 / 锚点）到本地缓存
      state.settings.choiceOptions = state.settings.choiceOptions.map((c, i) => ({
        value: c.value,
        label: payload.globalTexts[`choiceOption${i + 1}`]
      }));
      state.settings.ratingAnchor = payload.globalTexts.ratingAnchor;
      toast('已保存');
      location.hash = '#/r2'; // 保存后自动返回列表（路由播放后退动画）
    } catch (err) {
      setHint($r2EditorHint, err.message || '保存失败，请重试', true);
    } finally {
      $r2EditorSave.disabled = false;
    }
  };
}

/* ---------------------------------------------------------------- 研究3 */

function renderR3List() {
  $r3List.innerHTML = '';
  for (const scenario of state.scenarios) {
    $r3List.appendChild(researchRow(scenario, 'r3'));
  }
}

// 「从研究2复用」行：选择研究2 四段匹配文本之一，一键填入目标文本域
function buildReuseRow(scenario, textarea) {
  const row = el('div', 'reuse-row');
  row.appendChild(el('span', 'reuse-label', '从研究2复用：'));
  const select = el('select', 'reuse-select');
  for (const [key, label] of [
    ['r2OnceA', '单次 · 选择方案A'],
    ['r2OnceB', '单次 · 选择方案B'],
    ['r2MultiA', '多次 · 选择方案A'],
    ['r2MultiB', '多次 · 选择方案B']
  ]) {
    const opt = el('option', '', `研究2 ${label}`);
    opt.value = key;
    select.appendChild(opt);
  }
  const btn = el('button', 'mini-btn', '填入');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    textarea.value = scenario[select.value] || '';
    toast('已填入，保存后生效');
  });
  row.append(select, btn);
  return row;
}

// 组别区块：控制组 / 干预组各自的研究3 文本（每个文本域上方带复用选择器）
function buildR3GroupBlock(scenario, group) {
  const block = el('div', 'group-block');

  const head = el('div', 'group-block-head');
  head.append(
    el('span', 'role-tag', group.role === 'control' ? '控制组' : '干预组'),
    el('code', 'group-id', group.id)
  );
  block.appendChild(head);

  const nameField = makeField('组名（仅管理端可见）', group.name, 1);
  block.appendChild(nameField.wrap);

  const onceField = makeField('研究3 文本 · 单次博弈任务时呈现', group.r3Once, 4);
  block.append(buildReuseRow(scenario, onceField.input), onceField.wrap);

  const multiField = makeField('研究3 文本 · 多次博弈任务时呈现', group.r3Multi, 4);
  block.append(buildReuseRow(scenario, multiField.input), multiField.wrap);

  return {
    wrap: block,
    collect: () => ({
      id: group.id,
      name: nameField.input.value.trim(),
      r3Once: onceField.input.value,
      r3Multi: multiField.input.value
    })
  };
}

function renderR3Editor(scenario) {
  $r3EditorTitle.textContent = `研究3 · ${scenario.name}`;
  setHint($r3EditorHint, '');
  $r3Editor.innerHTML = '';

  const secGroups = sectionHead('组别文本', {
    hint: '每个情景固定控制 / 干预两组：控制组呈现客观描述文本，干预组呈现说服文本。问卷创建时选定其中一组，被试端不显示组别。可从研究2 匹配文本一键复用后微调。'
  });
  const blocks = scenario.groups.map((group) => buildR3GroupBlock(scenario, group));
  for (const b of blocks) secGroups.appendChild(b.wrap);
  $r3Editor.appendChild(secGroups);

  // 保存：情景级字段取当前现值，仅提交两组文本
  $r3EditorSave.onclick = async () => {
    const payload = {
      id: scenario.id,
      name: scenario.name,
      contextText: scenario.contextText,
      onceQuestion: scenario.onceQuestion,
      multiQuestion: scenario.multiQuestion,
      r2OnceA: scenario.r2OnceA,
      r2OnceB: scenario.r2OnceB,
      r2MultiA: scenario.r2MultiA,
      r2MultiB: scenario.r2MultiB,
      ratingQuestion: scenario.ratingQuestion,
      tasks: [...scenario.tasks],
      groups: blocks.map((b) => b.collect())
    };

    for (const g of payload.groups) {
      if (!g.name) return setHint($r3EditorHint, '组名不能为空', true);
      if (!g.r3Once.trim() || !g.r3Multi.trim()) {
        return setHint($r3EditorHint, `${g.name}的研究3文本不能为空`, true);
      }
    }

    setHint($r3EditorHint, '保存中…');
    $r3EditorSave.disabled = true;
    try {
      const res = await api('/api/admin/scenario', { method: 'POST', body: payload });
      Object.assign(scenario, res.scenario);
      toast('已保存');
      location.hash = '#/r3'; // 保存后自动返回列表（路由播放后退动画）
    } catch (err) {
      setHint($r3EditorHint, err.message || '保存失败，请重试', true);
    } finally {
      $r3EditorSave.disabled = false;
    }
  };
}

/* ---------------------------------------------------------------- 流程页面（默认文案模板） */

// 仅构建一次：切换视图不重建，避免丢失未保存的编辑；保存成功后强制重建
function renderFlowForm(force = false) {
  if ($flowForm.dataset.built === '1' && !force) return;
  $flowForm.dataset.built = '1';
  setHint($flowHint, '');
  $flowForm.innerHTML = '';
  const s = state.settings;

  const secProcess = sectionHead('会话流程文案', {
    hint: '欢迎语在进入实验时呈现；衔接语在每完成一个任务后呈现；结束语在全部任务完成后呈现。'
  });
  const welcomeField = makeField('欢迎语', s.welcomeText, 3);
  const nextField = makeField('任务衔接语', s.nextTaskText, 2);
  const endField = makeField('结束语', s.endText, 2);
  secProcess.append(welcomeField.wrap, nextField.wrap, endField.wrap);

  const secConsent = sectionHead('知情同意页', {
    hint: '被试进入实验前首先阅读该说明，勾选「我已阅读」后方可开始；服务端不强制校验，为前端门槛。'
  });
  const consentField = makeField('知情同意正文', s.consentText, 12);
  secConsent.appendChild(consentField.wrap);

  const secDebrief = sectionHead('结束说明页', {
    hint: '任务完成后展示，点击「我已阅读」实验即结束；被试端不提供任何跳转。'
  });
  const debriefField = makeField('结束说明正文', s.debriefText, 12);
  secDebrief.appendChild(debriefField.wrap);

  $flowForm.append(secProcess, secConsent, secDebrief);

  $flowSave.onclick = async () => {
    const payload = {
      welcomeText: welcomeField.input.value,
      nextTaskText: nextField.input.value,
      endText: endField.input.value,
      consentText: consentField.input.value,
      debriefText: debriefField.input.value
    };
    for (const [key, label] of [
      ['welcomeText', '欢迎语'],
      ['nextTaskText', '任务衔接语'],
      ['endText', '结束语'],
      ['consentText', '知情同意正文'],
      ['debriefText', '结束说明正文']
    ]) {
      if (!payload[key].trim()) return setHint($flowHint, `${label}不能为空`, true);
    }

    setHint($flowHint, '保存中…');
    $flowSave.disabled = true;
    try {
      const res = await api('/api/admin/settings', { method: 'POST', body: payload });
      state.settings = res.settings;
      renderFlowForm(true);
      setHint($flowHint, '已保存 ✓');
      toast('已保存（对新建问卷生效）');
    } catch (err) {
      setHint($flowHint, err.message || '保存失败，请重试', true);
    } finally {
      $flowSave.disabled = false;
    }
  };
}

/* ---------------------------------------------------------------- 弹窗（情景新增 / 复制 · 删除确认） */

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

$modal.addEventListener('click', (e) => {
  if (e.target === $modal) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$modal.classList.contains('hidden')) closeModal();
});

$modalConfirm.addEventListener('click', async () => {
  if (!modalOnConfirm) return;
  $modalConfirm.disabled = true;
  try {
    await modalOnConfirm();
  } catch (err) {
    showModalError(err.message || '操作失败，请重试');
  } finally {
    $modalConfirm.disabled = false;
  }
});

/* ---------------------------------------------------------------- 情景 CRUD（研究2 / 研究3 共用） */

function nextScenarioId() {
  let id;
  do {
    id = `scenario-${Math.random().toString(36).slice(2, 7)}`;
  } while (state.scenarios.some((s) => s.id === id));
  return id;
}

async function reloadScenarios() {
  const data = await api('/api/admin/scenarios');
  state.scenarios = data.scenarios;
}

// 新增 / 复制情景：填写 ID 与名称后创建，随即进入研究2 编辑页完善
function openScenarioModal({ mode, source }) {
  const isCopy = mode === 'copy';
  const idField = makeField('情景 ID（小写字母、数字或连字符，40 位以内）', nextScenarioId(), 1);
  const nameField = makeField('情景名称（管理端显示）', isCopy ? `${source.name} 副本` : '', 1);

  const body = el('div', 'modal-fields');
  if (isCopy) {
    body.appendChild(el('p', 'modal-note', `将完整复制「${source.name}」的情境材料、任务清单、研究2 匹配文本与研究3 组别文本。`));
  }
  body.append(idField.wrap, nameField.wrap);

  openModal({
    title: isCopy ? '复制情景' : '新增情景',
    body,
    confirmLabel: isCopy ? '复制并进入编辑' : '创建并进入编辑',
    onConfirm: async () => {
      const id = idField.input.value.trim().toLowerCase();
      const name = nameField.input.value.trim();
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
        return showModalError('情景 ID 需为小写字母、数字或连字符（40 位以内，字母或数字开头）');
      }
      if (!name) return showModalError('情景名称不能为空');

      let created;
      try {
        const res = await api('/api/admin/scenario/create', {
          method: 'POST',
          body: { id, name, copyFrom: isCopy ? source.id : '' }
        });
        created = res.scenario;
      } catch (err) {
        return showModalError(err.message || '创建失败，请重试');
      }
      await reloadScenarios();
      closeModal();
      toast(isCopy ? '已复制情景' : '已创建情景');
      location.hash = `#/r2/${created.id}`;
    }
  });
}

// 删除情景：已有被试会话或仅剩一个时服务端会拒绝，错误信息在弹窗内展示
function removeScenario(scenario) {
  openModal({
    title: '删除情景',
    body: el(
      'p',
      'modal-note',
      `确定删除情景「${scenario.name}」？其情境材料、任务清单与研究3 组别文本将一并删除，且不可恢复。`
    ),
    confirmLabel: '确认删除',
    danger: true,
    onConfirm: async () => {
      try {
        await api('/api/admin/scenario/delete', { method: 'POST', body: { id: scenario.id } });
      } catch (err) {
        return showModalError(err.message || '删除失败，请重试');
      }
      await reloadScenarios();
      closeModal();
      toast('已删除情景');
      renderR2List();
    }
  });
}

$btnNewScenario.addEventListener('click', () => openScenarioModal({ mode: 'new' }));

/* ---------------------------------------------------------------- 问卷管理 · 列表 */

$btnNewQuestionnaire.addEventListener('click', () => {
  location.hash = '#/q/new';
});

async function renderQList() {
  $qList.innerHTML = '';

  let questionnaires;
  try {
    const res = await api('/api/admin/questionnaires');
    questionnaires = res.questionnaires;
    state.questionnaires = questionnaires;
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $qList.appendChild(el('p', 'data-empty', err.message || '问卷列表加载失败'));
    return;
  }

  if (!questionnaires.length) {
    $qList.appendChild(
      el('p', 'data-empty', '还没有问卷。点击右上角「+ 新建问卷」：命名问卷、确认流程文案、插入研究实验，即可生成专属链接。')
    );
    return;
  }

  const wrap = el('div', 'data-table-wrap');
  const table = el('table', 'data-table q-table');

  const thead = el('thead');
  const headRow = el('tr');
  for (const title of ['问卷名称', '被试链接', '实验编排', '组别', '数据量', '创建时间', '操作']) {
    headRow.appendChild(el('th', '', title));
  }
  thead.appendChild(headRow);

  const tbody = el('tbody');
  for (const q of questionnaires) {
    const row = el('tr', 'q-row');
    row.title = '双击查看该问卷的数据';

    // 名称 + 短码
    const nameTd = el('td');
    nameTd.append(el('div', 'cell-strong', q.name), el('code', 'cell-code', q.id));
    row.appendChild(nameTd);

    // 被试链接（自动生成，点击选中，按钮复制）
    const linkTd = el('td', 'q-link-cell');
    linkTd.addEventListener('dblclick', (e) => e.stopPropagation());
    const linkRow = el('div', 'link-row');
    const linkInput = el('input');
    linkInput.type = 'text';
    linkInput.readOnly = true;
    linkInput.value = `${location.origin}/chat?q=${q.id}`;
    linkInput.addEventListener('click', () => linkInput.select());
    const btnCopy = el('button', 'ghost-btn', '复制');
    btnCopy.type = 'button';
    btnCopy.addEventListener('click', () => copyText(linkInput.value, '链接已复制'));
    linkRow.append(linkInput, btnCopy);
    linkTd.appendChild(linkRow);
    row.appendChild(linkTd);

    // 实验编排（按顺序）
    const expTd = el('td');
    const expTags = el('div', 'exp-tags');
    for (const exp of q.experiments) {
      expTags.appendChild(el('span', 'exp-tag', `${exp.sort}. ${KIND_LABEL[exp.kind] || exp.kind}·${exp.scenarioName}`));
    }
    expTd.appendChild(expTags);
    row.appendChild(expTd);

    row.appendChild(el('td', '', ROLE_LABEL[q.groupRole] || q.groupRole));
    row.appendChild(el('td', '', `${q.sessionCount} 份`));
    row.appendChild(el('td', '', formatTime(q.createdAt)));

    // 操作：修改（独立编辑页）/ 删除
    const actTd = el('td');
    actTd.addEventListener('dblclick', (e) => e.stopPropagation());
    const actRow = el('div', 'row-actions');
    const btnEdit = el('button', 'ghost-btn', '修改');
    btnEdit.type = 'button';
    btnEdit.addEventListener('click', () => {
      location.hash = `#/q/${q.id}/edit`;
    });
    const btnDel = el('button', 'ghost-btn danger', '删除');
    btnDel.type = 'button';
    btnDel.addEventListener('click', () => removeQuestionnaire(q));
    actRow.append(btnEdit, btnDel);
    actTd.appendChild(actRow);
    row.appendChild(actTd);

    row.addEventListener('dblclick', () => {
      location.hash = `#/q/${q.id}`;
    });
    tbody.appendChild(row);
  }

  table.append(thead, tbody);
  wrap.appendChild(table);
  $qList.appendChild(wrap);
}

// 删除问卷：有数据时弹窗中明确告知，确认后连同数据一并清空
function removeQuestionnaire(q) {
  let force = q.sessionCount > 0;
  openModal({
    title: '删除问卷',
    body: el(
      'p',
      'modal-note',
      force
        ? `「${q.name}」已有 ${q.sessionCount} 份被试数据，删除将连同全部作答与对话记录一并清空，且不可恢复。`
        : `确定删除问卷「${q.name}」？该操作不可恢复。`
    ),
    confirmLabel: '确认删除',
    danger: true,
    onConfirm: async () => {
      try {
        await api('/api/admin/questionnaire/delete', { method: 'POST', body: { id: q.id, force } });
      } catch (err) {
        if (err.code === 'has_sessions') force = true;
        return showModalError(err.message || '删除失败，请重试');
      }
      closeModal();
      toast('已删除问卷');
      renderQList();
    }
  });
}

/* ---------------------------------------------------------------- 问卷管理 · 创建 / 编辑页 */

// 流程文案块：可整块移除（缺键 = 被试端跳过该内容），可恢复
const FLOW_BLOCK_DEFS = [
  { key: 'welcomeText', title: '欢迎语', hint: '被试进入实验时首先呈现。', rows: 3 },
  { key: 'consentText', title: '知情同意页', hint: '进入实验前的说明页，勾选「我已阅读」后开始；移除则直接开始实验。', rows: 10 },
  { key: 'nextTaskText', title: '任务衔接语', hint: '每完成一个任务后呈现，衔接下一个任务。', rows: 2 },
  { key: 'endText', title: '结束语', hint: '全部任务完成后呈现。', rows: 2 },
  { key: 'debriefText', title: '结束说明页', hint: '全部任务完成后展示，点击「我已阅读」实验即结束；移除则任务结束后直接提示完成。', rows: 10 }
];

// 收尾类文案块（展示在实验编排之后）；其余为开场 / 过程文案（展示在实验编排之前）
const FLOW_TAIL_KEYS = new Set(['endText', 'debriefText']);

function buildFlowBlocks(flow) {
  const beforeSections = [];
  const afterSections = [];
  const blocks = [];

  for (const def of FLOW_BLOCK_DEFS) {
    const present = Object.prototype.hasOwnProperty.call(flow, def.key);
    let removed = !present;

    const section = el('section', 'editor-section flow-block');
    const head = el('div', 'editor-section-head');
    head.appendChild(el('h3', 'editor-section-title', def.title));
    const tools = el('div', 'reply-tools');
    const btnRemove = el('button', 'mini-btn btn-remove', '移除该内容');
    btnRemove.type = 'button';
    tools.appendChild(btnRemove);
    head.appendChild(tools);
    section.appendChild(head);

    const hint = el('p', 'editor-section-hint', def.hint);
    const field = makeField('内容', flow[def.key] || '', def.rows);
    const removedBar = el('div', 'flow-removed');
    removedBar.appendChild(el('span', '', '该内容已移除，被试端将跳过。'));
    const btnRestore = el('button', 'mini-btn', '恢复');
    btnRestore.type = 'button';
    removedBar.appendChild(btnRestore);

    function apply() {
      section.classList.toggle('removed', removed);
      tools.classList.toggle('hidden', removed);
      hint.classList.toggle('hidden', removed);
      field.wrap.classList.toggle('hidden', removed);
      removedBar.classList.toggle('hidden', !removed);
    }

    btnRemove.addEventListener('click', () => {
      removed = true;
      apply();
    });
    btnRestore.addEventListener('click', () => {
      removed = false;
      apply();
    });
    apply();

    section.append(hint, field.wrap, removedBar);
    if (FLOW_TAIL_KEYS.has(def.key)) afterSections.push(section);
    else beforeSections.push(section);
    blocks.push({ key: def.key, isRemoved: () => removed, read: () => field.input.value });
  }

  return {
    beforeSections,
    afterSections,
    collect: () => {
      const out = {};
      for (const block of blocks) {
        if (!block.isRemoved()) out[block.key] = block.read();
      }
      return out;
    }
  };
}

// 实验编排：单个 / 多个研究实验（研究2、研究3 可混排），可增删、上下移
function buildExperimentEditor(experiments) {
  const wrap = el('div', 'exp-editor');
  const list = el('div', 'exp-list');
  const addRow = el('div', 'task-add-row');
  addRow.appendChild(el('span', 'task-add-label', '追加实验：'));
  const addBtn = el('button', 'mini-btn', '+ 插入实验');
  addBtn.type = 'button';
  addRow.appendChild(addBtn);

  function refresh() {
    const items = [...list.children];
    items.forEach((item, i) => {
      item.querySelector('.exp-seq').textContent = `实验 ${i + 1}`;
      item.querySelector('.btn-move-up').disabled = i === 0;
      item.querySelector('.btn-move-down').disabled = i === items.length - 1;
      item.querySelector('.btn-remove').disabled = items.length <= 1;
    });
  }

  function addItem(kind, scenarioId) {
    const item = el('div', 'exp-item');

    const kindSelect = el('select', 'exp-kind');
    for (const [value, label] of [['r2', '研究2 · 策略认可度'], ['r3', '研究3 · 说服干预']]) {
      const opt = el('option', '', label);
      opt.value = value;
      kindSelect.appendChild(opt);
    }
    kindSelect.value = kind === 'r3' ? 'r3' : 'r2';

    const scenarioSelect = el('select', 'exp-scenario');
    for (const scenario of state.scenarios) {
      const opt = el('option', '', scenario.name);
      opt.value = scenario.id;
      scenarioSelect.appendChild(opt);
    }
    scenarioSelect.value =
      scenarioId && state.scenarios.some((s) => s.id === scenarioId)
        ? scenarioId
        : state.scenarios[0]
          ? state.scenarios[0].id
          : '';

    const tools = el('div', 'reply-tools');
    const btnUp = el('button', 'mini-btn btn-move-up', '↑');
    const btnDown = el('button', 'mini-btn btn-move-down', '↓');
    const btnDel = el('button', 'mini-btn btn-remove', '移除');
    [btnUp, btnDown, btnDel].forEach((b) => {
      b.type = 'button';
    });
    btnUp.title = '上移';
    btnDown.title = '下移';
    btnUp.addEventListener('click', () => {
      const prev = item.previousElementSibling;
      if (prev) {
        list.insertBefore(item, prev);
        refresh();
      }
    });
    btnDown.addEventListener('click', () => {
      const next = item.nextElementSibling;
      if (next) {
        list.insertBefore(next, item);
        refresh();
      }
    });
    btnDel.addEventListener('click', () => {
      if (list.children.length <= 1) {
        toast('至少保留一个实验');
        return;
      }
      item.remove();
      refresh();
    });
    tools.append(btnUp, btnDown, btnDel);

    item.append(el('span', 'exp-seq', ''), kindSelect, scenarioSelect, tools);
    list.appendChild(item);
  }

  for (const exp of experiments) addItem(exp.kind, exp.scenarioId);
  addBtn.addEventListener('click', () => {
    addItem('r2', '');
    refresh();
  });

  wrap.append(list, addRow);
  refresh();
  return {
    wrap,
    collect: () =>
      [...list.children].map((item) => ({
        kind: item.querySelector('.exp-kind').value,
        scenarioId: item.querySelector('.exp-scenario').value
      }))
  };
}

// 新建（id 为空）/ 修改（id 存在）共用一套独立编辑页
async function renderQEditor(id) {
  setHint($qEditorHint, '');
  $qEditor.innerHTML = '';
  $qEditorSave.disabled = false;

  let questionnaire = null;
  if (id) {
    try {
      const res = await api(`/api/admin/questionnaire?id=${encodeURIComponent(id)}`);
      questionnaire = res.questionnaire;
    } catch (err) {
      if (maybeSessionExpired(err)) return;
      $qEditorTitle.textContent = '修改问卷';
      $qEditorSave.disabled = true;
      $qEditor.appendChild(el('p', 'data-empty', err.message || '问卷不存在或已被删除'));
      return;
    }
  }

  $qEditorTitle.textContent = questionnaire ? `修改问卷 · ${questionnaire.name}` : '新建问卷';
  $qEditorSave.textContent = questionnaire ? '保存修改' : '生成问卷';

  // 1 基础信息：名称 + 固定组别
  const secBasic = sectionHead('基础信息', {
    hint: '问卷名称即链接名称与导出文件名。组别固定在该问卷内：控制组与干预组各建一份问卷、分别投放。'
  });
  const nameField = makeField('问卷名称', questionnaire ? questionnaire.name : '', 1);
  const roleField = el('label', 'field');
  roleField.appendChild(el('span', '', '组别（研究3 呈现的文本）'));
  const roleSelect = el('select');
  for (const [value, label] of [['control', '控制组 · 客观描述文本'], ['treat', '干预组 · 说服文本']]) {
    const opt = el('option', '', label);
    opt.value = value;
    roleSelect.appendChild(opt);
  }
  roleSelect.value = questionnaire ? questionnaire.groupRole : 'control';
  roleField.appendChild(roleSelect);
  secBasic.append(nameField.wrap, roleField);

  // 2 流程内容（开场 / 过程文案）：默认来自「流程页面」快照，可自定义或整块移除
  const secFlow = sectionHead('流程内容', {
    hint: '新建时来自「流程页面」的默认文案，可按本问卷自定义或整块移除；修改只影响本问卷，进行中的被试不受影响。'
  });
  const flow = questionnaire
    ? questionnaire.flow
    : {
        welcomeText: state.settings.welcomeText,
        consentText: state.settings.consentText,
        nextTaskText: state.settings.nextTaskText,
        endText: state.settings.endText,
        debriefText: state.settings.debriefText
      };
  const flowEditor = buildFlowBlocks(flow);
  for (const section of flowEditor.beforeSections) secFlow.appendChild(section);

  // 3 实验编排：插入研究实验（可多个、可混排、可排序）
  const secExp = sectionHead('研究实验编排', {
    hint: '插入单个或多个研究实验（研究2 / 研究3 可混排），每个实验独立选择情景；被试按此顺序依次完成。'
  });
  const expEditor = buildExperimentEditor(
    questionnaire ? questionnaire.experiments : [{ kind: 'r2', scenarioId: state.scenarios[0] ? state.scenarios[0].id : '' }]
  );
  secExp.appendChild(expEditor.wrap);

  // 4 完成阶段文案（结束语 / 结束说明）：实验编排之后展示
  const secTail = sectionHead('完成阶段文案', {
    hint: '全部任务完成后依次展示；移除则跳过对应内容。'
  });
  for (const section of flowEditor.afterSections) secTail.appendChild(section);

  $qEditor.append(secBasic, secFlow, secExp, secTail);

  $qEditorSave.onclick = async () => {
    const name = nameField.input.value.trim();
    if (!name) return setHint($qEditorHint, '请填写问卷名称', true);

    const experiments = expEditor.collect();
    if (!experiments.length || experiments.some((e) => !e.scenarioId)) {
      return setHint($qEditorHint, '请为每个实验选择情景', true);
    }

    const payload = {
      name,
      groupRole: roleSelect.value,
      flow: flowEditor.collect(),
      experiments
    };
    if (questionnaire) payload.id = questionnaire.id;

    setHint($qEditorHint, questionnaire ? '保存中…' : '生成中…');
    $qEditorSave.disabled = true;
    try {
      const res = await api(questionnaire ? '/api/admin/questionnaire/update' : '/api/admin/questionnaire/create', {
        method: 'POST',
        body: payload
      });
      toast(questionnaire ? '已保存修改' : `已生成问卷「${res.questionnaire.name}」`);
      location.hash = '#/q'; // 返回列表（路由播放后退动画）
    } catch (err) {
      setHint($qEditorHint, err.message || '保存失败，请重试', true);
      $qEditorSave.disabled = false;
    }
  };
}

/* ---------------------------------------------------------------- 问卷管理 · 数据（详情页） */

// 登录过期（401）时清理本地 token 并回到登录页
function maybeSessionExpired(err) {
  if (err.status !== 401) return false;
  state.token = '';
  sessionStorage.removeItem(TOKEN_KEY);
  location.reload();
  return true;
}

// 筛选器状态：随问卷切换重置（按实验段 / 问题筛选；组别在问卷内固定，无需筛选）
let qFilters = { qid: '', experiment: '', phase: '' };

// 问题（阶段）定义：kind 对应实验类型，用于问题筛选联动与导出文件名
const PHASE_FILTERS = [
  { value: 'r2_choice', short: '决策①', kind: 'r2' },
  { value: 'r2_rating', short: '评分', kind: 'r2' },
  { value: 'r3_base', short: '基线决策', kind: 'r3' },
  { value: 'r3_choice', short: '再决策', kind: 'r3' }
];

function makeFilter(labelText, options, current, onChange) {
  const wrap = el('label', 'field data-filter');
  wrap.appendChild(el('span', '', labelText));
  const select = el('select');
  for (const [value, text] of options) {
    const opt = el('option', '', text);
    opt.value = value;
    select.appendChild(opt);
  }
  select.value = current;
  select.addEventListener('change', () => onChange(select.value));
  wrap.appendChild(select);
  return wrap;
}

async function renderQDetail(id) {
  $qDetailHead.innerHTML = '';
  $qDetailToolbar.innerHTML = '';
  $qDetailSummary.textContent = '';
  $qDetailSummary.classList.remove('err');
  $qDetailList.innerHTML = '';
  if (qFilters.qid !== id) qFilters = { qid: id, experiment: '', phase: '' };

  const params = new URLSearchParams({ id });
  if (qFilters.experiment) params.set('experiment', qFilters.experiment);
  if (qFilters.phase) params.set('phase', qFilters.phase);

  let questionnaire;
  let rows;
  let rowCount = 0;
  let sessionCount = 0;
  try {
    const res = await api(`/api/admin/questionnaire/sessions?${params.toString()}`);
    questionnaire = res.questionnaire;
    rows = res.rows;
    rowCount = res.rowCount;
    sessionCount = res.sessionCount;
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $qDetailTitle.textContent = '问卷数据';
    $qDetailSummary.textContent = err.message || '数据加载失败';
    $qDetailSummary.classList.add('err');
    return;
  }

  $qDetailTitle.textContent = `${questionnaire.name} · 数据`;

  // 头部：短码 / 组别 / 实验编排 / 创建时间 + 被试链接
  const titleRow = el('div', 'q-detail-title-row');
  titleRow.append(
    el('code', 'cell-code', questionnaire.id),
    el('span', 'role-tag', ROLE_LABEL[questionnaire.groupRole] || questionnaire.groupRole)
  );
  for (const exp of questionnaire.experiments) {
    titleRow.appendChild(el('span', 'exp-tag', `${exp.sort}. ${KIND_LABEL[exp.kind] || exp.kind}·${exp.scenarioName}`));
  }
  titleRow.appendChild(el('span', 'q-detail-created', `创建于 ${formatTime(questionnaire.createdAt)}`));
  $qDetailHead.appendChild(titleRow);

  const linkRow = el('div', 'link-row');
  const linkInput = el('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  linkInput.value = `${location.origin}/chat?q=${questionnaire.id}`;
  linkInput.addEventListener('click', () => linkInput.select());
  const btnCopy = el('button', 'ghost-btn', '复制链接');
  btnCopy.type = 'button';
  btnCopy.addEventListener('click', () => copyText(linkInput.value, '链接已复制'));
  linkRow.append(linkInput, btnCopy);
  $qDetailHead.appendChild(linkRow);

  // 工具栏：实验 / 问题筛选（问题清单随实验类型联动）+ 导出
  const expOptions = [['', '全部实验']];
  for (const exp of questionnaire.experiments) {
    expOptions.push([String(exp.sort), `${exp.sort}. ${KIND_LABEL[exp.kind] || exp.kind}·${exp.scenarioName}`]);
  }
  const currentExp = questionnaire.experiments.find((exp) => String(exp.sort) === qFilters.experiment) || null;
  const kinds = currentExp ? new Set([currentExp.kind]) : new Set(questionnaire.experiments.map((exp) => exp.kind));
  const phaseOptions = [['', '全部问题']];
  for (const p of PHASE_FILTERS) {
    if (kinds.has(p.kind)) phaseOptions.push([p.value, p.short]);
  }
  const reload = () => renderQDetail(id);
  $qDetailToolbar.append(
    makeFilter('实验', expOptions, qFilters.experiment, (v) => {
      qFilters.experiment = v;
      const exp = questionnaire.experiments.find((e) => String(e.sort) === v);
      if (exp && !PHASE_FILTERS.some((p) => p.kind === exp.kind && p.value === qFilters.phase)) {
        qFilters.phase = '';
      }
      reload();
    }),
    makeFilter('问题', phaseOptions, qFilters.phase, (v) => {
      qFilters.phase = v;
      reload();
    })
  );
  const btnExport = el('button', 'ghost-btn', qFilters.experiment || qFilters.phase ? '导出当前筛选' : '导出全部');
  btnExport.type = 'button';
  btnExport.addEventListener('click', () => exportQuestionnaireXlsx(questionnaire));
  $qDetailToolbar.appendChild(btnExport);

  $qDetailSummary.textContent = `共 ${rowCount} 条作答 · ${sessionCount} 位被试；点击一行查看该被试的完整作答与对话。`;

  if (!rows.length) {
    $qDetailList.appendChild(
      el('p', 'data-empty', qFilters.experiment || qFilters.phase ? '当前筛选条件下暂无作答数据，试试切换筛选。' : '暂无被试数据。把链接发给被试，提交后这里会实时汇总。')
    );
    return;
  }

  const wrap = el('div', 'data-table-wrap');
  const table = el('table', 'data-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const title of ['编号', '实验', '任务', '问题', '作答值', '选项/分数文案', '作答时间', '耗时']) {
    headRow.appendChild(el('th', '', title));
  }
  thead.appendChild(headRow);

  const tbody = el('tbody');
  for (const r of rows) {
    const row = el('tr', 'data-row');
    row.title = '点击查看该被试的完整作答与对话';
    row.append(
      el('td', 'cell-strong', r.seq == null ? '—' : String(r.seq)),
      el('td', '', `${r.experimentSort}. ${KIND_LABEL[r.experimentKind] || r.experimentKind}·${r.scenarioName}`),
      el('td', '', `任务${r.taskIndex + 1}·${r.playCount === 1 ? '单次' : '多次'}`),
      el('td', 'cell-strong', r.phaseLabel || r.phase),
      el('td', 'cell-strong', String(r.value)),
      el('td', '', r.optionLabel || '—'),
      el('td', '', formatTime(r.answeredAt)),
      el('td', '', r.elapsedMs == null ? '—' : `${Math.round(r.elapsedMs / 100) / 10} 秒`)
    );
    row.addEventListener('click', () => {
      location.hash = `#/q/${id}/s/${r.sessionId}`;
    });
    tbody.appendChild(row);
  }

  table.append(thead, tbody);
  wrap.appendChild(table);
  $qDetailList.appendChild(wrap);
}

// 导出：一个实验一个 sheet，跟随当前筛选条件；文件名＝问卷名[-实验][-问题]
async function exportQuestionnaireXlsx(questionnaire) {
  const params = new URLSearchParams({ id: questionnaire.id });
  const nameParts = [questionnaire.name];
  if (qFilters.experiment) {
    params.set('experiment', qFilters.experiment);
    const exp = questionnaire.experiments.find((e) => String(e.sort) === qFilters.experiment);
    if (exp) nameParts.push(`${KIND_LABEL[exp.kind] || exp.kind}·${exp.scenarioName}`);
  }
  if (qFilters.phase) {
    params.set('phase', qFilters.phase);
    const phase = PHASE_FILTERS.find((p) => p.value === qFilters.phase);
    if (phase) nameParts.push(phase.short);
  }

  try {
    const res = await fetch(`/api/admin/questionnaire/export.xlsx?${params.toString()}`, {
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
    a.download = `${nameParts.join('-')}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast(`已开始下载：${nameParts.join('-')}.xlsx`);
  } catch (err) {
    $qDetailSummary.textContent = err.message || '导出失败，请重试';
    $qDetailSummary.classList.add('err');
  }
}

/* ---------------------------------------------------------------- 问卷管理 · 个案详情 */

async function renderQSession(qid, sid) {
  $qSession.innerHTML = '';
  $qSessionTitle.textContent = '被试详情';

  let data;
  try {
    data = await api(`/api/admin/questionnaire/session?id=${encodeURIComponent(qid)}&sid=${encodeURIComponent(sid)}`);
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $qSession.appendChild(el('p', 'data-empty', err.message || '会话加载失败'));
    return;
  }

  const { questionnaire, session, messages, responses } = data;
  $qSessionTitle.textContent = `${questionnaire.name} · 被试 #${session.seq == null ? '—' : session.seq}`;

  const scenarioNames = new Map(questionnaire.experiments.map((exp) => [exp.scenarioId, exp.scenarioName]));

  // 1 会话信息
  const secMeta = sectionHead('会话信息');
  const grid = el('div', 'meta-grid');
  for (const [label, value] of [
    ['被试编号', session.seq == null ? '—' : `#${session.seq}`],
    ['组别', session.groupRoleName || '—'],
    ['状态', session.statusLabel || session.status],
    ['开始时间', formatTime(session.started_at)],
    ['结束时间', formatTime(session.ended_at)],
    ['时长', formatDuration(session.duration_sec)],
    ['实验编排', session.planSummary || '—']
  ]) {
    const item = el('div', 'meta-item');
    item.append(el('span', 'meta-label', label), el('span', 'meta-value', value));
    grid.appendChild(item);
  }
  secMeta.appendChild(grid);

  // 2 作答明细
  const secResp = sectionHead('作答明细', { hint: '按实验顺序排列；决策 0/1 对应选项卡片，评分 1–7 对应量表。' });
  if (!responses.length) {
    secResp.appendChild(el('p', 'data-empty', '暂无作答记录（会话可能尚未开始作答）。'));
  } else {
    const wrap = el('div', 'data-table-wrap');
    const table = el('table', 'data-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const title of ['实验', '任务', '阶段', '作答值', '选项/分数文案', '呈现时间', '作答时间', '耗时']) {
      headRow.appendChild(el('th', '', title));
    }
    thead.appendChild(headRow);

    const tbody = el('tbody');
    for (const r of responses) {
      const tr = el('tr');
      tr.append(
        el('td', '', `${r.experiment_sort}. ${KIND_LABEL[r.experiment_kind] || r.experiment_kind || ''}·${scenarioNames.get(r.scenario_id) || r.scenario_id}`),
        el('td', '', `任务${Number(r.task_index) + 1}·${Number(r.play_count) === 1 ? '单次' : '多次'}`),
        el('td', 'cell-strong', r.phaseLabel || r.phase),
        el('td', 'cell-strong', String(r.value)),
        el('td', '', r.option_label || '—'),
        el('td', '', formatTime(r.shown_at)),
        el('td', '', formatTime(r.answered_at)),
        el('td', '', r.elapsed_ms == null ? '—' : `${Math.round(Number(r.elapsed_ms) / 100) / 10} 秒`)
      );
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    secResp.appendChild(wrap);
  }

  // 3 对话记录
  const secMsg = sectionHead('对话记录', { hint: '被试端界面中实际呈现的全部消息，按先后顺序。' });
  if (!messages.length) {
    secMsg.appendChild(el('p', 'data-empty', '暂无消息记录。'));
  } else {
    const timeline = el('div', 'msg-timeline');
    for (const m of messages) {
      const item = el('div', m.role === 'user' ? 'msg-item' : 'msg-item msg-ai');
      const head = el('div', 'msg-head');
      head.append(el('span', 'msg-role', m.role === 'user' ? '被试' : '系统'), el('span', 'msg-time', formatTime(m.created_at)));
      item.append(head, el('p', 'msg-content', m.content));
      timeline.appendChild(item);
    }
    secMsg.appendChild(timeline);
  }

  $qSession.append(secMeta, secResp, secMsg);
}

/* ---------------------------------------------------------------- 通用问卷（sv） */

// 题型与展示文案；主问卷支持七种（含实验），实验子题复用前六种
const SV_TYPE_LABELS = { single: '单选', multi: '多选', text: '填空', rating: '评分', rank: '排序', qa: '问答', experiment: '实验' };
const SV_TYPE_ICONS = { single: '◉', multi: '☑', text: '▭', rating: '★', rank: '↕', qa: '≡', experiment: '🧪' };
const SV_MAIN_TYPES = ['single', 'multi', 'text', 'rating', 'rank', 'qa', 'experiment'];
const SV_SUB_TYPES = ['single', 'multi', 'text', 'rating', 'rank', 'qa'];

// 编辑器状态：标题 / 正文 / 题目整树均在本地编辑，保存时整树提交
const svState = {
  surveys: [],
  id: '',
  title: '',
  startText: '',
  endText: '',
  questions: [],
  selected: -1,
  uid: 0,
  previewReady: false,
  trial: false,
  previewTimer: null
};

let svTypeMenuNode = null; // 当前展开的类型菜单（点击空白处收起）

document.addEventListener('click', (e) => {
  if (svTypeMenuNode && !svTypeMenuNode.classList.contains('hidden') && !e.target.closest('.sv-add-question')) {
    svTypeMenuNode.classList.add('hidden');
  }
});

function svMakeQuestion(type) {
  const q = { _uid: ++svState.uid, _collapsed: false, type, title: '', required: true, options: [], config: {} };
  if (type === 'single' || type === 'multi') {
    q.options = ['选项 1', '选项 2'];
    q.config = { layout: 1, other: false, minSel: 0, maxSel: 0 };
  } else if (type === 'rank') {
    q.options = ['项目 1', '项目 2', '项目 3'];
  } else if (type === 'rating') {
    q.config = { min: 1, max: 5, anchor: '', display: 'ends', cols: 0, labels: {} };
  } else if (type === 'experiment') {
    q.title = '新实验';
    q.config = { background: '', images: [], subs: [] };
  }
  return q;
}

function svMakeSub(type) {
  const s = { type, title: '', required: true, options: [], config: {}, _open: true };
  if (type === 'single' || type === 'multi') {
    s.options = ['选项 1', '选项 2'];
    s.config = { layout: 1, other: false, minSel: 0, maxSel: 0 };
  } else if (type === 'rank') {
    s.options = ['项目 1', '项目 2'];
  } else if (type === 'rating') {
    s.config = { min: 1, max: 5, anchor: '', display: 'ends', cols: 0, labels: {} };
  }
  return s;
}

// 收集当前编辑器内容（保存 / 发送给预览 iframe 共用）
function collectSvSurvey() {
  return {
    title: svState.title,
    startText: svState.startText,
    endText: svState.endText,
    questions: svState.questions.map(svCleanQuestion)
  };
}

// 编辑器内部对象 → 服务端契约结构（丢弃本地字段；选项去空白）
function svCleanQuestion(q) {
  const type = q.type;
  const cfg = q.config || {};
  const out = {
    type,
    title: String(q.title || ''),
    required: q.required !== false,
    options: (q.options || []).map((o) => String(o)).filter((o) => o.trim()),
    config: {}
  };
  if (type === 'single' || type === 'multi') {
    out.config = {
      layout: Number(cfg.layout) || 1,
      other: !!cfg.other,
      minSel: Number(cfg.minSel) || 0,
      maxSel: Number(cfg.maxSel) || 0
    };
  } else if (type === 'rating') {
    out.config = {
      min: Number(cfg.min) || 0,
      max: Number(cfg.max) || 5,
      anchor: String(cfg.anchor || ''),
      display: cfg.display === 'all' ? 'all' : 'ends',
      cols: Number(cfg.cols) || 0,
      labels: JSON.parse(JSON.stringify(cfg.labels || {}))
    };
  } else if (type === 'experiment') {
    out.required = true;
    out.options = [];
    out.config = {
      background: String(cfg.background || ''),
      images: (cfg.images || []).map(String),
      subs: (cfg.subs || []).map(svCleanQuestion)
    };
  }
  return out;
}

/* ------------------------------------------------ 题卡与编辑控件 */

// 题干输入（输入即更新题卡头部标题 + 右侧预览）
function svTitleField(q, labelText, titleEl) {
  const field = makeField(labelText, q.title, 2);
  field.input.addEventListener('input', () => {
    q.title = field.input.value;
    if (titleEl) titleEl.textContent = q.title || '（未填写题目）';
    scheduleSvPreview();
  });
  return field.wrap;
}

// 选项编辑块（单选 / 多选 / 排序共用）
function svOptionsBlock(q, rebuild) {
  const wrap = el('div');
  wrap.style.display = 'grid';
  wrap.style.gap = '8px';
  q.options.forEach((opt, oi) => {
    const row = el('div', 'sv-opt-row');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = opt;
    input.addEventListener('input', () => {
      q.options[oi] = input.value;
      scheduleSvPreview();
    });
    const del = el('button', 'del', '✕');
    del.type = 'button';
    del.title = '删除选项';
    del.addEventListener('click', () => {
      q.options.splice(oi, 1);
      rebuild();
    });
    row.append(el('span', 'drag', '⠿'), input, del);
    wrap.appendChild(row);
  });
  const add = el('button', 'sv-add-opt', '+ 添加选项');
  add.type = 'button';
  add.addEventListener('click', () => {
    q.options.push(`选项 ${q.options.length + 1}`);
    rebuild();
  });
  wrap.appendChild(add);
  return wrap;
}

// 选项布局：每行 N 个（1–8，默认 1；填写端不显示设置项）
function svLayoutRow(q) {
  const row = el('div', 'sv-row');
  row.appendChild(el('span', 'sv-inline-hint', '选项布局：每行'));
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'sv-num';
  input.min = '1';
  input.max = '8';
  input.value = String(q.config.layout || 1);
  input.addEventListener('input', () => {
    q.config.layout = Math.min(8, Math.max(1, Math.round(Number(input.value)) || 1));
    scheduleSvPreview();
  });
  input.addEventListener('change', () => {
    input.value = String(q.config.layout || 1);
  });
  row.append(input, el('span', 'sv-inline-hint', '个（默认 1；右侧预览实时生效）'));
  return row;
}

// 多选限选：最少 / 最多（0 = 不限）
function svLimitRow(q) {
  const row = el('div', 'sv-row');
  row.appendChild(el('span', 'sv-inline-hint', '限选：最少'));
  const minInp = document.createElement('input');
  minInp.type = 'number';
  minInp.className = 'sv-num';
  minInp.min = '0';
  minInp.value = String(q.config.minSel || 0);
  const maxInp = document.createElement('input');
  maxInp.type = 'number';
  maxInp.className = 'sv-num';
  maxInp.min = '0';
  maxInp.value = String(q.config.maxSel || 0);
  minInp.addEventListener('change', () => {
    q.config.minSel = Math.max(0, Math.round(Number(minInp.value)) || 0);
    if (q.config.maxSel > 0 && q.config.minSel > q.config.maxSel) {
      q.config.minSel = q.config.maxSel;
      minInp.value = String(q.config.minSel);
    }
    scheduleSvPreview();
  });
  maxInp.addEventListener('change', () => {
    q.config.maxSel = Math.max(0, Math.round(Number(maxInp.value)) || 0);
    scheduleSvPreview();
  });
  row.append(minInp, el('span', 'sv-inline-hint', '最多'), maxInp, el('span', 'sv-inline-hint', '项（0 = 不限）'));
  return row;
}

// 开关行（必答 / 其他选项）
function svToggleRow(labelText, on, onChange) {
  const label = el('label', 'sv-toggle-label');
  const sw = el('span', 'sv-switch' + (on ? ' on' : ''));
  label.append(sw, el('span', '', labelText));
  label.addEventListener('click', (e) => {
    e.preventDefault();
    onChange();
  });
  return label;
}

// 评分题：分值范围 / 预设法 / 注释显示 / 按钮布局 / 逐档文案 / 锚点
function svRatingBlock(q, rebuild) {
  const wrap = el('div');
  wrap.style.display = 'grid';
  wrap.style.gap = '10px';

  const range = el('div', 'sv-row');
  range.appendChild(el('span', 'sv-inline-hint', '分值范围'));
  const minInp = document.createElement('input');
  minInp.type = 'number';
  minInp.className = 'sv-num';
  minInp.value = String(q.config.min);
  const maxInp = document.createElement('input');
  maxInp.type = 'number';
  maxInp.className = 'sv-num';
  maxInp.value = String(q.config.max);
  minInp.addEventListener('change', () => {
    q.config.min = Math.min(10, Math.max(0, Math.round(Number(minInp.value)) || 0));
    if (q.config.max <= q.config.min) q.config.max = q.config.min + 1;
    rebuild();
  });
  maxInp.addEventListener('change', () => {
    q.config.max = Math.min(12, Math.max(q.config.min + 1, Math.round(Number(maxInp.value)) || q.config.min + 1));
    rebuild();
  });
  range.append(minInp, el('span', 'sv-inline-hint', '至'), maxInp, el('span', 'sv-inline-hint', '（0 或 1 ~ 12 分）'));
  const spacer = el('span');
  spacer.style.flex = '1';
  range.appendChild(spacer);
  range.appendChild(el('span', 'sv-inline-hint', '快捷预设'));
  const preset = el('div', 'sv-seg');
  for (const [key, label] of [['num', '纯数字'], ['sat', '满意度'], ['app', '认可度']]) {
    const b = el('button', '', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (key === 'num') q.config.labels = {};
      if (key === 'sat') {
        q.config.min = 1;
        q.config.max = 5;
        q.config.labels = { 1: '非常不满意', 2: '不满意', 3: '一般', 4: '满意', 5: '非常满意' };
      }
      if (key === 'app') {
        q.config.min = 1;
        q.config.max = 5;
        q.config.labels = { 1: '非常不认可', 2: '不认可', 3: '一般', 4: '认可', 5: '非常认可' };
      }
      rebuild();
    });
    preset.appendChild(b);
  }
  range.appendChild(preset);
  wrap.appendChild(range);

  const disp = el('div', 'sv-row');
  disp.appendChild(el('span', 'sv-inline-hint', '注释显示'));
  const dispSeg = el('div', 'sv-seg');
  for (const [d, label] of [['ends', '仅显示首末'], ['all', '每档都显示']]) {
    const b = el('button', (q.config.display || 'ends') === d ? 'on' : '', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      q.config.display = d;
      rebuild();
    });
    dispSeg.appendChild(b);
  }
  disp.append(dispSeg, el('span', 'sv-inline-hint', '（右侧预览实时可见）'));
  wrap.appendChild(disp);

  const layoutRow = el('div', 'sv-row');
  layoutRow.appendChild(el('span', 'sv-inline-hint', '按钮布局：每行'));
  const colsInp = document.createElement('input');
  colsInp.type = 'number';
  colsInp.className = 'sv-num';
  colsInp.min = '0';
  colsInp.max = '12';
  colsInp.value = String(q.config.cols || 0);
  colsInp.addEventListener('input', () => {
    q.config.cols = Math.max(0, Math.min(12, Math.round(Number(colsInp.value)) || 0));
    scheduleSvPreview();
  });
  colsInp.addEventListener('change', () => {
    colsInp.value = String(q.config.cols || 0);
  });
  layoutRow.append(colsInp, el('span', 'sv-inline-hint', '个（默认 0 = 一行全部自适应，按钮大小自动调整）'));
  wrap.appendChild(layoutRow);

  wrap.appendChild(el('div', 'sv-inline-hint', '每一档的文案（可逐个自定义，留空只显示数字）'));
  const grid = el('div', 'sv-score-labels');
  for (let v = q.config.min; v <= q.config.max; v += 1) {
    const cell = el('div', 'cell');
    cell.appendChild(el('span', 'n', String(v)));
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = '纯数字';
    inp.value = (q.config.labels && q.config.labels[v]) || '';
    inp.addEventListener('input', () => {
      if (!q.config.labels) q.config.labels = {};
      if (inp.value.trim()) q.config.labels[v] = inp.value;
      else delete q.config.labels[v];
      scheduleSvPreview();
    });
    cell.appendChild(inp);
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);

  const af = makeField('锚点文案（可选；留空时自动使用首档 / 末档文案）', q.config.anchor || '', 1);
  af.input.addEventListener('input', () => {
    q.config.anchor = af.input.value;
    scheduleSvPreview();
  });
  wrap.appendChild(af.wrap);
  return wrap;
}

/* ------------------------------------------------ 实验题（背景 + 图片 + 子题） */

function svExperimentBlock(body, q, qi, rebuild) {
  const bgField = makeField('实验背景材料（填写端先展示这段文字，可含图片）', q.config.background || '', 3);
  bgField.input.addEventListener('input', () => {
    q.config.background = bgField.input.value;
    scheduleSvPreview();
  });
  body.appendChild(bgField.wrap);

  const strip = el('div', 'sv-img-strip');
  (q.config.images || []).forEach((url, ii) => {
    const thumb = el('div', 'sv-img-thumb');
    const img = document.createElement('img');
    img.src = url;
    img.alt = `配图 ${ii + 1}`;
    const x = el('button', 'x', '✕');
    x.type = 'button';
    x.title = '移除该图';
    x.addEventListener('click', () => {
      q.config.images.splice(ii, 1);
      rebuild();
    });
    thumb.append(img, x);
    strip.appendChild(thumb);
  });
  const upBtn = el('button', 'sv-upload-btn');
  upBtn.type = 'button';
  upBtn.innerHTML = '<span style="font-size:16px">＋</span><span>上传图片</span>';
  upBtn.title = '选择本地图片（大图自动压缩后上传）';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if ((q.config.images || []).length >= 9) return toast('最多上传 9 张图片');
    upBtn.disabled = true;
    upBtn.querySelector('span:last-child').textContent = '上传中…';
    try {
      const url = await svUploadImage(file);
      if (url) {
        q.config.images.push(url);
        rebuild();
      }
    } catch (err) {
      toast(err.message || '图片上传失败');
    } finally {
      upBtn.disabled = false;
      upBtn.querySelector('span:last-child').textContent = '上传图片';
    }
  });
  upBtn.addEventListener('click', () => fileInput.click());
  strip.append(upBtn, fileInput);
  body.appendChild(strip);

  body.appendChild(el('div', 'sv-inline-hint', '内部题目（复用全部题型，填写端逐个作答）'));
  const list = el('div', 'sv-sub-list');
  (q.config.subs || []).forEach((s, si) => list.appendChild(buildSvSubcard(s, qi, si, q, rebuild)));
  body.appendChild(list);

  const addRow = el('div', 'sv-row');
  addRow.appendChild(el('span', 'sv-inline-hint', '＋ 添加子题：'));
  for (const t of SV_SUB_TYPES) {
    const b = el('button', 'ghost-btn', SV_TYPE_LABELS[t]);
    b.type = 'button';
    b.style.padding = '5px 11px';
    b.style.fontSize = '12px';
    b.addEventListener('click', () => {
      q.config.subs.push(svMakeSub(t));
      rebuild();
    });
    addRow.appendChild(b);
  }
  body.appendChild(addRow);
}

function buildSvSubcard(s, qi, si, q, rebuild) {
  const card = el('div', 'sv-subcard');
  const head = el('div', 'sv-subcard-head');
  const title = el('span', 'stitle', s.title || '（未填写）');
  const del = el('button', 'del', '✕');
  del.type = 'button';
  del.title = '删除子题';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    q.config.subs.splice(si, 1);
    rebuild();
  });
  head.append(
    el('span', 'snum', `${qi + 1}.${si + 1}`),
    el('span', 'sv-qbadge', SV_TYPE_LABELS[s.type] || s.type),
    title,
    del
  );

  const bodyEl = el('div', 'sv-subcard-body');
  if (s._open === false) bodyEl.style.display = 'none';
  bodyEl.appendChild(svTitleField(s, '子题题干', title));
  if (s.type === 'single' || s.type === 'multi' || s.type === 'rank') bodyEl.appendChild(svOptionsBlock(s, rebuild));
  if (s.type === 'single' || s.type === 'multi') {
    bodyEl.appendChild(svLayoutRow(s));
    if (s.type === 'multi') bodyEl.appendChild(svLimitRow(s));
    bodyEl.appendChild(
      svToggleRow('提供「其他」选项（可自行填写）', !!s.config.other, () => {
        s.config.other = !s.config.other;
        rebuild();
      })
    );
  }
  if (s.type === 'rating') bodyEl.appendChild(svRatingBlock(s, rebuild));
  bodyEl.appendChild(
    svToggleRow('必答（关闭后填写端显示「跳过」）', s.required !== false, () => {
      s.required = s.required === false;
      rebuild();
    })
  );

  head.addEventListener('click', (e) => {
    if (e.target.closest('.del')) return;
    s._open = s._open === false;
    bodyEl.style.display = s._open === false ? 'none' : '';
  });
  card.append(head, bodyEl);
  return card;
}

/* ------------------------------------------------ 题卡列表 */

function renderSvQuestions(opts = {}) {
  const list = $('sv-qlist');
  if (!list) return;
  list.innerHTML = '';
  svState.questions.forEach((q, i) => list.appendChild(buildSvQuestionCard(q, i)));
  const countTag = $svEditor.querySelector('.sv-qcount');
  if (countTag) countTag.textContent = `共 ${svState.questions.length} 题`;
  const cards = [...list.children];
  cards.forEach((c, ci) => c.classList.toggle('editing', ci === svState.selected));
  if (opts.scroll && cards[svState.selected]) cards[svState.selected].scrollIntoView({ block: 'nearest' });
}

function buildSvQuestionCard(q, i) {
  const rebuild = () => renderSvQuestions();
  const card = el('div', 'sv-qcard' + (q._collapsed ? ' collapsed' : ''));
  const head = el('div', 'sv-qhead');
  const title = el('span', 'sv-qtitle', q.title || '（未填写题目）');

  const ops = el('div', 'sv-qops');
  const btnUp = el('button', '', '↑');
  btnUp.type = 'button';
  btnUp.title = '上移';
  btnUp.disabled = i === 0;
  const btnDown = el('button', '', '↓');
  btnDown.type = 'button';
  btnDown.title = '下移';
  btnDown.disabled = i === svState.questions.length - 1;
  const btnCopy = el('button', '', '⧉');
  btnCopy.type = 'button';
  btnCopy.title = '复制该题';
  const btnDel = el('button', 'danger', '✕');
  btnDel.type = 'button';
  btnDel.title = '删除该题';
  ops.append(btnUp, btnDown, btnCopy, btnDel);

  const btnCollapse = el('button', 'sv-qcollapse');
  btnCollapse.type = 'button';
  btnCollapse.title = '折叠 / 展开';
  btnCollapse.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  head.append(
    el('span', 'sv-qnum', String(i + 1)),
    el('span', 'sv-qbadge' + (q.type === 'experiment' ? ' exp' : ''), SV_TYPE_LABELS[q.type] || q.type),
    title,
    el(
      'span',
      'sv-qreq' + (q.type !== 'experiment' && q.required === false ? ' off' : ''),
      q.type === 'experiment' ? `${(q.config.subs || []).length} 个小题` : q.required === false ? '选答' : '必答'
    ),
    ops,
    btnCollapse
  );

  const body = el('div', 'sv-qbody');
  buildSvQuestionBody(body, q, i, title);
  card.append(head, body);

  btnUp.addEventListener('click', () => {
    if (i > 0) svMoveQuestion(i, i - 1);
  });
  btnDown.addEventListener('click', () => {
    if (i < svState.questions.length - 1) svMoveQuestion(i, i + 1);
  });
  btnCopy.addEventListener('click', () => {
    const copy = svMakeQuestion(q.type);
    Object.assign(copy, JSON.parse(JSON.stringify(svCleanQuestion(q))), { _uid: ++svState.uid, _collapsed: false });
    if (copy.type === 'experiment') copy.config.subs = (copy.config.subs || []).map((s) => ({ ...s, _open: true }));
    svState.questions.splice(i + 1, 0, copy);
    selectSvCard(i + 1, { force: true, scroll: true });
  });
  btnDel.addEventListener('click', () => {
    svState.questions.splice(i, 1);
    if (svState.selected > svState.questions.length - 1) svState.selected = svState.questions.length - 1;
    renderSvQuestions();
    selectSvCard(svState.selected, { force: true });
  });
  btnCollapse.addEventListener('click', () => {
    q._collapsed = !q._collapsed;
    card.classList.toggle('collapsed', q._collapsed);
  });

  // 点击题卡任意处即选中该题：上下边界高亮 + 右侧手机实时显示该题
  card.addEventListener('click', () => selectSvCard(i));
  card.addEventListener('focusin', () => selectSvCard(i));
  return card;
}

function svMoveQuestion(from, to) {
  const [q] = svState.questions.splice(from, 1);
  svState.questions.splice(to, 0, q);
  if (svState.selected === from) svState.selected = to;
  else if (from < svState.selected && to >= svState.selected) svState.selected -= 1;
  else if (from > svState.selected && to <= svState.selected) svState.selected += 1;
  renderSvQuestions();
  selectSvCard(svState.selected, { force: true });
}

function buildSvQuestionBody(body, q, i, title) {
  const rebuild = () => renderSvQuestions();
  body.appendChild(
    svTitleField(q, q.type === 'experiment' ? '实验名称（填写端显示为「实验 N · 名称」）' : '题干', title)
  );
  if (q.type === 'single' || q.type === 'multi' || q.type === 'rank') body.appendChild(svOptionsBlock(q, rebuild));
  if (q.type === 'single' || q.type === 'multi') {
    body.appendChild(svLayoutRow(q));
    if (q.type === 'multi') body.appendChild(svLimitRow(q));
    body.appendChild(
      svToggleRow('提供「其他」选项（可自行填写）', !!q.config.other, () => {
        q.config.other = !q.config.other;
        rebuild();
      })
    );
  }
  if (q.type === 'rating') body.appendChild(svRatingBlock(q, rebuild));
  if (q.type === 'experiment') {
    svExperimentBlock(body, q, i, rebuild);
    return;
  }
  body.appendChild(
    svToggleRow('必答（关闭后填写端显示「跳过」）', q.required !== false, () => {
      q.required = q.required === false;
      rebuild();
    })
  );
}

/* ------------------------------------------------ 选中与右侧预览（postMessage 桥） */

// 选中第 i 题：上下边界高亮，右侧手机实时显示该题
function selectSvCard(i, opts = {}) {
  const list = $('sv-qlist');
  const cards = list ? [...list.children] : [];
  const valid = i >= 0 && i < svState.questions.length;
  cards.forEach((c, ci) => c.classList.toggle('editing', valid && ci === i));
  const prev = svState.selected;
  svState.selected = valid ? i : -1;
  if (opts.scroll && valid) cards[i].scrollIntoView({ block: 'nearest' });
  if (svState.selected !== prev || opts.force) svSyncPreview();
}

// 编辑输入时的防抖实时预览
function scheduleSvPreview(delay = 160) {
  clearTimeout(svState.previewTimer);
  svState.previewTimer = setTimeout(() => svSyncPreview(), delay);
}

function svSyncPreview() {
  if (!svState.previewReady || !svState.id) return;
  if (svState.trial) return; // 试填中不打断（退出试填后自动恢复跟随）
  svPostToPreview({ type: 'survey-follow', questionIndex: Math.max(0, svState.selected), survey: collectSvSurvey() });
}

function svPostToPreview(message) {
  try {
    $svPreview.contentWindow.postMessage(message, location.origin);
  } catch {
    /* 忽略 */
  }
}

function setSvTrialButton(on) {
  svState.trial = on;
  $svPvTrial.textContent = on ? '■ 退出试填' : '▶ 从头试填';
  $svPvTrial.classList.toggle('stop', on);
  $svPvTag.textContent = on ? '试填中 · 未保存' : '实时预览 · 跟随编辑';
  $svPvTag.classList.toggle('trial', on);
  $svPvTag.classList.toggle('on', !on);
}

// 预览 iframe 就绪上报（survey.html 加载完成后发送 survey-ready）
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  if ((e.data || {}).type !== 'survey-ready') return;
  if (e.source !== $svPreview.contentWindow) return;
  svState.previewReady = true;
  if (!svState.trial) svSyncPreview();
});

$svPvTrial.addEventListener('click', () => {
  if (!svState.previewReady || !svState.id) {
    toast('预览尚未就绪，请稍候');
    return;
  }
  if (svState.trial) {
    setSvTrialButton(false);
    svPostToPreview({ type: 'survey-exit-trial', survey: collectSvSurvey() });
    svSyncPreview();
  } else {
    setSvTrialButton(true);
    svPostToPreview({ type: 'survey-trial', survey: collectSvSurvey() });
  }
});

/* ------------------------------------------------ 图片上传（大图自动压缩） */

function svCompressImage(file) {
  return new Promise((resolve) => {
    if (!/^image\//.test(file.type) || file.type === 'image/gif' || file.size <= 600 * 1024) return resolve(file);
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        const maxSide = 1600;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        if (scale >= 1) return resolve(file);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob && blob.size < file.size ? blob : file), 'image/jpeg', 0.85);
      } catch {
        resolve(file);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };
    img.src = objectUrl;
  });
}

async function svUploadImage(file) {
  let blob = file;
  try {
    blob = await svCompressImage(file);
  } catch {
    blob = file;
  }
  if (blob.size > 8 * 1024 * 1024) throw new Error('单张图片不能超过 8MB，请先压缩');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
  if (!/^data:image\//.test(dataUrl)) throw new Error('仅支持 PNG / JPG / GIF / WebP 图片');
  const res = await api('/api/admin/survey/upload', { method: 'POST', body: { dataUrl } });
  return res.url;
}

/* ------------------------------------------------ 列表页 */

async function renderSvList() {
  $svList.innerHTML = '';

  let surveys;
  try {
    const res = await api('/api/admin/surveys');
    surveys = res.surveys;
    svState.surveys = surveys;
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $svList.appendChild(el('p', 'data-empty', err.message || '问卷列表加载失败'));
    return;
  }

  if (!surveys.length) {
    $svList.appendChild(
      el(
        'p',
        'data-empty',
        '还没有通用问卷。点击右上角「+ 新建问卷」：命名后添加题目（支持单选 / 多选 / 填空 / 评分 / 排序 / 问答 / 实验），右侧手机实时预览。'
      )
    );
    return;
  }

  const wrap = el('div', 'data-table-wrap');
  const table = el('table', 'data-table q-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const title of ['问卷名称', '填写链接', '题目', '数据量', '更新时间', '操作']) {
    headRow.appendChild(el('th', '', title));
  }
  thead.appendChild(headRow);

  const tbody = el('tbody');
  for (const s of surveys) {
    const row = el('tr', 'q-row');
    row.title = '双击进入编辑';

    const nameTd = el('td');
    nameTd.append(el('div', 'cell-strong', s.title), el('code', 'cell-code', s.id));
    row.appendChild(nameTd);

    const linkTd = el('td', 'q-link-cell');
    linkTd.addEventListener('dblclick', (e) => e.stopPropagation());
    const linkRow = el('div', 'link-row');
    const linkInput = document.createElement('input');
    linkInput.type = 'text';
    linkInput.readOnly = true;
    linkInput.value = `${location.origin}/survey?c=${s.id}`;
    linkInput.addEventListener('click', () => linkInput.select());
    const btnCopy = el('button', 'ghost-btn', '复制');
    btnCopy.type = 'button';
    btnCopy.title = '复制填写链接';
    btnCopy.addEventListener('click', () => copyText(linkInput.value, '填写链接已复制'));
    linkRow.append(linkInput, btnCopy);
    linkTd.appendChild(linkRow);
    row.appendChild(linkTd);

    row.appendChild(el('td', '', `${s.questionCount} 题`));
    row.appendChild(el('td', '', `${s.sessionCount} 份`));
    row.appendChild(el('td', '', formatTime(s.updatedAt)));

    const actTd = el('td');
    actTd.addEventListener('dblclick', (e) => e.stopPropagation());
    const actRow = el('div', 'row-actions');
    const btnEdit = el('button', 'ghost-btn', '编辑');
    btnEdit.type = 'button';
    btnEdit.addEventListener('click', () => {
      location.hash = `#/sv/${s.id}`;
    });
    const btnData = el('button', 'ghost-btn', '数据');
    btnData.type = 'button';
    btnData.addEventListener('click', () => {
      location.hash = `#/sv/${s.id}/data`;
    });
    const btnDup = el('button', 'ghost-btn', '复制');
    btnDup.type = 'button';
    btnDup.title = '复制为新问卷（含题目）';
    btnDup.addEventListener('click', () => openSvCreateModal({ mode: 'copy', source: s }));
    const btnDel = el('button', 'ghost-btn danger', '删除');
    btnDel.type = 'button';
    btnDel.addEventListener('click', () => removeSv(s));
    actRow.append(btnEdit, btnData, btnDup, btnDel);
    actTd.appendChild(actRow);
    row.appendChild(actTd);

    row.addEventListener('dblclick', () => {
      location.hash = `#/sv/${s.id}`;
    });
    tbody.appendChild(row);
  }

  table.append(thead, tbody);
  wrap.appendChild(table);
  $svList.appendChild(wrap);
}

// 新建 / 复制：填标题后创建，随即进入编辑页
function openSvCreateModal({ mode, source }) {
  const isCopy = mode === 'copy';
  const titleField = makeField('问卷标题', isCopy && source ? `${source.title} 副本` : '', 1);
  const body = el('div', 'modal-fields');
  if (isCopy) body.appendChild(el('p', 'modal-note', `将完整复制「${source.title}」的题目与卷首语 / 结束语（填写数据不复制）。`));
  body.appendChild(titleField.wrap);

  openModal({
    title: isCopy ? '复制问卷' : '新建问卷',
    body,
    confirmLabel: isCopy ? '复制并进入编辑' : '创建并进入编辑',
    onConfirm: async () => {
      const title = titleField.input.value.trim();
      if (!title) return showModalError('问卷标题不能为空');
      let created;
      try {
        const res = await api('/api/admin/survey/create', {
          method: 'POST',
          body: { title, copyFrom: isCopy ? source.id : '' }
        });
        created = res.survey;
      } catch (err) {
        return showModalError(err.message || '创建失败，请重试');
      }
      closeModal();
      toast(isCopy ? '已复制问卷' : '已创建问卷，请添加题目');
      location.hash = `#/sv/${created.id}`;
    }
  });
}

// 删除：有数据时弹窗中明确告知，确认后连同数据一并清空
function removeSv(survey) {
  let force = survey.sessionCount > 0;
  openModal({
    title: '删除问卷',
    body: el(
      'p',
      'modal-note',
      force
        ? `「${survey.title}」已有 ${survey.sessionCount} 份填写数据，删除将连同全部作答与对话记录一并清空，且不可恢复。`
        : `确定删除问卷「${survey.title}」？该题目与填写链接将一并失效，且不可恢复。`
    ),
    confirmLabel: '确认删除',
    danger: true,
    onConfirm: async () => {
      try {
        await api('/api/admin/survey/delete', { method: 'POST', body: { id: survey.id, force } });
      } catch (err) {
        if (err.code === 'has_sessions') force = true;
        return showModalError(err.message || '删除失败，请重试');
      }
      closeModal();
      toast('已删除问卷');
      renderSvList();
    }
  });
}

$btnNewSurvey.addEventListener('click', () => openSvCreateModal({ mode: 'new' }));

/* ------------------------------------------------ 编辑器 */

async function renderSvEditor(id) {
  setHint($svEditorHint, '');
  $svEditorSave.disabled = true;
  $svEditorSave.onclick = null;
  svState.id = id;
  svState.selected = -1;
  setSvTrialButton(false);
  clearTimeout(svState.previewTimer);

  let survey;
  try {
    const res = await api(`/api/admin/survey?id=${encodeURIComponent(id)}`);
    survey = res.survey;
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $svEditorTitle.textContent = '编辑问卷';
    $svEditor.innerHTML = '';
    $svEditor.appendChild(el('p', 'data-empty', err.message || '问卷不存在或已被删除'));
    $svEditorLink.classList.add('hidden');
    svState.previewReady = false;
    $svPreview.removeAttribute('src');
    return;
  }

  svState.title = survey.title;
  svState.startText = survey.startText || '';
  svState.endText = survey.endText || '';
  svState.questions = (survey.questions || []).map((q) => ({ ...q, _uid: ++svState.uid, _collapsed: false }));

  $svEditorTitle.textContent = `编辑问卷 · ${survey.title}`;
  $svEditorSave.textContent = '保存问卷';
  $svEditorSave.disabled = false;

  // 填写链接芯片（标题行右侧）
  $svEditorLink.innerHTML = '';
  const linkInput = document.createElement('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  linkInput.value = `${location.origin}/survey?c=${survey.id}`;
  linkInput.title = '点击全选';
  linkInput.addEventListener('click', () => linkInput.select());
  const btnCopy = el('button', 'ghost-btn', '复制填写链接');
  btnCopy.type = 'button';
  btnCopy.addEventListener('click', () => copyText(linkInput.value, '填写链接已复制'));
  const btnOpen = el('button', 'ghost-btn', '打开');
  btnOpen.type = 'button';
  btnOpen.title = '在新标签页打开正式填写页';
  btnOpen.addEventListener('click', () => window.open(linkInput.value, '_blank', 'noopener'));
  $svEditorLink.append(linkInput, btnCopy, btnOpen);
  $svEditorLink.classList.remove('hidden');

  renderSvEditorShell();

  // 右侧手机预览：同问卷复用已加载的 iframe，否则重新加载
  const wantSrc = `/survey?c=${encodeURIComponent(survey.id)}&preview=1`;
  if ($svPreview.getAttribute('src') !== wantSrc) {
    svState.previewReady = false;
    $svPreview.setAttribute('src', wantSrc);
  }
  if (svState.previewReady) svSyncPreview();

  // 默认选中第一题（无题时清空右侧题卡）
  selectSvCard(svState.questions.length ? 0 : -1, { force: true });
  $svEditorScroll.scrollTop = 0;

  $svEditorSave.onclick = async () => {
    const title = svState.title.trim();
    if (!title) return setHint($svEditorHint, '请填写问卷标题', true);
    if (!svState.questions.length) return setHint($svEditorHint, '请至少添加一道题目', true);

    for (let i = 0; i < svState.questions.length; i += 1) {
      const q = svState.questions[i];
      if (!String(q.title || '').trim()) return svHintAndFocus(i, `第 ${i + 1} 题尚未填写题干`);
      if (q.type === 'single' || q.type === 'multi' || q.type === 'rank') {
        if (!(q.options || []).some((o) => String(o).trim())) return svHintAndFocus(i, `第 ${i + 1} 题至少需要一个选项`);
      }
      if (q.type === 'rating' && q.config.max <= q.config.min) return svHintAndFocus(i, `第 ${i + 1} 题的分值范围不正确`);
      if (q.type === 'experiment' && !(q.config.subs || []).length) return svHintAndFocus(i, `第 ${i + 1} 题（实验）尚未添加子题`);
    }

    setHint($svEditorHint, '保存中…');
    $svEditorSave.disabled = true;
    try {
      const res = await api('/api/admin/survey/update', {
        method: 'POST',
        body: {
          id: svState.id,
          title,
          startText: svState.startText,
          endText: svState.endText,
          questions: svState.questions.map(svCleanQuestion)
        }
      });
      svState.title = res.survey.title;
      $svEditorTitle.textContent = `编辑问卷 · ${res.survey.title}`;
      toast('已保存问卷，修改即时生效');
      setHint($svEditorHint, '已保存 · 进行中的填写不受影响');
      if (svState.trial) {
        setSvTrialButton(false);
        svPostToPreview({ type: 'survey-exit-trial', survey: collectSvSurvey() });
      }
      svSyncPreview();
    } catch (err) {
      setHint($svEditorHint, err.message || '保存失败，请重试', true);
    } finally {
      $svEditorSave.disabled = false;
    }
  };
}

// 保存前的定位提示：滚动到对应题卡并高亮选中
function svHintAndFocus(index, message) {
  setHint($svEditorHint, message, true);
  selectSvCard(index, { force: true, scroll: true });
}

function renderSvEditorShell() {
  $svEditor.innerHTML = '';

  // 1 基础信息
  const secBasic = sectionHead('基础信息', { hint: '问卷标题即填写端顶部名称与导出文件名；保存后即时生效。' });
  const titleField = makeField('问卷标题', svState.title, 1);
  titleField.input.addEventListener('input', () => {
    svState.title = titleField.input.value;
    $svEditorTitle.textContent = svState.title ? `编辑问卷 · ${svState.title}` : '编辑问卷';
    scheduleSvPreview(260);
  });
  secBasic.appendChild(titleField.wrap);

  // 2 卷首语
  const secStart = sectionHead('卷首语', { hint: '填写端的第一条消息；留空则直接进入第一题。' });
  const startField = makeField('卷首语内容（可留空）', svState.startText, 3);
  startField.input.addEventListener('input', () => {
    svState.startText = startField.input.value;
    scheduleSvPreview();
  });
  secStart.appendChild(startField.wrap);

  // 3 题目
  const secQs = sectionHead('题目', {
    hint: '题目卡片默认全部展开；点题卡任意处即选中该题（上下边界高亮，右侧手机实时显示），点右上角按钮可折叠为一行。'
  });
  secQs.querySelector('.editor-section-head').appendChild(el('span', 'sv-qcount', `共 ${svState.questions.length} 题`));
  const qlist = el('div');
  qlist.id = 'sv-qlist';
  secQs.appendChild(qlist);

  const addRow = el('div', 'sv-add-question');
  const btnAdd = el('button', 'primary-btn', '+ 添加题目');
  btnAdd.type = 'button';
  const typeMenu = el('div', 'sv-type-menu hidden');
  for (const t of SV_MAIN_TYPES) {
    const b = el('button');
    b.type = 'button';
    b.append(el('span', 'ic', SV_TYPE_ICONS[t]), el('span', '', SV_TYPE_LABELS[t]));
    b.addEventListener('click', () => {
      svState.questions.push(svMakeQuestion(t));
      typeMenu.classList.add('hidden');
      renderSvQuestions();
      selectSvCard(svState.questions.length - 1, { force: true, scroll: true });
    });
    typeMenu.appendChild(b);
  }
  svTypeMenuNode = typeMenu;
  btnAdd.addEventListener('click', (e) => {
    e.stopPropagation();
    typeMenu.classList.toggle('hidden');
  });
  addRow.append(btnAdd, typeMenu);
  secQs.appendChild(addRow);

  // 4 结束语
  const secEnd = sectionHead('结束语', { hint: '全部题目完成后的最后一条消息；留空则显示默认感谢文案。' });
  const endField = makeField('结束语内容（可留空）', svState.endText, 3);
  endField.input.addEventListener('input', () => {
    svState.endText = endField.input.value;
    scheduleSvPreview();
  });
  secEnd.appendChild(endField.wrap);

  $svEditor.append(secBasic, secStart, secQs, secEnd);
  renderSvQuestions();
}

/* ------------------------------------------------ 数据页 / 个案 / 导出 */

async function renderSvData(id) {
  $svDataHead.innerHTML = '';
  $svDataToolbar.innerHTML = '';
  $svDataSummary.textContent = '';
  $svDataSummary.classList.remove('err');
  $svDataList.innerHTML = '';

  let data;
  try {
    data = await api(`/api/admin/survey/sessions?id=${encodeURIComponent(id)}`);
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $svDataTitle.textContent = '问卷数据';
    $svDataSummary.textContent = err.message || '数据加载失败';
    $svDataSummary.classList.add('err');
    return;
  }

  const { survey, sessions, totalUnits } = data;
  $svDataTitle.textContent = `${survey.title} · 数据`;

  const titleRow = el('div', 'q-detail-title-row');
  titleRow.append(
    el('code', 'cell-code', survey.id),
    el('span', 'role-tag', `${survey.questionCount} 题 · ${totalUnits} 个作答单元`),
    el('span', 'q-detail-created', `创建于 ${formatTime(survey.createdAt)}`)
  );
  $svDataHead.appendChild(titleRow);

  const linkRow = el('div', 'link-row');
  const linkInput = document.createElement('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  linkInput.value = `${location.origin}/survey?c=${survey.id}`;
  linkInput.addEventListener('click', () => linkInput.select());
  const btnCopy = el('button', 'ghost-btn', '复制填写链接');
  btnCopy.type = 'button';
  btnCopy.addEventListener('click', () => copyText(linkInput.value, '填写链接已复制'));
  linkRow.append(linkInput, btnCopy);
  $svDataHead.appendChild(linkRow);

  const btnExport = el('button', 'ghost-btn', '导出全部（xlsx）');
  btnExport.type = 'button';
  btnExport.addEventListener('click', () => exportSvXlsx(survey));
  $svDataToolbar.appendChild(btnExport);

  const completed = sessions.filter((s) => s.status === 'completed').length;
  $svDataSummary.textContent = `共 ${sessions.length} 位填写（完成 ${completed} · 进行中 ${sessions.length - completed}）；点击一行查看该次填写的完整作答与对话。`;

  if (!sessions.length) {
    $svDataList.appendChild(el('p', 'data-empty', '暂无填写数据。把链接发给被试，提交后这里会实时汇总。'));
    return;
  }

  const table = el('table', 'data-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const t of ['编号', '状态', '作答进度', '开始时间', '时长', '操作']) {
    headRow.appendChild(el('th', '', t));
  }
  thead.appendChild(headRow);

  const tbody = el('tbody');
  for (const s of sessions) {
    const row = el('tr', 'data-row');
    row.title = '点击查看该次填写的完整作答与对话';
    row.append(
      el('td', 'cell-strong', s.seq == null ? '—' : `#${s.seq}`),
      el('td', '', s.statusLabel || s.status),
      el('td', 'cell-strong', `${s.answerCount} / ${totalUnits}`),
      el('td', '', formatTime(s.startedAt)),
      el('td', '', formatDuration(s.durationSec)),
      el('td', '', '查看 →')
    );
    row.addEventListener('click', () => {
      location.hash = `#/sv/${id}/s/${s.id}`;
    });
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  $svDataList.appendChild(table);
}

async function renderSvSession(id, sid) {
  $svSession.innerHTML = '';
  $svSessionTitle.textContent = '填写详情';

  let data;
  try {
    data = await api(`/api/admin/survey/session?id=${encodeURIComponent(id)}&sid=${encodeURIComponent(sid)}`);
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $svSession.appendChild(el('p', 'data-empty', err.message || '会话加载失败'));
    return;
  }

  const { survey, session, messages, answers } = data;
  $svSessionTitle.textContent = `${survey.title} · 填写 #${session.seq == null ? '—' : session.seq}`;

  // 1 会话信息
  const secMeta = sectionHead('会话信息');
  const grid = el('div', 'meta-grid');
  for (const [label, value] of [
    ['填写编号', session.seq == null ? '—' : `#${session.seq}`],
    ['状态', session.statusLabel || session.status],
    ['开始时间', formatTime(session.startedAt)],
    ['结束时间', formatTime(session.endedAt)],
    ['时长', formatDuration(session.durationSec)],
    ['作答进度', `${answers.length} 项已作答`]
  ]) {
    const item = el('div', 'meta-item');
    item.append(el('span', 'meta-label', label), el('span', 'meta-value', value));
    grid.appendChild(item);
  }
  secMeta.appendChild(grid);

  // 2 作答明细
  const secAns = sectionHead('作答明细', { hint: '按题目顺序排列；「作答」列为填写端实际回显的文案。' });
  if (!answers.length) {
    secAns.appendChild(el('p', 'data-empty', '暂无作答记录（可能尚未开始作答）。'));
  } else {
    const table = el('table', 'data-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const t of ['题目', '类型', '作答', '作答时间', '耗时']) {
      headRow.appendChild(el('th', '', t));
    }
    thead.appendChild(headRow);

    const tbody = el('tbody');
    for (const a of answers) {
      const label = a.subIndex > 0 ? `第 ${a.questionSort} 题 · 子题 ${a.subIndex + 1}` : `第 ${a.questionSort} 题`;
      const tr = el('tr');
      tr.append(
        el('td', 'cell-strong', `${label}：${a.questionLabel}`),
        el('td', '', a.typeLabel || a.type),
        el('td', '', a.answerText),
        el('td', '', formatTime(a.answeredAt)),
        el('td', '', a.elapsedMs == null ? '—' : `${Math.round(a.elapsedMs / 100) / 10} 秒`)
      );
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    secAns.appendChild(table);
  }

  // 3 对话记录
  const secMsg = sectionHead('对话记录', { hint: '填写端界面中实际呈现的全部消息，按先后顺序。' });
  if (!messages.length) {
    secMsg.appendChild(el('p', 'data-empty', '暂无消息记录。'));
  } else {
    const timeline = el('div', 'msg-timeline');
    for (const m of messages) {
      const item = el('div', m.role === 'user' ? 'msg-item' : 'msg-item msg-ai');
      const head = el('div', 'msg-head');
      head.append(el('span', 'msg-role', m.role === 'user' ? '填写者' : '系统'), el('span', 'msg-time', formatTime(m.created_at)));
      item.append(head, el('p', 'msg-content', m.content));
      timeline.appendChild(item);
    }
    secMsg.appendChild(timeline);
  }

  $svSession.append(secMeta, secAns, secMsg);
}

// 导出：一行一份填写、一题一列（含实验子题；题目变更后的历史列追加在后）
async function exportSvXlsx(survey) {
  try {
    const res = await fetch(`/api/admin/survey/export.xlsx?id=${encodeURIComponent(survey.id)}`, {
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
    a.download = `${survey.title}-数据.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast(`已开始下载：${survey.title}-数据.xlsx`);
  } catch (err) {
    $svDataSummary.textContent = err.message || '导出失败，请重试';
    $svDataSummary.classList.add('err');
  }
}

/* ---------------------------------------------------------------- 启动 */

boot();
