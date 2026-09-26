// 界面截图工具：调用本机 Chrome/Edge 的无头模式（CDP 协议）自动操作页面并截图
// 用途：交付验收截图（入口说明 / 管理端问卷管理（列表 · 新建 · 修改）/ 流程与情景页 /
//       被试端全流程（同意 → 决策 → 评分 → 分组文本 → 结束说明终态）/ 手机端适配 /
//       问卷数据（行级视图 · 实验/问题筛选）与个案详情）
// 用法：先启动服务（npm start），再执行：node scripts/capture-shots.js
// 说明：脚本会复用或创建一份「演示问卷·控制组」，并向其提交一条完整被试会话用于数据页截图。
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
const DEMO_NAME = '演示问卷·控制组';

const DEMO_FLOW = {
  welcomeText: '欢迎参加本次研究。\n接下来你会阅读一段情境材料，并按照自己的真实想法做出判断与选择。',
  nextTaskText: '下面进入下一个任务。请同样先阅读情境材料，再根据自己的判断作答。',
  endText: '以上是本次实验的全部任务，感谢你的认真参与。',
  consentText:
    '【研究知情同意书】\n\n本研究旨在了解人们在面对决策情境时的判断过程。你的参与完全自愿，可随时退出，且不会对你有任何不利影响。\n\n实验中不会收集任何可直接识别你身份的信息；所有作答数据仅以匿名编号形式用于学术分析，不作他用。\n\n继续即表示你已理解上述说明，并同意参与本次研究。',
  debriefText:
    '【结束说明】\n\n感谢你的参与。本研究的目的是考察在决策情境中，不同类型的信息呈现方式对判断与选择的影响。\n\n实验中你看到的文本由研究团队事先编写，并非针对个人的评估或建议。\n\n如有任何疑问，可通过实验招募信息中的联系方式与研究者沟通。'
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到 Chrome / Edge 可执行文件');
}

/* ---------------------------------------------------------------- 演示问卷准备 */

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

// 复用已有的「演示问卷·控制组」；不存在则创建（流程文案与实验编排：研究2 + 研究3）
async function ensureDemoQuestionnaire() {
  const login = await adminFetch('', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
  const token = login.token;

  const list = await adminFetch(token, '/api/admin/questionnaires');
  const existing = list.questionnaires.find((q) => q.name === DEMO_NAME);
  if (existing) {
    console.log(`复用演示问卷：${existing.name}（${existing.id}）`);
    return { token, questionnaire: existing };
  }

  const scenarioList = await adminFetch(token, '/api/admin/scenarios');
  const scenario = scenarioList.scenarios.find((s) => s.id === 'medical') || scenarioList.scenarios[0];
  if (!scenario) throw new Error('没有可用情景，请先在管理端创建情景');

  const created = await adminFetch(token, '/api/admin/questionnaire/create', {
    body: {
      name: DEMO_NAME,
      groupRole: 'control',
      flow: DEMO_FLOW,
      experiments: [
        { kind: 'r2', scenarioId: scenario.id },
        { kind: 'r3', scenarioId: scenario.id }
      ]
    }
  });
  console.log(`已创建演示问卷：${created.questionnaire.name}（${created.questionnaire.id}）`);
  return { token, questionnaire: created.questionnaire };
}

/* ---------------------------------------------------------------- 极简 CDP 客户端 */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        this.events.push(msg);
        this.waiters = this.waiters.filter((w) => {
          if (w.method !== msg.method) return true;
          w.resolve(msg.params);
          return false;
        });
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

  waitEvent(method, timeout = 15000) {
    const found = this.events.find((e) => e.method === method);
    if (found) return Promise.resolve(found.params);
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`等待事件超时: ${method}`));
      }, timeout);
    });
  }
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { token, questionnaire } = await ensureDemoQuestionnaire();
  const scenarioId = questionnaire.experiments[0].scenarioId;
  const browserPath = findBrowser();
  const userDataDir = path.join(os.tmpdir(), `expchat-capture-${Date.now()}`);

  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,900',
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

  // 等待调试端口就绪
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
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

  // 新建页面 target
  let target = null;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: 'PUT' });
    if (res.ok) target = await res.json();
  } catch {
    /* 降级到已有 target */
  }
  if (!target) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    target = list.find((t) => t.type === 'page');
  }
  if (!target) throw new Error('未找到可用的浏览器页面');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });

  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  });

  let shotIndex = 0;
  const shot = async (name) => {
    shotIndex += 1;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`[${shotIndex}] 已保存 ${file}`);
  };

  const goto = async (url, settle = 600) => {
    cdp.events = [];
    await cdp.send('Page.navigate', { url });
    await cdp.waitEvent('Page.loadEventFired');
    await sleep(settle);
  };

  const evaluate = async (expression, awaitPromise = false) => {
    const res = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      const desc =
        (res.exceptionDetails.exception && res.exceptionDetails.exception.description) ||
        res.exceptionDetails.text;
      throw new Error(`页面脚本出错: ${desc}`);
    }
    return res.result.value;
  };

  // ---- hash 路由切换助手（同文档导航，不触发整页加载）
  const hashTo = async (hash, settle = 700) => {
    await evaluate(`(() => { location.hash = ${JSON.stringify(hash)}; return 'ok'; })()`);
    await sleep(settle);
  };

  // ---- 1. 入口说明页
  await goto(`${BASE}/`, 900);
  await shot('v3-01-home');

  // ---- 2. 管理端登录页
  await goto(`${BASE}/admin`, 900);
  await shot('v3-02-admin-login');

  // ---- 3. 登录（写入 sessionStorage 后刷新进入）→ 问卷管理列表
  await evaluate(
    `(() => { sessionStorage.setItem('expchat_admin_token', ${JSON.stringify(token)}); return 'ok'; })()`
  );
  await goto(`${BASE}/admin`, 1100);
  await shot('v3-03-admin-q-list');

  // ---- 4. 新建问卷页（填写名称，展示流程文案快照 + 实验编排）
  await hashTo('#/q/new', 900);
  await evaluate(`(() => {
    const input = document.querySelector('#q-editor .editor-section input');
    if (input) input.value = '演示问卷 · 新建示例';
    return 'ok';
  })()`);
  await sleep(300);
  await shot('v3-04-admin-q-new');

  // ---- 5. 修改问卷（独立编辑页）
  await hashTo(`#/q/${questionnaire.id}/edit`, 900);
  await shot('v3-05-admin-q-edit');

  // ---- 6. 流程页面（默认文案模板）
  await hashTo('#/flow', 800);
  await shot('v3-06-admin-flow');

  // ---- 7. 研究2 情景编辑页
  await hashTo(`#/r2/${scenarioId}`, 900);
  await shot('v3-07-admin-r2-editor');

  // ---- 操作区助手：点选选项并提交，等待动画完成
  const answer = async (selector, value, waitMs) => {
    await evaluate(`(() => {
      const btn = document.querySelector(${JSON.stringify(selector)} + '[data-value="' + ${JSON.stringify(String(value))} + '"]');
      if (!btn) throw new Error('未找到选项 ' + ${JSON.stringify(String(value))});
      btn.click();
      document.getElementById('btn-submit').click();
      return 'ok';
    })()`);
    await sleep(waitMs);
  };

  // ---- 8. 被试端：知情同意页（问卷级文案）
  await goto(`${BASE}/chat?q=${questionnaire.id}`, 900);
  await shot('v3-08-chat-consent');

  // ---- 9. 勾选同意并开始 → 欢迎语 + 情境材料 → 决策操作区
  await evaluate(`(() => {
    const cb = document.getElementById('consent-checkbox');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    document.getElementById('btn-consent').click();
    return 'ok';
  })()`);
  await sleep(11000);
  await shot('v3-09-chat-choice');

  // ---- 10. 决策①完成 → 研究2 匹配文本 → 相似度评分
  await answer('.option-btn', 1, 9000);
  await shot('v3-10-chat-rating');

  // ---- 11. 评分完成 → 衔接语 + 下一任务材料（多次博弈）→ 决策
  await answer('.rating-btn', 5, 9000);
  await shot('v3-11-chat-next-task');

  // ---- 12. 第二次评分完成 → 研究3 段：基线决策
  await answer('.option-btn', 2, 9000);
  await answer('.rating-btn', 6, 11000);
  await shot('v3-12-chat-r3-base');

  // ---- 13. 基线决策完成 → 控制组文本呈现 → 再次决策
  await answer('.option-btn', 2, 9000);
  await shot('v3-13-chat-group-text');

  // ---- 14. 快速走完剩余步骤 → 结束说明页（终态：无任何跳转按钮）
  await answer('.option-btn', 4, 9000);
  await answer('.option-btn', 1, 11000);
  await answer('.option-btn', 3, 11000);
  await sleep(1600);
  await shot('v3-14-chat-debrief');

  // ---- 视口切换助手（手机端适配检查）
  const setViewport = async (width, height, mobile) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    await sleep(350);
  };

  // ---- 15. 手机端（375×812）：知情同意页
  await setViewport(375, 812, true);
  await goto(`${BASE}/chat?q=${questionnaire.id}&fresh=1`, 900);
  await shot('v3-15-mobile-consent');

  // ---- 16. 手机端：勾选同意开始 → 选项卡片界面（单列大点按区域）
  await evaluate(`(() => {
    const cb = document.getElementById('consent-checkbox');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    document.getElementById('btn-consent').click();
    return 'ok';
  })()`);
  await sleep(11000);
  await shot('v3-16-mobile-choice');

  // ---- 恢复桌面视口
  await setViewport(1280, 900, false);

  // ---- 17. 问卷数据页（行级作答视图：实验 / 问题筛选 + 导出）
  await goto(`${BASE}/admin`, 1100);
  await hashTo(`#/q/${questionnaire.id}`, 1300);
  await shot('v3-17-data-list');

  // ---- 18. 数据页筛选：实验＝研究3 → 问题＝基线决策
  await evaluate(`(() => {
    const selects = document.querySelectorAll('#q-detail-toolbar select');
    if (selects.length < 2) throw new Error('筛选器未渲染');
    selects[0].value = '2';
    selects[0].dispatchEvent(new Event('change'));
    return 'ok';
  })()`);
  await sleep(1300);
  await evaluate(`(() => {
    const selects = document.querySelectorAll('#q-detail-toolbar select');
    selects[1].value = 'r3_base';
    selects[1].dispatchEvent(new Event('change'));
    return 'ok';
  })()`);
  await sleep(1300);
  await shot('v3-18-data-filtered');

  // ---- 19. 个案详情（会话信息 + 作答明细 + 对话时间线）
  await evaluate(`(() => {
    const row = document.querySelector('#q-detail-list .data-row');
    if (!row) throw new Error('数据列表为空，无法进入详情');
    row.click();
    return 'ok';
  })()`);
  await sleep(1300);
  await shot('v3-19-data-detail');

  ws.close();
  browser.kill();
  console.log(`全部截图完成，共 ${shotIndex} 张，输出目录：${OUT_DIR}`);
}

main().catch((err) => {
  console.error('CAPTURE ERROR:', err.message);
  process.exitCode = 1;
});
