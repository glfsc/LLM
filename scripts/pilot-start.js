// 预实验启动器：打印中文提示并启动服务（由「启动预实验.bat」调用）
// 说明：bat 保持纯 ASCII 并先执行 chcp 65001，中文提示集中在本文件（UTF-8），
//       避免批处理在 GBK/UTF-8 混用时被 cmd.exe 拆成乱码命令。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data.db');

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
    console.error('[!] 端口被占用：可能已有一个实验平台窗口开着。');
    console.error('    请先关闭其他黑色窗口再重试；或在本窗口执行 set PORT=3001 后重新双击本 bat。');
  } else {
    console.error('[!] 启动失败：', (err && err.message) || err);
  }
  console.error('');
  process.exit(1);
});

console.log('');
console.log('  实验对话系统 · 局域网预实验');
console.log('  ------------------------------------------------');
if (!fs.existsSync(DB_FILE)) console.log('  首次运行：正在初始化数据库...');
console.log('  请注意：');
console.log('   1. 若弹出 Windows 防火墙提示，请勾选「专用网络」并点「允许访问」，');
console.log('      否则手机将无法连接。');
console.log('   2. 启动后会自动打开「手机扫码进入实验」页面，用手机相机扫码即可。');
console.log('   3. 手机需与本机连接同一个 WiFi（或本机开出的移动热点）。');
console.log('   4. 实验期间请勿关闭本窗口；关闭 = 停止服务，数据不会丢失。');
console.log('');

process.env.OPEN_CONNECT = '1';
require(path.join(ROOT, 'server.js'));
