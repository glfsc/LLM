// 管理端逻辑：登录鉴权 + 情景空间管理（文本 / 任务清单 / 控制与干预组）+ 被试链接生成
// 与论文复刻流程一致：每情景一个空间，含研究2（决策→匹配文本→评分）与研究3（组别文本→再决策）全部固定文本。
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
const $scenarioList = $('scenario-list');
const $linkCards = $('link-cards');
const $batchGroup = $('batch-group');
const $batchStart = $('batch-start');
const $batchCount = $('batch-count');
const $btnBatch = $('btn-batch');
const $batchResult = $('batch-result');
const $batchOutput = $('batch-output');
const $batchCountLabel = $('batch-count-label');
const $btnCopyBatch = $('btn-copy-batch');
const $toast = $('toast');

const TOKEN_KEY = 'expchat_admin_token';
const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  scenarios: [],
  expanded: new Set()
};

// 任务类型：play_count 1 = 单次博弈，100 = 多次博弈
const PLAY_LABEL = { 1: '单次博弈', 100: '多次博弈' };

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

/* ---------------------------------------------------------------- 登录与视图 */

async function enterAdmin() {
  await loadScenarios();
  $loginView.classList.add('hidden');
  $adminView.classList.remove('hidden');
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

/* ---------------------------------------------------------------- 页签切换 */

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.tab;
    $('tab-texts').classList.toggle('hidden', tab !== 'texts');
    $('tab-links').classList.toggle('hidden', tab !== 'links');
  });
});

/* ---------------------------------------------------------------- 数据加载 */

async function loadScenarios() {
  const data = await api('/api/admin/scenarios');
  state.scenarios = data.scenarios;
  renderScenarioCards();
  renderLinkCards();
  renderBatchOptions();
}

/* ---------------------------------------------------------------- 情景空间卡片 */

function taskSummary(tasks) {
  return tasks.map((t) => PLAY_LABEL[t] || String(t)).join(' → ');
}

function refreshScenarioBadge(badge, scenario) {
  badge.textContent = scenario.enabled ? '已启用' : '已停用';
  badge.className = `badge ${scenario.enabled ? 'badge-on' : 'badge-off'}`;
}

function renderScenarioCards() {
  $scenarioList.innerHTML = '';
  for (const scenario of state.scenarios) {
    $scenarioList.appendChild(buildScenarioCard(scenario));
  }
}

// 任务清单编辑器：每项含类型标签 + 上移 / 下移 / 移除；同类型任务不可重复添加
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

// 组别区块：控制组 / 干预组各自的研究3 文本
function buildGroupBlock(group) {
  const block = el('div', 'group-block');

  const head = el('div', 'group-block-head');
  const roleTag = el('span', 'role-tag', group.role === 'control' ? '控制组' : '干预组');
  const switchLabel = el('label', 'switch-inline');
  const switchInput = el('input');
  switchInput.type = 'checkbox';
  switchInput.checked = group.enabled;
  switchLabel.append(switchInput, document.createTextNode('启用'));
  head.append(roleTag, el('code', 'group-id', group.id), switchLabel);
  block.appendChild(head);

  const nameField = makeField('组名（仅管理端可见）', group.name, 1);
  const onceField = makeField('研究3 文本 · 单次博弈任务时呈现', group.r3Once, 4);
  const multiField = makeField('研究3 文本 · 多次博弈任务时呈现', group.r3Multi, 4);
  block.append(nameField.wrap, onceField.wrap, multiField.wrap);

  const collect = () => ({
    id: group.id,
    name: nameField.input.value.trim(),
    r3Once: onceField.input.value,
    r3Multi: multiField.input.value,
    enabled: switchInput.checked
  });

  return { wrap: block, collect };
}

function buildScenarioCard(scenario) {
  const card = el('article', 'group-card');
  card.dataset.id = scenario.id;

  /* 头部 */
  const head = el('header', 'group-head');
  const title = el('div', 'group-title');
  const nameEl = el('span', 'group-name', scenario.name);
  const badge = el('span', 'badge');
  refreshScenarioBadge(badge, scenario);
  title.append(nameEl, el('code', 'group-id', scenario.id), badge);

  const meta = el('div', 'group-meta');
  const tasksEl = el('span', 'group-turns', taskSummary(scenario.tasks));
  const btnToggle = el('button', 'ghost-btn', '编辑');
  btnToggle.type = 'button';
  meta.append(tasksEl, btnToggle);
  head.append(title, meta);
  card.append(head);

  /* 编辑区 */
  const body = el('div', 'group-body hidden');
  card.append(body);

  btnToggle.addEventListener('click', () => {
    const collapsed = body.classList.toggle('hidden');
    if (collapsed) state.expanded.delete(scenario.id);
    else state.expanded.add(scenario.id);
    btnToggle.textContent = collapsed ? '编辑' : '收起';
  });
  if (state.expanded.has(scenario.id)) {
    body.classList.remove('hidden');
    btnToggle.textContent = '收起';
  }

  /* 基础信息 */
  const row = el('div', 'form-row');
  const nameField = makeField('情景名称（管理端显示）', scenario.name, 1);
  const switchField = el('label', 'field field-switch');
  switchField.appendChild(el('span', '', '启用该情景'));
  const switchInput = el('input');
  switchInput.type = 'checkbox';
  switchInput.checked = scenario.enabled;
  switchField.appendChild(switchInput);
  row.append(nameField.wrap, switchField);
  body.append(row);

  /* 情景材料与提问 */
  const secMaterial = el('section', 'scenario-section');
  secMaterial.appendChild(el('h4', 'section-title', '情景材料与提问'));
  const contextField = makeField('情境材料（进入任务时完整呈现）', scenario.contextText, 6);
  const onceQuestion = makeField('单次博弈提问', scenario.onceQuestion, 3);
  const multiQuestion = makeField('多次博弈提问', scenario.multiQuestion, 3);
  secMaterial.append(contextField.wrap, onceQuestion.wrap, multiQuestion.wrap);
  body.append(secMaterial);

  /* 研究2：匹配文本 + 评分题目 */
  const secR2 = el('section', 'scenario-section');
  secR2.appendChild(el('h4', 'section-title', '研究2 · 相似度文本与评分'));
  secR2.appendChild(
    el('p', 'section-hint', '下方四段文本在被试完成第一次决策后按「决策方向 × 任务类型」呈现，被试随后对该文本与自身思考过程的相似度评分。')
  );
  const r2OnceA = makeField('单次 · 选择方案A（非常可能 / 可能选A）', scenario.r2OnceA, 5);
  const r2OnceB = makeField('单次 · 选择方案B', scenario.r2OnceB, 5);
  const r2MultiA = makeField('多次 · 选择方案A', scenario.r2MultiA, 5);
  const r2MultiB = makeField('多次 · 选择方案B', scenario.r2MultiB, 5);
  const r2Row1 = el('div', 'form-row form-row-split');
  r2Row1.append(r2OnceA.wrap, r2OnceB.wrap);
  const r2Row2 = el('div', 'form-row form-row-split');
  r2Row2.append(r2MultiA.wrap, r2MultiB.wrap);
  const ratingField = makeField('相似度评分题目（7 点量表）', scenario.ratingQuestion, 2);
  secR2.append(r2Row1, r2Row2, ratingField.wrap);
  body.append(secR2);

  /* 任务清单 */
  const secTasks = el('section', 'scenario-section');
  secTasks.appendChild(el('h4', 'section-title', '任务清单（被试按顺序完成）'));
  secTasks.appendChild(
    el('p', 'section-hint', '每个任务固定包含：决策 → 匹配文本 → 相似度评分 → 组别文本 → 再次决策；此处只配置任务类型与顺序。')
  );
  const taskEditor = buildTaskEditor(scenario.tasks);
  secTasks.appendChild(taskEditor.wrap);
  body.append(secTasks);

  /* 研究3：组别文本 */
  const secR3 = el('section', 'scenario-section');
  secR3.appendChild(el('h4', 'section-title', '研究3 · 组别文本（被试不可见，由链接决定）'));
  const groupBlocks = scenario.groups.map((g) => buildGroupBlock(g));
  for (const gb of groupBlocks) secR3.appendChild(gb.wrap);
  body.append(secR3);

  /* 保存 */
  const actions = el('div', 'group-actions');
  const btnSave = el('button', 'primary-btn', '保存该情景');
  btnSave.type = 'button';
  const saveState = el('span', 'save-state', '');
  actions.append(btnSave, saveState);
  body.append(actions);

  btnSave.addEventListener('click', async () => {
    const payload = {
      id: scenario.id,
      name: nameField.input.value.trim(),
      enabled: switchInput.checked,
      contextText: contextField.input.value,
      onceQuestion: onceQuestion.input.value,
      multiQuestion: multiQuestion.input.value,
      r2OnceA: r2OnceA.input.value,
      r2OnceB: r2OnceB.input.value,
      r2MultiA: r2MultiA.input.value,
      r2MultiB: r2MultiB.input.value,
      ratingQuestion: ratingField.input.value,
      tasks: [...taskEditor.list.children].map((n) => Number(n.dataset.play)),
      groups: groupBlocks.map((gb) => gb.collect())
    };

    const fail = (message) => {
      saveState.classList.add('err');
      saveState.textContent = message;
    };
    if (!payload.name) return fail('请填写情景名称');
    for (const [key, label] of [
      ['contextText', '情境材料'],
      ['onceQuestion', '单次博弈提问'],
      ['multiQuestion', '多次博弈提问'],
      ['r2OnceA', '单次·选A 相似度文本'],
      ['r2OnceB', '单次·选B 相似度文本'],
      ['r2MultiA', '多次·选A 相似度文本'],
      ['r2MultiB', '多次·选B 相似度文本'],
      ['ratingQuestion', '相似度评分题目']
    ]) {
      if (!String(payload[key]).trim()) return fail(`${label}不能为空`);
    }
    if (payload.tasks.length === 0) return fail('任务清单至少包含一个任务');
    for (const g of payload.groups) {
      if (!g.name) return fail('组名不能为空');
      if (!String(g.r3Once).trim() || !String(g.r3Multi).trim()) {
        return fail(`${g.name}的研究3文本不能为空`);
      }
    }

    saveState.classList.remove('err');
    saveState.textContent = '保存中…';
    btnSave.disabled = true;
    try {
      const res = await api('/api/admin/scenario', { method: 'POST', body: payload });
      Object.assign(scenario, res.scenario);
      nameEl.textContent = scenario.name;
      tasksEl.textContent = taskSummary(scenario.tasks);
      refreshScenarioBadge(badge, scenario);
      saveState.textContent = '已保存 ✓';
      toast('已保存');
      renderLinkCards();
      renderBatchOptions();
    } catch (err) {
      fail(err.message || '保存失败，请重试');
    } finally {
      btnSave.disabled = false;
    }
  });

  return card;
}

/* ---------------------------------------------------------------- 被试链接 */

// 仅展示已启用的情景与分组（停用的组合无法被试进入）
function enabledCombos() {
  const combos = [];
  for (const scenario of state.scenarios) {
    if (!scenario.enabled) continue;
    for (const group of scenario.groups) {
      if (group.enabled) combos.push({ scenario, group });
    }
  }
  return combos;
}

function renderLinkCards() {
  $linkCards.innerHTML = '';
  const origin = location.origin;
  const combos = enabledCombos();

  if (combos.length === 0) {
    $linkCards.appendChild(
      el('p', 'panel-sub', '当前没有已启用的情景或分组，请先在「情景与文本」中启用。')
    );
    return;
  }

  for (const { scenario, group } of combos) {
    const card = el('div', 'link-card');
    const h3 = el('h3');
    h3.append(document.createTextNode(`${scenario.name} · ${group.name}`), el('code', '', group.id));

    const row = el('div', 'link-row');
    const input = el('input');
    input.readOnly = true;
    input.value = `${origin}/chat?group=${encodeURIComponent(group.id)}&uid={uid}`;
    const btnCopy = el('button', 'ghost-btn', '复制模板');
    btnCopy.type = 'button';
    btnCopy.addEventListener('click', () => copyText(input.value, '链接模板已复制'));
    row.append(input, btnCopy);

    const hint = el('p', 'link-hint');
    const example = el('a', '', `${origin}/chat?group=${encodeURIComponent(group.id)}&uid=1001`);
    example.href = `/chat?group=${encodeURIComponent(group.id)}&uid=1001`;
    example.target = '_blank';
    hint.append(document.createTextNode('示例（可直接点击试跑）：'), example);

    card.append(h3, row, hint);
    $linkCards.appendChild(card);
  }
}

function renderBatchOptions() {
  const current = $batchGroup.value;
  $batchGroup.innerHTML = '';
  for (const { scenario, group } of enabledCombos()) {
    const opt = el('option', '', `${scenario.name} · ${group.name}（${group.id}）`);
    opt.value = group.id;
    $batchGroup.appendChild(opt);
  }
  if (current && [...$batchGroup.options].some((o) => o.value === current)) {
    $batchGroup.value = current;
  }
}

// 起始编号为纯数字 → 递增（保留前导零）；否则 → 以 “-序号” 追加
function buildUids(start, count) {
  const uids = [];
  if (/^\d+$/.test(start)) {
    const base = Number(start);
    const width = start.length;
    for (let i = 0; i < count; i += 1) {
      uids.push(String(base + i).padStart(width, '0'));
    }
  } else {
    for (let i = 1; i <= count; i += 1) {
      uids.push(`${start}-${i}`);
    }
  }
  return uids;
}

$btnBatch.addEventListener('click', () => {
  const groupId = $batchGroup.value;
  const start = $batchStart.value.trim();
  const count = Math.floor(Number($batchCount.value));

  if (!groupId) return toast('请先在文本管理中启用情景与分组');
  if (!start) return toast('请填写起始编号');
  if (!Number.isFinite(count) || count < 1 || count > 500) {
    return toast('数量需为 1-500 之间的数字');
  }

  const origin = location.origin;
  const lines = buildUids(start, count).map(
    (uid) => `${origin}/chat?group=${encodeURIComponent(groupId)}&uid=${encodeURIComponent(uid)}`
  );
  $batchOutput.value = lines.join('\n');
  $batchCountLabel.textContent = `共 ${lines.length} 条链接`;
  $batchResult.classList.remove('hidden');
});

$btnCopyBatch.addEventListener('click', () => copyText($batchOutput.value, '已复制全部链接'));

/* ---------------------------------------------------------------- 启动 */

boot();
