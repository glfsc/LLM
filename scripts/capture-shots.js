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
const DEMO_TIMING = { delay: 4, wait: 5, minSubmit: 6, maxAnswer: 12 };   // maxAnswer 也留一段，走查里能看到「作答倒计时」

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome / Edge');
}

async function adminFetch(token, route, options = {}) {
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + route, {
    method: options.body ? 'POST' : 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// 准备演示问卷：每次重建，保证数据页只有一条完整会话
async function ensureDemo() {
  const token = (await adminFetch('', '/api/admin/login', { body: { password: ADMIN_PASSWORD } })).token;
  const list = await adminFetch(token, '/api/admin/questionnaires');
  for (const q of list.questionnaires.filter((x) => x.title === DEMO_NAME)) {
    await adminFetch(token, '/api/admin/questionnaire/delete', { body: { id: q.id, force: true } });
  }
  const source = list.questionnaires.find((x) => /组别3/.test(x.title));
  const created = (await adminFetch(token, '/api/admin/questionnaire/create', { body: { title: DEMO_NAME, copyFrom: source.id } })).questionnaire;
  // 缩短题目级计时（模板插入的题目都带显式限制）
  const items = created.items.map((it) => {
    const limits = { ...it.limits };
    if (limits.delay) limits.delay = DEMO_TIMING.delay;
    if (limits.wait) limits.wait = DEMO_TIMING.wait;
    if (limits.minSubmit) limits.minSubmit = DEMO_TIMING.minSubmit;
    if (limits.maxAnswer) limits.maxAnswer = DEMO_TIMING.maxAnswer;
    return { ...it, limits };
  });
  console.log('  含计时限制的题目：' + items.filter((i) => Object.keys(i.limits).length).map((i) => `${i.title}[${JSON.stringify(i.limits)}]`).join(' '));
  await adminFetch(token, '/api/admin/questionnaire/update', {
    body: { id: created.id, title: DEMO_NAME, timing: created.timing, items }
  });
  console.log(`演示问卷：${DEMO_NAME}（${created.id}）· 题目 ${items.length} 道`);
  return { token, questionnaire: created };
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
  await evaluate(`document.querySelectorAll('#sidebar-outline .ol-item')[6].click()`);
  await sleep(700);
  await shot('v6-05-admin-exp-outline');
  // 选中「内容创作」题组并滚动到视口中央（选中态会展开为完整编辑器，含子题）
  await evaluate(`(() => { const c=[...document.querySelectorAll('.qcard')].find(x=>/内容创作/.test(x.querySelector('.qtitle').textContent)); if (c) c.querySelector('.qcard-head').click(); return 'ok'; })()`);
  await sleep(600);
  await evaluate(`(() => { const c=[...document.querySelectorAll('.qcard')].find(x=>/内容创作/.test(x.querySelector('.qtitle').textContent)); if (c) c.scrollIntoView({ block: 'center' }); return 'ok'; })()`);
  await sleep(600);
  await shot('v6-06-admin-timing-limits');
  // 从头试填
  await evaluate(`startTrial()`);
  await sleep(1200);
  // 试填使用真实控件：点「继续」推进到打分局，再截图（可见可点的数字按钮而非下拉栏）
  for (let i = 0; i < 5; i += 1) {
    await evaluate(`(() => { const b=[...document.querySelectorAll('#pv-actions .go')].find(x=>/继续|开始实验/.test(x.textContent) && !x.classList.contains('disabled')); if (b) { b.click(); return 'clicked'; } return 'skip'; })()`);
    await sleep(500);
  }
  await shot('v6-07-admin-trial');
  await evaluate(`exitTrial()`);
  await sleep(500);
  await hashTo('#/q', 900);
  await shot('v6-08-admin-q-list');
  await hashTo(`#/q/${questionnaire.id}`, 1200);
  await shot('v6-09-admin-q-editor');

  // ---- 从头试填（问卷编辑页，20× 倍速）跑到「试填结束」：回归「点试填后手机屏空白」——空消息必须被跳过
  await evaluate(`(() => { const s = document.querySelector('.pv-speed'); s.value = '20'; s.dispatchEvent(new Event('change')); state.previewSpeed = 20; return 'ok'; })()`);
  const splitterOk = JSON.parse(await evaluate(`(() => {
    const side = document.getElementById('split-sidebar');
    const main = document.querySelector('.editor-cols > .splitter');
    return JSON.stringify({ side: !!side, main: !!main, tools: ['btn-side-out', 'btn-side-in', 'btn-side-collapse', 'btn-side-expand'].every((id) => !!document.getElementById(id)) });
  })()`));
  console.log('三栏布局：分隔线（菜单栏 ' + (splitterOk.side ? '有' : '缺') + ' / 编辑·手机 ' + (splitterOk.main ? '有' : '缺')
    + '）+ 菜单栏折叠与缩放按钮 ' + (splitterOk.tools ? '齐全 ✔' : '缺失 ✘'));
  await evaluate(`startTrial()`);
  const trialStep = () => evaluate(`(() => {
    const b = document.getElementById('pv-body');
    const gates = [...b.querySelectorAll('.screen-gate')];
    const gate = gates.find((g) => !g.querySelector('.go').classList.contains('done-flag')) || null;
    const card = b.querySelector('.pv-qcard.active');
    const doneCards = [...b.querySelectorAll('.pv-qcard.done')];
    return JSON.stringify({
      kids: b.children.length,
      done: !!b.querySelector('.pv-done'),
      gate: gate ? gate.querySelector('.go').textContent : null,
      gateChecked: gate ? gate.querySelector('.check').classList.contains('checked') : null,
      consentCount: gates.filter((g) => /知情同意/.test(g.textContent)).length,
      q: card ? (card.querySelector('.pv-qtitle') || {}).textContent || '' : null,
      opts: card ? [...card.querySelectorAll('.option-btn')].map((x) => x.textContent.trim()) : [],
      timer: card && card.querySelector('.pv-timer') ? card.querySelector('.pv-timer').textContent : '',
      doneCards: doneCards.length,
      toggles: doneCards.filter((c) => c.querySelector('.pv-qtoggle')).length,
      idx: state.trial ? state.trial.idx : null
    });
  })()`);
  const trialAnswer = () => evaluate(`(() => {
    const card = document.querySelector('#pv-body .pv-qcard.active');
    if (!card) return 'no-card';
    const first = card.querySelector('.rating-btn, .option-btn');
    if (first && !card.querySelector('.rating-btn.selected, .option-btn.selected')) first.click();
    card.querySelectorAll('textarea, input').forEach((inp) => { if (!inp.value) { inp.value = '试填内容'; inp.dispatchEvent(new Event('input')); } });
    const s = card.querySelector('.pv-submit');
    if (s && !s.disabled) s.click();
    return 'ok';
  })()`);
  let trialGuard = 0;
  let trialBlankAt = null;
  let trialReached = false;
  let trialOpts = null;
  let trialTimer = null;
  let trialConsentLeft = null;
  let trialToggleSeen = 0;
  let sawConsent = false;
  let trialChoiceShot = false;
  const trialSeen = [];
  while (trialGuard++ < 900) {
    const st = JSON.parse(await trialStep());
    if (st.idx != null && !trialSeen.includes(st.idx)) trialSeen.push(st.idx);
    if (!trialOpts && st.opts.length) trialOpts = st.opts;
    if (!trialTimer && st.timer) trialTimer = st.timer;
    if (st.consentCount > 0) sawConsent = true;
    else if (sawConsent) trialConsentLeft = 0;                        // 同意页确认后不再留在屏内
    if (st.doneCards > 0 && st.toggles === st.doneCards) trialToggleSeen = Math.max(trialToggleSeen, st.doneCards);
    if (st.done) { trialReached = true; break; }
    if (!st.kids) { trialBlankAt = st.idx; break; }
    if (st.gate) {
      await evaluate(`(() => { const gs = [...document.querySelectorAll('#pv-body .screen-gate')]; const last = gs[gs.length - 1];
        if (!last.querySelector('.check').classList.contains('checked')) last.querySelector('.check').click(); else last.querySelector('.go').click(); return 'ok'; })()`);
      await sleep(400);
      continue;
    }
    if (st.q && st.opts.length && !trialChoiceShot) { trialChoiceShot = true; await sleep(250); await shot('v6-21-admin-trial-choice'); }
    if (st.q) { await trialAnswer(); await sleep(400); continue; }
    await sleep(300);
  }
  await sleep(400);
  await shot('v6-20-admin-trial-end');
  console.log('从头试填（20×）：' + (trialReached
    ? `跑到「试填结束」✔（经过 ${trialSeen.length} 个步骤）`
    : `未跑完 ✘${trialBlankAt != null ? `，在第 ${trialBlankAt} 步出现空白屏` : '（超时）'}`));
  console.log('  试填检查：选项文字 ' + (trialOpts && trialOpts.every((t) => t) ? `非空 ✔ ${JSON.stringify(trialOpts)}` : '空白 ✘')
    + '；知情同意确认后已从屏内清空 ' + (trialConsentLeft === 0 ? '✔' : '✘')
    + `；已答题折叠按钮 ${trialToggleSeen > 0 ? `${trialToggleSeen} 张全覆盖 ✔` : '缺失 ✘'}`
    + '；右上角倒计时 ' + (trialTimer ? `出现过（${trialTimer}）✔` : '未出现 ✘'));
  await evaluate(`if (state.trial) exitTrial(); 0`);
  await sleep(400);

  // ---- 被试端全流程（新会话，避免沿用管理端同一浏览器里的记录）
  await evaluate(`localStorage.clear()`);
  await goto(`${BASE}/chat?q=${questionnaire.id}&fresh=1`, 1200);
  await waitFor(`!document.getElementById('page-screen').classList.contains('hidden')`, 30000, '知情同意页');
  await shot('v6-10-chat-consent');
  await evaluate(`(() => { const cb=document.getElementById('page-check'); cb.checked=true; cb.dispatchEvent(new Event('change')); return 'ok'; })()`);
  await sleep(300);
  await evaluate(`document.getElementById('page-btn').click()`);
  await waitFor(`(() => { const a=state.action; return !!(a && a.type==='rating' && state.questionNodes.get(a.itemId)); })()`, 120000, '首个打分题');
  await shot('v6-11-chat-rating');

  // 内联作答：直接点卡片内的控件（打分局/单选点选即提交；题组/文本点提交）
  const answerCurrent = async () => {
    const info = await evaluate(`(() => {
      const a = state.action;
      if (!a) return null;
      const node = state.questionNodes.get(a.itemId);
      if (!node) return null;
      return { type: a.type, id: a.itemId, gated: node.submitBtn ? node.submitBtn.disabled : false };
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
        const inp = card.querySelector('.answer-input');
        if (inp && !inp.value) { inp.value = '轻负担，一口青柠爽'; inp.dispatchEvent(new Event('input')); }
      } else if (a.type === 'group') {
        card.querySelectorAll('.answer-input').forEach((inp, i) => {
          if (!inp.value) { inp.value = i === 0 ? '轻负担，一口青柠爽' : '突出 0 糖'; inp.dispatchEvent(new Event('input')); }
        });
      }
      // 2) 再点提交（按钮未到放行时间时会被服务端 too_early 兜底，由外层循环等待）
      if (node.submitBtn && !node.submitBtn.disabled) node.submitBtn.click();
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
  // 按服务端门控时刻精确等待：availableAtMs（强制阅读）/ minSubmitAtMs（最短提交）/ pendingAt（延迟消息）
  const gateInfo = () => evaluate(`(() => {
    const a = state.action;
    const pendingAt = state.pendingAtMs || 0;
    return {
      type: a ? a.type : null, itemId: a ? a.itemId : null,
      availableAtMs: a ? (a.availableAtMs || 0) : 0,
      minSubmitAtMs: a ? (a.minSubmitAtMs || 0) : 0,
      deadlineMs: a ? (a.deadlineMs || 0) : 0,
      serverNow: (typeof serverNow === 'function' ? serverNow() : Date.now()),
      pendingAt,
      // 正处于「等 AI 回复」的过渡窗口：此时视口按设计跟随底部等待，不计入落点判定
      pending: !!(pendingAt && pendingAt > (typeof serverNow === 'function' ? serverNow() : Date.now())),
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
      // 本轮新增内容的开头应贴视口顶部（issue 5）：期望 scrollTop = 该节点顶部 - 12（不够滚则贴底）
      stepTop: (() => {
        const sc = document.getElementById('chat-scroll');
        const s = document.getElementById('chat-stream');
        if (!sc || !s) return null;
        const base = s.querySelector('[data-step-base]');
        const node = base ? base.nextElementSibling : s.firstElementChild;
        if (!node) return null;
        const desired = Math.max(0, node.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 12);
        const max = sc.scrollHeight - sc.clientHeight;
        return { got: Math.round(sc.scrollTop), desired: Math.round(desired), max: Math.round(max),
          dom: s.children.length + 'n/' + s.querySelectorAll('.qcard').length + 'c/' + s.querySelectorAll('.qcard.done').length + 'd' };
      })(),
      pageVisible: !document.getElementById('page-screen').classList.contains('hidden'),
      pageTitle: document.getElementById('page-title').textContent,
      pageBtnHidden: document.getElementById('page-btn').classList.contains('hidden')
    };
  })()`);

  let guard = 0;
  const landings = {};        // 每道新题首次出现时，「本轮新增内容」距视口顶部的像素（issue 5）
  const chatTimers = [];      // 被试端右上角倒计时的取值样本
  while (guard++ < 1500) {
    const info = await gateInfo();
    if (info.timer && !chatTimers.includes(info.timer)) chatTimers.push(info.timer);
    // 只在「题目待作答且不处于等 AI 回复」时判定落点
    if (info.itemId && info.stepTop && !info.pending && !info.waiting && !info.cardDone) {
      // 取「进入下一题之前的最后一次采样」：平滑滚动可能仍在进行，首帧会偏
      const st = info.stepTop;
      const ok = st.desired >= st.max - 40 ? st.got >= st.max - 40 : Math.abs(st.got - st.desired) <= 8;   // 贴底容差：倒计时徽标出现会让卡片略增高
      const prev = landings[info.itemId];
      const samples = (prev ? prev.samples : 0) + 1;
      // 只取题目出现后的前 3 次采样（此后的变化是「等待 AI 回复跟随底部」等设计行为，不属落点判定）
      if (!prev || prev.samples < 3) {
        landings[info.itemId] = { type: info.type, ok, got: st.got, desired: st.desired, max: st.max, samples, trace: (prev ? prev.trace : []), dom: st.dom };
      } else {
        prev.samples = samples;
      }
      const lg = landings[info.itemId];
      if (lg.trace.length < 10) lg.trace.push(st.got + '/' + st.desired + '/' + st.max + (info.waiting ? 'W' : '') + '[' + st.dom + ']');
    }
    // 1) 等待延迟发出的消息
    if (info.pendingAt && info.pendingAt > info.serverNow) {
      if (!seen.includes('WAIT-FEEDBACK')) { seen.push('WAIT-FEEDBACK'); await shot('v6-12-chat-waiting'); }
      await sleep(Math.min(1500, info.pendingAt - info.serverNow + 120));
      continue;
    }
    // 2) 等待作答前强制阅读
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
    // 4) 全屏页面题：知情同意 / 结束说明 → 截图后点按钮继续
    if (info.type === 'gate' || info.type === 'debrief') {
      const key = `${info.type}:${info.itemId}`;
      if (!seen.includes(key)) seen.push(key);
      if (info.type === 'debrief' && !seen.includes('SHOT-DEBRIEF')) {
        seen.push('SHOT-DEBRIEF');
        await sleep(600);
        await shot('v6-15-chat-debrief');
      }
      if (info.type === 'gate') {
        await evaluate(`(() => { const cb=document.getElementById('page-check'); cb.checked=true; cb.dispatchEvent(new Event('change')); return 'ok'; })()`);
        await sleep(250);
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
  // 结束页：同一设备给下一位被试的「重新开始」入口
  const finalInfo = JSON.parse(await evaluate(`(() => {
    const b = document.getElementById('page-btn');
    return JSON.stringify({
      visible: !document.getElementById('page-screen').classList.contains('hidden'),
      label: b.textContent,
      hint: document.getElementById('page-hint').textContent
    });
  })()`));
  console.log('结束页换人入口：' + (finalInfo.visible && /重新开始/.test(finalInfo.label) ? `按钮「${finalInfo.label}」✔` : '缺失 ✘'));
  if (finalInfo.visible) await shot('v6-22-chat-final');
  const done = await evaluate('JSON.stringify({ answered: state.answeredCount, total: state.totalAnswers, completed: state.completed })');
  // issue 5：每道新题出现时，滚动位置是否落在「本轮新增内容的开头」（内容不足一屏则贴底也算合格）
  const rows = Object.values(landings);
  const bad = rows.filter((r) => !r.ok);
  console.log('新内容落点（滚动位置 / 期望位置）：共 ' + rows.length + ' 题，'
    + (bad.length
      ? `${bad.length} 处未落到内容开头 ✘ ` + bad.map((r) => `${r.type} got=${r.got} desired=${r.desired} max=${r.max}`).join('；')
      : '均落在内容开头 ✔'));
  console.log('被试端完成情况：' + done + '（等待类型：' + seen.filter((x) => x.startsWith('WAIT')).join(', ') + '）');
  const answeringTimer = chatTimers.find((t) => /作答计时/.test(t));
  console.log('  被试端右上角倒计时：共 ' + chatTimers.length + ' 种取值' + (chatTimers.length ? '（' + chatTimers.slice(0, 3).map((t) => `「${t}」`).join(' ') + '…）' : '')
    + '；作答倒计时阶段 ' + (answeringTimer ? `出现过「${answeringTimer}」✔` : '未出现 ✘'));

  // ---- 手机端
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await evaluate(`localStorage.clear()`);
  await goto(`${BASE}/chat?q=${questionnaire.id}&fresh=1`, 1200);
  await waitFor(`!document.getElementById('page-screen').classList.contains('hidden')`, 30000, '手机端知情同意页');
  await evaluate(`(() => { const cb=document.getElementById('page-check'); cb.checked=true; cb.dispatchEvent(new Event('change')); document.getElementById('page-btn').click(); return 'ok'; })()`);
  await waitFor(`(() => { const a=state.action; return !!(a && a.type==='rating' && state.questionNodes.get(a.itemId)); })()`, 120000, '手机端打分题');
  await shot('v6-16-mobile-rating');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });

  // ---- 数据页
  await goto(`${BASE}/admin`, 1200);
  await hashTo(`#/q/${questionnaire.id}/data`, 1400);
  await shot('v6-17-admin-data');
  await evaluate(`(() => { const r=document.querySelector('#admin-main .data-table tbody tr'); if (r) r.click(); return 'ok'; })()`);
  await sleep(1400);
  await shot('v6-18-admin-session');

  ws.close();
  browser.kill();
  console.log(`\n走查完成，共 ${shotIndex} 张截图 → ${OUT_DIR}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('CAPTURE ERROR:', err.message);
    try { if (browserProc) browserProc.kill(); } catch { /* 忽略 */ }
    process.exit(1);
  });
