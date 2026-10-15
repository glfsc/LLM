// 预实验启动器：打印中文提示、自动处理端口冲突并启动服务（由「启动预实验.bat」调用）
// 说明：bat 保持纯 ASCII 并先执行 chcp 65001，中文提示集中在本文件（UTF-8），
//       避免批处理在 GBK/UTF-8 混用时被 cmd.exe 拆成乱码命令。
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
// 与 db.js 同口径：默认项目根目录的 data.db，可用 DB_PATH 覆盖
const DB_FILE = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(ROOT, 'data.db');
const PORT_WANTED = Number(process.env.PORT) || 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('');
  console.error(`[!] Node.js 版本过旧（当前 ${process.versions.node}），需要 22.13.0 及以上。`);
  console.error('    请使用本包内附带的 node.exe，或到 https://nodejs.org/ 安装新版后重试。');
  console.error('');
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error('');
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[!] 端口 ${PORT_WANTED} 又被占走了：自动处理没赶上（多半是和别的程序同时抢端口）。`);
    console.error('    请关闭其他占用该端口的程序后重新双击本 bat。');
  } else {
    console.error('[!] 启动失败：', (err && err.message) || err);
  }
  console.error('');
  process.exit(1);
});

/* ---------------------------------------------------------------- 端口冲突自动处理
   双击 bat 最常见的失败原因是「上一次的窗口关了、而 node 进程还挂在端口上」，
   以前只会打出 EADDRINUSE 让人自己去处理。现在启动前先自检：
     ① 端口空闲            → 直接用；
     ② 端口被占、且探测到就是本平台（/api/health 回 ok 且首页是本平台页面）
                           → 那是没退干净的旧实例，结束它（仅当占用者确实是 node.exe）后继续用原端口；
     ③ 端口被别的程序占着  → 不动别人的进程，自动往后找一个空闲端口启动，
                            二维码 / 连接页 / 管理入口都跟着新端口走，实验人员不用做任何设置。 */

// 端口上有没有人在监听：用「连一下」判断。
// 注意：Windows 上直接 bind 探测不可靠——SO_REUSEADDR 允许再次绑定同一端口，
// 探测会误判成空闲，直到真正 listen 时才报 EADDRINUSE（这正是以前那个报错的由来）。
function portTaken(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const finish = (taken) => { sock.destroy(); resolve(taken); };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));          // ECONNREFUSED：没人监听
    sock.once('timeout', () => finish(false));
    sock.setTimeout(1200);
  });
}

async function waitFree(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await portTaken(port))) return true;
    await sleep(250);
  }
  return !(await portTaken(port));
}

// 监听该端口的进程号（Windows 用 netstat；其他平台拿不到就算了，靠换端口兜底）
function listeningPids(port) {
  if (process.platform !== 'win32') return [];
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m && Number(m[1]) === port) pids.add(Number(m[2]));
    }
    return [...pids];
  } catch { return []; }
}

function processImageName(pid) {
  if (process.platform !== 'win32') return '';
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const m = /^"([^"]+)"/.exec(out.trim());
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

// 这个端口上跑的到底是不是本平台？健康检查与首页品牌字样都对上才算——避免误杀别人的程序。
async function isOurPlatform(port) {
  const brief = { signal: AbortSignal.timeout(1500) };
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, brief);
    if (!health.ok) return false;
    const data = await health.json().catch(() => null);
    if (!data || data.ok !== true) return false;
    const home = await fetch(`http://127.0.0.1:${port}/`, brief);
    return /实验对话系统/.test(await home.text().catch(() => ''));
  } catch { return false; }
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore', windowsHide: true, timeout: 8000 });
    else process.kill(pid, 'SIGKILL');
    return true;
  } catch { return false; }
}

async function resolvePort(wanted) {
  if (!(await portTaken(wanted))) return wanted;
  console.log(`  端口 ${wanted} 被占用，正在自动处理…`);

  if (await isOurPlatform(wanted)) {
    // 只结束 node.exe（本平台的运行方式）——别的程序即便回了个 ok 也不动它
    const pids = listeningPids(wanted).filter((pid) => processImageName(pid) === 'node.exe');
    const killed = pids.filter((pid) => killPid(pid));
    if (killed.length) console.log(`  · 已结束上一次没退干净的旧实例（PID ${killed.join(', ')}）`);
    if (killed.length && await waitFree(wanted, 6000)) {
      console.log(`  · 继续使用端口 ${wanted}（作答数据实时写进 data.db，已提交的作答不会丢）`);
      return wanted;
    }
    if (!killed.length) console.log('  · 是本平台的实例，但拿不到可结束的进程（无权限或系统不支持），改换端口。');
  } else {
    console.log('  · 占用端口的不是本平台（不是你之前启动的窗口），不动它。');
  }

  for (let p = wanted + 1; p <= wanted + 20; p += 1) {
    if (!(await portTaken(p))) {
      console.log(`  · 本次改用端口 ${p}：管理端 http://localhost:${p}/（被试链接 / 二维码跟着新端口自动生成）`);
      return p;
    }
  }
  throw new Error(`端口 ${wanted}–${wanted + 20} 都被占用，请关掉其他占用端口的程序后重试。`);
}

async function main() {
  const port = await resolvePort(PORT_WANTED);
  process.env.PORT = String(port);

  console.log('');
  console.log('  实验对话系统 · 局域网预实验');
  console.log('  ------------------------------------------------');
  if (!fs.existsSync(DB_FILE)) console.log('  首次运行：正在初始化数据库...');
  console.log('  请注意：');
  console.log('   1. 若弹出 Windows 防火墙提示，请勾选「专用网络」并点「允许访问」，');
  console.log('      否则手机将无法连接。');
    console.log('   2. 启动后会自动打开管理端（未登录时先显示登录卡片）；');
    console.log('      可保存成图片打印或发给被试（扫码直达作答页）。');
  console.log('   3. 手机需与本机连接同一个 WiFi（或本机开出的移动热点）。');
  console.log('   4. 实验期间请勿关闭本窗口；关闭 = 停止服务，数据不会丢失。');
  console.log('   5. 重复双击本 bat = 结束旧实例并重新启动；被试正在作答时请勿双击。');
  console.log('');

  // 启动后自动打开管理端（未登录时先显示登录卡片）；脚本化启动时可用 OPEN_PAGE=0 关掉
  if (process.env.OPEN_PAGE !== '0') process.env.OPEN_PAGE = '1';
  require(path.join(ROOT, 'server.js'));
}

main().catch((err) => {
  console.error('');
  console.error('[!] 启动失败：', (err && err.message) || err);
  console.error('');
  process.exit(1);
});
