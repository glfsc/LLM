// 走查脚本公共：读取 xlsx（零依赖，自写 ZIP 中央目录解析 + inflate）
// 用于校验导出的 sheet 名与单元格内容，不引入第三方库。
'use strict';

const zlib = require('node:zlib');

// 从 zip 中取出某个条目并解压为字符串；找不到返回 ''
function unzipEntry(buf, name) {
  const target = Buffer.from(name, 'utf8');
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return '';
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    if (buf.slice(off + 46, off + 46 + nameLen).equals(target)) {
      const method = buf.readUInt16LE(localOff + 8);
      const csize = buf.readUInt32LE(localOff + 18);
      const lnameLen = buf.readUInt16LE(localOff + 26);
      const lextraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lnameLen + lextraLen;
      const data = buf.slice(start, start + csize);
      return method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data).toString('utf8');
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return '';
}

// 工作簿里的 sheet 名列表（按顺序）
function unzipSheetNames(buf) {
  return [...unzipEntry(buf, 'xl/workbook.xml').matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => m[1]);
}

module.exports = { unzipEntry, unzipSheetNames };
