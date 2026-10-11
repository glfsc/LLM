// 打包「局域网预实验便携包」：dist/预实验便携包.zip —— 唯一的分发件。
// 产物特征（缺一不可，实验人员电脑上不需要安装任何东西）：
//   ① 内置当前运行的 node.exe（与开发/自检同版本，规避兼容性）；解压后双击「启动预实验.bat」即可；
//   ② 内置一份**数据库快照**：当前 data.db 里的实验模板 / 问卷 / 账号原样带走（研究者准备什么就带走什么），
//      只清空被试数据（会话、作答、对话消息）——不给实验人员留下历史被试记录；
//   ③ 只带运行必需文件，不带 design/ documents/ screenshots/ .tmp/ .git 等开发脚手架，
//      也不带会清库的开发脚本（scripts/ 下只留启动器 pilot-start.js）。
// 用法：node scripts/build-portable.js   （或 npm run portable）
// 校验：打包前后都做完整性检查 —— 核对快照里「问卷/实验保留、被试数据清零」、内置 node.exe 可执行且版本达标、
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

// 从开发机的 data.db 导出打包用快照：实验模板 / 问卷 / 账号原样保留，只清空被试数据。
// 两个关键点：
//   ① 不能直接复制文件 —— data.db-wal 里往往还有未合并的近期写入，复制主库会漏掉它们，
//      所以走 SQLite 的 VACUUM INTO 导出（顺带把库压成单文件，包里不会多出 -wal/-shm）；
//   ② 源库以只读方式打开（只读连接同样支持 VACUUM INTO），保证打包动作不会改动开发机上的 data.db。
// 想发「从代码种子重建的库」时：先在开发机跑 npm run reset-db，再执行打包即可。
function buildSanitizedDb() {
  const { DatabaseSync } = require('node:sqlite');
  const liveDb = path.join(ROOT, 'data.db');
  if (!fs.existsSync(liveDb)) {
    fail('找不到 data.db：打包要带上一份含实验模板与问卷的库；请先准备好内容，或 npm run reset-db 用代码种子重建。');
  }
  const stageDb = path.join(STAGE_ASCII, 'data.db');
  const snapshot = path.join(STAGE_ASCII, 'data.snapshot.db');
  fs.rmSync(snapshot, { force: true });

  const count = (db, table) => db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get().c;
  const readCounts = (db) => ({
    exp: count(db, 'experiments'),
    q: count(db, 'questionnaires'),
    users: count(db, 'users'),
    sessions: count(db, 'sessions'),
    responses: count(db, 'responses'),
    messages: count(db, 'messages')
  });

  const src = new DatabaseSync(liveDb, { readOnly: true });
  let before;
  try {
    before = readCounts(src);
    src.exec(`VACUUM INTO '${snapshot.replace(/\\/g, '/')}'`);
  } finally {
    src.close();
  }
  if (before.exp < 1 || before.q < 1) {
    fail(`当前 data.db 里没有可发的实验内容（实验模板 ${before.exp} 个 / 问卷 ${before.q} 份），先准备好内容再打包。`);
  }

  const db = new DatabaseSync(snapshot);
  let after;
  try {
    db.exec(`
      BEGIN;
      DELETE FROM responses;
      DELETE FROM messages;
      DELETE FROM sessions;
      DELETE FROM sqlite_sequence WHERE name IN ('responses', 'messages');
      COMMIT;
    `);
    db.exec('VACUUM');
    after = readCounts(db);
  } finally {
    db.close();
  }
  if (after.sessions || after.responses || after.messages) {
    fail(`被试数据没清干净（会话 ${after.sessions} / 作答 ${after.responses} / 消息 ${after.messages}），中止打包。`);
  }
  if (after.exp !== before.exp || after.q !== before.q || after.users !== before.users) {
    fail('清空被试数据后，实验 / 问卷 / 账号的数量发生了变化，中止打包。');
  }
  fs.rmSync(stageDb, { force: true });
  fs.renameSync(snapshot, stageDb);
  console.log(`  · 库快照：实验模板 ${after.exp} 个 / 问卷 ${after.q} 份 / 账号 ${after.users} 个（原样保留）`);
  console.log(`  · 已清空被试数据：会话 ${before.sessions} 份 / 作答 ${before.responses} 条 / 对话消息 ${before.messages} 条`);
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

  buildSanitizedDb();

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
  console.log(`OK: dist/${STAGE_NAME}.zip（${sizeMb} MB，${zipEntries} 个文件，内置 node.exe + 保留问卷/实验并已清空被试数据的库，完整性校验通过）`);
  console.log('把这个 zip 发给实验人员即可：对方解压后双击「启动预实验.bat」，无需安装 Node 或任何其他软件。');
}

main();
