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
    ['view-r3-list', 'view-r3-editor']
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
  } else if (route.section === 'r2') viewId = route.id ? 'view-r2-editor' : 'view-r2-list';
  else if (route.section === 'r3') viewId = route.id ? 'view-r3-editor' : 'view-r3-list';
  else if (route.section === 'flow') viewId = 'view-flow';

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

/* ---------------------------------------------------------------- 启动 */

boot();
