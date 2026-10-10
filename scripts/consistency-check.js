// 配置快照层自检：按**当前这份实验配置**（组别3 / 组别4 预设问卷）走一遍并核对。
//
// 与 check-platform.js（平台行为层）的分工：
//   本脚本断言的是「当前实验配置是不是你上次确认的那份」——题目数、量表数、作答行数、
//   量表标题、反馈正文、问卷级计时默认值等。**这些断言会随你有意修改实验内容而失败**，
//   那属于预期，不是 bug；失败信息会标注「配置已变更？」。
//   平台行为层（check-platform.js）自带夹具、不依赖实验内容，那层失败才是代码坏了。
//
// 走查**不真实等待门控**：收到 too_early 就把时间基准回拨过去（见 lib/direct-db.js），
// 所以可以用真实的门控值（40 秒强制阅读 / 180 秒最短提交 / 300 秒作答窗口）而几乎不花时间。
//
// 用法：先启动服务（npm start），再执行：node scripts/consistency-check.js
'use strict';

const { makeHttp } = require('./lib/http');
const { walk, aiTexts } = require('./lib/walk');
const { backdateSession } = require('./lib/direct-db');
const { unzipEntry, unzipSheetNames } = require('./lib/xlsx-read');
const RT = require('../public/assets/richtext.js');   // 正文以 HTML 落库：比对前折成纯文本

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const EXP_NAME = '自检实验模板';
const Q_NAME = '自检问卷';
const Q_NAME_2 = '自检问卷·组别4';
const RUN_STARTED = Date.now();

let passed = 0;
const failures = { platform: [], config: [] };
// opts.config = true：这条断言依赖当前实验配置，失败多半是配置变更而非代码缺陷
function check(name, cond, detail, opts) {
  const isConfig = !!(opts && opts.config);
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); return; }
  (isConfig ? failures.config : failures.platform).push({ name, detail });
  console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}${isConfig ? '   ← 配置已变更？' : ''}`);
}
let sectionAt = Date.now();
function section(title) {
  const now = Date.now();
  const cost = (now - sectionAt) / 1000;
  sectionAt = now;
  console.log(`\n${title}${cost > 0.3 ? `   （上一节 ${cost.toFixed(1)}s）` : ''}`);
}

/* ---------------------------------------------------------------- 主流程 */

async function cleanup(admin) {
  for (const q of (await admin('/api/admin/questionnaires')).questionnaires) {
    if (q.title === Q_NAME || q.title === Q_NAME_2) {
      await admin('/api/admin/questionnaire/delete', { body: { id: q.id, force: true } });
    }
  }
  for (const e of (await admin('/api/admin/experiments')).experiments) {
    if (e.name === EXP_NAME) await admin('/api/admin/experiment/delete', { body: { id: e.id } });
  }
}

async function main() {
  console.log('配置快照层自检（按当前实验配置走查）');
  console.log(`服务：${BASE}`);
  console.log('说明：本层断言依赖当前实验配置，失败可能是「你有意改了配置」；代码缺陷请看 check-platform.js\n');

  const { request, login, bindAdmin } = makeHttp(BASE, ADMIN_PASSWORD);
  const token = await login();
  const admin = bindAdmin(token);
  await cleanup(admin);

  // 0) 自检模板：复制组别3。走查靠回拨快进消化等待，所以自检跑**真实门控值**
  //    （40 秒强制阅读 / 180 秒最短提交 / 300 秒作答窗口），配置保真度更高。
  const base = (await admin('/api/admin/experiment?id=group3-high-clarity')).experiment;
  const probeItems = base.items;
  const exp = (await admin('/api/admin/experiment/create', { body: { name: EXP_NAME, copyFrom: 'group3-high-clarity' } })).experiment;
  await admin('/api/admin/experiment/update', { body: { id: exp.id, name: EXP_NAME, items: probeItems } });

  // 问卷1：默认 4 题 + 插入自检模板题目 + 收尾
  const q1 = (await admin('/api/admin/questionnaire/create', { body: { title: Q_NAME } })).questionnaire;
  const parts = [...q1.items];
  const tail = parts.splice(parts.length - 2, 2);
  const copies = probeItems.map((it, i) => ({ ...it, id: `t0_${i}_${it.id}`, fromTemplateId: exp.id, fromTemplateName: EXP_NAME }));
  const q1Full = (await admin('/api/admin/questionnaire/update', { body: { id: q1.id, title: Q_NAME, items: [...parts, ...copies, ...tail] } })).questionnaire;

  // 问卷2：复制组别4 的原始问卷（用于组间逐字比对）
  const g4 = (await admin('/api/admin/questionnaires')).questionnaires.find((x) => /组别4/.test(x.title));
  const q2Full = (await admin('/api/admin/questionnaire/create', { body: { title: Q_NAME_2, copyFrom: g4.id } })).questionnaire;

  // 期望值全部由题目推导（这部分不依赖配置，改配置也不会误报）
  const answerUnits = q1Full.items.filter((it) => it.type !== 'message');
  const expectSeq = answerUnits.map((it) => `${it.type}:${it.id}`);
  const expectRows = answerUnits.reduce((n, it) => n + (it.type === 'group' ? it.subs.length : 1), 0);

  section('[1] 题目模型（含配置快照）');
  check('使用到的题型都在白名单内',
    [...new Set(q1Full.items.map((i) => i.type))].every((t) => ['message', 'gate', 'confirm', 'debrief', 'group', 'rating', 'single', 'multi', 'text', 'rank'].includes(t)),
    [...new Set(q1Full.items.map((i) => i.type))].join(','));
  // 自检问卷 = 新建问卷默认 4 题（欢迎语 / 知情同意 / 结束语 / 结束说明）去掉 2 条收尾页
  //   + 模板题目逐条复制 + 2 条收尾页。题数跟着模板走，所以这里写成「2 + 模板题数 + 2」；
  //   以前写死 44，线上模板比种子少一道（第 8 节的指导语被并进了任务要求）就会红，且看不出别的问题。
  check(`自检问卷题目数 = 2 + 模板 ${probeItems.length} 题 + 2 = ${probeItems.length + 4}`,
    q1Full.items.length === probeItems.length + 4, String(q1Full.items.length), { config: true });
  check('量表 = 22 道打分题', q1Full.items.filter((i) => i.type === 'rating').length === 22,
    String(q1Full.items.filter((i) => i.type === 'rating').length), { config: true });
  const groups = q1Full.items.filter((i) => i.type === 'group');
  // 创作题 = 单框文本题（排除两道「需输入指定内容」的阅读确认题——它们不写作品）
  const soloText = q1Full.items.filter((i) => i.type === 'text' && i.variant !== 'match');
  const matchTexts = q1Full.items.filter((i) => i.variant === 'match');
  // 「需输入指定内容」的标准答案不下发被试端：走查时由这里显式提供
  const matchAnswers = Object.fromEntries(q1Full.items
    .filter((i) => i.variant === 'match')
    .map((i) => [i.id, i.answer]));
  // 当前配置：两次创作都是单框文本题（广告语 + 创作说明写在同一框里提交），已不再用题组
  check('创作 = 两道单框文本题（不再用题组）',
    groups.length === 0 && soloText.length === 2,
    JSON.stringify({ groups: groups.length, solo: soloText.map((x) => x.title) }), { config: true });
  check('两道阅读确认题（需输入「已完成阅读」才能继续）',
    matchTexts.length === 2 && matchTexts.every((i) => String(i.answer || '').includes('已完成阅读')),
    JSON.stringify(matchTexts.map((i) => ({ title: i.title, answer: i.answer }))), { config: true });
  check('问卷不再携带问卷级计时默认值（参数只在题目上）', q1Full.timing === undefined, JSON.stringify(q1Full.timing));
  const fbItem = q1Full.items.find((i) => i.type === 'message' && String(i.text || '').startsWith('很感谢你的认真创作'));
  check('反馈题带思考稿与思考时长 20000ms（默认 20 秒）',
    !!fbItem && String(fbItem.thinking || '').length > 0 && fbItem.limits.thinkMs === 20000,
    JSON.stringify(fbItem && fbItem.limits), { config: true });
  // 2026-10-10：反馈正文按组别3「评价标准」的四个维度改写（品牌契合度 / 原创性 / 可记忆性 / 可延展性），
  //   按研究者口径**不写分值**；两组共用同一份（组间只差任务要求两处，由下面的 [3.5] 守着）。
  //   同时守住注意力检测题：题干问「哪一个选项没有在反馈中出现」，正确答案是「格式不符合要求」（第 3 个），
  //   所以正文里必须**保留**另外两个「出现过」的选项，并且**不得出现**正确答案（以及别让别的选项也变成没出现）。
  const fbText = String((fbItem && fbItem.text) || '');
  const attn = q1Full.items.find((i) => i.type === 'single' && /没有在上述反馈中出现/.test(String(i.text || '')));
  const attnOptions = (attn && attn.options) || [];
  const attnHit = attnOptions.filter((t) => fbText.includes(t));
  console.log(`  · 注意力检测：${attnOptions.join(' / ')}（正确项 = 第 ${attn ? attn.correct : '?'} 个 = ${attnOptions[(attn && attn.correct ? attn.correct : 1) - 1] || '?'}）`);
  check('反馈正文按评价标准的四个维度组织、且不写分值',
    ['品牌契合度', '原创性', '可记忆性', '可延展性'].every((t) => fbText.includes(t)) && !/\d+\s*分/.test(fbText),
    `正文 ${fbText.length} 字`, { config: true });
  check('注意力检测的选项与反馈正文对得上（恰好两个选项在正文里出现过，正确答案那个没出现）',
    attnOptions.length === 4 && attnHit.length === 2 && !fbText.includes(attnOptions[Number(attn && attn.correct) - 1] || '\u0000'),
    `正文里出现的选项：${attnHit.join(' / ') || '（无）'}`, { config: true });
  check('思考稿已加长（≥ 700 字，供 20 秒按字数自动调速铺满）',
    String((fbItem && fbItem.thinking) || '').length >= 700,
    `思考稿 ${String((fbItem && fbItem.thinking) || '').length} 字 / 正文 ${fbText.length} 字`, { config: true });

  section('[2] 同问卷逐字一致 + 环节序列');
  const recA = {};
  const recB = {};
  const sesA = await walk({ request, questionnaireId: q1Full.id, record: recA, matchAnswers });
  const sesB = await walk({ request, questionnaireId: q1Full.id, record: recB, matchAnswers });
  check('流程走完（会话已完成）', recA.finished && recB.finished);
  check(`环节序列与预期一致（${expectSeq.length} 个作答单元）`,
    JSON.stringify(recA.seen) === JSON.stringify(expectSeq),
    `实际 ${recA.seen.length} 项：${recA.seen.join(' ')}`);
  const aiA = aiTexts(recA.messages);
  const aiB = aiTexts(recB.messages);
  check('同问卷两会话 AI 消息条数一致', aiA.length === aiB.length, `${aiA.length} vs ${aiB.length}`);
  check('同问卷两会话 AI 消息逐字一致', aiA.length === aiB.length && aiA.every((t, i) => t === aiB[i]),
    aiA.length === aiB.length ? `首个差异 ${aiA.findIndex((t, i) => t !== aiB[i]) + 1}` : '');

  section('[3] 组别3 / 组别4 的组间差异（操纵是否还在）');
  const sesC = await walk({ request, questionnaireId: q2Full.id, matchAnswers: Object.fromEntries(q2Full.items
    .filter((i) => i.variant === 'match')
    .map((i) => [i.id, i.answer])) });
  const aiC = aiTexts(sesC.messages);
  const diff = [];
  for (let i = 0; i < Math.max(aiA.length, aiC.length); i += 1) if (aiA[i] !== aiC[i]) diff.push(i + 1);
  // 消息条数 / 差异处数都取决于问卷配置（你随时可能在管理端改），这里只作为信息打印
  console.log(`  · 组别3 消息 ${aiA.length} 条 / 组别4 消息 ${aiC.length} 条；两组的第 ${diff.join(', ') || '—'} 条不同`);
  // 真正要守的是「组间操纵还在」：任务要求那段文案必须两组不同、且组内一致
  const taskMsg = (arr) => arr.filter((t) => /^【青柠气泡水/.test(t || ''));
  const taskA = [...new Set(taskMsg(aiA))];
  const taskC = [...new Set(taskMsg(aiC))];
  check('每组都有「任务要求」消息', taskA.length >= 1 && taskC.length >= 1,
    `组别3 ${taskA.length} 段 / 组别4 ${taskC.length} 段`, { config: true });
  check('任务要求文案组间不同（组别操纵仍在）',
    taskA.length === 1 && taskC.length === 1 && taskA[0] !== taskC[0],
    `组别3「${String(taskA[0] || '').slice(0, 20)}…」 vs 组别4「${String(taskC[0] || '').slice(0, 20)}…」`, { config: true });
  check('同一组内多次呈现的任务要求完全一致（组内无差异）',
    new Set(taskMsg(aiA)).size === 1 && new Set(taskMsg(aiC)).size === 1,
    `组别3 出现 ${taskMsg(aiA).length} 次 / 组别4 出现 ${taskMsg(aiC).length} 次`, { config: true });

  section('[3.5] 组间结构一致（除任务要求两处之外必须逐字段相同）');
  const rawQ3 = (await admin('/api/admin/questionnaire?id=' + (await admin('/api/admin/questionnaires')).questionnaires.find((x) => /组别3/.test(x.title)).id)).questionnaire;
  const rawQ4 = (await admin('/api/admin/questionnaire?id=' + g4.id)).questionnaire;
  const normItems = (items) => items.map((it) => {
    const o = JSON.parse(JSON.stringify(it));
    o.id = String(o.id).replace(/^group3-high-clarity__/, '').replace(/^group4-low-clarity__/, '');
    delete o.fromTemplateId;
    delete o.fromTemplateName;
    return o;
  });
  const n3 = normItems(rawQ3.items);
  const n4 = normItems(rawQ4.items);
  const fieldDiffs = [];
  check('两组问卷题数一致', n3.length === n4.length, `${n3.length} vs ${n4.length}`, { config: true });
  for (let i = 0; i < Math.max(n3.length, n4.length); i += 1) {
    const a = n3[i];
    const b = n4[i];
    if (!a || !b) { fieldDiffs.push(`#${i + 1} 只有一边有`); continue; }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) fieldDiffs.push(`${a.id}.${k}`);
    }
  }
  const taskReqDiffs = fieldDiffs.filter((d) => /task_req/.test(d));
  check('除任务要求（正文 / html / text）外，两组逐字段完全一致',
    fieldDiffs.length === taskReqDiffs.length && taskReqDiffs.length > 0,
    fieldDiffs.filter((d) => !/task_req/.test(d)).slice(0, 8).join('；') || `差异 ${fieldDiffs.length} 处（均为任务要求）`, { config: true });
  check('两组的层级（大纲层级）完全对应',
    JSON.stringify(n3.map((i) => i.level || 0)) === JSON.stringify(n4.map((i) => i.level || 0)),
    JSON.stringify(n3.map((i) => i.level || 0).join(',')), { config: true });

  section('[4] 计时门控（真实门控值，靠回拨快进，不等待）');
  check('触发过作答前强制等待', recA.flags.wait);
  check('触发过最短提交 / 最长作答时间窗', recA.flags.window);
  // 题组承载窗口的机制由平台层夹具覆盖（check-platform 的 groupWindow 断言）；
  // 当前配置里两道创作题都是单框文本题（见 [1]），这里按配置快照核对它们的窗口参数
  check('两道创作题都配了最长作答窗口（maxAnswer）',
    soloText.length === 2 && soloText.every((i) => Number(i.limits.maxAnswer) > 0),
    JSON.stringify(soloText.map((i) => ({ title: i.title, limits: i.limits }))), { config: true });
  check('服务端拦截过未到时的提交（too_early）', recA.gates.rejected > 0, `拒绝 ${recA.gates.rejected} 次`);
  console.log(`  · 门控快进实况：一次走查被拒 ${recA.gates.rejected} 次，回拨合计 ${(recA.gates.fastForwardedMs / 1000).toFixed(0)}s`
    + `（若真等这些门控，3 次走查要等约 ${((recA.gates.fastForwardedMs / 1000) * 3 / 60).toFixed(1)} 分钟）`);

  section('[5] 落库核验（含配置快照）');
  const detail = await admin(`/api/admin/questionnaire/session?id=${q1Full.id}&sid=${sesA.sessionId}`);
  check(`作答记录 ${expectRows} 行（${expectSeq.length} 个作答单元，题组按子题分行）`,
    detail.responses.length === expectRows, String(detail.responses.length), { config: true });
  // 两道创作题各 1 行（阅读确认题也是文本题，但它们的内容是固定口令、不算作品）
  const workIds = new Set(soloText.map((i) => i.id));
  const workRows = detail.responses.filter((r) => r.itemType === 'text' && r.text && workIds.has(r.itemId));
  check('文本作答按行落库（两道创作题各 1 行）', workRows.length === 2, String(workRows.length), { config: true });
  check('单选题带对错判定', detail.responses.some((r) => r.itemType === 'single' && (r.isCorrect === '正确' || r.isCorrect === '错误')));
  check('量表题标签归入量表', detail.responses.some((r) => /目标清晰度测量 第 1 题/.test(r.itemLabel)),
    (detail.responses.find((r) => r.itemType === 'rating') || {}).itemLabel, { config: true });
  check('呈现/作答时间戳齐全且顺序合理',
    detail.responses.every((r) => r.presentedAt && r.answeredAt && Date.parse(r.presentedAt) <= Date.parse(r.answeredAt) + 1000));
  check('对话流含反馈正文全文', detail.messages.some((m) => RT.htmlToText(m.content).includes('很感谢你的认真创作')),
    undefined, { config: true });

  section('[6] 数据页与导出（含配置快照）');
  const list = await admin(`/api/admin/questionnaire/sessions?id=${q1Full.id}`);
  check('会话列表含 2 位被试', list.sessions.length === 2, String(list.sessions.length), { config: true });
  check(`会话作答进度 = ${expectRows}`, list.sessions.every((s) => s.answerCount === expectRows),
    list.sessions.map((s) => s.answerCount).join(','), { config: true });
  // 题号口径的进度（数据页显示的就是它）：完成会话 = 全部题号都答完
  const qnTotal = q1Full.items.filter((i) => ['group', 'rating', 'single', 'multi', 'text', 'rank'].includes(i.type)).length;
  check(`题号口径进度 = ${qnTotal}（数据页显示口径）`,
    list.totalQuestions === qnTotal && list.sessions.every((s) => s.answeredQuestions === qnTotal),
    JSON.stringify({ total: list.totalQuestions, got: list.sessions.map((s) => s.answeredQuestions) }), { config: true });
  const xlsxRes = await fetch(`${BASE}/api/admin/questionnaire/export.xlsx?id=${q1Full.id}`, { headers: { Authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await xlsxRes.arrayBuffer());
  check('xlsx 导出可用（PK 头）', xlsxRes.ok && buf.slice(0, 2).toString() === 'PK', `${buf.length} 字节`);
  const sheets = unzipSheetNames(buf);
  check('含「汇总（一被试一行）」与「作答明细」两个 sheet',
    sheets.includes('汇总（一被试一行）') && sheets.includes('作答明细'), sheets.join(' / '));
  const s1 = unzipEntry(buf, 'xl/worksheets/sheet1.xml');
  check('汇总表含量表均分与两次创作列',
    /目标清晰度测量（均分）/.test(s1) && /广告语和创作/.test(s1) && /广告语和创作说明/.test(s1) && /注意力检测·是否正确/.test(s1),
    undefined, { config: true });
  // 走查时文本题的作答按出现顺序编号（「需输入指定内容」的阅读确认题占号，所以作品编号不是从 1 开始）
  check('汇总表含被试作品文本', /作品\d/.test(s1));

  section('[7] 中途退出与恢复窗口');
  const settings = (await admin('/api/admin/settings')).settings;
  const partial = await request('/api/session', { body: { q: q1Full.id } });
  const partialId = partial.data.session.id;
  const inWindow = await request(`/api/bootstrap?q=${q1Full.id}&session=${partialId}`);
  check('窗口内重进：可恢复进行中的会话', inWindow.ok && !!inWindow.data.session);
  await admin('/api/admin/settings', { body: { resumeWindowHours: 24 } });
  backdateSession(partialId, 100);
  const outWindow = await request(`/api/bootstrap?q=${q1Full.id}&session=${partialId}`);
  check('超窗重进：返回空会话（重新开始）', outWindow.ok && outWindow.data.session === null);
  const stillThere = await admin(`/api/admin/questionnaire/session?id=${q1Full.id}&sid=${partialId}`);
  check('超窗后旧会话仍保留在数据中', stillThere.session && stillThere.session.status === 'in_progress');
  await admin('/api/admin/settings', { body: { resumeWindowHours: 0 } });
  const unlimited = await request(`/api/bootstrap?q=${q1Full.id}&session=${partialId}`);
  check('窗口设为 0（不限制）：可继续恢复', unlimited.ok && !!unlimited.data.session);

  section('[8] 清理与设置还原');
  await admin('/api/admin/questionnaire/delete', { body: { id: q1Full.id, force: true } });
  await admin('/api/admin/questionnaire/delete', { body: { id: q2Full.id, force: true } });
  await admin('/api/admin/experiment/delete', { body: { id: exp.id } });
  const restQ = (await admin('/api/admin/questionnaires')).questionnaires;
  const restE = (await admin('/api/admin/experiments')).experiments;
  check('问卷残留清零（仅剩预设问卷）', restQ.every((q) => q.title !== Q_NAME && q.title !== Q_NAME_2));
  check('实验残留清零（仅剩组别3 / 组别4 模板）', restE.every((e) => e.name !== EXP_NAME));
  await admin('/api/admin/settings', { body: { resumeWindowHours: settings.resumeWindowHours } });
  const restored = (await admin('/api/admin/settings')).settings;
  check('全局设置已还原（恢复窗口）', restored.resumeWindowHours === settings.resumeWindowHours,
    `${restored.resumeWindowHours} vs ${settings.resumeWindowHours}`);

  const totalFail = failures.platform.length + failures.config.length;
  console.log(`\n断言通过 ${passed} 项；平台层失败 ${failures.platform.length} 项；配置层失败 ${failures.config.length} 项`);
  console.log(`总耗时 ${((Date.now() - RUN_STARTED) / 1000).toFixed(1)}s（走查不真实等待门控，门控靠回拨快进）`);
  if (failures.platform.length) {
    console.log('\n【平台层失败】这些是代码问题，必须修：');
    for (const f of failures.platform) console.log(`  ✗ ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
  }
  if (failures.config.length) {
    console.log('\n【配置层失败】这些多半是实验配置变了（题目数 / 文案 / 计时默认值 / 预设问卷），请确认是否有意：');
    for (const f of failures.config) console.log(`  ✗ ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
  }
  if (totalFail) process.exit(1);
  console.log('ALL PASS ✓');
}

main().catch((err) => { console.error('自检异常：', err.message); process.exit(1); });
