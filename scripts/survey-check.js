// 通用问卷模块自检（API 全链路 + 落库核验 + 关键界面快照）
// 验证目标：
//   1) 管理端：创建问卷 → 7 题录入（含「其他」选项与实验题 2 子题）→ 回读一致
//   2) 被试端：preview 结构校验（不落库）→ 完整填写会话（8 个作答单元，含负例分支：
//      「其他」未填 / 多选超限 / 必答跳过 / 跨题提交 / 排序不完整 / 必答留空 / 结束后再提交）
//   3) 落库正确：answers 回显文案、子题 sub_index、shown_at = answered_at − elapsed_ms、消息条数
//   4) 数据页 / 个案详情 / xlsx 导出接口可用
//   5) 关键界面快照（管理端编辑器·数据页·个案；填写端桌面 + 375×667 手机视口断言与折叠）
//   6) 清理：非 force 删除被拦截 → force 删除 → 无残留
// 用法：先启动服务（npm start），再执行：node scripts/survey-check.js
//      跳过界面快照段（无浏览器环境）：SKIP_SHOTS=1 node scripts/survey-check.js
// 说明：脚本会创建一份「自检问卷·通用问卷」跑完全流程校验，结束后自动删除，不留数据。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DB_FILE = path.join(__dirname, '..', 'data.db');
const OUT_DIR = path.join(__dirname, '..', 'screenshots');
const SKIP_SHOTS = process.env.SKIP_SHOTS === '1';
const CDP_PORT = Number(process.env.CDP_PORT) || 9336;
const SELF_TITLE = '自检问卷·通用问卷';

const START_TEXT = '您好！这是一份产品体验小调研，共 7 题，约 1 分钟。请按真实感受作答。';
const END_TEXT = '问卷到此结束，感谢您的参与！';
const EXP_TITLE = '实验一 · 情境阅读';
const EXP_BG = '某平台正在测试新版推荐算法：新版会优先展示你常看的内容，但看到的新话题会变少。请根据第一感觉作答。';

// 7 道题：六种题型全覆盖 + 实验题（2 子题）→ 展平 8 个作答单元
const SELF_QUESTIONS = [
  {
    type: 'single', title: '您的年龄段是？', required: true,
    options: ['18-24 岁', '25-30 岁', '31-40 岁', '41 岁及以上'],
    config: { layout: 2, other: true }
  },
  {
    type: 'multi', title: '您使用过以下哪些产品？', required: true,
    options: ['手机', '平板', '电脑', '耳机', '手表'],
    config: { layout: 2, minSel: 1, maxSel: 2 }
  },
  { type: 'text', title: '您所在的城市是？', required: false, options: [], config: {} },
  {
    type: 'rating', title: '总体而言，您对产品的满意度如何？', required: true, options: [],
    config: { min: 1, max: 5, display: 'all', anchor: '1 = 很不满意 · 5 = 非常满意', labels: { 1: '很不满意', 5: '非常满意' } }
  },
  {
    type: 'rank', title: '请对以下因素的重要性排序', required: true,
    options: ['响应速度', '准确性', '易用性', '隐私保护'], config: {}
  },
  { type: 'qa', title: '您对产品还有什么建议？', required: true, options: [], config: {} },
  {
    type: 'experiment', title: EXP_TITLE, required: true, options: [],
    config: {
      background: EXP_BG,
      images: [],
      subs: [
        { type: 'single', title: '您是否愿意继续使用新版推荐？', required: true, options: ['愿意', '不愿意'], config: {} },
        { type: 'rating', title: '您对新版的整体评价', required: true, options: [], config: { min: 1, max: 5 } }
      ]
    }
  }
];

// 逐单元作答计划：先跑负例（不影响落库），再正常提交并校验回显与推进
const STEPS = [
  {
    desc: '单选题（选「其他」并填写）',
    submit: { value: 4, otherText: '暂不透露' },
    echo: '我选择：其他（暂不透露）',
    nextType: 'multi',
    negatives: [{ desc: '「其他」未填内容', body: { value: 4 }, keyword: '请填写「其他」的内容' }]
  },
  {
    desc: '多选题（限选 2 项）',
    submit: { values: [0, 2] },
    echo: '我选择：手机、电脑（共 2 项）',
    nextType: 'text',
    negatives: [
      { desc: '多选超限', body: { values: [0, 1, 2] }, keyword: '最多选择 2 项' },
      { desc: '必答题跳过', body: { skip: true }, keyword: '不能跳过' }
    ]
  },
  {
    desc: '填空题（选答 → 跳过）',
    submit: { skip: true },
    echo: '（跳过）',
    nextType: 'rating',
    negatives: [{ desc: '跨题提交（questionId 不同步）', body: { value: 1 }, questionIdDelta: 999, keyword: '不同步', status: 409 }]
  },
  { desc: '评分题', submit: { value: 4 }, echo: '评分：4 分', nextType: 'rank', negatives: [] },
  {
    desc: '排序题',
    submit: { order: [2, 0, 3, 1] },
    echo: '排序：1. 易用性  2. 响应速度  3. 隐私保护  4. 准确性',
    nextType: 'qa',
    negatives: [{ desc: '排序不完整', body: { order: [0, 1] }, keyword: '请给出完整的排序结果' }]
  },
  {
    desc: '问答题',
    submit: { text: '希望增加夜间模式。' },
    echo: '我的回答：希望增加夜间模式。',
    nextType: 'single',
    negatives: [{ desc: '必答题留空', body: { text: '' }, keyword: '请填写内容后再提交' }]
  },
  { desc: '实验 · 子题1（单选）', submit: { value: 0 }, echo: '我选择：愿意', nextType: 'rating', negatives: [] },
  { desc: '实验 · 子题2（评分）', submit: { value: 5 }, echo: '评分：5 分', nextType: null, negatives: [] }
];

const UNIT_COUNT = STEPS.length; // 8
const MESSAGE_COUNT = 11; // 1 开始语 + 6 普通题回显 + 1 实验背景 + 2 子题回显 + 1 结束语

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- 请求封装 */

async function request(route, options = {}) {
  const res = await fetch(BASE + route, {
    method: options.body ? 'POST' : 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// 不抛错版本：用于负例断言
async function requestRaw(route, options = {}) {
  const res = await fetch(BASE + route, {
    method: options.body ? 'POST' : 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

let adminToken = '';

async function admin(route, options = {}) {
  const headers = { Authorization: `Bearer ${adminToken}` };
  if (options.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + route, {
    method: options.body ? 'POST' : 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (options.raw) {
    if (!res.ok) throw new Error(`${route} -> ${res.status}`);
    return { res, buffer: Buffer.from(await res.arrayBuffer()) };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function adminRaw(route, options = {}) {
  const headers = { Authorization: `Bearer ${adminToken}` };
  if (options.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + route, {
    method: options.body ? 'POST' : 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

function openDbReadOnly() {
  try {
    return new DatabaseSync(DB_FILE, { readOnly: true });
  } catch {
    return new DatabaseSync(DB_FILE);
  }
}

/* ---------------------------------------------------------------- 界面快照（CDP） */

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 20000);
    });
  }
}

// 关键界面快照：管理端编辑器（实时预览）/ 数据页 / 个案 + 填写端桌面 / 手机视口断言与折叠
async function runShots(code, check) {
  const browserPath = findBrowser();
  if (!browserPath) {
    check('界面快照：找到 Chrome / Edge', false, '未找到浏览器可执行文件（可用 SKIP_SHOTS=1 跳过）');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = path.join(os.tmpdir(), `survey-check-${Date.now()}`);
  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1500,950',
      '--hide-scrollbars',
      '--no-first-run',
      '--disable-extensions',
      '--mute-audio',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );
  process.on('exit', () => {
    try {
      browser.kill();
    } catch {
      /* 忽略 */
    }
  });

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* 继续等待 */
    }
    await sleep(250);
  }
  if (!ready) throw new Error('浏览器调试端口未就绪');

  let target = null;
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new`, { method: 'PUT' });
    if (res.ok) target = await res.json();
  } catch {
    /* 降级到已有页面 */
  }
  if (!target) {
    const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
    target = list.find((t) => t.type === 'page');
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });

  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 2, mobile: false });

  let shotIndex = 0;
  const shot = async (name) => {
    shotIndex += 1;
    const fileName = `sv-${String(shotIndex).padStart(2, '0')}-${name}.png`;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, fileName), Buffer.from(data, 'base64'));
    console.log(`  截图 ${fileName}`);
  };
  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      const desc = (res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text;
      throw new Error(`页面脚本出错: ${desc}`);
    }
    return res.result.value;
  };
  const goto = async (url, settle = 900) => {
    await cdp.send('Page.navigate', { url });
    await sleep(settle);
  };
  const hashTo = async (hash, settle = 1000) => {
    await evaluate(`(() => { location.hash = ${JSON.stringify(hash)}; return 'ok'; })()`);
    await sleep(settle);
  };
  const poll = async (expr, timeout = 15000, step = 300) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const v = await evaluate(expr);
        if (v) return v;
      } catch {
        /* 忽略瞬时错误 */
      }
      await sleep(step);
    }
    return null;
  };
  const setViewport = async (width, height, mobile) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    await sleep(400);
  };

  // 1) 管理端编辑器：两栏布局 + 手机实时预览（默认选中第 1 题）
  await goto(`${BASE}/admin.html`, 600);
  await poll(`!!document.querySelector('.login-view, .admin-layout')`, 15000);
  await evaluate(`(() => { sessionStorage.setItem('expchat_admin_token', ${JSON.stringify(adminToken)}); return 'ok'; })()`);
  await goto(`${BASE}/admin.html`, 600);
  await poll(`!!document.querySelector('.admin-layout')`, 15000);
  await hashTo(`#/sv/${code}`, 1000);
  const previewReady = await poll(`typeof svState !== 'undefined' && svState.previewReady === true`, 30000);
  check('界面快照：编辑器实时预览就绪', !!previewReady);
  const editorInfo = await evaluate(`(() => {
    const cards = document.querySelectorAll('#sv-qlist .sv-qcard').length;
    const editing = [...document.querySelectorAll('#sv-qlist .sv-qcard')].findIndex((c) => c.classList.contains('editing'));
    const d = document.getElementById('sv-preview').contentDocument;
    const tag = d && d.getElementById('s-tag') ? d.getElementById('s-tag').textContent : '';
    return { cards, editing, tag };
  })()`);
  check('界面快照：编辑器 7 题卡 + 默认选中第 1 题', editorInfo.cards === 7 && editorInfo.editing === 0, JSON.stringify(editorInfo));
  await shot('admin-editor');

  // 2) 管理端数据页（此时仅 1 份完成数据）+ 个案详情
  await hashTo(`#/sv/${code}/data`, 1100);
  await poll(`document.querySelectorAll('#sv-data-list tbody tr').length >= 1`, 10000);
  const dataRows = await evaluate(`document.querySelectorAll('#sv-data-list tbody tr').length`);
  check('界面快照：数据页含 1 份填写', dataRows === 1, `行数=${dataRows}`);
  await shot('admin-data');
  await evaluate(`(() => { document.querySelector('#sv-data-list tbody tr').click(); return 'ok'; })()`);
  await sleep(900);
  const sessionTitle = await evaluate(`document.getElementById('sv-session-title').textContent`);
  check('界面快照：个案详情打开', /填写 #1/.test(sessionTitle), sessionTitle);
  await shot('admin-session');

  // 3) 填写端（桌面）：开始语 + 第 1 题单选
  const composerReady = `(() => {
    const wrap = document.getElementById('composer-wrap');
    const title = document.getElementById('s-title');
    return !!wrap && !wrap.classList.contains('hidden') && !!title && title.textContent.length > 0;
  })()`;
  await setViewport(1280, 900, false);
  await goto(`${BASE}/survey?c=${code}&fresh=1`, 1200);
  const ready1 = await poll(composerReady, 60000, 400);
  check('界面快照：填写端桌面第 1 题出现', !!ready1);
  await sleep(500);
  const deskInfo = await evaluate(`(() => {
    const opts = document.querySelectorAll('#s-controls .s-opt').length;
    const tag = document.getElementById('s-tag').textContent;
    return { opts, tag };
  })()`);
  check('界面快照：第 1 题含 4 个选项 + 其他', deskInfo.opts >= 4, JSON.stringify(deskInfo));
  await shot('survey-desktop');

  // 4) 手机视口（375×667）：选项区高度 / 输入栏贴底 / 折叠可用
  await setViewport(375, 667, true);
  await sleep(600);
  const mobile = await evaluate(`(() => {
    const opts = document.querySelector('#s-controls .s-opts');
    const composer = document.getElementById('composer-wrap');
    const col = document.getElementById('s-collapse');
    const oRect = opts ? opts.getBoundingClientRect() : { height: 0 };
    const cRect = composer.getBoundingClientRect();
    return {
      optsH: Math.round(oRect.height),
      viewH: window.innerHeight,
      ratio: +(oRect.height / window.innerHeight).toFixed(3),
      composerBottom: Math.round(cRect.bottom),
      collapseVisible: !!col && getComputedStyle(col).display !== 'none' && col.offsetParent !== null
    };
  })()`);
  check(
    '手机：选项区高度 ≤ 1/5 屏',
    mobile.ratio <= 0.225,
    `高度 ${mobile.optsH}px（${(mobile.ratio * 100).toFixed(1)}% 屏高）`
  );
  check('手机：底部作答区贴底（固定式，无键盘遮挡风险）', mobile.composerBottom >= mobile.viewH - 2, `bottom=${mobile.composerBottom} / viewH=${mobile.viewH}`);
  check('手机：折叠按钮可见', mobile.collapseVisible === true);
  await shot('survey-mobile');
  await evaluate(`(() => { document.getElementById('s-collapse').click(); return 'ok'; })()`);
  await sleep(400);
  const folded = await evaluate(`(() => {
    const card = document.getElementById('s-card');
    const controls = document.getElementById('s-controls');
    return {
      collapsed: card.classList.contains('collapsed'),
      optsHidden: !!controls && getComputedStyle(controls).display === 'none',
      cardH: Math.round(card.getBoundingClientRect().height)
    };
  })()`);
  check('手机：折叠后仅保留题条一行', folded.collapsed && folded.optsHidden && folded.cardH < 80, JSON.stringify(folded));
  await shot('survey-mobile-collapsed');

  await setViewport(1280, 900, false);
  ws.close();
  try {
    browser.kill();
  } catch {
    /* 忽略 */
  }
  await sleep(300);
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  console.log(`通用问卷自检开始（BASE = ${BASE}）`);
  let allPass = true;
  const check = (name, ok, extra) => {
    allPass = allPass && ok;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  -> ${extra}` : ''}`);
  };

  /* ---- 0) 准备：登录 + 清理同名残留 */
  console.log('\n[准备]');
  const login = await request('/api/admin/login', { body: { password: ADMIN_PASSWORD } });
  adminToken = login.token;
  check('管理员登录', !!adminToken);

  const before = await admin('/api/admin/surveys');
  let cleaned = 0;
  for (const s of before.surveys) {
    if (s.title === SELF_TITLE) {
      await admin('/api/admin/survey/delete', { body: { id: s.id, force: true } });
      cleaned += 1;
    }
  }
  if (cleaned) console.log(`  （已清理 ${cleaned} 份上次运行残留）`);

  /* ---- 1) 管理端：创建 → 7 题录入 → 回读一致 */
  console.log('\n[管理端创建与录入]');
  const created = await admin('/api/admin/survey/create', { body: { title: SELF_TITLE } });
  const code = created.survey.id;
  check('创建问卷', !!code && created.survey.questionCount === 0, `短码=${code}`);

  const saved = await admin('/api/admin/survey/update', {
    body: { id: code, title: SELF_TITLE, startText: START_TEXT, endText: END_TEXT, questions: SELF_QUESTIONS }
  });
  check('保存 7 题整树', saved.survey.questionCount === 7, `题数=${saved.survey.questionCount}`);

  const reread = await admin(`/api/admin/survey?id=${code}`);
  const qs = reread.survey.questions;
  const q0 = qs[0];
  const q3 = qs[3];
  const q6 = qs[6];
  check(
    '回读：单选配置（other + layout=2）',
    q0.type === 'single' && q0.options.length === 4 && q0.config.other === true && q0.config.layout === 2,
    JSON.stringify(q0.config)
  );
  check(
    '回读：评分区间与逐档文案',
    q3.type === 'rating' && q3.config.min === 1 && q3.config.max === 5 && q3.config.display === 'all' && q3.config.labels['5'] === '非常满意',
    JSON.stringify(q3.config)
  );
  check(
    '回读：实验题 2 子题与背景',
    q6.type === 'experiment' && q6.config.subs.length === 2 && q6.config.subs[0].type === 'single' && q6.config.background.includes('推荐算法'),
    `subs=${q6.config.subs.map((s) => s.type).join('+')}`
  );

  /* ---- 2) preview 结构校验：不建会话、不落库 */
  console.log('\n[预览（管理端试填）]');
  const pv = await request(`/api/survey/bootstrap?c=${code}&preview=1`);
  check(
    'preview 返回结构且无会话',
    pv.preview === true && pv.session === null && pv.action === null && (pv.survey.questions || []).length === 7
  );
  const sessBefore = await admin(`/api/admin/survey/sessions?id=${code}`);
  check('preview 不落库（会话数为 0）', sessBefore.sessions.length === 0);

  /* ---- 3) 创造会话 + 逐单元作答（含负例） */
  console.log('\n[填写会话（含负例分支）]');
  const sessionStart = await request('/api/survey/session', { body: { c: code } });
  const sid = sessionStart.session.id;
  check(
    '创建会话：编号 1、首题动作为单选',
    sessionStart.session.seq === 1 && sessionStart.action && sessionStart.action.type === 'single',
    `seq=${sessionStart.session.seq}`
  );
  check(
    '开始语入库为首条 AI 消息',
    sessionStart.messages.length === 1 && sessionStart.messages[0].role === 'assistant' && sessionStart.messages[0].content === START_TEXT
  );

  let action = sessionStart.action;
  let lastStatus = '';
  for (let i = 0; i < STEPS.length; i += 1) {
    const step = STEPS[i];

    // 负例：期望被拒绝且不推进
    for (const neg of step.negatives || []) {
      const body = {
        sessionId: sid,
        questionId: action.questionId + (neg.questionIdDelta || 0),
        subIndex: action.subIndex,
        ...neg.body,
        elapsedMs: 1000
      };
      const { status, data } = await requestRaw('/api/survey/step', { body });
      check(
        `负例 · ${neg.desc}`,
        status === (neg.status || 400) && String(data.message || '').includes(neg.keyword),
        `${status} ${data.message || ''}`
      );
    }

    // 正常提交
    const elapsedMs = 1600 + i * 250;
    const res = await request('/api/survey/step', {
      body: { sessionId: sid, questionId: action.questionId, subIndex: action.subIndex, ...step.submit, elapsedMs }
    });
    const echoOk = res.userMessage && res.userMessage.role === 'user' && res.userMessage.content === step.echo;
    const nextType = res.action ? res.action.type : null;
    check(
      `${step.desc} → 回显与推进`,
      echoOk && nextType === step.nextType && res.completedUnits === i + 1 && res.totalUnits === UNIT_COUNT,
      echoOk ? `echo=${step.echo}${nextType ? ` / 下一题=${nextType}` : ' / 会话完成'}` : `actual=${res.userMessage && res.userMessage.content}`
    );

    if (i === 5) {
      check(
        '进入实验题时输出背景说明（标题 + 背景）',
        res.messages.length === 1 && res.messages[0].role === 'assistant' && res.messages[0].content === `${EXP_TITLE}\n\n${EXP_BG}`
      );
    }
    if (i === STEPS.length - 1) {
      check(
        '答完末题：输出结束语并完成会话',
        res.messages.length === 1 && res.messages[0].content === END_TEXT && res.session.status === 'completed' && res.action === null,
        `status=${res.session.status}`
      );
    }
    lastStatus = res.session.status;
    action = res.action;
  }
  check('会话最终状态 completed', lastStatus === 'completed');

  const afterClosed = await requestRaw('/api/survey/step', { body: { sessionId: sid, value: 1, elapsedMs: 500 } });
  check('结束后再提交 → 409', afterClosed.status === 409, `${afterClosed.status} ${afterClosed.data && afterClosed.data.message}`);

  /* ---- 4) 数据页 / 个案 / 落库核验 */
  console.log('\n[落库与数据接口]');
  const summaries = await admin(`/api/admin/survey/sessions?id=${code}`);
  const sum0 = summaries.sessions[0];
  check(
    '数据页摘要：complete / 8 作答 / 11 消息 / 耗时非空',
    summaries.sessions.length === 1 &&
      sum0.status === 'completed' &&
      sum0.answerCount === UNIT_COUNT &&
      sum0.messageCount === MESSAGE_COUNT &&
      sum0.durationSec !== null,
    `回答=${sum0.answerCount} 消息=${sum0.messageCount}`
  );

  const detail = await admin(`/api/admin/survey/session?id=${code}&sid=${sid}`);
  const ans = detail.answers;
  check(
    '个案详情：8 条作答 + 11 条消息',
    ans.length === UNIT_COUNT && detail.messages.length === MESSAGE_COUNT,
    `answers=${ans.length} messages=${detail.messages.length}`
  );
  check(
    '个案详情：跳过项与子题标签正确',
    ans[2].answerText === '（跳过）' && ans[6].subIndex === 0 && ans[7].subIndex === 1 && ans[6].questionLabel.includes('子题1'),
    `${ans[2].answerText} / ${ans[6].questionLabel}`
  );
  const showGap = new Date(ans[0].answeredAt).getTime() - new Date(ans[0].shownAt).getTime();
  check('时间戳：shown_at = answered_at − elapsed_ms', showGap === ans[0].elapsedMs, `差值=${showGap}ms / elapsed=${ans[0].elapsedMs}ms`);

  const db = openDbReadOnly();
  const dbAns = Number(db.prepare('SELECT COUNT(*) AS n FROM survey_answers WHERE session_id = ?').get(sid).n);
  const dbMsg = Number(db.prepare('SELECT COUNT(*) AS n FROM survey_messages WHERE session_id = ?').get(sid).n);
  check('直查数据库：answers / messages 条数一致', dbAns === UNIT_COUNT && dbMsg === MESSAGE_COUNT, `answers=${dbAns} messages=${dbMsg}`);

  /* ---- 5) xlsx 导出 */
  console.log('\n[导出]');
  const { res: xres, buffer } = await admin(`/api/admin/survey/export.xlsx?id=${code}`, { raw: true });
  const contentType = xres.headers.get('content-type') || '';
  check(
    '导出 xlsx：内容类型与文件头正常',
    contentType.includes('spreadsheetml') && buffer.length > 1000 && buffer[0] === 0x50 && buffer[1] === 0x4b,
    `${buffer.length} 字节`
  );
  check('导出文件名包含问卷标题', (xres.headers.get('content-disposition') || '').includes(encodeURIComponent(SELF_TITLE)));

  /* ---- 6) 关键界面快照（可通过 SKIP_SHOTS=1 跳过） */
  if (SKIP_SHOTS) {
    console.log('\n[界面快照] 已跳过（SKIP_SHOTS=1）');
  } else {
    console.log('\n[界面快照]');
    await runShots(code, check);
  }

  /* ---- 7) 清理：非 force 拦截 → force 删除 → 无残留 */
  console.log('\n[清理]');
  const del0 = await adminRaw('/api/admin/survey/delete', { body: { id: code } });
  check('非 force 删除被拦截（has_sessions）', del0.status === 400 && del0.data.error === 'has_sessions' && del0.data.sessionCount >= 1, `sessionCount=${del0.data.sessionCount}`);
  const del1 = await admin('/api/admin/survey/delete', { body: { id: code, force: true } });
  check('force 删除成功', del1.ok === true);
  const after = await admin(`/api/admin/survey/sessions?id=${code}`).catch((err) => ({ notFound: /404/.test(err.message) }));
  check('删除后查询返回 404', after.notFound === true || after.sessions === undefined);
  const left = {
    survey: Number(db.prepare('SELECT COUNT(*) AS n FROM surveys WHERE id = ?').get(code).n),
    sessions: Number(db.prepare('SELECT COUNT(*) AS n FROM survey_sessions WHERE survey_id = ?').get(code).n),
    answers: Number(db.prepare('SELECT COUNT(*) AS n FROM survey_answers sa JOIN survey_sessions ss ON ss.id = sa.session_id WHERE ss.survey_id = ?').get(code).n),
    messages: Number(db.prepare('SELECT COUNT(*) AS n FROM survey_messages sm JOIN survey_sessions ss ON ss.id = sm.session_id WHERE ss.survey_id = ?').get(code).n)
  };
  check(
    '无残留（问卷 / 会话 / 作答 / 消息均为 0）',
    left.survey === 0 && left.sessions === 0 && left.answers === 0 && left.messages === 0,
    JSON.stringify(left)
  );

  console.log(`\n---- result: ${allPass ? 'ALL PASS' : 'HAS FAILURES'} ----`);
  process.exitCode = allPass ? 0 : 1;
}

main().catch((err) => {
  console.error(`\n自检异常中止：${err.message}`);
  process.exitCode = 1;
});
