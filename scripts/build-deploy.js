// 打包「上线包」：dist/上线包.zip —— 发到公网服务器覆盖更新用。
// 与「预实验便携包」的区别只有两点：
//   ① 不带 node.exe：服务器上自己装着 Node（要求 ≥ 22.13.0，node:sqlite 的硬性下限）；
//   ② 不带 data.db：服务器上的库原样保留 —— 新代码第一次启动会自动补齐旧库缺的表与列
//      （db.js 里 CREATE TABLE IF NOT EXISTS + ensureColumn，注释写着「旧库补齐」），
//      所以覆盖代码既不会丢数据，也不需要重建库。
// 产物形态：zip 内是「站点目录直接一层」，**没有外层文件夹** —— 上传到站点根目录解压即可原地覆盖。
// 用法：node scripts/build-deploy.js   （或 npm run deploy）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
// 暂存目录必须走 ASCII 路径：fs.cpSync 在 Windows 上目标路径含中文时会静默失败（不复制也不报错）
const STAGE = path.join(DIST, 'deploy-stage');
const ZIP_PATH = path.join(DIST, '上线包.zip');

const FILES = ['server.js', 'db.js', 'seed-content.js', 'xlsx.js', 'package.json', 'README.md', 'DEPLOY.md'];
const DIRS = ['public', 'vendor'];
// 唯一带上的脚本：内容同步（幂等、会先备份）。线上库里存的题目是「创建时的快照」，
// 升级后参数/文案对不上时用它把两份预设问卷与模板更新成当前种子（问卷 id 不变，二维码不受影响）。
const NESTED = ['scripts/sync-group-content.js'];

// 压缩后必须存在：少一个都会让线上白屏或起不来（db.js 还依赖 public/assets/richtext.js）
const MUST_HAVE = [
  'server.js', 'db.js', 'seed-content.js', 'xlsx.js', 'package.json',
  'public/admin.html', 'public/chat.html',
  'public/assets/admin.js', 'public/assets/admin.css',
  'public/assets/chat.js', 'public/assets/chat.css', 'public/assets/richtext.js',
  'vendor/qrcode.js', 'scripts/sync-group-content.js'
];

// 绝不该混进上线包的东西：数据库与它的伴生文件、运行时、开发脚手架、会造数据/清库的脚本
// （scripts/ 里只放内容同步那一个脚本，其余一律点名禁止）
const FORBIDDEN = [
  'data.db', 'data.db-wal', 'data.db-shm', 'node.exe',
  '.git', '.zcode', '.tmp', 'design', 'documents', 'screenshots',
  'scripts/lib', 'scripts/reset-db.js', 'scripts/seed-presets.js', 'scripts/seed-thinking.js',
  'scripts/check-platform.js', 'scripts/consistency-check.js', 'scripts/simulate-subjects.js',
  'scripts/load-probe.js', 'scripts/capture-shots.js', 'scripts/build-portable.js', 'scripts/build-deploy.js',
  '启动预实验.bat', '实验人员须知.txt'
];

function listFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function fail(message) {
  console.error(`[x] ${message}`);
  console.error(`    （暂存目录保留在 ${STAGE}，请勿分发未通过校验的产物。）`);
  process.exit(1);
}

/* ---------------------------------------------------------------- zip 写入
   自己写 zip 只为了一件 Compress-Archive 做不到的事：条目名用正斜杠。
   Windows PowerShell 5.1 的 Compress-Archive 会把分隔符写成反斜杠，资源管理器能认，
   但面板那类（Python 实现的）解压器会解出名为「public\admin.html」的单文件 —— 静默坏包。 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// DOS 时间（zip 用）：秒要除以 2，年份从 1980 起算
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function writeZip(entries, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data, mtime } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const { time, date } = dosDateTime(mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // flag: 文件名 UTF-8
    local.writeUInt16LE(8, 8);               // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // extra len
    chunks.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);                 // version made by
    cd.writeUInt16LE(20, 6);                 // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0x81a40000, 38);        // 外部属性：普通文件 0644
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(outPath, Buffer.concat([...chunks, cdBuf, eocd]));
}

// 回读校验用：从中央目录里把条目名读出来
function readZipNames(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdAt = i; break; }
  }
  if (eocdAt < 0) fail('产物不是可识别的 zip（找不到中央目录结尾），已中止。');
  const count = buf.readUInt16LE(eocdAt + 10);
  let p = buf.readUInt32LE(eocdAt + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) fail('zip 中央目录损坏，已中止。');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`[x] 当前 Node ${process.versions.node} 过旧：node:sqlite 需要 ≥ 22.13.0，请升级后重新打包。`);
    process.exit(1);
  }

  fs.mkdirSync(DIST, { recursive: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  for (const rel of FILES) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) fail(`缺少 ${rel}，中止打包。`);
    fs.copyFileSync(src, path.join(STAGE, rel));
  }
  for (const dir of DIRS) {
    const src = path.join(ROOT, dir);
    if (!fs.existsSync(src)) fail(`缺少 ${dir}/ 目录，中止打包。`);
    fs.cpSync(src, path.join(STAGE, dir), { recursive: true });
  }
  for (const rel of NESTED) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) fail(`缺少 ${rel}，中止打包。`);
    fs.mkdirSync(path.dirname(path.join(STAGE, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(STAGE, rel));
  }

  for (const rel of MUST_HAVE) {
    if (!fs.existsSync(path.join(STAGE, rel))) fail(`staging 缺少 ${rel}，中止打包。`);
  }
  for (const banned of FORBIDDEN) {
    if (fs.existsSync(path.join(STAGE, banned))) fail(`staging 混入了 ${banned}（不应分发），中止打包。`);
  }
  const rels = listFiles(STAGE);
  console.log(`  · 已复制：${FILES.length} 个文件 + ${DIRS.join(' / ')}/（共 ${rels.length} 个文件，不含 node.exe / data.db）`);

  const entries = rels.map((rel) => ({
    name: rel,                                   // 正斜杠；listFiles 已经用 / 拼
    data: fs.readFileSync(path.join(STAGE, rel)),
    mtime: fs.statSync(path.join(STAGE, rel)).mtime
  }));
  writeZip(entries, ZIP_PATH);

  const names = readZipNames(ZIP_PATH);
  if (names.length !== rels.length) fail(`zip 条目数（${names.length}）与 staging 文件数（${rels.length}）不符，产物不可信，已中止。`);
  if (names.some((n) => n.includes('\\'))) fail('zip 条目名里出现了反斜杠（解压会多出怪文件名），产物不可用。');
  if (!names.includes('server.js')) fail('zip 里 server.js 不在根目录（解压会多出一层文件夹），产物不可用。');
  for (const rel of MUST_HAVE) {
    if (!names.includes(rel)) fail(`zip 里缺 ${rel}，产物不可用。`);
  }
  fs.rmSync(STAGE, { recursive: true, force: true });

  const sizeKb = Math.round(fs.statSync(ZIP_PATH).size / 1024);
  console.log('');
  console.log(`OK: dist/上线包.zip（${sizeKb} KB，${names.length} 个文件，正斜杠路径 + 完整性校验通过）`);
  console.log('用法：上传到站点根目录解压（原地覆盖），再重启服务器上的 Node 进程。');
  console.log('data.db 保持原样，新代码启动时会自动补齐旧库缺的表与列。');
}

main();
