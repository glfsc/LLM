// 打包「局域网预实验便携包」：dist/预实验便携包.zip —— 唯一的分发件。
// 产物特征（缺一不可，实验人员电脑上不需要安装任何东西）：
//   ① 内置当前运行的 node.exe（与开发/自检同版本，规避兼容性）；解压后双击「启动预实验.bat」即可；
//   ② 内置一份**干净数据库**（两个实验模板 + 两份预设问卷 + 0 会话 + 默认管理员 admin/admin123），
//      首次启动就能直接扫码做实验，不用自己建问卷；
//   ③ 只带运行必需文件，不带 design/ documents/ screenshots/ .tmp/ .git 等开发脚手架，
//      也不带会清库的开发脚本（scripts/ 下只留启动器 pilot-start.js）。
// 用法：node scripts/build-portable.js   （或 npm run portable）
// 校验：打包前后都做完整性检查 —— 暂存目录里生成数据库并核对种子数量、内置 node.exe 可执行且版本达标、
//       zip 条目数与暂存文件数一致。任何一步不过就中止，不产出可疑的 zip。
// 注意：fs.cpSync 在 Windows 上目标路径含中文时会静默失败（不复制也不报错），
//       所以先复制到 ASCII 临时目录、压缩前再改名（rename 是单次系统调用，无此问题）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE_ASCII = path.join(DIST, 'portable-stage');   // 复制 / 建库用 ASCII 临时目录
const STAGE_NAME = '预实验便携包';
const STAGE = path.join(DIST, STAGE_NAME);
const ZIP_PATH = path.join(DIST, `${STAGE_NAME}.zip`);
// 旧版曾产出「-精简版.zip」「-精简版-不含node.zip」两个变体：不含 node 的那个到了没装 Node 的电脑上
// 只能看到“找不到 Node.js”而用不了，是这轮问题的根源。打包时一并清掉，避免再被发出去。
const STALE_ARTIFACTS = ['预实验便携包-精简版.zip', '预实验便携包-精简版-不含node.zip'];

const COPY_FILES = ['server.js', 'db.js', 'seed-content.js', 'xlsx.js', 'package.json', '启动预实验.bat', '实验人员须知.txt'];
const COPY_DIRS = ['public', 'vendor'];
const COPY_NESTED = ['scripts/pilot-start.js'];

// 包内**不允许**出现的东西（开发脚手架 / 会清库或造数据的脚本 / 数据库副本残留）
const FORBIDDEN = [
  'design', 'documents', 'screenshots', '.tmp', '.git', '.zcode',
  'scripts/lib', 'scripts/reset-db.js', 'scripts/check-platform.js',
  'scripts/consistency-check.js', 'scripts/simulate-subjects.js', 'scripts/capture-shots.js',
  'data.db-wal', 'data.db-shm'
];

// 压缩后必须存在于 zip 中的关键文件（防止静默丢内容）
const MUST_HAVE_IN_ZIP = [
  'server.js',
  'db.js',
  'seed-content.js',
  'xlsx.js',
  'package.json',
  'node.exe',
  'data.db',
  '启动预实验.bat',
  '实验人员须知.txt',
  'scripts/pilot-start.js',
  'public/index.html',
  'public/connect.html',
  'public/chat.html',
  'public/admin.html',
  'public/assets/chat.js',
  'public/assets/richtext.js',
  'public/assets/admin.js',
  'vendor/qrcode.js'
];

function walkCount(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += walkCount(path.join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

function fail(message) {
  console.error(`[x] ${message}`);
  console.error(`    （暂存目录保留在 ${STAGE_ASCII}，请勿分发未通过校验的产物。）`);
  process.exit(1);
}

// 在暂存目录里生成一份干净数据库：借用 reset-db.js（删库 → 重新建表 → 灌种子），跑完即删。
// 这样产出的 data.db 永远来自当前代码里的种子内容，而不是某台机器上的历史库。
function buildCleanDb() {
  const seedScript = path.join(STAGE_ASCII, 'scripts', 'reset-db.js');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'reset-db.js'), seedScript);
  const r = spawnSync(process.execPath, [seedScript], { cwd: STAGE_ASCII, encoding: 'utf8' });
  fs.rmSync(seedScript, { force: true });
  if (r.status !== 0) fail(`生成干净数据库失败：${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  const summary = String(r.stdout || '').trim().split(/\r?\n/).slice(0, 4).join(' / ');
  console.log(`  · 已生成干净数据库：${summary}`);

  // 收起 -wal：把库 VACUUM 成单文件（否则 zip 里会多出 data.db-wal，解压后首次启动还会改库），
  // 并顺手数一遍种子数量，确保发出去的库里确实有模板、有预设问卷、没有会话数据。
  const dbFile = path.join(STAGE_ASCII, 'data.db');
  const cleanFile = path.join(STAGE_ASCII, 'data.clean.db');
  const checkScript = path.join(STAGE_ASCII, '__dbcheck.js');
  // SQLite 的字符串字面量用单引号（双引号会被当成标识符）；Windows 路径统一转成 / 免转义
  const vacuumSql = `VACUUM INTO '${cleanFile.replace(/\\/g, '/')}'`;
  fs.writeFileSync(checkScript, `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(dbFile)});
    const n = (t) => db.prepare('SELECT COUNT(*) c FROM "' + t + '"').get().c;
    const counts = { exp: n('experiments'), q: n('questionnaires'), users: n('users'), sessions: n('sessions'), responses: n('responses') };
    db.exec(${JSON.stringify(vacuumSql)});
    db.close();
    process.stdout.write(JSON.stringify(counts));
  `, 'utf8');
  const check = spawnSync(process.execPath, [checkScript], { encoding: 'utf8' });
  fs.rmSync(checkScript, { force: true });
  if (check.status !== 0) fail(`数据库自检失败：${String(check.stderr || '').trim().slice(0, 300)}`);
  let counts = {};
  try { counts = JSON.parse(String(check.stdout).trim()); } catch { fail(`数据库自检输出无法解析：${String(check.stdout).slice(0, 200)}`); }
  if (counts.sessions !== 0 || counts.responses !== 0) fail(`干净数据库里还有会话数据（sessions=${counts.sessions}）—— 种子流程不对，中止打包。`);
  if (counts.users !== 1) fail(`干净数据库应只有 1 个账号（admin），实际 ${counts.users} 个。`);
  if (!(counts.exp >= 2 && counts.q >= 2)) fail(`干净数据库缺少种子内容（实验模板 ${counts.exp} 个 / 问卷 ${counts.q} 份）。`);
  fs.rmSync(dbFile, { force: true });
  fs.renameSync(cleanFile, dbFile);
  console.log(`  · 库自检：实验模板 ${counts.exp} 个 / 预设问卷 ${counts.q} 份 / 账号 ${counts.users} 个 / 会话 ${counts.sessions} 份`);
}

// 内置运行时的体检：能跑、版本达标（node:sqlite 需要 ≥ 22.13）
function verifyBundledNode() {
  const nodeExe = path.join(STAGE_ASCII, 'node.exe');
  const r = spawnSync(nodeExe, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0 || !/^v\d/.test(String(r.stdout || '').trim())) fail('内置 node.exe 无法执行（复制不完整？）。');
  const version = String(r.stdout).trim();
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) fail(`内置 node.exe 版本过旧（${version}）：node:sqlite 需要 ≥ 22.13.0。`);
  console.log(`  · 内置运行时：node.exe ${version}`);
}

function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`[x] 当前 Node ${process.versions.node} 过旧：node:sqlite 需要 ≥ 22.13.0，请升级后重新打包。`);
    process.exit(1);
  }

  fs.rmSync(STAGE_ASCII, { recursive: true, force: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(STAGE_ASCII, { recursive: true });
  for (const stale of STALE_ARTIFACTS) {
    const p = path.join(DIST, stale);
    if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); console.log(`  · 已移除旧变体：dist/${stale}`); }
  }

  for (const rel of COPY_FILES) fs.copyFileSync(path.join(ROOT, rel), path.join(STAGE_ASCII, rel));
  for (const dir of COPY_DIRS) fs.cpSync(path.join(ROOT, dir), path.join(STAGE_ASCII, dir), { recursive: true });
  for (const rel of COPY_NESTED) {
    const dest = path.join(STAGE_ASCII, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }
  console.log(`  · 已复制运行必需文件（${COPY_FILES.length} 个文件 + ${COPY_DIRS.join(' / ')} + ${COPY_NESTED.length} 个脚本）`);

  buildCleanDb();

  // 捆绑当前 Node 运行时（与开发 / 自检同版本）——没装 Node 的电脑靠它才能双击即用
  fs.copyFileSync(process.execPath, path.join(STAGE_ASCII, 'node.exe'));
  verifyBundledNode();

  // 改成中文包名（rename 为单次 Move 调用，不受 cpSync 的中文路径 bug 影响）
  fs.renameSync(STAGE_ASCII, STAGE);

  // 压缩前校验 staging 完整性
  const stageFiles = walkCount(STAGE);
  for (const rel of MUST_HAVE_IN_ZIP) {
    if (!fs.existsSync(path.join(STAGE, rel))) fail(`staging 缺少 ${rel}，中止打包。`);
  }
  for (const banned of FORBIDDEN) {
    if (fs.existsSync(path.join(STAGE, banned))) fail(`staging 混入了 ${banned}（不应分发），中止打包。`);
  }
  console.log(`  · staging 完整：${stageFiles} 个文件`);

  // 用 Windows 自带 PowerShell 压缩（经 UTF-8 BOM 的 ps1 文件传递中文路径，避免编码问题）
  const ps1 = path.join(DIST, '.zip.ps1');
  fs.writeFileSync(
    ps1,
    `\uFEFFCompress-Archive -Path '${STAGE}' -DestinationPath '${ZIP_PATH}' -Force; ` +
    `if ($?) { Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `$z = [IO.Compression.ZipFile]::OpenRead('${ZIP_PATH}'); Write-Output $z.Entries.Count; $z.Dispose() }\n`,
    'utf8'
  );
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8' });
  fs.rmSync(ps1, { force: true });
  if (r.status !== 0) {
    console.error('[x] 压缩失败（需要 Windows PowerShell 5.0+）。staging 目录保留在 dist/预实验便携包/，可手动压缩。');
    process.exit(1);
  }

  // 压缩后校验：zip 条目数必须等于 staging 文件数（防止静默丢文件）
  const zipEntries = Number(String(r.stdout).trim().split(/\r?\n/).filter(Boolean).pop());
  if (zipEntries !== stageFiles) {
    console.error(`[x] zip 条目数（${zipEntries}）与 staging 文件数（${stageFiles}）不符，产物不可信，已中止。`);
    console.error('    staging 保留在 dist/预实验便携包/，请勿分发该 zip。');
    process.exit(1);
  }
  fs.rmSync(STAGE, { recursive: true, force: true });

  const sizeMb = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1);
  console.log('');
  console.log(`OK: dist/${STAGE_NAME}.zip（${sizeMb} MB，${zipEntries} 个文件，内置 node.exe + 干净数据库，完整性校验通过）`);
  console.log('把这个 zip 发给实验人员即可：对方解压后双击「启动预实验.bat」，无需安装 Node 或任何其他软件。');
}

main();
