// 富文本工具：正文 HTML 的清洗、纯文本互转、Word 粘贴处理。
// 服务端保存时清洗一次，被试端渲染前再清洗一次——同一份实现，Node 与浏览器共用。
// 只允许「Word 常用格式」所需的最小标签/样式集合，其余一律降级为纯文本，避免脏 HTML 进入数据。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RichText = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 允许保留的标签（div / b / i / strike / font 等先归一化到这些名字）
  const ALLOWED = new Set([
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'u', 's', 'sub', 'sup',
    'ul', 'ol', 'li', 'blockquote', 'span', 'a'
  ]);
  const VOID = new Set(['br', 'hr']);
  // 连内容一起丢掉的容器
  const DROP_CONTENT = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'iframe', 'object', 'embed', 'svg', 'math', 'noscript', 'template', 'form', 'input', 'textarea', 'select', 'button']);
  // DROP_CONTENT 里没有结束标签的 void 标签（meta / link / input / embed，或源码里写 <xxx/> 自闭合的）：
  // 丢掉标签本身即可，不能让 skipTag 一直挂着 —— 否则它们后面的整段内容都会被当成「容器内部」而被吞掉。
  const VOID_DROP = new Set(['meta', 'link', 'input', 'embed']);
  // 块级标签：新开一个块时按种类自动闭合上一个（避免 <p> 套 <p>、<li> 把 <ul> 顶掉）
  const CLOSE_ON_START = new Map([
    ['p', ['p']],
    ['li', ['li']],
    ['ul', ['p', 'li']],
    ['ol', ['p', 'li']],
    ['blockquote', ['p']],
    ['hr', ['p']]
  ]);
  for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    CLOSE_ON_START.set(h, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p']);
  }
  const TAG_ALIAS = {
    div: 'p', section: 'p', article: 'p', header: 'p', footer: 'p', main: 'p', pre: 'p', center: 'p', figure: 'p', figcaption: 'p',
    b: 'strong', i: 'em', strike: 's', del: 's', ins: 'u', font: 'span', big: 'span', small: 'span', mark: 'span', tt: 'span',
    code: 'span', kbd: 'span', samp: 'span', var: 'span', label: 'span', nobr: 'span', abbr: 'span', cite: 'em', dfn: 'em', q: 'span'
  };
  const STYLE_PROPS = ['color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-align'];
  // 字号档位（Word 中文号数 ↔ px ↔ pt）：编辑器下拉、粘贴识别、吸附共用这一张表
  const BODY_FONT_PX = 14;                                                        // 「正文（默认）」字号
  const FONT_SIZE_PRESETS = [
    { px: 10, pt: 7.5, label: '六号' },
    { px: 12, pt: 9, label: '小五' },
    { px: 14, pt: 10.5, label: '五号' },
    { px: 16, pt: 12, label: '小四' },
    { px: 19, pt: 14, label: '四号' },
    { px: 20, pt: 15, label: '小三' },
    { px: 21, pt: 16, label: '三号' },
    { px: 24, pt: 18, label: '小二' },
    { px: 29, pt: 22, label: '二号' },
    { px: 35, pt: 26, label: '一号' },
    { px: 48, pt: 36, label: '小初' }
  ];
  // 把任意 px 归到最近的号数档位（幂等：snap(snap(x)) === snap(x)）
  function closestFontSize(px) {
    const n = Number(px);
    if (!Number.isFinite(n) || n <= 0) return null;
    let best = FONT_SIZE_PRESETS[0];
    let bestD = Infinity;
    for (const p of FONT_SIZE_PRESETS) {
      const d = Math.abs(p.px - n);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }
  function fontPresetOf(px) {
    const hit = closestFontSize(px);
    return hit ? { ...hit, exact: hit.px === Math.round(Number(px)) } : null;
  }
  // execCommand('fontSize') 的 1–7 档 → px（保存后就是固定字号，跨端一致）
  const FONT_SIZE_SCALE = { 1: 12, 2: 14, 3: 16, 4: 19, 5: 21, 6: 29, 7: 40 };   // 对齐 Word 号数：小五/五号/小四/四号/三号/二号
  const FONT_SIZE_KEYWORDS = { 'xx-small': 12, 'x-small': 14, small: 14, medium: 16, large: 19, 'x-large': 21, 'xx-large': 29 };

  function escapeText(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeText(s).replace(/"/g, '&quot;');
  }

  function safeStyleValue(prop, value) {
    const v = String(value || '').replace(/!\s*important/ig, '').trim();
    if (!v || /url\s*\(|expression\s*\(|javascript:|[\\<>]/i.test(v)) return '';
    if (prop === 'color' || prop === 'background-color') {
      if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(v)) return v;
      if (/^rgba?\(\s*[\d.\s,%]+\)$/i.test(v)) return v;
      if (/^hsla?\(\s*[\d.\s,%a-z]+\)$/i.test(v)) return v;
      if (/^[a-z]{3,20}$/i.test(v)) return v;                       // 具名颜色（transparent 等）
      return '';
    }
    if (prop === 'font-size') {
      const kw = FONT_SIZE_KEYWORDS[v.toLowerCase()];
      if (kw) return `${kw}px`;
      const m = /^(\d+(?:\.\d+)?)\s*(px|pt|em|rem|%)$/i.exec(v);
      if (!m) return '';
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      // 复制过来的字号一律折算成 px 并归到最近的号数档位：
      //   pt → px（×4/3）；em/rem/% 按「正文 14px」为基准折算；
      //   上下限 9–48px（以前上限是 44px，导致「小初 48px / 36pt」被压成 44px，识别不出来）
      let px = null;
      if (unit === 'pt') px = n * 4 / 3;
      else if (unit === 'px') px = n;
      else if (unit === '%') px = (n / 100) * BODY_FONT_PX;
      else px = n * BODY_FONT_PX;                                   // em / rem
      const clamped = Math.min(48, Math.max(9, Math.round(px)));
      const preset = closestFontSize(clamped);
      return `${preset ? preset.px : clamped}px`;
    }
    if (prop === 'font-weight') return /^(normal|bold|bolder|lighter|[1-9]00)$/i.test(v) ? v.toLowerCase() : '';
    if (prop === 'font-style') return /^(normal|italic|oblique)$/i.test(v) ? v.toLowerCase() : '';
    if (prop === 'text-decoration' || prop === 'text-decoration-line') {
      const parts = v.toLowerCase().split(/\s+/).filter((x) => ['none', 'underline', 'line-through', 'overline'].includes(x));
      return parts.join(' ');
    }
    if (prop === 'text-align') return /^(left|right|center|justify)$/i.test(v) ? v.toLowerCase() : '';
    return '';
  }

  function sanitizeStyle(raw) {
    const out = [];
    for (const part of String(raw || '').split(';')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const prop = part.slice(0, idx).trim().toLowerCase();
      if (!STYLE_PROPS.includes(prop)) continue;
      const safe = safeStyleValue(prop, part.slice(idx + 1));
      if (safe) out.push(`${prop}: ${safe}`);
    }
    return out.join('; ');
  }

  function parseAttrs(raw) {
    const out = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))|([a-zA-Z_:][-a-zA-Z0-9_:.]*)/g;
    let m;
    while ((m = re.exec(String(raw || ''))) !== null) {
      const name = (m[1] || m[6] || '').toLowerCase();
      if (!name) continue;
      out[name] = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : 'true';
    }
    return out;
  }

  // Word 的一级标题常写成 <p class=MsoHeading1> 或 style 里的 mso-outline-level
  function headingFrom(attrs) {
    const cls = String(attrs.class || '');
    const hit = /(?:Mso)?(?:Heading|Title)\s*([1-6])/i.exec(cls);
    if (hit) return `h${hit[1]}`;
    if (/MsoTitle/i.test(cls)) return 'h1';
    const lvl = /mso-outline-level\s*:\s*([1-6])/i.exec(String(attrs.style || ''));
    if (lvl) return `h${lvl[1]}`;
    return '';
  }

  // 清洗：白名单标签 + 白名单样式；不认识的标签只脱壳、保留里面的文字
  function sanitizeHtml(html) {
    const src = String(html == null ? '' : html);
    if (!src) return '';
    const out = [];
    const stack = [];
    let skipTag = null;                       // 正在丢弃内容的容器名
    const TAG_RE = /<!--[\s\S]*?-->|<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)\s*>|<\s*([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\s*\/?>/g;
    let last = 0;
    let m;

    // 栈里存 { tag, raw }：转换过的标签（如 MsoHeading1 的 <p> → <h1>）也能被 </p> 正确关上
    const closeTop = () => {
      const top = stack.pop();
      if (top && !VOID.has(top.tag)) out.push(`</${top.tag}>`);
    };
    const closeAll = (names) => {
      while (stack.length && names.has(stack[stack.length - 1].tag)) closeTop();
    };
    const push = (tag, raw) => stack.push({ tag, raw });

    const emitStart = (rawName, attrsRaw) => {
      const attrs = parseAttrs(attrsRaw);
      let name = TAG_ALIAS[rawName] || rawName;
      if (!ALLOWED.has(name)) return;                                  // 脱壳：标签丢掉，内容保留
      if (name === 'p' || name === 'span') {
        const head = headingFrom(attrs);
        if (head) name = head;
      }
      const toClose = CLOSE_ON_START.get(name);
      if (toClose) closeAll(new Set(toClose));
      if (VOID.has(name)) { out.push(name === 'br' ? '<br>' : '<hr>'); return; }

      const style = sanitizeStyle(attrs.style);
      if (name === 'a') {
        const href = String(attrs.href || '').trim();
        if (/^(https?:|mailto:)/i.test(href)) {
          out.push(`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">`);
          push('a', rawName);
          return;
        }
        return;                                                        // 非 http(s) 链接 → 脱壳
      }
      if (name === 'span') {
        // font 标签的 color/size 属性（旧数据、部分编辑器）也映射进来
        const extra = [];
        const color = safeStyleValue('color', attrs.color);
        if (color) extra.push(`color: ${color}`);
        const rawSize = FONT_SIZE_SCALE[String(attrs.size || '').trim()];
        if (rawSize) {
          const snapped = closestFontSize(rawSize);                     // 7 档（40px）吸附到一号 35px，保证二次清洗幂等
          extra.push(`font-size: ${snapped ? snapped.px : rawSize}px`);
        }
        const all = [style, extra.join('; ')].filter(Boolean).join('; ');
        if (!all) return;                                              // 空 span 直接省掉
        out.push(`<span style="${escapeAttr(all)}">`);
        push('span', rawName);
        return;
      }
      if (name === 'ul' || name === 'ol' || name === 'blockquote' || name === 'strong' || name === 'em' || name === 'u' || name === 's' || name === 'sub' || name === 'sup') {
        out.push(`<${name}>`);
        push(name, rawName);
        return;
      }
      // p / h1..h6
      out.push(style ? `<${name} style="${escapeAttr(style)}">` : `<${name}>`);
      push(name, rawName);
    };

    while ((m = TAG_RE.exec(src)) !== null) {
      const text = src.slice(last, m.index);
      last = TAG_RE.lastIndex;
      // 注意：这里不能用 continue 短路——文本与标签要各自处理，否则「文本后面的标签」会被整段跳过
      if (text && !skipTag) out.push(escapeText(text));
      if (m[0].startsWith('<!--')) continue;                            // 注释丢弃
      if (m[1]) {                                                       // 结束标签
        const rawName = m[1].toLowerCase();
        if (skipTag) { if (rawName === skipTag) skipTag = null; continue; }
        const name = TAG_ALIAS[rawName] || rawName;
        let at = -1;
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i].tag === name || stack[i].raw === rawName) { at = i; break; }
        }
        if (at >= 0) { while (stack.length > at) closeTop(); }
        continue;
      }
      const rawName = (m[2] || '').toLowerCase();
      if (!rawName || skipTag) continue;
      if (DROP_CONTENT.has(rawName)) {
        if (!VOID_DROP.has(rawName) && !/\/\s*>$/.test(m[0])) skipTag = rawName;
        continue;
      }
      emitStart(rawName, m[3] || '');
    }
    if (last < src.length && !skipTag) out.push(escapeText(src.slice(last)));
    while (stack.length) closeTop();
    return out.join('')
      .replace(/<p(?:\s[^>]*)?>(?:\s|<br>|&nbsp;)*<\/p>/gi, '')      // 空段落（Word 常留）
      .replace(/<span(?:\s[^>]*)?>\s*<\/span>/gi, '')
      .trim();
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', middot: '·', mdash: '—', ndash: '–', times: '×', copy: '©', reg: '®', deg: '°', plusmn: '±', bull: '•', laquo: '«', raquo: '»', sect: '§', para: '¶', dagger: '†', prime: '′', Prime: '″', euro: '€', pound: '£', yen: '¥', cent: '¢', frac12: '½', frac14: '¼', sup2: '²', sup3: '³', micro: 'µ' };
  function decodeEntities(s) {
    return String(s || '')
      .replace(/&#x([0-9a-f]+);/gi, (mm, hex) => {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      })
      .replace(/&#(\d+);/g, (mm, dec) => {
        const code = Number(dec);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      })
      .replace(/&([a-zA-Z]+);/g, (mm, name) => (ENTITIES[name] != null ? ENTITIES[name] : mm));
  }

  // 纯文本 ← HTML：块级标签当换行，便于列表/导出/自检里的「首行」语义继续成立
  function htmlToText(html) {
    let s = String(html == null ? '' : html);
    if (!s) return '';
    s = s.replace(/<\s*(br|hr)\s*\/?>/gi, '\n');
    s = s.replace(/<\s*\/\s*(p|div|h[1-6]|li|ul|ol|blockquote)\s*>/gi, '\n');
    s = s.replace(/<[^>]*>/g, '');
    s = decodeEntities(s);
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // 纯文本 → HTML：转义 + 换行保留（不再是 CSS pre-wrap 的依赖）
  function textToHtml(text) {
    const t = String(text == null ? '' : text);
    if (!t.trim()) return '';
    return `<p>${escapeText(t.trim()).replace(/\r?\n/g, '<br>')}</p>`;
  }

  // 纯文本 → HTML（分节材料用）：首段成 <p>，一、二、三… 这类小节标题成行用 <h3>（加粗），其余行用 <br>。
  // 问卷里「任务要求」这类带小节的材料统一走它，保证种子、后台保存、同步脚本三处呈现一致。
  function sectionedHtml(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let buf = [];
    const flushP = () => {
      if (!buf.length) return;
      out.push(`<p>${buf.join('<br>')}</p>`);
      buf = [];
    };
    for (const line of lines) {
      const t = line.trim();
      if (/^[一二三四五六七八九十]+、/.test(t)) {
        flushP();
        out.push(`<h3><span style="font-weight: bold">${escapeText(t)}</span></h3>`);
        continue;
      }
      if (!t) {                       // 空行 → 段落分隔
        if (buf.length) buf.push('');
        continue;
      }
      buf.push(escapeText(line));
    }
    flushP();
    return sanitizeHtml(out.join(''));
  }

  // Word / 网页粘贴：先按 MsoHeading 等特征映射标题，再走统一清洗
  function cleanWordPaste(html) {
    return sanitizeHtml(html);
  }

  // 粘贴的纯文本 → HTML（保换行）
  function plainPasteToHtml(text) {
    return textToHtml(text);
  }

  // 取正文首行作为大纲标题（去格式、去空白、截断）
  function firstLine(html, max = 60) {
    const text = htmlToText(html);
    const line = (text.split('\n').find((x) => x.trim()) || '').trim();
    return line.length > max ? `${line.slice(0, max)}…` : line;
  }

  return {
    sanitizeHtml,
    htmlToText,
    textToHtml,
    sectionedHtml,
    cleanWordPaste,
    plainPasteToHtml,
    firstLine,
    escapeText,
    FONT_SIZE_SCALE,
    FONT_SIZE_PRESETS,
    BODY_FONT_PX,
    closestFontSize,
    fontPresetOf
  };
});
