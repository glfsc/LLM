// 界面走查：管理端（两栏 + 编辑期大纲 + 题卡 + 手机预览与试填）与被试端（9 种题型全流程）
// 用法：先启动服务（npm start），再执行：node scripts/capture-shots.js
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BASE = process.env.BASE || 'http://localhost:3000';
const PORT = Number(process.env.CDP_PORT) || 9333;
const OUT_DIR = path.join(__dirname, '..', 'screenshots');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
// 演示问卷：复制组别3 的问卷（题目与文档逐字一致），计时改短便于走查
const DEMO_NAME = '演示问卷（走查用）';
// 时间已到自检用的专用问卷（文本题 / 打分题各 6 秒作答窗口），走完即删
const TIMEOUT_Q = '【走查·时间已到停止作答】';
// 门控压到秒级：走查只需要「这些状态出现过」，不需要真实时长
// （真实门控由 consistency-check 用回拨快进覆盖）
// maxAnswer 留 30 秒：走查里能看到「作答倒计时」，又不至于在「跳到最后一题后先播回放」时把窗口耗光
// （压到 5 秒时，最后一道创作题会在回放还没播完就超时停止，走不到终态页）
const DEMO_TIMING = { wait: 2, minSubmit: 2, maxAnswer: 30 };
const DEMO_THINK_MS = 600;                                               // 思考面板时长（走查只看状态，不等真实 8 秒）
// 「需输入指定内容」的文本题：标准答案不下发被试端，走查时由这里显式喂给自动作答（与 consistency-check 同一套做法）
let MATCH_ANSWERS = {};
const setMatchAnswers = (items) => {
  MATCH_ANSWERS = Object.fromEntries(items
    .filter((i) => i.variant === 'match')
    .map((i) => [i.id, String(i.answer || '').split('\n')[0].trim()]));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome / Edge');
}

// 管理端请求走公共模块（与 consistency-check.js 共用同一套实现）
const { makeHttp } = require('./lib/http');
const { adminFetch } = makeHttp(BASE, ADMIN_PASSWORD);

// 准备演示问卷：每次重建，保证数据页只有一条完整会话
async function ensureDemo() {
  const token = (await adminFetch('', '/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD } })).token;
  const list = await adminFetch(token, '/api/admin/questionnaires');
  for (const q of list.questionnaires.filter((x) => x.title === DEMO_NAME)) {
    await adminFetch(token, '/api/admin/questionnaire/delete', { body: { id: q.id, force: true } });
  }
  const source = list.questionnaires.find((x) => /组别3/.test(x.title));
  const created = (await adminFetch(token, '/api/admin/questionnaire/create', { body: { title: DEMO_NAME, copyFrom: source.id } })).questionnaire;
  // 缩短题目级计时（模板插入的题目都带显式限制）：
  // 门控压到秒级，思考面板压到 0.6 秒——走查只需要「这些状态出现过」，
  // 不需要真实时长；真实时长由 consistency-check 用回拨快进覆盖。
  const items = created.items.map((it) => {
    const limits = { ...it.limits };
    if (limits.wait) limits.wait = DEMO_TIMING.wait;
    if (limits.minSubmit) limits.minSubmit = DEMO_TIMING.minSubmit;
    if (limits.maxAnswer) limits.maxAnswer = DEMO_TIMING.maxAnswer;
    if (limits.thinkMs) limits.thinkMs = DEMO_THINK_MS;
    if (/广告语和创作说明/.test(it.title)) limits.refresh = 1;   // 批次5：走查覆盖「呈现前清空」端到端（最后一题）
    return { ...it, limits };
  });
  console.log('  含计时限制的题目：' + items.filter((i) => Object.keys(i.limits).length).map((i) => `${i.title}[${JSON.stringify(i.limits)}]`).join(' '));
  // 走查要覆盖「阅读确认页（内联块）」：线上原卷已改用「需输入指定内容」的题，这里插一道确认页在最后一题之后
  const confirmAt = items.findIndex((i) => /广告语和创作说明/.test(i.title));
  if (confirmAt >= 0) {
    items.splice(confirmAt + 1, 0, {
      id: 'demo_confirm', type: 'confirm', title: '请确认你已阅读上面的反馈',
      text: '上面是系统给你的反馈。确认已读后，下面还有最后几道题。', button: '我已阅读，继续', limits: {}
    });
    console.log('  已插入阅读确认页（内联）演示题');
  }
  await adminFetch(token, '/api/admin/questionnaire/update', {
    body: { id: created.id, title: DEMO_NAME, timing: created.timing, items }
  });
  setMatchAnswers(items);
  console.log(`演示问卷：${DEMO_NAME}（${created.id}）· 题目 ${items.length} 道`
    + (Object.keys(MATCH_ANSWERS).length ? ` · 需输入指定内容 ${Object.keys(MATCH_ANSWERS).length} 道` : ''));
  return { token, questionnaire: created };
}

// 时间已到自检用的小问卷：文本题（消息式题面）+ 打分题（题卡）各 6 秒作答窗口。
// 每次重建，保证这一支走查不受上次残留影响。
async function ensureTimeoutFixture(token) {
  const list = await adminFetch(token, '/api/admin/questionnaires');
  for (const q of list.questionnaires.filter((x) => x.title === TIMEOUT_Q)) {
    await adminFetch(token, '/api/admin/questionnaire/delete', { body: { id: q.id, force: true } });
  }
  const items = [
    { id: 'to_g', type: 'gate', title: '知情同意', text: '请阅读并勾选同意。', check: '我已阅读并同意', button: '开始实验' },
    { id: 'to_t', type: 'text', title: '限时文本题', text: '请在窗口内作答。', rows: 1, limits: { maxAnswer: 6 } },
    { id: 'to_r', type: 'rating', title: '限时打分题', min: 1, max: 5, anchor: '1 = 不同意　·　5 = 同意', limits: { maxAnswer: 6 } },
    { id: 'to_e', type: 'debrief', title: '结束说明', text: '到此结束，感谢参与。' }
  ];
  const created = (await adminFetch(token, '/api/admin/questionnaire/create', { body: { title: TIMEOUT_Q, items } })).questionnaire;
  return created;
}

// AI 消息呈现自检用的小问卷：开场两条连续消息（第一条短、第二条长到超过一屏）+ 一条带思考面板的反馈。
// 用来验证两件事：① 长消息流式输出时「还没输出的部分不占高度」（否则视口会被顶到一片空白行上）；
// ② 思考面板的文字按目标时长铺满（字数多就走得快），末尾不再干等。
const FEEDBACK_Q = '【走查·AI 反馈呈现】';
const FEEDBACK_Q_THINK_MS = 3000;      // 面板时长（真实配置是 20 秒，走查只验证节奏关系）

async function ensureFeedbackFixture(token) {
  const list = await adminFetch(token, '/api/admin/questionnaires');
  for (const q of list.questionnaires.filter((x) => x.title === FEEDBACK_Q)) {
    await adminFetch(token, '/api/admin/questionnaire/delete', { body: { id: q.id, force: true } });
  }
  // 第二条消息要比视口还高（约 40 行），这样才能验证「跟随滚动不会停在没写字的空白底部」
  const longLines = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：占位文字。`);
  const items = [
    { id: 'fb_g', type: 'gate', title: '知情同意', text: '请阅读并勾选同意。', check: '我已阅读并同意', button: '开始实验' },
    { id: 'fb_m1', type: 'message', title: '第一条消息', text: '第一条消息：先把背景说清楚。' },
    { id: 'fb_m2', type: 'message', title: '第二条消息（长）', text: longLines.join('\n') },
    {
      id: 'fb_m3', type: 'message', title: '带思考面板的反馈',
      text: '反馈正文：这条消息前面有一块按固定时长铺满的思考面板。',
      thinking: '先看评价标准，再逐条对照。'.repeat(28),
      limits: { thinkMs: FEEDBACK_Q_THINK_MS }
    },
    { id: 'fb_t', type: 'text', title: '收尾文本题', text: '随便写一句。', rows: 1 },
    // 「交完卷、AI 还在长篇回应」的真实情形（创作 → 反馈 就是这样）：
    // 交上去之后紧接着一条 18 行的 AI 消息在逐字输出，这期间输入框必须是空的
    { id: 'fb_m4', type: 'message', title: '交卷后的 AI 回应', text: longLines.slice(0, 18).join('\n') },
    { id: 'fb_t2', type: 'text', title: '最后一道文本题', text: '随便写第二句。', rows: 1 }
  ];
  const created = (await adminFetch(token, '/api/admin/questionnaire/create', { body: { title: FEEDBACK_Q, items } })).questionnaire;
  return created;
}

// 致谢页置顶自检用的小问卷：知情同意页 + 一页很长的致谢（手机上必然可滚）。
// 手机上填编号一定会在知情同意页里往下滚，而这两页共用同一个全屏滚动容器 ——
// 以前浏览器会把知情同意页的滚动偏移沿用到致谢页，于是致谢页一进来就停在最下面。
const TOP_Q = '【走查·致谢页置顶】';
async function ensureTopFixture(token) {
  const list = await adminFetch(token, '/api/admin/questionnaires');
  for (const q of list.questionnaires.filter((x) => x.title === TOP_Q)) {
    await adminFetch(token, '/api/admin/questionnaire/delete', { body: { id: q.id, force: true } });
  }
  const items = [
    {
      // 知情同意页要够长：手机上必须超过一屏，它才会被滚动（真实知情同意页就是这种长度）
      id: 'tp_g', type: 'gate', title: '知情同意说明',
      text: Array.from({ length: 22 }, (_, i) => `第 ${i + 1} 行：知情同意说明的正文，手机上要滚动才能读完。`).join('\n'),
      check: '我已阅读并同意', button: '开始实验'
    },
    {
      id: 'tp_e', type: 'debrief', title: '致谢与事后解释',
      text: Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 行：致谢与事后解释的正文，用来把这一页撑到手机上必须滚动的高度。`).join('\n')
    }
  ];
  const created = (await adminFetch(token, '/api/admin/questionnaire/create', { body: { title: TOP_Q, items } })).questionnaire;
  return created;
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.nextId = 0; this.pending = new Map(); this.events = []; this.waiters = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method) {
        this.events.push(msg);
        this.waiters = this.waiters.filter((w) => { if (w.method !== msg.method) return true; w.resolve(msg.params); return false; });
      }
    });
  }
  send(method, params = {}) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); } }, 25000);
    });
  }
  waitEvent(method, timeout = 15000) {
    const found = this.events.find((e) => e.method === method);
    if (found) return Promise.resolve(found.params);
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve };
      this.waiters.push(waiter);
      setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== waiter); reject(new Error(`等待事件超时: ${method}`)); }, timeout);
    });
  }
}

let browserProc = null;
let shotIndex = 0;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { token, questionnaire } = await ensureDemo();
  const browserPath = findBrowser();
  const browser = spawn(browserPath, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), `expchat-capture-${Date.now()}`)}`,
    '--window-size=1440,1000', '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--mute-audio',
    'about:blank'
  ], { stdio: 'ignore' });
  browserProc = browser;
  process.on('exit', () => { try { browser.kill(); } catch { /* 忽略 */ } });

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try { const res = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (res.ok) { ready = true; break; } } catch { /* 等待 */ }
    await sleep(250);
  }
  if (!ready) throw new Error('浏览器调试端口未就绪');

  let target = null;
  try { const res = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: 'PUT' }); if (res.ok) target = await res.json(); } catch { /* 降级 */ }
  if (!target) target = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((t) => t.type === 'page');
  if (!target) throw new Error('未找到浏览器页面');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });

  const shot = async (name) => {
    shotIndex += 1;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`[${shotIndex}] ${name}`);
  };
  const goto = async (url, settle = 700) => {
    cdp.events = [];
    await cdp.send('Page.navigate', { url });
    await cdp.waitEvent('Page.loadEventFired');
    await sleep(settle);
  };
  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error('页面脚本出错: ' + ((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text));
    }
    return res.result.value;
  };
  const hashTo = async (hash, settle = 800) => { await evaluate(`(() => { location.hash = ${JSON.stringify(hash)}; return 'ok'; })()`); await sleep(settle); };
  const waitFor = async (expression, timeout, label) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok = await evaluate(`(() => { try { return !!(${expression}); } catch (e) { return false; } })()`);
      if (ok) return true;
      await sleep(400);
    }
    throw new Error('等待超时：' + label);
  };
  // 批次5 的硬性检查：不满足就让走查以非 0 退出
  const failures = [];
  const hardCheck = (ok, label, detail) => {
    console.log('  ' + (ok ? '✔' : '✘') + ' ' + label + (detail ? '（' + detail + '）' : ''));
    if (!ok) failures.push(label + (detail ? '（' + detail + '）' : ''));
  };

  // ---- 管理端
  await goto(`${BASE}/`, 900);
  await shot('v6-01-home');
  await goto(`${BASE}/admin`, 900);
  await shot('v6-02-admin-login');
  await evaluate(`sessionStorage.setItem('expchat_admin_token', ${JSON.stringify(token)})`);
  await goto(`${BASE}/admin`, 1200);
  await shot('v6-03-admin-exp-list');
  await hashTo('#/exp/group3-high-clarity', 1200);
  await shot('v6-04-admin-exp-editor');
  // 本轮：进入编辑页，大纲**默认折叠到最高层**（只显示最大级别，下属不显示）。
  // 「最高层」= 前面没有任何更深层级的题（用与大纲同一套层级规则独立算一遍，不直接读它的内部集合）
  const olFirst = JSON.parse(await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#sidebar-outline .ol-item')];
    const items = (state.editingExp && state.editingExp.items) || [];
    const rank = (lv) => { const v = Math.min(4, Math.max(0, Math.round(Number(lv) || 0))); return v === 0 ? 0 : 5 - v; };
    const roots = items.filter((it, i) => items.slice(0, i).every((p) => rank(p.level) <= rank(it.level)));
    const rootIds = roots.map((it) => it.id);
    return JSON.stringify({
      rows: rows.length, total: items.length, roots: rootIds.length,
      onlyRoots: rows.every((r) => rootIds.includes(r.dataset.id)),
      folded: rows.filter((r) => { const f = r.querySelector('.ol-fold'); return f && f.textContent === '▸'; }).length,
      unfoldArrow: rows.filter((r) => { const f = r.querySelector('.ol-fold'); return f && f.textContent === '▾'; }).length
    });
  })()`));
  hardCheck(olFirst.rows > 0 && olFirst.rows < olFirst.total && olFirst.onlyRoots && olFirst.unfoldArrow === 0,
    '进入编辑页：大纲默认折叠到最高层（只显示最大级别，下属不显示）',
    `显示 ${olFirst.rows} 行 / 共 ${olFirst.total} 题（最高层 ${olFirst.roots} 行）· 展开态的父题 ${olFirst.unfoldArrow} 个`);
  // 折叠 / 展开：点箭头 → 下属出现；箭头方向跟着变
  const foldCheck = JSON.parse(await evaluate(`(() => {
    const rows = () => [...document.querySelectorAll('#sidebar-outline .ol-item')];
    const before = rows().length;
    const parent = rows().find((r) => r.querySelector('.ol-fold'));
    if (!parent) return JSON.stringify({ skip: true });
    const id = parent.dataset.id;
    parent.querySelector('.ol-fold').click();
    const after = rows();
    const row = after.find((r) => r.dataset.id === id);
    return JSON.stringify({ skip: false, id, before, opened: after.length, arrow: row.querySelector('.ol-fold').textContent });
  })()`));
  hardCheck(!foldCheck.skip && foldCheck.opened > foldCheck.before && foldCheck.arrow === '▾',
    '大纲：点箭头展开下属（折叠 → 展开，箭头变向）',
    foldCheck.skip ? '没有可折叠的父题' : `${foldCheck.before} 行 → ${foldCheck.opened} 行，箭头 ${foldCheck.arrow}`);
  // 本轮：离开再进来要恢复「大纲长什么样」与「看到哪一题」（默认折叠只在没有记录时生效）
  const olSaved = JSON.parse(await evaluate(`(() => {
    const rows = () => [...document.querySelectorAll('#sidebar-outline .ol-item')];
    const folded = rows().find((r) => { const f = r.querySelector('.ol-fold'); return f && f.textContent === '▸'; });
    if (folded) folded.querySelector('.ol-fold').click();            // 再折一道：让状态与默认不同
    const list = rows();
    const target = list[list.length - 1];                             // 选最后一行（离第一题最远）
    target.click();
    return JSON.stringify({ id: target.dataset.id, rows: rows().length, scrollTop: Math.round(document.querySelector('.editor-scroll').scrollTop) });
  })()`));
  await sleep(900);
  await hashTo('#/q', 800);                                          // 离开编辑页
  await hashTo('#/exp/group3-high-clarity', 1500);                   // 再进来
  const olBack = JSON.parse(await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#sidebar-outline .ol-item')];
    const on = document.querySelector('#sidebar-outline .ol-item.on');
    const sc = document.querySelector('.editor-scroll');
    const card = on ? document.querySelector('.qcard[data-id="' + on.dataset.id + '"]') : null;
    return JSON.stringify({
      rows: rows.length, selected: state.selected || '', onId: on ? on.dataset.id : '',
      cardTop: card && sc ? Math.round(card.getBoundingClientRect().top - sc.getBoundingClientRect().top) : null
    });
  })()`));
  hardCheck(olBack.rows === olSaved.rows && olBack.selected === olSaved.id && olBack.onId === olSaved.id,
    '大纲：退出再进入，恢复上次的展开状态与所在题目',
    `回来 ${olBack.rows} 行（离开前 ${olSaved.rows} 行）· 选中 ${olBack.selected || '（空）'} / 高亮 ${olBack.onId || '（无）'}（期望 ${olSaved.id}）`);
  hardCheck(olBack.cardTop !== null && olBack.cardTop >= -4 && olBack.cardTop < 200,
    '大纲：恢复时编辑区落回那一题（瞬时落位，不再是回到第一题）',
    `题卡距编辑区顶 ${olBack.cardTop}px`);
  await shot('v6-05-admin-exp-outline');
  // 点大纲第 7 行：选中 + 平滑滑到该题开头（沿用原有的落点断言）
  await evaluate(`(() => { const rows=[...document.querySelectorAll('#sidebar-outline .ol-item')]; const r = rows[Math.min(6, rows.length - 1)]; r.click(); return 'ok'; })()`);
  await sleep(700);
  await shot('v6-28-admin-exp-outline-jump');
  // 选中「内容创作」题组并滚动到视口中央（选中态会展开为完整编辑器，含子题）
  await evaluate(`(() => { const c=[...document.querySelectorAll('.qcard')].find(x=>/内容创作/.test(x.querySelector('.qtitle').textContent)); if (c) c.querySelector('.qcard-head').click(); return 'ok'; })()`);
  await sleep(600);
  await evaluate(`(() => { const c=[...document.querySelectorAll('.qcard')].find(x=>/内容创作/.test(x.querySelector('.qtitle').textContent)); if (c) c.scrollIntoView({ block: 'center' }); return 'ok'; })()`);
  await sleep(600);
  await shot('v6-06-admin-timing-limits');
  // 手机预览：真 iframe 加载 /chat?preview=…（与被试端同一份页面、同一套状态机）
  // 用「立即显示」档：自动化浏览器在后台会把定时器节流，逐字动画会拖很久
  await evaluate(`(() => { const s = document.querySelector('.pv-speed'); if (s) { s.value = '20'; s.dispatchEvent(new Event('change')); } return 'ok'; })()`);
  await sleep(400);
  await evaluate(`document.querySelector('.phone-bar .mini-btn').click()`);
  await waitFor(`(() => { const f = document.querySelector('.phone-frame'); if (!f) return false; const d = f.contentDocument;
    if (!d || d.readyState !== 'complete') return false;
    const pageOn = d.getElementById('page-screen') && !d.getElementById('page-screen').classList.contains('hidden');
    return !!(pageOn || d.querySelector('.qcard, .qmsg')); })()`, 60000, '预览 iframe 呈现内容');
  await sleep(500);
  await shot('v6-07-admin-preview');
  const pvInfo = JSON.parse(await evaluate(`(() => { const d = document.querySelector('.phone-frame').contentDocument;
    return JSON.stringify({ title: d.getElementById('page-title').textContent, composer: !!d.getElementById('composer'),
      topbar: !!d.querySelector('.topbar'), rich: !!(d.getElementById('page-text') || {}).classList, richtext: typeof d.defaultView.RichText }); })()`));
  console.log('手机预览（真 iframe）：页面标题「' + (pvInfo.title || '（模板无知情同意页，直接进题目）') + '」· 顶栏 ' + (pvInfo.topbar ? '✔' : '✘')
    + ' · 常驻输入框 ' + (pvInfo.composer ? '✔' : '✘') + ' · richtext 模块 ' + (pvInfo.richtext === 'object' ? '✔' : '✘'));
    await hashTo('#/q', 900);
  await shot('v6-08-admin-q-list');
  await hashTo(`#/q/${questionnaire.id}`, 1200);
  await shot('v6-09-admin-q-editor');
  // 第三轮补丁：点大纲 → 题卡「开头」应落在粘性操作条下方，且不牵动整页（整页一动，右边手机栏会被顶出视口）
  const jumpId = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#sidebar-outline .ol-item')];
    const row = rows[Math.floor(rows.length * 0.4)];
    row.click();
    return row.dataset.id;
  })()`);
  await sleep(1100);                       // 平滑下滑 + 落点校正跑完再量
  const jump = JSON.parse(await evaluate(`(() => {
    const row = document.querySelector('#sidebar-outline .ol-item.on');   // 点过的那一行（高亮被钉住）
    const card = document.querySelector('.qcard[data-id="' + row.dataset.id + '"]');
    const bar = document.querySelector('.editor-actionbar');
    const main = document.getElementById('admin-main');
    const sc = document.querySelector('.editor-scroll');
    return JSON.stringify({
      id: row.dataset.id, selected: state.selected,
      cardTop: Math.round(card.getBoundingClientRect().top - sc.getBoundingClientRect().top),
      headTop: Math.round(card.querySelector('.qcard-head').getBoundingClientRect().top),
      barBottom: Math.round(bar.getBoundingClientRect().bottom),
      mainScroll: main.scrollTop, winY: Math.round(window.scrollY)
    });
  })()`));
  hardCheck(jump.selected === jump.id && jump.headTop >= jump.barBottom - 2,
    '点大纲：编辑区跳到该题开头（题头在粘性操作条下方）',
    '题头 ' + jump.headTop + 'px / 操作条底 ' + jump.barBottom + 'px');
  hardCheck(jump.mainScroll === 0,
    '点大纲不牵动整页（右侧手机栏留在原位）',
    'admin-main scrollTop=' + jump.mainScroll + '，window.scrollY=' + jump.winY);
  // 第三轮补丁：右侧手机栏必须完整可见（此前手机壳略高于主区域，被裁成只剩最下面一条）
  const phoneFit = JSON.parse(await evaluate(`(() => {
    const holder = document.querySelector('.phone-holder');
    const main = document.getElementById('admin-main');
    const r = holder.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), mainBottom: Math.round(m.bottom), overflow: main.scrollHeight - main.clientHeight });
  })()`));
  hardCheck(phoneFit.w >= 150 && phoneFit.bottom <= phoneFit.mainBottom + 2 && phoneFit.overflow <= 1,
    '右侧手机栏完整可见（未被裁、未撑出滚动）',
    phoneFit.w + '×' + phoneFit.h + '，栏底 ' + phoneFit.bottom + ' / 主区域底 ' + phoneFit.mainBottom + '，隐藏溢出 ' + phoneFit.overflow + 'px');

  // ---- 显示全卷：把每道题的正文拼成一份全文（每题之间一条分割线）→ 全选改字号 → 切回分题
  const fullInfo = JSON.parse(await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.editor-actionbar-right button')].find((b) => /显示全卷/.test(b.textContent));
    if (!btn) return JSON.stringify({ ok: false });
    btn.click();
    const view = document.querySelector('.fullview');
    const ed = view && view.querySelector('.rich-edit');
    const items = state.editingQ.items;
    return JSON.stringify({
      ok: true,
      visible: !!(view && !view.classList.contains('hidden')),
      seps: ed ? ed.querySelectorAll('hr.fullv-sep').length : -1,
      locators: ed ? ed.querySelectorAll('.fullv-head').length : -1,
      items: items.length,
      textLen: items.reduce((n, i) => n + String(i.text || '').length, 0)
    });
  })()`));
  hardCheck(fullInfo.ok && fullInfo.visible && fullInfo.seps === fullInfo.items - 1 && fullInfo.locators === fullInfo.items,
    '显示全卷：每题之间一条分割线 + 每题一行题目标识（不可编辑）',
    `分割线 ${fullInfo.seps} 条 / 标识行 ${fullInfo.locators} 行 / 共 ${fullInfo.items} 题`);
  await shot('v6-09b-admin-fullview');
  // 全选 → 改字号「小四 16px」：走的是编辑器工具条那条路（也覆盖「选区被下拉抢走 / 同值不触发」的修复）
  const fullApply = JSON.parse(await evaluate(`(() => {
    const view = document.querySelector('.fullview');
    const ed = view.querySelector('.rich-edit');
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    const sizeSel = view.querySelectorAll('.rich-bar select')[1];
    sizeSel.value = '16px';
    sizeSel.dispatchEvent(new Event('change'));
    return JSON.stringify({ value: sizeSel.value, spans: ed.querySelectorAll('[style*="font-size"]').length });
  })()`));
  hardCheck(fullApply.value === '16px' && fullApply.spans > 0,
    '全卷视图：全选后能改字号（下拉回显 = 刚应用的档位，不再「点了没反应」）',
    `下拉 ${fullApply.value} · 带字号的内联块 ${fullApply.spans} 处`);
  // 切回分题：按分割线切分写回 → 题数不变、文本一字不少、题目标识与分割线不会写进正文
  const fullBack = JSON.parse(await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.editor-actionbar-right button')].find((b) => /返回分题编辑/.test(b.textContent));
    if (!btn) return JSON.stringify({ ok: false });
    btn.click();
    const items = state.editingQ.items;
    const view = document.querySelector('.fullview');
    return JSON.stringify({
      ok: true,
      items: items.length,
      cards: document.querySelectorAll('.qcard').length,
      textLen: items.reduce((n, i) => n + String(i.text || '').length, 0),
      // 注意：这段在 JS 模板字符串里，正则里的 \s 要写成 \\s，否则反斜杠会被模板吃掉（/s*16px/ 匹配不上）
      with16: items.filter((i) => /font-size:\\s*16px/.test(i.html || '')).length,
      locatorLeak: items.filter((i) => /fullv-head/.test(i.html || '')).length,
      hrLeak: items.filter((i) => /<hr/i.test(i.html || '')).length,
      viewHidden: !view || view.classList.contains('hidden'),
      sample: items.slice(0, 3).map((i) => String(i.html || '').replace(/\\s+/g, ' ').slice(0, 70))
    });
  })()`));
  hardCheck(fullBack.ok && fullBack.viewHidden && fullBack.items === fullInfo.items
    && fullBack.textLen === fullInfo.textLen && fullBack.locatorLeak === 0 && fullBack.hrLeak === 0,
    '返回分题编辑：按分割线切回每题（题数不变、正文一字不少、标识行与分割线不写进正文）',
    `题数 ${fullBack.items}（原 ${fullInfo.items}）· 文本 ${fullBack.textLen}（原 ${fullInfo.textLen}）`
      + ` · 标识行泄漏 ${fullBack.locatorLeak} · 分割线泄漏 ${fullBack.hrLeak}`);
  hardCheck(fullBack.with16 >= 1, '全卷里改的字号确实写回了分题正文', `带 16px 的题目 ${fullBack.with16} 道`);
  console.log('全卷视图：' + fullBack.items + ' 题 · 切回后带 16px 的题 ' + fullBack.with16 + ' 道 · 文本 ' + fullBack.textLen + ' 字（原 ' + fullInfo.textLen + '）');
  console.log('  样例正文：' + JSON.stringify(fullBack.sample));

  // ---- 手机预览（问卷编辑页）：真 iframe + 20× 倍速；并核对「预览 = 被试端同一份页面」
  await evaluate(`(() => { const s = document.querySelector('.pv-speed'); if (!s) return 'no-speed'; s.value = '20'; s.dispatchEvent(new Event('change')); return 'ok'; })()`);
  await sleep(300);
  await waitFor(`(() => { const f = document.querySelector('.phone-frame'); if (!f) return false; const d = f.contentDocument;
    if (!d || d.readyState !== 'complete') return false;
    const pageOn = d.getElementById('page-screen') && !d.getElementById('page-screen').classList.contains('hidden');
    return !!(pageOn || d.querySelector('.qcard, .qmsg')); })()`, 60000, '问卷编辑页预览呈现内容');
  const oneToOne = JSON.parse(await evaluate(`(() => { const d = document.querySelector('.phone-frame').contentDocument;
    const w = d.defaultView;
    return JSON.stringify({
      sameTitle: d.title === '智能评估系统',
      hasTopbar: !!d.querySelector('.topbar'),
      hasComposer: !!(d.getElementById('composer') && d.getElementById('composer-input')),
      hasPageScreen: !!d.getElementById('page-screen'),
      richtext: typeof w.RichText,
      hasStartSession: typeof w.startSession === 'function',
      consentTitle: d.getElementById('page-title').textContent
    }); })()`));
  console.log('预览一比一核对：' + (oneToOne.sameTitle && oneToOne.hasTopbar && oneToOne.hasComposer && oneToOne.hasPageScreen
    && oneToOne.richtext === 'object' && oneToOne.hasStartSession
    ? '与被试端同一份页面（同一份 chat.js / chat.css / richtext.js）✔'
    : '结构不一致 ✘ ' + JSON.stringify(oneToOne)));
  await sleep(400);
  await shot('v6-20-admin-preview-consent');
  // 预览里点一下「开始实验」：确认门控页可用（数据仍不落库）
  await evaluate(`(() => { const d = document.querySelector('.phone-frame').contentDocument;
    const cb = d.getElementById('page-check'); if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    const id = d.getElementById('page-id-input'); if (id && !id.value) { id.value = 'PV-01'; id.dispatchEvent(new Event('input')); }
    const btn = d.getElementById('page-btn'); if (btn && !btn.disabled) btn.click(); return 'ok'; })()`);
  await sleep(1200);
  const pvAfter = JSON.parse(await evaluate(`(() => { const d = document.querySelector('.phone-frame').contentDocument;
    const s = d.getElementById('chat-stream');
    return JSON.stringify({ kids: s.children.length, pageVisible: !d.getElementById('page-screen').classList.contains('hidden'),
      msgs: d.querySelectorAll('.msg.ai').length }); })()`));
  console.log('预览里走第 1 步：聊天气泡 ' + pvAfter.kids + ' 个 · 消息 ' + pvAfter.msgs + ' 条 · 同意页已收起 ' + (pvAfter.pageVisible ? '✘' : '✔'));
  // 批次5 #8：进度条跳题（不用等开场逐字打字）+ 改倍速不重建会话（已作答保留）
  const pvBridge = JSON.parse(await evaluate(`(async () => {
    const w = document.querySelector('.phone-frame').contentWindow;
    const b = w.__preview;
    if (!b) return JSON.stringify({ ok: false });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const d = w.document;
    const seekQuestion = (qno) => (b.seekQuestion ? b.seekQuestion(qno) : b.seek(qno - 1));
    const snap = () => ({
      done: d.querySelectorAll('#chat-stream .qcard.done').length,
      text: [...d.querySelectorAll('#chat-stream .qcard.done')].map((c) => (c.textContent || '').replace(/\\s+/g, '')).join('|').slice(0, 120)
    });
    const total = b.total();
    const totalQ = b.totalQuestions ? b.totalQuestions() : total;
    // ① 跳到第 3 题：现在传的是**题号**（与卡面「第 N 题」一致，知情同意 / 确认页不占题号）
    await seekQuestion(3);
    for (let i = 0; i < 60 && (b.currentQno ? b.currentQno() : 0) !== 3; i += 1) await sleep(250);
    await sleep(500);                       // 让 DOM 跟上（rerender 是异步的）
    const a1 = snap();
    const answered1 = b.answered();
    const qno1 = b.currentQno ? b.currentQno() : 0;
    const pending1 = (d.querySelector('#chat-stream .qcard.pending') || {}).textContent || '';
    const pendingFlat = String(pending1).replace(/\\s+/g, '');
    const cardQno = (/第(\\d+)题/.exec(pendingFlat) || [])[1] ? Number(/第(\\d+)题/.exec(pendingFlat)[1]) : 0;
    // ② 改倍速：同一会话只改门控缩放，已作答的题卡必须原样还在（不再从头重填）
    await b.setSpeed(5);
    const speedNow = b.speed ? b.speed() : null;                  // 客户端确实拿到了倍速（倒计时/打字机都靠它）
    const tsNow = (() => { try { return w.state ? w.state.timeScale : null; } catch (e) { return null; } })();
    for (let i = 0; i < 40 && snap().done < a1.done; i += 1) await sleep(250);
    const a2 = snap();
    const answered2 = b.answered();
    await b.setSpeed(1);
    return JSON.stringify({
      ok: true, total, totalQ, done1: a1.done, done2: a2.done, answered1, answered2, qno1, cardQno, speedNow,
      kept: a1.done > 0 && a2.done === a1.done && a1.text === a2.text,
      pendingText: pending1.replace(/\\s+/g, '').slice(0, 16)
    });
  })()`));
  // 第三轮：进度条旁的「题号输入框」——输题号回车直接跳（等同拖进度条）
  const jumpBox = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inp = document.querySelector('.pv-scrub-jump');
    const b = document.querySelector('.phone-frame').contentWindow.__preview;
    if (!inp || !b) return JSON.stringify({ ok: false });
    const totalQ = b.totalQuestions ? b.totalQuestions() : b.total();
    const d2 = document.querySelector('.phone-frame').contentDocument;
    inp.value = '5';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 40 && (b.currentQno ? b.currentQno() : 0) !== 5; i += 1) await sleep(250);
    await sleep(500);                       // 让 DOM 跟上
    const pendingFlat2 = String((d2.querySelector('#chat-stream .qcard.pending') || {}).textContent || '').replace(/\\s+/g, '');
    const cardQno = (/第(\\d+)题/.exec(pendingFlat2) || [])[1] ? Number(/第(\\d+)题/.exec(pendingFlat2)[1]) : 0;
    const ok1 = { answered: b.answered(), qno: b.currentQno ? b.currentQno() : 0, cardQno, label: (document.querySelector('.pv-scrub-label') || {}).textContent, cleared: inp.value === '' };
    inp.value = '999';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(400);
    const toastEl = document.querySelector('.toast');
    return JSON.stringify({ ok: true, totalQ, ok1, invalidToast: toastEl ? (toastEl.textContent || '').trim() : '' });
  })()`));
  hardCheck(jumpBox.ok && jumpBox.ok1.qno === 5 && jumpBox.ok1.cardQno === 5 && /第 5 \/ /.test(jumpBox.ok1.label || '') && jumpBox.ok1.cleared,
    '预览：题号输入框可直接跳题（卡面题号 = 输入题号，回车生效、跳完清空）',
    jumpBox.ok ? jumpBox.ok1.label + '，卡面第 ' + jumpBox.ok1.cardQno + ' 题' : '没有找到输入框/桥');
  hardCheck(/1–\d+ 之间的题号|1-\d+ 之间的题号/.test(jumpBox.invalidToast || ''),
    '预览：题号超范围时给出提示且不跳转',
    '提示「' + (jumpBox.invalidToast || '') + '」');
  // 批次6：跳题打断「正在逐字播放的消息」 —— 上一步没播完的消息、以及它的下一题卡，
  // 都不得串进新聊天流。用户报的现象：跳到第 5 题作答后，开场材料又在第六题下方重播一遍，
  // 最后还冒出一张等着作答的「第 1 题」旧卡（旧那一步的渲染续集没被取消）。
  const raceJump = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const w = document.querySelector('.phone-frame').contentWindow;
    const b = w.__preview;
    const d = w.document;
    if (!b) return JSON.stringify({ ok: false });
    const seekQuestion = (qno) => (b.seekQuestion ? b.seekQuestion(qno) : b.seek(qno - 1));
    const snap = () => [...d.querySelectorAll('#chat-stream > *')].map((n) => n.className + '|' + (n.textContent || '').replace(/\\s+/g, '').slice(0, 12));
    await b.setSpeed(20);                        // 20×：材料仍在逐字播放，但整段几秒内跑完——旧续集要串屏也落在这几秒
    await seekQuestion(0);                       // 回到知情同意（seek 0 = 不合成任何作答，直接停在第一页）
    await sleep(600);
    const pageUp = !d.getElementById('page-screen').classList.contains('hidden');
    const cb = d.getElementById('page-check');
    if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    const idIn = d.getElementById('page-id-input');
    if (idIn && !idIn.value) { idIn.value = 'RACE-01'; idIn.dispatchEvent(new Event('input', { bubbles: true })); }
    d.getElementById('page-btn').click();        // 答知情同意 → 开场材料开始逐字播放
    let sawCursor = false;
    for (let i = 0; i < 160 && !sawCursor; i += 1) { sawCursor = !!d.querySelector('.type-cursor'); if (!sawCursor) await sleep(25); }
    await seekQuestion(5);                       // 播放中跳题：旧续集必须就此收手
    const afterSeek = snap();
    await sleep(4000);                           // 观察窗：旧续集若还活着，会在这段时间里补旧消息 / 补旧题卡
    const later = snap();
    const pendings = [...d.querySelectorAll('#chat-stream .qcard.pending, #chat-stream .qmsg.pending')].map((n) => (n.querySelector('.qnum') || {}).textContent || '');
    const staleOldCard = [...d.querySelectorAll('#chat-stream .qcard.pending, #chat-stream .qmsg.pending')]
      .some((n) => /第\\s*1\\s*题/.test((n.querySelector('.qnum') || {}).textContent || ''));
    await b.setSpeed(1);
    return JSON.stringify({ ok: true, pageUp, sawCursor, stable: JSON.stringify(afterSeek) === JSON.stringify(later),
      pendings, staleOldCard, nodes: afterSeek.length, qno: b.currentQno ? b.currentQno() : 0 });
  })()`));
  hardCheck(raceJump.ok && raceJump.sawCursor && raceJump.stable && raceJump.pendings.length === 1 && !raceJump.staleOldCard,
    '预览：播放中跳题后，旧消息 / 旧题卡不会串进新聊天流（只留目标题一张待作答卡）',
    raceJump.ok ? ('播放中跳题 → 4 秒内流内 ' + raceJump.nodes + ' 个节点保持不变 · 待作答卡 ' + JSON.stringify(raceJump.pendings))
      : '预览桥不可用');
  // 批次7：预览做完后刷新，必须**强制重进**（回到知情同意页从头再走），不能被上一份的终态页锁住 ——
  // 终态记录早先按「问卷短码」分桶，而预览没有短码（空串），于是所有预览共用一个键：
  // 做完一份预览再刷新 / 再开另一组问卷的预览，都会停在上一份的终态页，进不去也刷不掉。
  // 跳到最后一道题 → 一路答到会话结束（最后一道题之后可能还有确认页这类待作答的环节）。
  // 一步只做一件短事：CDP 的 evaluate 有 25 秒上限，长等待都在 Node 侧轮询。
  const pvSeekLast = JSON.parse(await evaluate(`(async () => {
    const w = document.querySelector('.phone-frame').contentWindow;
    const b = w.__preview;
    if (!b) return JSON.stringify({ ok: false });
    try {
      await b.setSpeed(1);                         // 20× 下作答窗口会先到点，这里用 1×
      await (b.seekQuestion ? b.seekQuestion(b.totalQuestions()) : b.seek(b.total() - 1));   // 跳到最后一道题
    } catch (e) { return JSON.stringify({ ok: false, msg: e.message }); }
    return JSON.stringify({ ok: true, total: b.totalQuestions() });
  })()`));
  // 逐帧观察：题面是否就绪（输入框可用 / 有可提交的按钮）、是否已到终态
  const pvPose = async () => JSON.parse(await evaluate(`(() => {
    const w = document.querySelector('.phone-frame').contentWindow;
    const d = w.document;
    const input = d.getElementById('composer-input');
    const card = d.querySelector('.qcard.pending, .qmsg.pending');
    const btn = card ? card.querySelector('.primary-btn') : null;
    return JSON.stringify({
      completed: !!(w.state && w.state.completed),
      pageUp: !d.getElementById('page-screen').classList.contains('hidden'),
      title: (d.getElementById('page-title') || {}).textContent || '',
      hasCard: !!card,
      cardReady: !!(btn && !btn.disabled),
      composerReady: !!(input && !input.disabled),
      kind: card ? card.className : (input && !input.disabled ? 'composer' : 'none')
    });
  })()`));
  let answeredVia = 'none';
  for (let round = 0; round < 14; round += 1) {
    let pose = null;
    for (let i = 0; i < 100; i += 1) {            // 等题面就绪（含：跳题后先播回放）
      await sleep(300);
      pose = await pvPose();
      if (pose.completed || pose.pageUp && !/知情同意/.test(pose.title)) break;
      if (pose.cardReady || pose.composerReady) break;
    }
    if (!pose || pose.completed) { if (pose) answeredVia += '+done'; break; }
    if (pose.cardReady) {                          // 题卡 / 确认页：点提交
      await evaluate(`(() => {
        const d = document.querySelector('.phone-frame').contentWindow.document;
        const card = d.querySelector('.qcard.pending, .qmsg.pending');
        if (!card) return 'none';
        const first = card.querySelector('.rating-btn, .option-btn');
        if (first && !first.classList.contains('selected')) first.click();
        const btn = card.querySelector('.primary-btn');
        if (btn && !btn.disabled) { btn.click(); return 'card'; }
        return 'card-wait';
      })()`);
      answeredVia = 'card';
      await sleep(600);
      continue;
    }
    if (pose.composerReady) {                      // 消息式题面：底部输入框作答
      await evaluate(`(() => {
        const w = document.querySelector('.phone-frame').contentWindow;
        const d = w.document;
        const input = d.getElementById('composer-input');
        input.value = '终态自检用的一句话';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const send = d.getElementById('composer-send');
        if (send && !send.disabled) send.click();
        return 'ok';
      })()`);
      answeredVia = 'composer';
      await sleep(600);
      continue;
    }
    break;                                          // 门控没放行 / 时间已到：交给下面的断言报错
  }
  let ended = false;
  for (let i = 0; i < 60 && !ended; i += 1) {
    await sleep(300);
    const st2 = await pvPose();
    ended = st2.completed || (st2.pageUp && !/知情同意/.test(st2.title));
    if (ended) break;
  }
  const pvEnd = await pvPose();
  const pvDiag = JSON.parse(await evaluate(`(() => {
    const w = document.querySelector('.phone-frame').contentWindow;
    const d = w.document;
    const last = d.getElementById('chat-stream').lastElementChild;
    return JSON.stringify({
      action: w.state && w.state.action ? (w.state.action.type + ':' + w.state.action.itemId) : null,
      busy: !!(w.state && w.state.busy),
      deadFired: !!(w.state && w.state.deadlineFired),
      err: (d.getElementById('composer-error') || {}).textContent || '',
      kids: d.getElementById('chat-stream').children.length,
      last: last ? (last.className + ' | ' + String(last.textContent).slice(0, 30)) : null
    });
  })()`));
  // 刷新预览页：必须**强制重进**（回到知情同意页），不能被上一次的终态页锁住
  await evaluate(`(() => { document.querySelector('.phone-frame').contentWindow.location.reload(); return 'ok'; })()`);
  let backTitle = '';
  for (let i = 0; i < 60; i += 1) {
    await sleep(300);
    const st3 = await pvPose();
    if (st3.pageUp) { backTitle = st3.title; break; }
  }
  const reenterPv = { ok: pvSeekLast.ok, via: answeredVia, ended, endTitle: pvEnd.title, backTitle, backIsConsent: /知情同意/.test(backTitle) };
  hardCheck(reenterPv.ok && reenterPv.ended && reenterPv.backIsConsent,
    '预览：做完后刷新强制重进（回到知情同意页，不再被终态页锁住）',
    reenterPv.ok ? ('作答路径 ' + reenterPv.via + ' · 终态「' + reenterPv.endTitle + '」→ 刷新后「' + reenterPv.backTitle + '」'
      + ' · 诊断 ' + JSON.stringify(pvDiag)) : '预览桥不可用');
  const pvOk = pvBridge.ok && pvBridge.kept && pvBridge.qno1 === 3 && pvBridge.cardQno === 3 && pvBridge.speedNow === 5;
  hardCheck(pvBridge.speedNow === 5, '预览：改倍速后客户端立刻拿到新倍速（倒计时与弹字都按它加速）', 'speed=' + pvBridge.speedNow);
  console.log('预览进度/倍速：会话共 ' + pvBridge.totalQ + ' 题（' + pvBridge.total + ' 个作答单元）· 跳到第 3 题后卡面显示第 ' + pvBridge.cardQno + ' 题（作答卡 ' + pvBridge.done1 + '）'
    + '· 当前题「' + pvBridge.pendingText + '」'
    + ' → 改 5× 倍速后已答 ' + pvBridge.answered2 + '（作答卡 ' + pvBridge.done2 + '，内容一致 ' + (pvBridge.kept ? '✔' : '✘') + '）'
    + (pvOk ? ' ✔' : ' ✘'));
  // 第三轮修正：切倍速后，**屏幕上**的倒计时必须仍是「设定秒数」量级 ——
  // 曾经的 bug：服务端把剩余按新倍速重算成 9 秒，客户端却还在用旧基准 176 秒 × 20 显示 58:48。
  const pvSpeedItems = [
    { id: 'sp_wait', type: 'text', title: '强制阅读 180 秒', required: true, limits: { wait: 180, maxAnswer: 300 } },
    { id: 'sp_end', type: 'debrief', title: '结束', text: '完' }
  ];
  const pvSpeedPv = (await adminFetch(token, '/api/admin/preview', { body: { items: pvSpeedItems, speed: 1 } })).previewId;
  await evaluate(`(() => { document.querySelector('.phone-frame').src = '/chat?preview=${pvSpeedPv}&speed=1'; return 'ok'; })()`);
  await waitFor(`(() => { const f = document.querySelector('.phone-frame'); const d = f.contentDocument; return !!(d && d.querySelector('.qcard-timer')); })()`, 40000, '倍速校验预览的倒计时');
  await sleep(800);
  const speedScreen = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const w = document.querySelector('.phone-frame').contentWindow;
    const d = w.document;
    const toSec = (txt) => {
      const mm = /(\\d+):(\\d+)/.exec(txt || '');
      if (mm) return Number(mm[1]) * 60 + Number(mm[2]);
      const ss = /(\\d+)\\s*秒/.exec(txt || '');
      return ss ? Number(ss[1]) : -1;
    };
    const snap = () => ({
      screen: toSec((d.querySelector('.qcard-timer') || {}).textContent || ''),
      text: (d.querySelector('.qcard-timer') || {}).textContent || '',
      leftWait: w.eval("(function(){ var a = state && state.action; return a && a.availableAtMs ? Math.round((a.availableAtMs - serverNow())/1000) : null; })()"),
      ts: w.eval('(state && state.timeScale) || null'),
      speed: w.eval('(typeof previewSpeed === \"number\") ? previewSpeed : null')
    });
    const setSpeed = async (v) => {
      const sel = document.querySelector('.pv-speed');
      sel.value = String(v);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(900);
    };
    // 切倍速前给聊天流的第一个节点打标记：切速后它必须还在（否则就是被重画了）
    const markFirst = () => { const f = d.getElementById('chat-stream').firstElementChild; if (f) f.dataset.probeMark = 'keep-me'; return !!f; };
    const markAlive = () => !!((d.getElementById('chat-stream').firstElementChild || {}).dataset || {}).probeMark;
    markFirst();
    const at1 = snap();
    await setSpeed(20);
    const markAfter1 = markAlive();
    const at20 = snap();
    await setSpeed(5);
    const markAfter2 = markAlive();
    const at5 = snap();
    // 正在输出的消息：开跑 800ms 后把倍速从 1x 提到 20x，整段应明显变快
    w.eval('previewSpeed = 1');
    const text = '<p>' + '这是一段用来验证中途切倍速的示例文本。'.repeat(10) + '</p>';
    const t0 = performance.now();
    const running = w.appendAiMessageAnimated(text, { typeMs: 30, thinkMs: 0 }, '');
    setTimeout(() => { try { w.eval('previewSpeed = 20'); } catch (e) { /* 忽略 */ } }, 800);
    await running;
    const typingMid = Math.round(performance.now() - t0);
    return JSON.stringify({ at1, at20, at5, typingMid, markAfter1, markAfter2 });
  })()`));
  // 屏幕上的秒数 = 真实剩余 × 当前倍速（切速当时不会跳变，之后按新倍速往下走）；
  // 关键是**不能出现「设定值 × 倍速」**（设 180 秒 → 绝不会显示 3528 秒）
  const expect20 = Math.round(speedScreen.at20.leftWait * speedScreen.at20.ts);
  const expect5 = Math.round(speedScreen.at5.leftWait * speedScreen.at5.ts);
  hardCheck(
    speedScreen.at1.screen > 150 && speedScreen.at20.screen > 0 && speedScreen.at20.screen <= 185
      && Math.abs(speedScreen.at20.screen - expect20) <= 6 && Math.abs(speedScreen.at5.screen - expect5) <= 6,
    '切倍速后屏幕倒计时 = 真实剩余 × 倍速（不会出现 设定值 × 倍速）',
    `1× 显示 ${speedScreen.at1.text}（真实剩余 ${speedScreen.at1.leftWait}s）· 20× 显示 ${speedScreen.at20.text}（真实剩余 ${speedScreen.at20.leftWait}s × 20 ≈ ${expect20}s）· 5× 显示 ${speedScreen.at5.text}（× 5 ≈ ${expect5}s）`);
  hardCheck(speedScreen.at20.leftWait != null && speedScreen.at20.leftWait <= 25 && speedScreen.at20.ts === 20,
    '切倍速后真实剩余按新倍速缩短（180 秒 → 约 9 秒）',
    `20× 下真实剩余 ${speedScreen.at20.leftWait}s · timeScale=${speedScreen.at20.ts} · previewSpeed=${speedScreen.at20.speed}`);
  hardCheck(speedScreen.typingMid < 3000,
    '正在输出的消息：中途切倍速立刻变快（1× 全程约需 5 秒以上）',
    `1× 跑 800ms 后提到 20×，整段耗时 ${speedScreen.typingMid}ms`);
  hardCheck(speedScreen.markAfter1 && speedScreen.markAfter2,
    '切倍速不会重画聊天流（已输出的内容继续保留，不会清掉重来）',
    `切 20× 后标记${speedScreen.markAfter1 ? '仍在 ✔' : '丢了 ✘'} · 切 5× 后${speedScreen.markAfter2 ? '仍在 ✔' : '丢了 ✘'}`);
  // 知情同意 → 开场材料 / 任务要求 / 阅读确认（需输入指定内容）→ 首个打分题：
  // 材料自动播放（1× 逐字输出，两份材料加起来约 20 秒），阅读确认题要把标准答案原样打进底部输入框再发送，
  // 打分题出现才算到位。预算给足 3 分钟（中间只等待，不做断言）。
  const advanceToFirstRating = async () => {
    for (let i = 0; i < 360; i += 1) {
      const t = await evaluate(`(() => { const a = state.action; return a ? a.type : null; })()`);
      if (t === 'rating') return;
      if (t === 'text') {
        await evaluate(`(() => {
          const a = state.action;
          const inp = document.getElementById('composer-input');
          if (!inp || inp.disabled) return 'skip';
          inp.value = (${JSON.stringify(MATCH_ANSWERS)})[a.itemId] || '轻负担，一口青柠爽';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          const send = document.getElementById('composer-send');
          if (send && !send.disabled) send.click();
          return 'ok';
        })()`);
        await sleep(700);
      } else {
        await sleep(500);
      }
    }
    await waitFor(`(() => { const a=state.action; return !!(a && a.type==='rating' && state.questionNodes.get(a.itemId)); })()`, 120000, '首个打分题');
  };

  await evaluate(`localStorage.clear()`);
  await goto(`${BASE}/chat?q=${questionnaire.id}&fresh=1`, 1200);
  await waitFor(`!document.getElementById('page-screen').classList.contains('hidden')`, 30000, '知情同意页');
  await shot('v6-10-chat-consent');
  // 知情同意页（含编号形态）：先填编号 → 再勾选 → 按钮才可用
  await evaluate(`(() => { const id=document.getElementById('page-id-input'); if (id && !id.value) { id.value='PV-01'; id.dispatchEvent(new Event('input', { bubbles: true })); } return 'ok'; })()`);
  await sleep(250);
  await evaluate(`(() => { const cb=document.getElementById('page-check'); if (cb && !cb.checked) { cb.checked=true; cb.dispatchEvent(new Event('change')); } return 'ok'; })()`);
  await sleep(300);
  await evaluate(`document.getElementById('page-btn').click()`);
  await advanceToFirstRating();
  await shot('v6-11-chat-rating');

  // 批次5 #7：禁止选中 / 复制 / 右键（输入框内放行）
  const antiCopy = JSON.parse(await evaluate(`(() => {
    const body = getComputedStyle(document.body);
    const sel = body.userSelect || body.webkitUserSelect;
    const stream = document.getElementById('chat-stream');
    const inp = document.getElementById('composer-input') || document.getElementById('page-id-input');
    const fire = (type, target) => { const e = new Event(type, { bubbles: true, cancelable: true }); (target || stream).dispatchEvent(e); return e.defaultPrevented; };
    return JSON.stringify({
      sel,
      copy: fire('copy'), cut: fire('cut'), menu: fire('contextmenu'),
      inpSel: inp ? (getComputedStyle(inp).userSelect || getComputedStyle(inp).webkitUserSelect) : null,
      inpCopy: inp ? fire('copy', inp) : null
    });
  })()`));
  hardCheck(antiCopy.sel === 'none', '被试端正文不可选中（user-select: none）', 'user-select=' + antiCopy.sel);
  hardCheck(antiCopy.copy && antiCopy.cut && antiCopy.menu, '复制 / 剪切 / 右键菜单已拦截', JSON.stringify({ copy: antiCopy.copy, cut: antiCopy.cut, menu: antiCopy.menu }));
  hardCheck(antiCopy.inpSel === 'text' && antiCopy.inpCopy === false, '输入框内可正常选中与复制', 'input user-select=' + antiCopy.inpSel);
  // 被试端正文与编辑器「正文（默认 16px）」严格一致（2026-10-09 起统一为小四 16px）
  const fontFit = JSON.parse(await evaluate(`(() => {
    const ai = document.querySelector('#chat-stream .msg.ai .ai-text');
    const page = document.getElementById('page-text');
    return JSON.stringify({ ai: ai ? getComputedStyle(ai).fontSize : null, page: page ? getComputedStyle(page).fontSize : null });
  })()`));
  hardCheck(fontFit.ai === '16px' && (fontFit.page == null || fontFit.page === '16px'),
    '被试端正文 16px（小四，与编辑器「正文（默认 16px）」一致）',
    'AI 正文 ' + fontFit.ai + ' · 页面正文 ' + fontFit.page);

  // 内联作答：直接点卡片内的控件（打分局/单选点选即提交；题组/文本点提交）
  const answerCurrent = async () => {
    const info = await evaluate(`(() => {
      const a = state.action;
      if (!a) return null;
      const node = state.questionNodes.get(a.itemId);
      if (!node) return null;
      const ctl = node.card.querySelector('.primary-btn') || document.getElementById('composer-send');
      return { type: a.type, id: a.itemId, gated: ctl ? !!ctl.disabled : false };
    })()`);
    if (!info) return null;
    await evaluate(`(() => {
      const a = state.action;
      const node = state.questionNodes.get(a.itemId);
      if (!node) return 'skip';
      const card = node.card;
      // 1) 先选/填（控件在门控期间也可操作）
      if (a.type === 'rating' || a.type === 'single') {
        const b = card.querySelector('.rating-btn') || card.querySelector('.option-btn');
        if (b) b.click();
      } else if (a.type === 'multi') {
        card.querySelectorAll('.option-btn').forEach((b2, i) => { if (i === 0) b2.click(); });
      } else if (a.type === 'text') {
        // 消息式题面：题干像一条 AI 消息，作答在底部常驻输入框（本轮改动）
        // 「需输入指定内容」的题必须输入标准答案：服务端会先断言，不符时这一笔不发送、走查会卡住
        const need = (${JSON.stringify(MATCH_ANSWERS)})[a.itemId];
        const inp0 = document.getElementById('composer-input');
        if (inp0 && !inp0.disabled) {
          const want = need || '轻负担，一口青柠爽';
          if (inp0.value !== want) {
            inp0.value = want;
            inp0.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      } else if (a.type === 'group') {
        const inputs = card.querySelectorAll('.answer-input');
        if (inputs.length) {
          inputs.forEach((inp, i) => {
            if (!inp.value) { inp.value = i === 0 ? '轻负担，一口青柠爽' : '突出 0 糖'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
          });
        } else {
          // 两段文本的题组（广告语 + 创作说明）改在底部输入框作答：第一行 / 其余行
          const inp = document.getElementById('composer-input');
          if (inp && !inp.disabled && !inp.value) {
            inp.value = '轻负担，一口青柠爽\\n突出 0 糖';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      }
      // 2) 再发送 / 提交（未到放行时间时会被服务端 too_early 兜底，由外层循环等待）
      const sendBtn = card.querySelector('.primary-btn') || document.getElementById('composer-send');
      if (sendBtn && !sendBtn.disabled) sendBtn.click();
      // 记下「本轮提交前的最后一条内容」，用于校验新内容是否落在视口顶部（issue 5）
      const s = document.getElementById('chat-stream');
      s.querySelectorAll('[data-step-base]').forEach((n) => n.removeAttribute('data-step-base'));
      if (s.lastElementChild) s.lastElementChild.setAttribute('data-step-base', '1');
      return 'ok';
    })()`);
    await sleep(420);
    return info;
  };

  // 当前待作答卡片是否处于门控 / 计时状态
  const seen = [];
  // 按服务端门控时刻精确等待：availableAtMs（强制阅读）/ minSubmitAtMs（最短提交）/ deadlineMs
  const gateInfo = () => evaluate(`(() => {
    const a = state.action;
    return {
      type: a ? a.type : null, itemId: a ? a.itemId : null,
      title: (a && a.title) || '',
      availableAtMs: a ? (a.availableAtMs || 0) : 0,
      minSubmitAtMs: a ? (a.minSubmitAtMs || 0) : 0,
      deadlineMs: a ? (a.deadlineMs || 0) : 0,
      serverNow: (typeof serverNow === 'function' ? serverNow() : Date.now()),
      locked: !!(a && state.questionNodes.get(a.itemId) && state.questionNodes.get(a.itemId).card.classList.contains('locked')),
      hint: (a && state.questionNodes.get(a.itemId) && state.questionNodes.get(a.itemId).hint) ? state.questionNodes.get(a.itemId).hint.textContent : '',
      waiting: !!document.querySelector('.thinking-label'),
      // 题目右上角倒计时徽标（门控 → 作答倒计时）
      timer: (a && state.questionNodes.get(a.itemId) && state.questionNodes.get(a.itemId).timer)
        ? state.questionNodes.get(a.itemId).timer.textContent : '',
      cardDone: (() => {
        const n = a && state.questionNodes.get(a.itemId);
        return !!(n && n.card.classList.contains('done'));
      })(),
      completed: state.completed,
      cardTop: (a && state.questionNodes.get(a.itemId))
        ? Math.round(state.questionNodes.get(a.itemId).card.getBoundingClientRect().top
          - document.getElementById('chat-scroll').getBoundingClientRect().top)
        : null,
      // 落点（issue 5）：新题出现后，待答的题卡应当完整落在视口里
      stepTop: (() => {
        const sc = document.getElementById('chat-scroll');
        const card = document.querySelector('#chat-stream .qcard.pending');
        if (!sc || !card) return null;
        const scRect = sc.getBoundingClientRect();
        const cRect = card.getBoundingClientRect();
        const stream = document.getElementById('chat-stream');
        return {
          got: Math.round(sc.scrollTop),
          desired: Math.round(Math.max(0, cRect.top - scRect.top + sc.scrollTop - 12)),
          max: Math.round(sc.scrollHeight - sc.clientHeight),
          cardTop: Math.round(cRect.top - scRect.top),
          cardBottom: Math.round(cRect.bottom - scRect.top),
          viewport: Math.round(sc.clientHeight),
          dom: stream.children.length + 'n/' + stream.querySelectorAll('.qcard').length + 'c/' + stream.querySelectorAll('.qcard.done').length + 'd'
        };
      })(),
      pageVisible: !document.getElementById('page-screen').classList.contains('hidden'),
      pageTitle: document.getElementById('page-title').textContent,
      pageBtnHidden: document.getElementById('page-btn').classList.contains('hidden'),
      // 阅读确认页已改为内联块：内容留在聊天流里，下方一个确认按钮
      confirmInline: (() => {
        const n = a && state.questionNodes.get(a.itemId);
        return !!(n && n.card && n.card.classList.contains('confirm-inline'));
      })(),
      confirmBtnDisabled: (() => {
        const n = a && state.questionNodes.get(a.itemId);
        return !!(n && n.submitBtn && n.submitBtn.disabled);
      })(),
      // 批次5：清屏（呈现前清空）后，之前答过的题卡会整块消失 → 用「已完成题卡数」验证
      doneCount: document.querySelectorAll('#chat-stream .qcard.done').length,
      streamKids: document.getElementById('chat-stream').children.length
    };
  })()`);

  let guard = 0;
  const firstSight = {};      // 批次5：每题首次出现的采样（清屏断言用）
  const landings = {};        // 每道新题首次出现时，「本轮新增内容」距视口顶部的像素（issue 5）
  const chatTimers = [];      // 被试端右上角倒计时的取值样本
  while (guard++ < 1500) {
    const info = await gateInfo();
    if (info.timer && !chatTimers.includes(info.timer)) chatTimers.push(info.timer);
    if (info.itemId && !firstSight[info.itemId]) {
      firstSight[info.itemId] = { type: info.type, title: (info.title || ''), done: info.doneCount, kids: info.streamKids };
    }
    // 只在「题目待作答且不处于等 AI 回复」时判定落点
    if (info.itemId && info.stepTop && !info.waiting && !info.cardDone) {
      // 取「进入下一题之前的最后一次采样」：平滑滚动可能仍在进行，首帧会偏
      const st = info.stepTop;
      // 题卡放得下 → 整张卡要完整可见；题卡比视口还高 → 至少顶部可见
      const fits = st.cardBottom - st.cardTop <= st.viewport;
      const ok = fits ? (st.cardTop >= -24 && st.cardBottom <= st.viewport + 24) : st.cardTop >= -24;
      const prev = landings[info.itemId];
      const samples = (prev ? prev.samples : 0) + 1;
      // 只取题目出现后的前 3 次采样（此后的变化是「等待 AI 回复跟随底部」等设计行为，不属落点判定）
      if (!prev || prev.samples < 3) {
        landings[info.itemId] = { type: info.type, ok, got: st.got, desired: st.desired, max: st.max, samples, trace: (prev ? prev.trace : []), dom: st.dom };
      } else {
        prev.samples = samples;
      }
      const lg = landings[info.itemId];
      if (lg.trace.length < 10) lg.trace.push('卡' + st.cardTop + '~' + st.cardBottom + ' 视口' + st.viewport + (info.waiting ? 'W' : '') + '[' + st.dom + ']');
    }
    // 1) 等待作答前强制阅读
    if (info.availableAtMs && info.availableAtMs > info.serverNow) {
      if (!seen.includes('WAIT-READING')) { seen.push('WAIT-READING'); await shot('v6-13-chat-reading-gate'); }
      await sleep(Math.min(1500, info.availableAtMs - info.serverNow + 120));
      continue;
    }
    // 3) 等待最短提交时间（创作窗口）：同时抓一张创作窗口截图
    if (info.minSubmitAtMs && info.minSubmitAtMs > info.serverNow) {
      if (!seen.includes('SHOT-CREATION') && (info.type === 'text' || info.type === 'group')) { seen.push('SHOT-CREATION'); await shot('v6-14-chat-text-window'); }
      await sleep(Math.min(1500, info.minSubmitAtMs - info.serverNow + 120));
      continue;
    }
    // 3.5) 阅读确认页（内联）：内容留在流里，点下方确认按钮继续
    if (info.type === 'confirm') {
      if (!seen.includes('SHOT-CONFIRM')) {
        seen.push('SHOT-CONFIRM');
        await sleep(400);
        await shot('v6-24-chat-confirm-inline');
        // 批次5 #9（核心）：确认页是聊天流里的内联块 —— 不进全屏遮罩，上面的内容仍然看得见
        const conf = JSON.parse(await evaluate(`(() => {
          const n = state.questionNodes.get(state.action.itemId);
          const stream = document.getElementById('chat-stream');
          return JSON.stringify({
            inline: !!(n && n.card && n.card.classList.contains('confirm-inline')),
            pageVisible: !document.getElementById('page-screen').classList.contains('hidden'),
            kids: stream.children.length,
            others: [...stream.children].filter((el) => el !== (n && n.card)).length,
            btn: !!(n && n.submitBtn)
          });
        })()`));
        hardCheck(conf.inline && conf.btn, '阅读确认页 = 聊天流内的内联块（下方带确认按钮）');
        hardCheck(!conf.pageVisible, '确认页不再占用全屏遮罩');
        hardCheck(conf.others >= 2, '确认页出现时上方内容仍可见', '同屏其它节点 ' + conf.others + ' 个');
      }
      const clicked = await evaluate(`(() => {
        const n = state.questionNodes.get(state.action.itemId);
        if (!n || !n.submitBtn) return 'skip';
        if (n.submitBtn.disabled) return 'wait';
        n.submitBtn.click();
        return 'clicked';
      })()`);
      await sleep(clicked === 'clicked' ? 700 : 400);
      continue;
    }
    // 4) 全屏页面题：知情同意 / 结束说明 → 截图后点按钮继续
    if (info.type === 'gate' || info.type === 'debrief') {
      const key = `${info.type}:${info.itemId}`;
      if (!seen.includes(key)) seen.push(key);
      if (info.type === 'debrief' && !seen.includes('SHOT-DEBRIEF')) {
        // 注意：当前配置下结束说明会直接转成「终态页」（applyPayload 自动 ack → showFinalPage），
        // 所以这一支通常不触发；「致谢页置顶」由终态页检查与手机端那支专项检查覆盖。
        seen.push('SHOT-DEBRIEF');
        await sleep(600);
        await shot('v6-15-chat-debrief');
      }
      if (info.type === 'gate') {
        await evaluate(`(() => { const id=document.getElementById('page-id-input'); if (id && !id.value) { id.value='PV-01'; id.dispatchEvent(new Event('input', { bubbles: true })); } return 'ok'; })()`);
        await sleep(250);
        await evaluate(`(() => { const cb=document.getElementById('page-check'); if (cb && !cb.checked) { cb.checked=true; cb.dispatchEvent(new Event('change')); } return 'ok'; })()`);
        await sleep(250);
        // 本轮：把知情同意页滚到下半屏（手机上填编号必然要滚）——这样后面「致谢页从最上方开始」才有验证意义
        await evaluate(`(() => { const p=document.getElementById('page-screen'); p.scrollTop = p.scrollHeight; return 'ok'; })()`);
        await sleep(120);
      }
      await evaluate(`document.getElementById('page-btn').click()`);
      await sleep(700);
      continue;
    }
    // 5) 结束（已无待作答单元）
    if (info.completed || !info.type) break;
    // 6) 作答当前单元
    const key = `${info.type}:${info.itemId}`;
    if (!seen.includes(key)) seen.push(key);
    await answerCurrent();
    await sleep(900);        // 等平滑滚动落定，再采样落点
    // 已提交的卡片就地保留（只读 + ✓ 已提交）——抓一张回看
    if (info.type === 'rating' && !seen.includes('SHOT-ANSWERED')) {
      seen.push('SHOT-ANSWERED');
      await evaluate(`(() => {
        const done = document.querySelectorAll('#chat-scroll .qcard.done');
        const last = done[done.length - 1];
        if (last) { const sc = document.getElementById('chat-scroll'); sc.scrollTop = Math.max(0, last.offsetTop - 80); }
        return 'ok';
      })()`);
      await sleep(500);
      await shot('v6-19-chat-answered');
    }
  }  await sleep(800);
  if (!seen.includes('SHOT-DEBRIEF')) await shot('v6-15-chat-debrief');
  // 结束页：终态只留一个「重做」按钮（填完即释放设备；想再来一遍不必刷新或关标签页）
  const finalInfo = JSON.parse(await evaluate(`(() => {
    const b = document.getElementById('page-btn');
    const others = [...document.querySelectorAll('#page-screen button')].map((x) => x.textContent.trim());
    return JSON.stringify({
      visible: !document.getElementById('page-screen').classList.contains('hidden'),
      buttonHidden: b.classList.contains('hidden'),
      buttonText: b.textContent.trim(),
      buttons: others,
      hint: document.getElementById('page-hint').textContent,
      body: document.getElementById('page-text').textContent,
      title: document.getElementById('page-title').textContent,
      scrollTop: Math.round(document.getElementById('page-screen').scrollTop)
    });
  })()`));
  // 收尾小字（「可以关闭本页面」）现在是结束说明正文的一部分，由作者在管理端编辑
  const finalOk = finalInfo.visible && !finalInfo.buttonHidden && /重做/.test(finalInfo.buttonText) && finalInfo.buttons.length === 1;
  // 收尾小字由作者在管理端编辑（当前文案见 seed-content.js 的 DEBRIEF_CLOSING），这里只要求正文非空
  hardCheck(finalOk && finalInfo.body.trim().length > 0,
    '结束页终态只留一个「重做」按钮（想再来一遍不必刷新或关标签页）',
    `按钮=${JSON.stringify(finalInfo.buttons)} · 标题「${finalInfo.title}」`);
  hardCheck(finalInfo.scrollTop === 0, '终止页也从最上方开始显示',
    `scrollTop=${finalInfo.scrollTop}`);
  if (finalInfo.visible) await shot('v6-22-chat-final');
  const done = await evaluate('JSON.stringify({ answered: state.answeredCount, total: state.totalAnswers, completed: state.completed })');
  // issue 5：每道新题出现时，滚动位置是否落在「本轮新增内容的开头」（内容不足一屏则贴底也算合格）
  const rows = Object.values(landings);
  const bad = rows.filter((r) => !r.ok);
  console.log('新内容落点（待答题卡 / 视口）：共 ' + rows.length + ' 题，'
    + (bad.length
      ? bad.length + ' 处题卡未完整可见 ✘ ' + bad.map((r) => r.type + ' 卡' + ((r.trace && r.trace[0]) || '-')).join('；')
      : '待答题卡均完整可见 ✔'));
  // 批次5 #9：呈现前清空 —— 到达清屏点后，之前答过的题卡不应再留在屏幕上
  const demoRefresh = Object.entries(firstSight).find(([, v]) => /广告语和创作说明/.test(v.title));
  if (demoRefresh) {
    const [rid, rv] = demoRefresh;
    const beforeClear = Object.entries(firstSight).filter(([id]) => id !== rid);
    const maxDone = beforeClear.length ? Math.max(...beforeClear.map(([, v]) => v.done || 0)) : 0;
    hardCheck(rv.done === 0 && maxDone > 0,
      '呈现前清空：到达清屏点后，之前答过的题卡全部消失',
      '该题首见时已完成题卡 ' + rv.done + ' 个（清屏前最多 ' + maxDone + ' 个）');
    console.log('  清屏点题目：' + rv.title + ' · 首见时屏内节点 ' + rv.kids + ' 个');
  } else {
    console.log('  （演示问卷里没有找到带「呈现前清空」的题目，跳过清屏断言）');
  }

  console.log('被试端完成情况：' + done + '（等待类型：' + seen.filter((x) => x.startsWith('WAIT')).join(', ') + '）');
  // 倒计时文案本轮压缩为「N 秒后可提交 / 剩余 m:ss」；能否采样到「剩余」取决于走查作答节奏，仅作信息输出
  const answeringTimer = chatTimers.find((t) => /剩余/.test(t));
  console.log('  被试端右上角倒计时：共 ' + chatTimers.length + ' 种取值' + (chatTimers.length ? '（' + chatTimers.slice(0, 3).map((t) => `「${t}」`).join(' ') + '…）' : '')
    + '；作答倒计时（剩余）' + (answeringTimer ? `出现过「${answeringTimer}」✔` : '本轮未被采样到（取决于走查作答节奏，非门禁）'));

  // ---- AI 消息呈现（本轮）：① 连发两条记录不刷空白；② 思考面板按目标时长铺满（不干等）
  console.log(`\nAI 消息呈现：连发两条消息（第二条超过一屏）+ 思考面板 ${FEEDBACK_Q_THINK_MS / 1000} 秒铺满`);
  const fbQ = await ensureFeedbackFixture(token);
  try {
    await evaluate(`localStorage.clear()`);
    await goto(`${BASE}/chat?q=${fbQ.id}&fresh=1`, 1200);
    await waitFor(`!document.getElementById('page-screen').classList.contains('hidden')`, 30000, '反馈夹具知情同意页');
    await evaluate(`(() => { const cb=document.getElementById('page-check'); cb.checked=true; cb.dispatchEvent(new Event('change')); return 'ok'; })()`);
    // 从点「开始实验」那一刻开始采样（每 60ms）：正文的光标位置 + 思考面板里文字的长度
    await evaluate(`(() => {
      const sc = document.getElementById('chat-scroll');
      const p = { panelSeen: false, t0: 0, panelEnd: 0, lastGrowAt: 0, len: 0, samples: 0, phantomMax: 0, frontAbove: 0 };
      window.__fbProbe = p;
      const timer = setInterval(() => {
        const inner = document.querySelector('.think-inner');
        if (inner) {
          if (!p.panelSeen) { p.panelSeen = true; p.t0 = performance.now(); }
          const t = Math.round(performance.now() - p.t0);
          const len = (inner.textContent || '').length;
          if (len !== p.len) { p.len = len; p.lastGrowAt = t; }
          if (!p.panelEnd && document.querySelector('.think-done')) p.panelEnd = t;
        }
        const texts = [...document.querySelectorAll('.ai-text')];
        const el = texts[texts.length - 1];
        const cur = el && el.querySelector('.type-cursor');
        if (el && cur) {
          p.samples += 1;
          const phantom = Math.round(el.getBoundingClientRect().bottom - cur.getBoundingClientRect().bottom);
          if (phantom > p.phantomMax) p.phantomMax = phantom;
          if (cur.getBoundingClientRect().bottom < sc.getBoundingClientRect().top + 8) p.frontAbove += 1;
        }
      }, 60);
      window.__fbProbeStop = () => clearInterval(timer);
      return 'ok';
    })()`);
    await evaluate(`document.getElementById('page-btn').click()`);
    await waitFor(`state.action && state.action.itemId === 'fb_t' && !!state.questionNodes.get('fb_t')`, 90000, '反馈夹具走到收尾文本题');
    await sleep(800);
    const fbProbe = JSON.parse(await evaluate(`(() => {
      window.__fbProbeStop();
      const p = window.__fbProbe;
      const inner = document.querySelector('.think-inner');
      return JSON.stringify({
        panelSeen: p.panelSeen, panelEnd: Math.round(p.panelEnd), lastGrowAt: Math.round(p.lastGrowAt),
        thinkingLen: (inner ? inner.textContent : '').length, panelDone: !!document.querySelector('.think-done'),
        samples: p.samples, phantomMax: p.phantomMax, frontAbove: p.frontAbove,
        messages: document.querySelectorAll('#chat-stream .msg.ai').length,
        tall: Math.round((document.querySelectorAll('.ai-text')[1] || document.body).getBoundingClientRect().height),
        viewport: Math.round(document.getElementById('chat-scroll').clientHeight)
      });
    })()`));
    const growRatio = fbProbe.panelEnd ? fbProbe.lastGrowAt / fbProbe.panelEnd : 0;
    hardCheck(fbProbe.panelSeen && fbProbe.panelDone,
      '思考面板按目标时长走完（出现「思考已完成」）',
      `面板 ${fbProbe.panelEnd}ms · 思考稿 ${fbProbe.thinkingLen} 字 · AI 消息 ${fbProbe.messages} 条`);
    hardCheck(growRatio >= 0.8,
      '思考面板：文字一直写到时长末尾（按字数调速铺满，不是先铺一段再干等）',
      `最后一次增长在面板结束的 ${(growRatio * 100).toFixed(0)}%（旧实现约 78% 就停笔、剩下干等）`);
    hardCheck(fbProbe.samples > 20 && fbProbe.phantomMax <= 60,
      '长消息流式输出：还没输出的部分不占高度（光标下方没有成片空白）',
      `光标下方最大空白 ${fbProbe.phantomMax}px · 采样 ${fbProbe.samples} 次 · 第二条消息高 ${fbProbe.tall}px / 视口 ${fbProbe.viewport}px`);
    hardCheck(fbProbe.frontAbove <= Math.max(2, Math.round(fbProbe.samples * 0.05)),
      '长消息流式输出：视口跟着正在输出的文字走（没有停在空白底部）',
      `输出位置落到视口上方的采样 ${fbProbe.frontAbove}/${fbProbe.samples} 次`);
    await shot('v6-29-chat-thinking-panel');
    // 本轮：发送后输入框**立刻**清空（内容已作为用户气泡进流；留在框里会被当成「没发出去」）
    await evaluate(`(() => { const i=document.getElementById('composer-input'); i.value='轻负担，一口青柠爽'; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await sleep(200);
    await evaluate(`document.getElementById('composer-send').click()`);
    await sleep(250);
    const afterSend = JSON.parse(await evaluate(`(() => {
      const i = document.getElementById('composer-input');
      return JSON.stringify({
        value: i.value, disabled: i.disabled, placeholder: i.placeholder,
        bubbles: document.querySelectorAll('#chat-stream .msg.user.answered').length
      });
    })()`));
    hardCheck(afterSend.value === '' && afterSend.disabled && afterSend.bubbles === 1 && /已提交|已完成/.test(afterSend.placeholder),
      '发送后输入框立刻清空（内容已进聊天流，不再留在框里）',
      `框内「${afterSend.value}」· 停用 ${afterSend.disabled ? '✔' : '✘'} · 用户气泡 ${afterSend.bubbles} 个 · 提示「${afterSend.placeholder}」`);
    // 关键的那一段：交完卷、AI 的长篇回应还在逐字输出（创作 → 反馈就是这样），
    // 这期间输入框必须一直是空的 —— 以前会把刚交上去的内容留到「下一题出现」为止。
    await sleep(2200);
    const duringReply = JSON.parse(await evaluate(`(() => {
      const i = document.getElementById('composer-input');
      return JSON.stringify({
        value: i.value, disabled: i.disabled, typing: !!document.querySelector('.type-cursor'),
        action: (state.action && state.action.itemId) || '', bubble: document.querySelector('#chat-stream .msg.user.answered') ? 1 : 0
      });
    })()`));
    hardCheck(duringReply.value === '' && duringReply.disabled && duringReply.typing && duringReply.action === 'fb_t',
      'AI 回应还在输出期间，输入框保持为空（创作交卷后看反馈的那一段）',
      `框内「${duringReply.value}」· 停用 ${duringReply.disabled ? '✔' : '✘'} · 仍在逐字输出 ${duringReply.typing ? '✔' : '✘'} · 当前题 ${duringReply.action}`);
  } finally {
    await adminFetch(token, '/api/admin/questionnaire/delete', { body: { id: fbQ.id, force: true } });
    console.log('已清理 AI 反馈呈现自检问卷');
  }

  // ---- 手机端
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await evaluate(`localStorage.clear()`);
  await goto(`${BASE}/chat?q=${questionnaire.id}&fresh=1`, 1200);
  await waitFor(`!document.getElementById('page-screen').classList.contains('hidden')`, 30000, '手机端知情同意页');
  await evaluate(`(() => { const id=document.getElementById('page-id-input'); if (id && !id.value) { id.value='PV-01'; id.dispatchEvent(new Event('input', { bubbles: true })); } const cb=document.getElementById('page-check'); if (cb && !cb.checked) { cb.checked=true; cb.dispatchEvent(new Event('change')); } return 'ok'; })()`);
  await sleep(300);
  await evaluate(`document.getElementById('page-btn').click()`);
  await advanceToFirstRating();
  await waitFor(`(() => { const a=state.action; return !!(a && a.type==='rating' && state.questionNodes.get(a.itemId)); })()`, 120000, '手机端打分题');
  await shot('v6-16-mobile-rating');

  // 切屏提醒：居中弹窗必须完整落在屏幕内（贴底浮层在手机上会被浏览器底栏 / 键盘盖住）
  const notice = JSON.parse(await evaluate(`(() => {
    showLeaveNotice(3200);
    const mask = document.getElementById('leave-mask');
    const card = mask.querySelector('.confirm-card');
    const r = card.getBoundingClientRect();
    const inside = !mask.classList.contains('hidden')
      && r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5;
    const info = { inside, w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight,
      backdrop: getComputedStyle(mask).backgroundColor !== 'rgba(0, 0, 0, 0)' };
    return JSON.stringify(info);
  })()`));
  await sleep(300);
  await shot('v6-23-chat-leave-notice');
  await evaluate(`document.getElementById('leave-ok').click()`);
  console.log('切屏提醒（手机 ' + notice.vw + '×' + notice.vh + '）：' + (notice.inside
    ? `居中弹窗完整可见 ✔（${notice.w}×${notice.h}，带遮罩 ${notice.backdrop ? '✔' : '✘'}）`
    : `超出屏幕 ✘ ${JSON.stringify(notice)}`));

  // 本轮：致谢页置顶（手机视口下才看得出问题 —— 桌面视口往往窄到不滚，偏移被夹成 0 也可能「看着正常」）
  const topQ = await ensureTopFixture(token);
  try {
    console.log('\n致谢页置顶（手机 375×812）：先在知情同意页滚到底，再看致谢页的滚动位置');
    await evaluate(`localStorage.clear()`);
    await goto(`${BASE}/chat?q=${topQ.id}&fresh=1`, 1200);
    await waitFor(`!document.getElementById('page-screen').classList.contains('hidden')`, 30000, '置顶自检知情同意页');
    const gateAt = JSON.parse(await evaluate(`(() => {
      const cb=document.getElementById('page-check'); cb.checked=true; cb.dispatchEvent(new Event('change'));
      const p = document.getElementById('page-screen');
      p.scrollTop = p.scrollHeight;            // 知情同意页滚到底（手机上填编号必然要滚）
      return JSON.stringify({ top: Math.round(p.scrollTop), max: Math.round(p.scrollHeight - p.clientHeight) });
    })()`));
    await evaluate(`document.getElementById('page-btn').click()`);
    await waitFor(`(() => {
      const p = document.getElementById('page-screen');
      return !p.classList.contains('hidden') && /致谢/.test(document.getElementById('page-title').textContent);
    })()`, 60000, '手机端致谢页');
    await sleep(500);
    const topAt = JSON.parse(await evaluate(`(() => {
      const p = document.getElementById('page-screen');
      const t = document.getElementById('page-title');
      return JSON.stringify({
        top: Math.round(p.scrollTop), max: Math.round(p.scrollHeight - p.clientHeight),
        titleTop: Math.round(t.getBoundingClientRect().top - p.getBoundingClientRect().top),
        title: t.textContent
      });
    })()`));
    hardCheck(gateAt.top > 0 && topAt.max > 0 && topAt.top === 0 && topAt.titleTop >= -2 && topAt.titleTop < 160,
      '致谢页从最上方开始显示（知情同意页滚过之后，致谢页仍从顶部开始）',
      `知情同意页滚到 ${gateAt.top}px（可滚 ${gateAt.max}px）→ 致谢页 scrollTop=${topAt.top}（可滚 ${topAt.max}px）· 标题「${topAt.title}」距顶 ${topAt.titleTop}px`);
    await shot('v6-30-chat-debrief-top');
  } finally {
    await adminFetch(token, '/api/admin/questionnaire/delete', { body: { id: topQ.id, force: true } });
    console.log('已清理致谢页置顶自检问卷');
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });

  // ---- 时间已到：直接停止作答（不自动提交、不再开新窗口），提示可以点顶部「重做」
  // 单独一份小问卷走两支：文本题（消息式题面）与打分题（题卡）各等它的作答窗口到点。
  console.log('\n时间已到（停止作答）：文本题 / 打分题各 6 秒窗口');
  const toQ = await ensureTimeoutFixture(token);
  try {
    await evaluate(`localStorage.clear()`);
    await goto(`${BASE}/chat?q=${toQ.id}&fresh=1`, 1200);
    await waitFor(`!document.getElementById('page-screen').classList.contains('hidden')`, 30000, '限时问卷知情同意页');
    await evaluate(`(() => { const cb=document.getElementById('page-check'); cb.checked=true; cb.dispatchEvent(new Event('change')); return 'ok'; })()`);
    await evaluate(`document.getElementById('page-btn').click()`);
    // ① 文本题（消息式题面）：写一半就不写了，等时间到
    await waitFor(`state.action && state.action.itemId === 'to_t' && !!state.questionNodes.get('to_t')`, 60000, '限时文本题呈现');
    const draftKey = `expchat_draft_${toQ.id}_to_t`;
    await evaluate(`(() => { const i=document.getElementById('composer-input'); i.value='写到一半就到点了'; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    const hadDraft = await evaluate(`!!localStorage.getItem(${JSON.stringify(draftKey)})`);
    await waitFor(`!!document.querySelector('.qmsg.stopped')`, 30000, '文本题进入「已停止作答」');
    const toText = JSON.parse(await evaluate(`(() => {
      const n = state.questionNodes.get('to_t');
      return JSON.stringify({
        closed: !!(n && n.closed),
        timer: (document.querySelector('.qmsg .qcard-timer') || {}).textContent || '',
        hint: (document.querySelector('.qstopped-hint') || {}).textContent || '',
        composerOff: document.getElementById('composer-input').disabled && document.getElementById('composer-send').disabled,
        composerHint: document.getElementById('composer-hint').textContent,
        draft: !!localStorage.getItem(${JSON.stringify(draftKey)}),
        bubbles: document.querySelectorAll('#chat-stream .msg.user.answered').length,
        sameQuestion: !!(state.action && state.action.itemId === 'to_t')
      });
    })()`));
    hardCheck(toText.closed && toText.sameQuestion && toText.bubbles === 0 && /已停止作答/.test(toText.timer) && toText.hint.includes('重做'),
      '时间已到：文本题直接停止作答（没自动提交、没推进到下一题）',
      `状态「${toText.timer}」· 提示含「重做」${toText.hint.includes('重做') ? '✔' : '✘'} · 作答气泡 ${toText.bubbles} 个`);
    hardCheck(hadDraft === true && toText.draft === false && toText.composerOff && toText.composerHint.includes('重做'),
      '时间已到：输入停用、未提交的草稿被销毁',
      `草稿 ${hadDraft ? '有' : '无'} → ${toText.draft ? '仍在' : '已销毁'} · 输入停用 ${toText.composerOff ? '✔' : '✘'}`);
    await shot('v6-25-chat-timeup-text');
    // 提示给的出口：点顶部「重做」→ 确认 → 回到知情同意页重新开始
    const sidBefore = await evaluate('state.sessionId');
    await evaluate(`document.getElementById('btn-redo').click()`);
    await waitFor(`!document.getElementById('confirm-mask').classList.contains('hidden')`, 10000, '重做确认弹窗');
    await evaluate(`document.getElementById('confirm-ok').click()`);
    await waitFor(`!document.getElementById('page-screen').classList.contains('hidden')`, 60000, '重做后回到知情同意页');
    const afterRedo = JSON.parse(await evaluate(`JSON.stringify({
      changed: state.sessionId !== ${JSON.stringify(sidBefore)},
      stoppedLeft: document.querySelectorAll('.qmsg.stopped, .qcard.stopped').length
    })`));
    hardCheck(afterRedo.changed && afterRedo.stoppedLeft === 0,
      '时间已到：按提示点「重做」可以重新开始（会话换新、停止态清零）',
      `会话换新 ${afterRedo.changed ? '✔' : '✘'} · 残留停止态 ${afterRedo.stoppedLeft} 处`);
    // ② 打分题（题卡）：先按时交掉文本题，再让打分题到点
    await evaluate(`(() => { const cb=document.getElementById('page-check'); cb.checked=true; cb.dispatchEvent(new Event('change')); return 'ok'; })()`);
    await evaluate(`document.getElementById('page-btn').click()`);
    await waitFor(`state.action && state.action.itemId === 'to_t' && !!state.questionNodes.get('to_t')`, 60000, '限时文本题再次呈现');
    await evaluate(`(() => { const i=document.getElementById('composer-input'); i.value='按时提交的回答'; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await waitFor(`document.getElementById('composer-send').disabled === false`, 15000, '发送按钮可用');
    await evaluate(`document.getElementById('composer-send').click()`);
    await waitFor(`state.action && state.action.itemId === 'to_r' && !!state.questionNodes.get('to_r')`, 60000, '限时打分题呈现');
    await waitFor(`!!document.querySelector('.qcard.stopped')`, 30000, '打分题进入「已停止作答」');
    const toCard = JSON.parse(await evaluate(`(() => {
      const box = document.querySelector('.qcard.stopped');
      return JSON.stringify({
        closed: box.classList.contains('window-closed'),
        timer: (box.querySelector('.qcard-timer') || {}).textContent || '',
        hint: (box.querySelector('.qfoot-hint') || {}).textContent || '',
        submitGone: !box.querySelector('.qcard-foot .primary-btn'),
        allOff: [...box.querySelectorAll('button')].every((b) => b.disabled)
      });
    })()`));
    hardCheck(toCard.closed && toCard.submitGone && toCard.allOff && /已停止作答/.test(toCard.timer) && toCard.hint.includes('重做'),
      '时间已到：题卡式题目同样停止作答（提交入口撤掉、控件停用）',
      `状态「${toCard.timer}」· 提交入口${toCard.submitGone ? '已撤' : '仍在'} · 控件停用 ${toCard.allOff ? '✔' : '✘'}`);
    await shot('v6-26-chat-timeup-card');
  } finally {
    await adminFetch(token, '/api/admin/questionnaire/delete', { body: { id: toQ.id, force: true } });
    console.log('已清理限时自检问卷');
  }

  // ---- 数据页
  await goto(`${BASE}/admin`, 1200);
  await hashTo(`#/q/${questionnaire.id}/data`, 1400);
  await shot('v6-17-admin-data');
  await evaluate(`(() => { const r=document.querySelector('#admin-main .data-table tbody tr'); if (r) r.click(); return 'ok'; })()`);
  await sleep(1400);
  await shot('v6-18-admin-session');

  ws.close();
  browser.kill();
  // 清理走查用的演示问卷（连同它的会话数据），避免每次走查都在库里留一份
  try {
    await adminFetch(token, '/api/admin/questionnaire/delete', { body: { id: questionnaire.id, force: true } });
    console.log('已清理走查演示问卷');
  } catch (err) {
    console.log('演示问卷清理失败（可手动删除）：' + err.message);
  }
  if (failures.length) {
    console.log('\n批次5 硬性检查未通过 ' + failures.length + ' 项：');
    failures.forEach((f) => console.log('  ✘ ' + f));
    throw new Error('批次5 检查未通过');
  }
  console.log(`\n走查完成，共 ${shotIndex} 张截图 → ${OUT_DIR}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('CAPTURE ERROR:', err.message);
    try { if (browserProc) browserProc.kill(); } catch { /* 忽略 */ }
    process.exit(1);
  });
