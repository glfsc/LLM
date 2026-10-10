// 组别内容同步（可重复执行、幂等）：把线上的两份预设问卷与两个实验模板，重建为
// seed-content.js + db.js 里那份「种子内容」——
//   · 组别3 / 组别4 的题目**只差「任务要求」两处**（组别操纵：详细版 vs 极简版）
//   · 模板 = 各自问卷的题目区（不含知情同意页与结束说明页——它们是问卷自带的默认头尾）
//   · 排版（正文小四 16px、小节标题四号 19px）与参数（思考时长 20 秒等）由 db.js 的构造统一给出
//   · 线上手工插入过的题目 id 走 db.js 的 LIVE_ITEM_ID_ALIASES 原样保留（既有会话的作答仍对得上号）
//
// 直接读写 data.db（走 db.js 的归一化，与在管理界面里改是同一条路），不需要先启动服务；
// 但**服务端要重启一次**新代码才生效（db.js / server.js 是进程启动时加载的）。
//
// 用法：
//   node scripts/sync-group-content.js              # 只预览，不写库（默认）
//   node scripts/sync-group-content.js --apply      # 先备份 data.db 到 .tmp/，再写入并复核
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('../db.js');
const SEED = require('../seed-content');
const RT = require('../public/assets/richtext.js');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'data.db');

const suffixOf = (id) => String(id).replace(/^group[34]-(?:high|low)-clarity__/, '');
const brief = (it) => `${it.type}:${suffixOf(it.id)}`;

// 逐题差异（位置对应）：返回 ['#3 正文文案', ...] 这样的短句
function diffItems(oldItems, newItems) {
  const out = [];
  const n = Math.max(oldItems.length, newItems.length);
  for (let i = 0; i < n; i += 1) {
    const a = oldItems[i];
    const b = newItems[i];
    if (!a || !b) { out.push(`#${i + 1} ${a ? '删除 ' + brief(a) : '新增 ' + brief(b)}`); continue; }
    const fields = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (k === 'text') continue;                            // text 由 html 推导
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) fields.push(k);
    }
    if (RT.htmlToText(a.html || '') !== RT.htmlToText(b.html || '')) fields.push('正文文案');
    else if ((a.html || '') !== (b.html || '')) fields.push('正文排版');
    if (fields.length) out.push(`#${i + 1} ${brief(b)} → 变化字段：${fields.join(', ')}`);
  }
  return out;
}

function main() {
  const qList = store.listQuestionnaires();
  const eList = store.listExperiments();
  const findQ = (re) => qList.find((q) => re.test(q.title));
  const findE = (re) => eList.find((e) => re.test(e.name));
  const q3 = findQ(/组别3/);
  const q4 = findQ(/组别4/);
  const e3 = findE(/组别3/);
  const e4 = findE(/组别4/);
  if (!q3 || !q4 || !e3 || !e4) throw new Error('找不到组别3 / 组别4 的预设问卷或实验模板');

  const fullQ = (id) => store.getQuestionnairePayload(id);
  const fullE = (id) => store.getExperimentPayload(id);
  const [liveQ3, liveQ4, liveE3, liveE4] = [fullQ(q3.id), fullQ(q4.id), fullE(e3.id), fullE(e4.id)];

  // 期望内容：完全由种子构造（模板 → 问卷 = 模板 + 知情同意页 + 结束说明页）
  const template3 = store.normalizeItems(store.experimentItems(SEED.REQUIRE_HIGH));
  const template4 = store.normalizeItems(store.experimentItems(SEED.REQUIRE_LOW));
  const wantQ3 = store.normalizeItems(store.presetQuestionnaireItems({ id: e3.id, name: e3.name, items: template3 }));
  const wantQ4 = store.normalizeItems(store.presetQuestionnaireItems({ id: e4.id, name: e4.name, items: template4 }));
  const wantE3 = store.normalizeItems(template3);
  const wantE4 = store.normalizeItems(template4);

  const show = (label, oldItems, newItems) => {
    const diffs = diffItems(oldItems, newItems);
    console.log(`\n【${label}】${oldItems.length} 题 → ${newItems.length} 题；差异 ${diffs.length} 处`);
    diffs.slice(0, 24).forEach((d) => console.log('   ' + d));
    if (diffs.length > 24) console.log(`   … 其余 ${diffs.length - 24} 处`);
    const idMap = oldItems
      .map((a, i) => (newItems[i] && a.id !== newItems[i].id ? `${a.id} → ${newItems[i].id}` : null))
      .filter(Boolean);
    if (idMap.length) console.log('   id 变化：' + idMap.join('；'));
  };
  show('组别3 问卷', liveQ3.items, wantQ3);
  show('组别4 问卷', liveQ4.items, wantQ4);
  show('组别3 模板', liveE3.items, wantE3);
  show('组别4 模板', liveE4.items, wantE4);

  // 自检：两组只差任务要求；两组问卷同构
  const clone = (items) => items.map((it) => {
    const o = JSON.parse(JSON.stringify(it));
    delete o.html; delete o.text; delete o.id; delete o.fromTemplateId; delete o.fromTemplateName;
    return o;
  });
  const sameExceptText = JSON.stringify(clone(wantQ3)) === JSON.stringify(clone(wantQ4));
  const textDiffIds = wantQ3
    .filter((it, i) => RT.htmlToText(it.html || '') !== RT.htmlToText((wantQ4[i] || {}).html || ''))
    .map((it) => suffixOf(it.id));
  const onlyTaskReq = textDiffIds.every((id) => /task_req/.test(id)) && textDiffIds.length === 2;
  const aliasesOk = Object.entries(store.LIVE_ITEM_ID_ALIASES).every(([, liveId]) =>
    wantQ3.some((it) => it.id === liveId) && wantQ4.some((it) => it.id === liveId));
  console.log(`\n自检：除任务要求外两组逐字段一致 ${sameExceptText ? '✔' : '✘'}；文案不同的题目恰为 ${JSON.stringify(textDiffIds)}`
    + `${onlyTaskReq ? ' ✔' : ' ✘'}；线上 id 别名已套用 ${aliasesOk ? '✔' : '✘'}`);
  if (!sameExceptText || !onlyTaskReq || !aliasesOk) throw new Error('自检不通过，已中止');

  if (!APPLY) {
    console.log('\n（dry-run：只预览。确认无误后执行：node scripts/sync-group-content.js --apply）');
    return;
  }

  // 备份 → 写入 → 复核
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(__dirname, '..', '.tmp', `backup-${stamp}.db`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(DB_PATH, backup);
  console.log(`\n已备份：${path.relative(process.cwd(), backup)}`);

  store.updateQuestionnaire(q3.id, { title: liveQ3.title, items: wantQ3 });
  store.updateQuestionnaire(q4.id, { title: liveQ4.title, items: wantQ4 });
  store.updateExperiment(e3.id, { name: liveE3.name, items: wantE3 });
  store.updateExperiment(e4.id, { name: liveE4.name, items: wantE4 });
  console.log('已写入：两份预设问卷 + 两个实验模板');

  // 复核：逐字段与期望内容比对（服务端已做过一次归一化，这里是最终落库的样子）
  const check = (label, got, want) => {
    const bad = [];
    if (got.length !== want.length) bad.push(`题数 ${got.length} ≠ ${want.length}`);
    for (let i = 0; i < Math.min(got.length, want.length); i += 1) {
      const a = got[i];
      const b = want[i];
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) bad.push(`#${i + 1} ${brief(b)}.${k}`);
      }
    }
    console.log(`复核 ${label}：${bad.length ? '✘ ' + bad.slice(0, 6).join('；') : '✔ 与种子逐字段一致'}`);
    return bad.length === 0;
  };
  const okAll = [
    check('组别3 问卷', fullQ(q3.id).items, wantQ3),
    check('组别4 问卷', fullQ(q4.id).items, wantQ4),
    check('组别3 模板', fullE(e3.id).items, wantE3),
    check('组别4 模板', fullE(e4.id).items, wantE4)
  ].every(Boolean);
  if (!okAll) throw new Error('复核不通过：落库内容与种子不一致');
  console.log('\n✅ 完成：预设问卷与实验模板已与 seed-content.js / db.js 的种子内容一致');
}

try { main(); } catch (err) { console.error('同步失败：', err.message); process.exit(1); }
