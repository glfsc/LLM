// 零依赖 XLSX 生成器：多工作表、表头加粗、列宽、文本/数字单元格、字体与对齐
// 实现方式：手工组装 OOXML（SpreadsheetML）+ ZIP（zlib deflate 压缩存储）。
// 用法：const { buildXlsx } = require('./xlsx');
//   const buf = buildXlsx([{ name: 'Sheet1', columns: [{ title: '编号', width: 8 }], rows: [[1], ['文本']] }]);
//
// 样式（可选，不写就是原样：表头加粗、正文默认字体）：
//   sheet.header / column.style = { bold, font, size, align, valign, wrap }
//     font = 字体名（如 'Times New Roman'）；size = 字号（如 11）
//     align = 'left' | 'center'；valign 同理；wrap = true 时自动换行
//   sheet.headerRowHeight / sheet.rowHeight = 行高（磅）；表头常配 wrap 用高一点的表头行
//   同一份样式描述子在整本工作簿里去重后共用一个 cellXfs 序号。
'use strict';

const zlib = require('node:zlib');

/* ---------------------------------------------------------------- CRC32 与 ZIP */

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
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

// 极简 ZIP（deflate 压缩、UTF-8 文件名）
function zipSync(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = file.data;
    const compressed = zlib.deflateRawSync(data, { level: zlib.constants.Z_DEFAULT_COMPRESSION });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // UTF-8 文件名
    local.writeUInt16LE(8, 8);         // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ---------------------------------------------------------------- XML 组装 */

function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

// 1 → A、26 → Z、27 → AA
function colName(index) {
  let name = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function cellXml(ref, value, styleId) {
  if (value == null || value === '') return '';
  const s = styleId ? ` s="${styleId}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  const text = escapeXml(value);
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function rowXml(rowNumber, cells, styleIds, height) {
  const parts = [];
  (cells || []).forEach((value, i) => {
    const styleId = Array.isArray(styleIds) ? styleIds[i] : styleIds;
    const cell = cellXml(`${colName(i + 1)}${rowNumber}`, value, styleId);
    if (cell) parts.push(cell);
  });
  const ht = height ? ` ht="${height}" customHeight="1"` : '';
  return `<row r="${rowNumber}"${ht}>${parts.join('')}</row>`;
}

// 工作表名：去非法字符、限 31 字符、去重
function safeSheetName(name, used) {
  const base = String(name).replace(/[\[\]*?/\\:]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let final = base;
  let i = 2;
  while (used.has(final)) {
    const suffix = `-${i}`;
    final = base.slice(0, 31 - suffix.length) + suffix;
    i += 1;
  }
  used.add(final);
  return final;
}

function sheetXml(sheet, layout) {
  const cols = sheet.columns && sheet.columns.length
    ? `<cols>${sheet.columns
        .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`)
        .join('')}</cols>`
    : '';
  const rows = [rowXml(1, sheet.columns.map((c) => c.title), layout.headerId, sheet.headerRowHeight)];
  (sheet.rows || []).forEach((cells, i) =>
    rows.push(rowXml(i + 2, cells, layout.colIds, sheet.rowHeight)));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows.join('')}</sheetData></worksheet>`;
}

/* ---------------------------------------------------------------- 样式表 */
// 样式描述子 → 去重后的 cellXfs 序号（0 = 默认样式，其余从 1 开始）。
// 字体也一并去重：{ bold, font, size } 相同的共用一个 <font>。
const DEFAULT_HEADER_STYLE = { bold: true };

function styleKeyOf(s) {
  const d = s || {};
  return [d.bold ? 1 : 0, d.font || '', Number(d.size) || 0, d.align || '', d.valign || '', d.wrap ? 1 : 0].join('|');
}

function stylesXml(styles) {
  const fonts = [{ bold: false, name: '', size: 0 }];            // 0 = 默认字体
  const fontIdByKey = new Map([['', 0]]);
  const fontIdOf = (s) => {
    const key = `${s.bold ? 1 : 0}|${s.font || ''}|${Number(s.size) || 0}`;
    if (!fontIdByKey.has(key)) {
      fontIdByKey.set(key, fonts.length);
      fonts.push({ bold: !!s.bold, name: s.font || '', size: Number(s.size) || 0 });
    }
    return fontIdByKey.get(key);
  };

  const xfs = styles.map((s) => {
    const attrs = [];
    if (s.align) attrs.push(`horizontal="${s.align}"`);
    if (s.valign) attrs.push(`vertical="${s.valign}"`);
    if (s.wrap) attrs.push('wrapText="1"');
    const align = attrs.length ? `<alignment ${attrs.join(' ')}/>` : '';
    return { fontId: fontIdOf(s), align };
  });
  // 下标 0 = 默认样式（无样式描述子的单元格用它）
  xfs.unshift({ fontId: 0, align: '' });

  const fontsXml = fonts
    .map((f) => `<font>${[f.bold ? '<b/>' : '', f.size ? `<sz val="${f.size}"/>` : '',
      f.name ? `<name val="${escapeXml(f.name)}"/>` : ''].join('')}</font>`)
    .join('');
  const xfsXml = xfs
    .map((x) => `<xf fontId="${x.fontId}"${x.fontId ? ' applyFont="1"' : ''}`
      + `${x.align ? ' applyAlignment="1"' : ''}>${x.align}</xf>`)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${fonts.length}">${fontsXml}</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfsXml}</cellXfs>
</styleSheet>`;
}

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

function workbookXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets
    .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')}</sheets>
</workbook>`;
}

function workbookRelsXml(sheetCount) {
  const rels = [];
  for (let i = 1; i <= sheetCount; i += 1) {
    rels.push(
      `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`
    );
  }
  rels.push(
    `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
  );
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
}

function contentTypesXml(sheets) {
  const overrides = sheets
    .map(
      (s, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides}
</Types>`;
}

/* ---------------------------------------------------------------- 对外接口 */

// sheets: [{ name, columns: [{ title, width?, style? }], rows: [[cell, ...], ...],
//            header?, headerRowHeight?, rowHeight? }] → Buffer
function buildXlsx(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('至少需要一个工作表');
  const used = new Set();
  const safeSheets = sheets.map((s) => ({ ...s, name: safeSheetName(s.name, used) }));

  // 样式表：把各 sheet 用到的样式描述子去重成 cellXfs 序号（表头默认加粗，正文默认样式）
  const styles = [];
  const styleIdByKey = new Map();
  const styleIdOf = (s) => {
    if (!s) return 0;
    const key = styleKeyOf(s);
    if (!styleIdByKey.has(key)) {
      styleIdByKey.set(key, styles.length + 1);
      styles.push(s);
    }
    return styleIdByKey.get(key);
  };
  const layout = safeSheets.map((sheet) => ({
    headerId: styleIdOf(sheet.header === undefined ? DEFAULT_HEADER_STYLE : sheet.header),
    colIds: (sheet.columns || []).map((c) => styleIdOf(c.style))
  }));

  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml(safeSheets), 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(safeSheets), 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRelsXml(safeSheets.length), 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(stylesXml(styles), 'utf8') }
  ];
  safeSheets.forEach((sheet, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(sheet, layout[i]), 'utf8') });
  });
  return zipSync(files);
}

module.exports = { buildXlsx };
