// 预览页走查 v6.1：验证 9 种题型 / 默认展开 / 折叠 / 拖拽排序 / 计时勾选 / 试填 / 插入模板
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 9452;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FILE = 'file:///' + path.join(__dirname, '..', 'design', 'admin-v6-mockup.html').replace(/\\/g, '/');
const OUT = path.join(__dirname, '..', 'design', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fails.push(name + (detail ? ' —— ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' —— ' + detail : '')); }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), `mock2-${Date.now()}`)}`,
    '--window-size=1440,1000', '--hide-scrollbars', '--no-first-run', '--allow-file-access-from-files',
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: 'PUT' });
      if (res.ok) target = await res.json();
    } catch { /* 等待 */ }
  }
  if (!target) throw new Error('无可用 target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true });
  });

  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[EXC] ' + ((d.exception && d.exception.description) || d.text));
    }
  });

  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === myId) { ws.removeEventListener('message', h); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => reject(new Error('超时 ' + method)), 25000);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };
  let n = 0;
  const shot = async (name) => {
    n += 1;
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${String(n).padStart(2, '0')}-${name}.png`), Buffer.from(data, 'base64'));
  };

  await send('Page.navigate', { url: FILE });
  await sleep(1500);

  console.log('\n[1] 题型解耦：只有 9 种，无「量表」「创作」专用题型');
  const types = await evalJs(`JSON.stringify(Object.keys(TYPE))`);
  check('题型清单为 8 种', JSON.parse(types).length === 8, types);
  check('不含 scale / creation / qa（填空与问答已合并为文本题）', !/scale|creation|qa/.test(types), types);

  console.log('\n[2] 实验编辑页：题目默认全部展开');
  await evalJs(`openExp('group3-high-clarity')`);
  await sleep(700);
  check('题卡数 = 37（量表已展开为逐题）', await evalJs(`document.querySelectorAll('.qcard').length`) === 37,
    String(await evalJs(`document.querySelectorAll('.qcard').length`)));
  check('默认无折叠（.qcard 全部带 qbody）', await evalJs(`document.querySelectorAll('.qcard .qbody').length`) === 37,
    String(await evalJs(`document.querySelectorAll('.qcard .qbody').length`)));
  check('题目区可拖动手柄存在', await evalJs(`document.querySelectorAll('.qcard .drag').length`) === 37);
  check('计时默认值全为 0', await evalJs(`JSON.stringify(state.editingExp.timing)`) === JSON.stringify({ delay: 0, wait: 0, minSubmit: 0, maxAnswer: 0 }));
  await shot('exp-editor-expanded');

  console.log('\n[3] 折叠：点击「折叠」才收起，点题卡即展开');
  await evalJs(`(() => { const b=[...document.querySelectorAll('.qcard .mini-btn')].find(x=>x.textContent==='折叠'); b.click(); return 'ok'; })()`);
  await sleep(400);
  check('折叠后该题只剩摘要行', await evalJs(`document.querySelectorAll('.qcard .qbody').length`) === 36,
    String(await evalJs(`document.querySelectorAll('.qcard .qbody').length`)));
  await evalJs(`(() => { const c=document.querySelectorAll('.qcard')[0]; c.querySelector('.qcard-head').click(); return 'ok'; })()`);
  await sleep(400);
  check('点题卡后自动展开', await evalJs(`document.querySelectorAll('.qcard .qbody').length`) === 37);
  await shot('exp-editor-collapsed');

  console.log('\n[4] 计时按题勾选（题目优先，未勾选用全局默认）');
  const lim = await evalJs(`(() => {
    const cards=[...document.querySelectorAll('.qcard')];
    const ad=cards.find(c=>/^广告语$/.test(c.querySelector('.qtitle').textContent));
    const boxes=[...ad.querySelectorAll('.limits .limit-row')];
    return JSON.stringify(boxes.map(b=>({ label:b.querySelector('span').textContent, checked:b.querySelector('input[type=checkbox]').checked, val:b.querySelector('input[type=number]').value, disabled:b.querySelector('input[type=number]').disabled })));
  })()`);
  check('广告语：最短提交与最长作答已勾选，强制等待未勾选且禁用',
    /"checked":true/.test(lim) && /"val":"180"/.test(lim) && /"val":"300"/.test(lim) && /"checked":false/.test(lim) && /"disabled":true/.test(lim), lim);
  const fb = await evalJs(`(() => {
    const c=[...document.querySelectorAll('.qcard')].find(x=>/负面反馈/.test(x.querySelector('.qtitle').textContent));
    return JSON.stringify([...c.querySelectorAll('.limits .limit-row')].map(b=>({ checked:b.querySelector('input[type=checkbox]').checked, val:b.querySelector('input[type=number]').value })));
  })()`);
  check('负面反馈勾选了「延迟发出 30」（仅 message 支持该限制）', /"checked":true/.test(fb) && /"val":"30"/.test(fb), fb);
  const att = await evalJs(`(() => {
    const c=[...document.querySelectorAll('.qcard')].find(x=>/注意力检测/.test(x.querySelector('.qtitle').textContent));
    const b=[...c.querySelectorAll('.limit-row')].find(x=>/强制等待/.test(x.textContent));
    return JSON.stringify({ checked:b.querySelector('input[type=checkbox]').checked, val:b.querySelector('input[type=number]').value });
  })()`);
  check('注意力检测勾选了「作答前强制等待 40」', /"checked":true/.test(att) && /"val":"40"/.test(att), att);
  const create = await evalJs(`(() => {
    const cards=[...document.querySelectorAll('.qcard')];
    const ad=cards.find(c=>/^广告语$/.test(c.querySelector('.qtitle').textContent));
    return JSON.stringify([...ad.querySelectorAll('.limits .limit-row input[type=number]')].map(i=>i.value));
  })()`);
  check('广告语含最短 180 / 最长 300 时间窗', /"180"/.test(create) && /"300"/.test(create), create);
  await shot('exp-editor-limits');

  console.log('\n[5] 拖拽排序');
  const before = await evalJs(`JSON.stringify(state.editingExp.items.slice(0,4).map(i=>i.title))`);
  await evalJs(`(() => { const l=state.editingExp.items; moveItem(l, l[3].id, l[0].id, false); renderExpEditor(); return 'ok'; })()`);
  await sleep(600);
  const after = await evalJs(`JSON.stringify(state.editingExp.items.slice(0,4).map(i=>i.title))`);
  check('moveItem 能把第 4 题拖到第 1 位', JSON.parse(after)[0] === JSON.parse(before)[3], before + ' → ' + after);
  await evalJs(`(() => { const l=state.editingExp.items; moveItem(l, l[0].id, l[3].id, true); renderExpEditor(); return 'ok'; })()`);
  await sleep(500);
  check('拖回后顺序还原', await evalJs(`JSON.stringify(state.editingExp.items.slice(0,4).map(i=>i.title))`) === before);

  console.log('\n[6] 手机试填（从头走一遍，不落库）');
  await evalJs(`startTrial()`);
  await sleep(500);
  check('进入试填态（标签变化）', /试填中/.test(await evalJs(`document.getElementById('pv-tag').textContent`)));
  check('出现底部作答区', await evalJs(`!document.getElementById('pv-actions').classList.contains('hidden')`));
  const step = async () => { await evalJs(`(() => { const b=document.querySelector('#pv-actions .go:not(.disabled)'); if(b) b.click(); return 'ok'; })()`); await sleep(220); };
  for (let i = 0; i < 5; i += 1) await step();
  check('试填可连续推进并回显作答', await evalJs(`document.querySelectorAll('#pv-body .pv-msg.user').length`) > 0);
  await shot('trial');
  await evalJs(`exitTrial()`);
  await sleep(400);
  check('退出试填后恢复实时预览', /实时预览/.test(await evalJs(`document.getElementById('pv-tag').textContent`)));

  console.log('\n[7] 问卷：默认内容 + 插入实验模板 + 批量打分题');
  await evalJs(`(() => { state.questionnaires.unshift({ id:'demo1234', title:'新建示例问卷', timing:timing(), items:newQuestionnaireItems(), sessions:0, createdAt:'2026-10-06 16:30' }); openQ('demo1234'); return 'ok'; })()`);
  await sleep(700);
  check('新问卷默认 4 道（欢迎语/知情同意/结束语/结束说明）', await evalJs(`document.querySelectorAll('.qcard').length`) === 4);
  check('欢迎语与结束语默认为空（正文为空）', await evalJs(`(() => { const l=state.editingQ.items; return l[0].text==='' && l[2].text===''; })()`));
  await shot('q-editor-new');
  await evalJs(`(() => { const s=[...document.querySelectorAll('.add-row select')]; s[1].value='group3-high-clarity'; [...document.querySelectorAll('.add-row .mini-btn')].find(b=>/插入整组/.test(b.textContent)).click(); return 'ok'; })()`);
  await sleep(700);
  check('插入模板后题数 = 4 + 37 = 41', await evalJs(`document.querySelectorAll('.qcard').length`) === 41,
    String(await evalJs(`document.querySelectorAll('.qcard').length`)));
  check('带「来自模板」分组标识与整组删除', await evalJs(`/来自模板/.test(document.querySelector('.group-band').textContent) && /整组删除/.test(document.querySelector('.group-band').textContent)`));
  const pos = await evalJs(`(() => { const l=state.editingQ.items; return JSON.stringify({ first:l[0].title, second:l[1].type, third:l[2].title, last:l[l.length-1].type, secondLast:l[l.length-2].title }); })()`);
  check('插入位置正确（在开头页之后、收尾页之前）', /"first":"欢迎语"/.test(pos) && /"second":"gate"/.test(pos) && /"last":"debrief"/.test(pos) && /"secondLast":"结束语"/.test(pos), pos);
  await shot('q-editor-inserted');
  await evalJs(`(() => { const num=document.querySelector('.add-num'); num.value='3'; [...document.querySelectorAll('.add-row .mini-btn')].find(b=>/插入 N 道/.test(b.textContent)).click(); return 'ok'; })()`);
  await sleep(600);
  check('批量插入打分题 +3 → 44', await evalJs(`document.querySelectorAll('.qcard').length`) === 44,
    String(await evalJs(`document.querySelectorAll('.qcard').length`)));

  console.log('\n[9] 左侧栏复用为题目大纲');
  await evalJs(`openExp('group3-high-clarity')`);
  await sleep(700);
  check('进入编辑页默认切到大纲', await evalJs(`!document.getElementById('sidebar-outline').classList.contains('hidden')`));
  check('菜单项此时隐藏', await evalJs(`document.getElementById('sidebar-menu').classList.contains('hidden')`));
  const olCount = await evalJs(`document.querySelectorAll('#sidebar-outline .ol-item').length`);
  check('大纲题目条目数 = 37', olCount === 37, String(olCount));
  check('大纲含三个区块跳转', await evalJs(`document.querySelectorAll('#sidebar-outline .ol-sec').length`) === 3);
  check('大纲条目显示已启用的限制数量', await evalJs(`document.querySelectorAll('#sidebar-outline .ol-item .lm').length`) > 0);
  await shot('sidebar-outline');
  await evalJs(`document.querySelectorAll('#sidebar-outline .ol-item')[6].click()`);
  await sleep(500);
  check('点大纲即选中对应题卡并高亮', await evalJs(`!!document.querySelector('.qcard.selected') && document.querySelectorAll('#sidebar-outline .ol-item.on').length === 1`));
  const pair = await evalJs(`(() => {
    const ol = document.querySelectorAll('#sidebar-outline .ol-item')[6];
    const card = document.querySelector('.qcard.selected');
    return JSON.stringify({ ol: ol.querySelector('.tx').textContent, card: card.querySelector('.qtitle').textContent });
  })()`);
  check('点大纲条目后选中题卡与之一致', JSON.parse(pair).ol === JSON.parse(pair).card, pair);
  await evalJs(`setSidebarMode('menu')`);
  await sleep(300);
  check('可切回菜单（两个菜单项可见）', await evalJs(`!document.getElementById('sidebar-menu').classList.contains('hidden') && document.querySelectorAll('#sidebar-menu .sidebar-item').length === 2`));
  await evalJs(`setSidebarMode('outline')`);
  await sleep(300);
  check('可再切回大纲', await evalJs(`!document.getElementById('sidebar-outline').classList.contains('hidden')`));
  await evalJs(`(() => { const l=state.editingExp.items; moveItem(l, l[5].id, l[0].id, false); render(); return 'ok'; })()`);
  await sleep(500);
  const olFirst = await evalJs(`(() => JSON.stringify({ ol: document.querySelector('#sidebar-outline .ol-item .tx').textContent, moved: state.editingExp.items[0].title }))()`);
  check('拖动排序后大纲首条 = 被移动的题', JSON.parse(olFirst).ol === JSON.parse(olFirst).moved, olFirst);
  await evalJs(`(() => { const l=state.editingExp.items; moveItem(l, l[0].id, l[5].id, true); render(); return 'ok'; })()`);
  await sleep(400);

  console.log('\n[10] 文本题：输入框高度可配');
  const rows = await evalJs(`(() => {
    const l = state.editingExp.items;
    const ad = l.find((x) => x.title === '广告语');
    const note = l.filter((x) => /创作说明/.test(x.title))[0];
    return JSON.stringify({ ad: ad.rows, note: note.rows, type: ad.type });
  })()`);
  check('广告语 1 行、创作说明 2 行，类型同为文本题', /"ad":1/.test(rows) && /"note":2/.test(rows) && /"type":"text"/.test(rows), rows);
  check('文本题字段含「输入框高度」', await evalJs(`(() => { const c=[...document.querySelectorAll('.qcard')].find(x=>/^广告语$/.test(x.querySelector('.qtitle').textContent)); return /输入框高度/.test(c.textContent); })()`));
  check('手机预览按行数渲染高度', await evalJs(`(() => { const l=state.editingExp.items; const n=l.filter(x=>/创作说明/.test(x.title))[0]; state.selected=n.id; renderPhoneOnly(); return !!document.querySelector('#pv-body .pv-input[style]'); })()`));
  await shot('text-rows');

  console.log('\n[8] 共用时间窗提示');
  await evalJs(`(() => { const c=[...document.querySelectorAll('.qcard')].find(x=>/创作说明（选填）$/.test(x.querySelector('.qtitle').textContent)); c.querySelector('.qcard-head').click(); return 'ok'; })()`);
  await sleep(600);
  check('创作说明标注「与上一题共用同一个作答窗口」', /共用同一个作答窗口/.test(await evalJs(`document.getElementById('pv-body').textContent`)));
  await shot('q-editor-shared-window');

  console.log('\n--- 控制台异常 ---');
  console.log(logs.length ? logs.join('\n') : '（无）');

  console.log(`\n断言通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) { console.log('失败明细：'); for (const f of fails) console.log('  ✗ ' + f); }
  ws.close();
  browser.kill();
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error('走查失败:', e.message); process.exit(1); });
