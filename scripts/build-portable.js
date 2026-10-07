// 打包「局域网预实验便携包」：dist/预实验便携包.zip
// 产物内含当前运行所用的 node.exe，实验人员电脑无需安装 Node，
// 解压后双击「启动预实验.bat」即可（数据库首次启动自动初始化，不含任何旧数据）。
// 用法：node scripts/build-portable.js
// 注意：fs.cpSync 在 Windows 上目标路径含中文时会静默失败（不复制也不报错），
//       所以先复制到 ASCII 临时目录、压缩前再改名（rename 是单次系统调用，无此问题）；
//       压缩前后均做完整性校验，防止再出现静默丢文件。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE_ASCII = path.join(DIST, 'portable-stage'); // 复制用 ASCII 临时目录
const STAGE_NAME = '预实验便携包';
const STAGE = path.join(DIST, STAGE_NAME);
const ZIP_PATH = path.join(DIST, `${STAGE_NAME}.zip`);

const COPY_FILES = ['server.js', 'db.js', 'xlsx.js', 'package.json', '启动预实验.bat', '实验人员须知.txt'];
const COPY_DIRS = ['public', 'vendor'];
const COPY_NESTED = ['scripts/reset-db.js'];

// 压缩后必须存在于 zip 中的关键文件（防止静默丢内容）
const MUST_HAVE_IN_ZIP = [
  '预实验便携包/server.js',
  '预实验便携包/db.js',
  '预实验便携包/node.exe',
  '预实验便携包/启动预实验.bat',
  '预实验便携包/实验人员须知.txt',
  '预实验便携包/scripts/reset-db.js',
  '预实验便携包/public/index.html',
  '预实验便携包/public/chat.html',
  '预实验便携包/public/admin.html',
  '预实验便携包/public/assets/chat.js',
  '预实验便携包/vendor/qrcode.js'
];

function walkCount(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += walkCount(path.join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`[x] 当前 Node ${process.versions.node} 过旧：node:sqlite 需要 ≥ 22.13.0，请升级后重新打包。`);
    process.exit(1);
  }

  fs.rmSync(STAGE_ASCII, { recursive: true, force: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE_ASCII, { recursive: true });

  for (const rel of COPY_FILES) fs.copyFileSync(path.join(ROOT, rel), path.join(STAGE_ASCII, rel));
  for (const dir of COPY_DIRS) fs.cpSync(path.join(ROOT, dir), path.join(STAGE_ASCII, dir), { recursive: true });
  for (const rel of COPY_NESTED) {
    const dest = path.join(STAGE_ASCII, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }
  // 捆绑当前 Node 运行时（与开发/自检同版本，规避兼容性问题）
  fs.copyFileSync(process.execPath, path.join(STAGE_ASCII, 'node.exe'));

  // 改成中文包名（rename 为单次 Move 调用，不受 cpSync 的中文路径 bug 影响）
  fs.renameSync(STAGE_ASCII, STAGE);

  // 压缩前校验 staging 完整性
  const stageFiles = walkCount(STAGE);
  for (const rel of MUST_HAVE_IN_ZIP.map((p) => p.replace(`${STAGE_NAME}/`, ''))) {
    if (!fs.existsSync(path.join(STAGE, rel))) {
      console.error(`[x] staging 缺少 ${rel}，中止打包。`);
      process.exit(1);
    }
  }

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

  // 压缩后校验：zip 条目数必须等于 staging 文件数，且关键文件齐全
  const zipEntries = Number(String(r.stdout).trim().split(/\r?\n/).filter(Boolean).pop());
  if (zipEntries !== stageFiles) {
    console.error(`[x] zip 条目数（${zipEntries}）与 staging 文件数（${stageFiles}）不符，产物不可信，已中止。`);
    console.error('    staging 保留在 dist/预实验便携包/，请勿分发该 zip。');
    process.exit(1);
  }
  fs.rmSync(STAGE, { recursive: true, force: true });

  const sizeMb = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`OK: dist/预实验便携包.zip（${sizeMb} MB，${zipEntries} 个文件，完整性校验通过）`);
  console.log('把这个 zip 发给实验人员即可；对方解压后双击「启动预实验.bat」。');
}

main();
