// 组别内容同步（可重复执行、幂等）：
//   以「组别4」问卷为基准，把「组别3」问卷改成同构 —— 结构 / 文字 / 层级 / 参数全部对齐，
//   **只保留「任务要求」与「任务要求（再次）」两处的组别差异**（组别3 详细版 / 组别4 极简版），
//   这正是 demand 文档规定的「两组只应在任务要求上不同」。
//   同时把两个实验模板改成与各自问卷的题目区一致（模板不含知情同意页与结束说明页——那两页是问卷自带的默认头尾）。
//
// 组内不变量：第 8 节标题写着「任务要求（与开头一致）」，所以每组问卷内 task_req2 必须与
//   task_req **逐字节相同**（text 与 html 都相同，含加粗 / 小标题等富文本样式）。
//   富文本只能手工改，改开头那处时极易漏掉第二处，因此这里以开头为准回填第二处；
//   两组都回填（组别4 是内容基准，但这条不变量与内容基准无关）。
//
// 用法：先启动服务（npm start），再执行：node scripts/sync-group-content.js [--dry]
'use strict';

const BASE = process.env.BASE || 'http://localhost:3000';
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DRY = process.argv.includes('--dry');

const { makeHttp } = require('./lib/http');
const RT = require('../public/assets/richtext.js');

const P4 = 'group4-low-clarity__';
const P3 = 'group3-high-clarity__';
const TASK_REQ_SUFFIX = ['task_req', 'task_req2'];      // 唯一的组别操纵点（两处必须组内一致）
const DEPTH_PREFIX = 'group3-high-clarity-demo';         // 占位，仅为说明层级是数据字段，不做前缀

// 任务要求的富文本（首段 <p>，小节标题 <h3>，其余行 <br>）由 richtext 统一提供：
// 种子（db.js）与本脚本共用同一个实现，避免「新建库 / 同步」两条路径呈现不一致。
const textToGroupHtml = RT.sectionedHtml;

function rePrefix(item, from, to) {
  const out = JSON.parse(JSON.stringify(item));
  if (out.id && out.id.startsWith(from)) out.id = to + out.id.slice(from.length);
  return out;
}

// 组内不变量：第二处「任务要求」= 第一处（逐字节，含富文本样式）。返回是否发生了回填。
function enforceTaskReqPair(items) {
  const head = items.find((i) => i.id.endsWith('task_req'));
  const tail = items.find((i) => i.id.endsWith('task_req2'));
  if (!head || !tail) throw new Error('任务要求两处未找齐（task_req / task_req2）');
  const changed = head.text !== tail.text || head.html !== tail.html;
  tail.text = head.text;
  tail.html = head.html;
  return changed;
}

// 自检用：两处任务要求当前是否同文
function taskReqPairState(items) {
  const head = items.find((i) => i.id.endsWith('task_req'));
  const tail = items.find((i) => i.id.endsWith('task_req2'));
  if (!head || !tail) return '缺题';
  return head.text === tail.text && head.html === tail.html ? '同文' : '不一致';
}

// 模板项：同一个题，但去掉「来自模板」标记（模板本身就是源）
function asTemplateItem(item) {
  const out = JSON.parse(JSON.stringify(item));
  delete out.fromTemplateId;
  delete out.fromTemplateName;
  if (out.subs) out.subs.forEach((s) => { delete s.fromTemplateId; delete s.fromTemplateName; });
  return out;
}

(async () => {
  const { request, login, bindAdmin } = makeHttp(BASE, PASSWORD);
  const token = await login();
  const admin = bindAdmin(token);

  const list = await admin('/api/admin/questionnaires');
  const q3 = list.questionnaires.find((q) => /组别3/.test(q.title));
  const q4 = list.questionnaires.find((q) => /组别4/.test(q.title));
  if (!q3 || !q4) throw new Error('找不到组别3 / 组别4 问卷');
  const full3 = (await admin(`/api/admin/questionnaire?id=${q3.id}`)).questionnaire;
  const full4 = (await admin(`/api/admin/questionnaire?id=${q4.id}`)).questionnaire;
  const exps = (await admin('/api/admin/experiments')).experiments;
  const e3 = exps.find((e) => /组别3/.test(e.name));
  const e4 = exps.find((e) => /组别4/.test(e.name));
  if (!e3 || !e4) throw new Error('找不到组别3 / 组别4 实验模板');
  const fullE3 = (await admin(`/api/admin/experiment?id=${e3.id}`)).experiment;
  const fullE4 = (await admin(`/api/admin/experiment?id=${e4.id}`)).experiment;

  // 1) 组别3 的详细版任务要求（原文来自组别3 现有数据，不手抄）
  const reqText3 = {};
  for (const suffix of TASK_REQ_SUFFIX) {
    const src = full3.items.find((i) => i.id.endsWith(`__${suffix}`) || i.id === suffix);
    if (!src) throw new Error(`组别3 里找不到 ${suffix}`);
    reqText3[suffix] = String(src.text || RT.htmlToText(src.html || '') || '').trim();
  }

  // 2) 组别4（基准）先守住组内不变量：第二处任务要求回填成与开头逐字节相同
  const base4 = JSON.parse(JSON.stringify(full4.items));
  const pair4Backfilled = enforceTaskReqPair(base4);

  // 3) 组别3 问卷 = 组别4 问卷（前缀与模板标记换成组别3），任务要求两处换回详细版
  const nextItems3 = base4.map((raw) => {
    const suffix = TASK_REQ_SUFFIX.find((s) => raw.id.endsWith(s));
    let item = rePrefix(raw, P4, P3);
    if (raw.fromTemplateId === e4.id) {
      item.fromTemplateId = e3.id;
      item.fromTemplateName = e3.name;
    }
    if (suffix) {
      item.text = reqText3[suffix];
      item.html = textToGroupHtml(reqText3[suffix]);
    }
    return item;
  });
  const pair3Backfilled = enforceTaskReqPair(nextItems3);

  // 4) 模板 = 各自问卷的题目区（去掉知情同意页 gate 与结束说明页 debrief —— 它们是问卷自带的默认头尾）
  const isHeadTail = (it) => it.type === 'gate' || it.type === 'debrief';
  const templateItems3 = nextItems3.filter((it) => !isHeadTail(it)).map(asTemplateItem);
  const templateItems4 = base4.filter((it) => !isHeadTail(it)).map(asTemplateItem);
  enforceTaskReqPair(templateItems3);
  enforceTaskReqPair(templateItems4);

  // 5) diff 摘要（只统计实质字段）
  const summarize = (items) => items.map((i) => `${i.type}:${i.id.replace('group3-high-clarity__', '').replace('group4-low-clarity__', '')}:L${i.level || 0}`).join('\n');
  const before3 = summarize(full3.items);
  const after3 = summarize(nextItems3);
  const diffLines = [];
  const maxLen = Math.max(full3.items.length, nextItems3.length);
  for (let i = 0; i < maxLen; i += 1) {
    const a = full3.items[i];
    const b = nextItems3[i];
    const key = (x) => (x ? `${x.type} ${String(x.id).replace('group3-high-clarity__', '').replace('group4-low-clarity__', '')} L${x.level || 0} ${String(x.title || '').slice(0, 12)}` : '（无）');
    if (key(a) !== key(b)) diffLines.push(`  #${i + 1}  ${key(a)}  →  ${key(b)}`);
  }
  const level3 = full3.items.filter((i) => i.level).length;
  const level3New = nextItems3.filter((i) => i.level).length;

  console.log(`组别3 问卷：${full3.items.length} 题 → ${nextItems3.length} 题（带层级 ${level3} 处 → ${level3New} 处）`);
  console.log(`组别4 问卷：${full4.items.length} 题（内容基准）· 带层级 ${base4.filter((i) => i.level).length} 处 · 第二处任务要求${pair4Backfilled ? '已回填为与开头一致' : '本就与开头一致'}`);
  console.log(`组别3 问卷第二处任务要求${pair3Backfilled ? '已回填为与开头一致' : '本就与开头一致'}；两个模板同文：${taskReqPairState(templateItems3)} / ${taskReqPairState(templateItems4)}`);
  console.log(`组别3 模板：${fullE3.items.length} 题 → ${templateItems3.length} 题`);
  console.log(`组别4 模板：${fullE4.items.length} 题 → ${templateItems4.length} 题`);
  console.log('位置对应的差异（前 20 条）：');
  diffLines.slice(0, 20).forEach((l) => console.log(l));
  if (diffLines.length > 20) console.log(`  … 其余 ${diffLines.length - 20} 条`);
  console.log('保留的组别差异：task_req / task_req2 的正文（组别3 详细版 6 条 + 100 分评价标准，组别4 极简版 2 条）');

  // 6) 逐字段核对：除任务要求外必须一致；且组内第二处任务要求必须与开头逐字节相同
  const clone = (items) => items.map((i) => {
    const o = JSON.parse(JSON.stringify(i));
    delete o.html; delete o.text;                    // 正文单独比
    delete o.fromTemplateId; delete o.fromTemplateName;
    delete o.id; delete o.level;                     // id/层级单独比
    return o;
  });
  const sameExceptText = JSON.stringify(clone(nextItems3)) === JSON.stringify(clone(base4));
  const levelSame = JSON.stringify(nextItems3.map((i) => [String(i.id).replace(P3, ''), i.level || 0]))
    === JSON.stringify(base4.map((i) => [String(i.id).replace(P4, ''), i.level || 0]));
  const textDiff = nextItems3.filter((i, idx) => RT.htmlToText(i.html) !== RT.htmlToText(base4[idx].html))
    .map((i) => i.id.replace(P3, ''));
  const pairStates = [taskReqPairState(base4), taskReqPairState(nextItems3), taskReqPairState(templateItems4), taskReqPairState(templateItems3)];
  const pairOk = pairStates.every((s) => s === '同文');
  console.log(`除正文外的字段一致：${sameExceptText ? '✔' : '✘'}`);
  console.log(`层级一一对应：${levelSame ? '✔' : '✘'}`);
  console.log(`正文不同的题目（应恰为任务要求两处）：${JSON.stringify(textDiff)}`);
  console.log(`组内两处任务要求同文（组别4 问卷 / 组别3 问卷 / 组别4 模板 / 组别3 模板）：${pairStates.join(' · ')}`);

  if (DRY) { console.log('\n--dry：只预览，不写入'); return; }
  if (!sameExceptText || !levelSame || textDiff.length !== 2 || !pairOk) {
    throw new Error('自检不通过（除任务要求外应逐字段一致，且组内两处任务要求须同文），已中止写入');
  }

  await admin('/api/admin/questionnaire/update', { body: { id: q3.id, title: full3.title, items: nextItems3 } });
  if (pair4Backfilled) {
    await admin('/api/admin/questionnaire/update', { body: { id: q4.id, title: full4.title, items: base4 } });
  }
  await admin('/api/admin/experiment/update', { body: { id: e3.id, name: e3.name, items: templateItems3 } });
  await admin('/api/admin/experiment/update', { body: { id: e4.id, name: e4.name, items: templateItems4 } });
  console.log(`\n✅ 已写入：组别3 问卷 + 两个模板${pair4Backfilled ? ' + 组别4 问卷（仅把第二处任务要求的富文本样式对齐开头，正文未改）' : '（组别4 问卷本就同文，未改动）'}`);

  const after = (await admin(`/api/admin/questionnaire?id=${q3.id}`)).questionnaire;
  const after4 = (await admin(`/api/admin/questionnaire?id=${q4.id}`)).questionnaire;
  console.log(`复核：组别3 现有 ${after.items.length} 题，带层级 ${after.items.filter((i) => i.level).length} 处，含 html ${after.items.filter((i) => i.html).length} 题`);
  console.log(`复核：组别4 现有 ${after4.items.length} 题，第二处任务要求与开头${taskReqPairState(after4.items) === '同文' ? '逐字节一致 ✔' : '仍不一致 ✘'}`);
  const sessions = (await admin(`/api/admin/questionnaire/sessions?id=${q3.id}`)).sessions.length;
  console.log(`复核：组别3 会话数 ${sessions}（未受影响）`);
})().catch((err) => { console.error('同步失败：', err.message); process.exit(1); });
