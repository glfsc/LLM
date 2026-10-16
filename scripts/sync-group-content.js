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
// 与 db.js 同口径：默认项目根目录的 data.db，可用 DB_PATH 覆盖
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, '..', 'data.db');

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
  const template3 = store.normalizeItems(store.experimentItems(SEED.REQUIRE_HIGH, SEED.GROUP_VARIANTS.high));
  const template4 = store.normalizeItems(store.experimentItems(SEED.REQUIRE_LOW, SEED.GROUP_VARIANTS.low));
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

  // 自检：两组只差**两份 v4 文档里写明的组别操纵**，其余逐字段一致
  //   允许的差异（逐条对照两份文档）：
  //     · task_info       欢迎语：组别4 的文档没有「您目前就职于…」那段
  //     · task_req/_req2  任务要求：详细版（组别3）vs 极简版（组别4）
  //     · feedback_confirm 强制阅读负面反馈：30 秒（组别3）vs 40 秒（组别4）
  const ALLOWED_DIFF = {
    task_info: ['html', 'text'],
    task_req: ['html', 'text'],
    task_req2: ['html', 'text'],
    feedback_confirm: ['limits']
  };
  // 逻辑名：线上手工插入的题走 LIVE_ITEM_ID_ALIASES 保留了别名 id（如 feedback_confirm → newmv10z3u5），
  // 比对允许差异时要先把它换回逻辑名，否则查不到 ALLOWED_DIFF。
  const aliasToName = new Map(Object.entries(store.LIVE_ITEM_ID_ALIASES).map(([name, live]) => [live, name]));
  const logicalName = (id) => aliasToName.get(String(id)) || suffixOf(id);
  const violations = [];
  // id 与模板来源本来就按问卷各自生成，不参与组间比对
  const IGNORE_KEYS = new Set(['id', 'fromTemplateId', 'fromTemplateName']);
  for (let i = 0; i < Math.max(wantQ3.length, wantQ4.length); i += 1) {
    const a = wantQ3[i];
    const b = wantQ4[i];
    if (!a || !b) { violations.push(`#${i + 1} 只有一边有`); continue; }
    const allowed = ALLOWED_DIFF[logicalName(b.id)] || [];
    const bad = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => !IGNORE_KEYS.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]) && !allowed.includes(k));
    if (bad.length) violations.push(`#${i + 1} ${logicalName(b.id)}: ${bad.join(', ')}`);
  }
  const sameExceptAllowed = violations.length === 0;
  const bodyDiffIds = wantQ3
    .filter((it, i) => RT.htmlToText(it.html || '') !== RT.htmlToText((wantQ4[i] || {}).html || ''))
    .map((it) => logicalName(it.id));
  const onlyDocumented = JSON.stringify(bodyDiffIds.slice().sort()) === JSON.stringify(['task_info', 'task_req', 'task_req2']);
  const aliasesOk = Object.entries(store.LIVE_ITEM_ID_ALIASES).every(([, liveId]) =>
    wantQ3.some((it) => it.id === liveId) && wantQ4.some((it) => it.id === liveId));
  console.log(`\n自检：除文档写明的组别差异外两组逐字段一致 ${sameExceptAllowed ? '✔' : '✘' + violations.slice(0, 4).join('；')}`
    + `；正文不同的题目恰为 ${JSON.stringify(bodyDiffIds)}${onlyDocumented ? ' ✔' : ' ✘'}`
    + `；线上 id 别名已套用 ${aliasesOk ? '✔' : '✘'}`);
  if (!sameExceptAllowed || !onlyDocumented || !aliasesOk) throw new Error('自检不通过，已中止');

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
