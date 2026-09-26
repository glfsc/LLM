// 界面截图工具：调用本机 Chrome/Edge 的无头模式（CDP 协议）自动操作页面并截图
// 用途：交付验收时生成新流程界面截图（调试入口 / 管理端 / 决策 / 评分 / 完成页）
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到 Chrome / Edge 可执行文件');
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

  // ---- 1. 研究团队调试入口首页
  await goto(`${BASE}/`, 900);
  await shot('v2-01-home');

  // ---- 2. 管理端登录页
  await goto(`${BASE}/admin`, 900);
  await shot('v2-02-admin-login');

  // ---- 3. 登录（通过接口拿 token 写入 sessionStorage，再刷新进入）
  await evaluate(
    `(async () => {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'admin123' })
      });
      const data = await res.json();
      if (!data.token) throw new Error('登录失败');
      sessionStorage.setItem('expchat_admin_token', data.token);
      return 'ok';
    })()`,
    true
  );
  await goto(`${BASE}/admin`, 1000);
  await shot('v2-03-admin-scenarios');

  // ---- 4. 展开医疗情景编辑区（含任务清单与控制/干预组文本）
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.group-card')].find((c) => c.dataset.id === 'medical');
    card.querySelector('.group-meta button').click();
    return 'ok';
  })()`);
  await sleep(500);
  await shot('v2-04-admin-scenario-edit');

  // ---- 5. 保存（不修改内容）并截取“已保存”状态
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.group-card')].find((c) => c.dataset.id === 'medical');
    card.querySelector('.group-actions .primary-btn').click();
    return 'ok';
  })()`);
  await sleep(1000);
  await shot('v2-05-admin-saved');

  // ---- 6. 被试链接页 + 批量编号生成
  await evaluate(`(() => {
    [...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'links').click();
    return 'ok';
  })()`);
  await sleep(400);
  await evaluate(`(() => {
    document.getElementById('batch-group').value = 'medical-control';
    document.getElementById('batch-start').value = '1001';
    document.getElementById('batch-count').value = '5';
    document.getElementById('btn-batch').click();
    return 'ok';
  })()`);
  await sleep(500);
  await shot('v2-06-admin-links');

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

  // ---- 7. 被试端：医疗控制组 —— 决策操作区（4 点量表）
  await goto(`${BASE}/chat?group=medical-control&uid=capture-flow-1`, 11000);
  await shot('v2-07-chat-choice');

  // ---- 8. 作答后呈现研究2匹配文本 → 相似度评分操作区（7 点量表）
  await answer('.option-btn', 1, 9000);
  await shot('v2-08-chat-rating');

  // ---- 9. 评分后呈现研究3组别文本 → 第二次决策
  await answer('.rating-btn', 5, 9000);
  await shot('v2-09-chat-second-choice');

  // ---- 10. 快速走完剩余步骤 → 完成页
  await answer('.option-btn', 4, 11000);
  await answer('.option-btn', 2, 9000);
  await answer('.rating-btn', 6, 9000);
  await answer('.option-btn', 3, 11000);
  await sleep(1200);
  await shot('v2-10-done');

  ws.close();
  browser.kill();
  console.log(`全部截图完成，共 ${shotIndex} 张，输出目录：${OUT_DIR}`);
}

main().catch((err) => {
  console.error('CAPTURE ERROR:', err.message);
  process.exitCode = 1;
});
