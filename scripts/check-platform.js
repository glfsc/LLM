// 平台行为层自检：自带最小夹具，**不依赖任何实验内容**（不复制组别3/组别4）。
//
// 与 consistency-check.js（配置快照层）的分工：
//   本脚本断言的是「平台代码有没有坏」——预期结果全部由夹具推导，
//   所以你改文案、改题量、换思考稿、删预设问卷，都不会让它误报。
//   配置快照层断言的是「当前这份实验配置是不是你上次确认的那份」，那层会随配置变更而失败。
//
// 用法：先启动服务（npm start），再执行：node scripts/check-platform.js
'use strict';

const { makeHttp } = require('./lib/http');
const { walk, aiTexts } = require('./lib/walk');
const { backdateSession, backdateActivity, fastForwardGates, withDb } = require('./lib/direct-db');
const { unzipEntry, unzipSheetNames } = require('./lib/xlsx-read');
const RT = require('../public/assets/richtext.js');

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const Q_A = '自检·平台层A';
const Q_C = '【自检夹具C·消息式题面与清屏点】';
const Q_D = '【自检夹具D·超时重试】';
const Q_B = '自检·平台层B';
const RUN_STARTED = Date.now();

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}
let sectionAt = Date.now();
function section(title) {
  const now = Date.now();
  const cost = (now - sectionAt) / 1000;
  sectionAt = now;
  console.log(`\n${title}${cost > 0.3 ? `   （上一节 ${cost.toFixed(1)}s）` : ''}`);
}

/* ---------------------------------------------------------------- 夹具 */
// 任务要求：两组只差这一段文案（模拟真实的组别差异）
const TASK_TEXT_A = '【夹具·任务要求 A】请为新品写一句广告语，8-20 字。';
const TASK_TEXT_B = '【夹具·任务要求 B】请为新品写一句广告语，并说明创作思路。';
const FEEDBACK_TEXT = '【夹具·反馈正文】这是标准化反馈，用于验证逐字一致与落库完整。';
const THINKING_TEXT = '【夹具·思考过程】先把任务要求过一遍，再对照标准推演。\n• 第一条\n• 第二条\n\n结论：按这几条来写反馈。';

// 覆盖全部题型 + 三类门控 + 题组 + 思考面板；门控用真实值（走查靠回拨快进，不用等）
function fixture(taskText) {
  return [
    { id: 'welcome', type: 'message', title: '欢迎语', text: '【夹具】欢迎参加。' },
    { id: 'consent', type: 'gate', title: '知情同意说明', text: '【夹具】请阅读并勾选同意。', check: '我已阅读并同意', button: '开始实验', variant: 'id', idLabel: '被试编号', idPlaceholder: '请填写编号' },
    { id: 'task', type: 'message', title: '任务要求', text: taskText },
    { id: 'scale_intro', type: 'message', title: '量表指导语', text: '请根据实际感受作答。' },
    { id: 'r1', type: 'rating', title: '我清楚任务目标。', min: 1, max: 5, anchor: '1 = 完全不同意　·　5 = 完全同意' },
    { id: 'r2', type: 'rating', title: '我知道评价标准。', min: 1, max: 5, anchor: '1 = 完全不同意　·　5 = 完全同意' },
    { id: 'r3', type: 'rating', title: '我清楚努力方向。', min: 1, max: 5, anchor: '1 = 完全不同意　·　5 = 完全同意' },
    {
      id: 'work', type: 'group', title: '内容创作', text: '', layout: 'column',
      limits: { minSubmit: 180, maxAnswer: 300 },            // 最短提交 / 最长作答窗口
      subs: [
        { id: 'slogan', type: 'text', title: '广告语', required: true, rows: 1, maxLen: 20, placeholder: '请输入广告语' },
        { id: 'note', type: 'text', title: '创作说明（选填）', required: false, rows: 2, maxLen: 50, placeholder: '可简要说明' }
      ]
    },
    {
      id: 'feedback', type: 'message', title: '负面反馈输出',
      text: FEEDBACK_TEXT, thinking: THINKING_TEXT,
      limits: { thinkMs: 8000 }                              // 思考面板（延迟发出参数已删除）
    },
    {
      id: 'confirm', type: 'confirm', title: '阅读确认页',
      text: '【夹具】请确认你已阅读完上面的反馈。', button: '我已阅读完',
      limits: { wait: 40 }                                   // 停留 40 秒后才能点确认
    },
    { id: 'attention', type: 'single', title: '注意力检测', options: ['选项甲', '选项乙', '选项丙'], correct: 3, limits: { wait: 40, refresh: 1 } },  // 强制等待 + 刷新点（呈现本题前清空聊天流）
    { id: 'multi', type: 'multi', title: '多选题', options: ['甲', '乙', '丙'] },
    { id: 'rank', type: 'rank', title: '请排序', options: ['一', '二', '三'] },
    { id: 'free', type: 'text', title: '文本题', required: true, rows: 1, maxLen: 30, placeholder: '请输入' },
    { id: 'debrief', type: 'debrief', title: '结束说明', text: '【夹具】到此结束，感谢参与。' }
  ];
}

// 夹具 C：专门覆盖本轮的「消息式题面 / 题号口径 / 消息清屏点 / 思考参数 / 回放重建」
function fixtureC() {
  return [
    { id: 'c_gate', type: 'gate', title: '【夹具C】知情同意', text: '【夹具C】请勾选同意。', check: '我已阅读并同意', button: '开始实验' },
    { id: 'c_intro', type: 'message', title: '开场', text: '【夹具C】开场材料，稍后会被清屏点清掉。' },
    { id: 'c_r1', type: 'rating', title: '【夹具C】打分题一', min: 1, max: 5 },
    { id: 'c_mid', type: 'message', title: '分屏材料', text: '【夹具C·分屏材料】这条消息之前的内容会被清空。', limits: { refresh: 1 } },
    { id: 'c_plain', type: 'message', title: '无思考材料', text: '【夹具C·无思考】这条消息没配思考过程。' },
    { id: 'c_think', type: 'message', title: '带思考材料', text: '【夹具C·带思考】正文。', thinking: '【夹具C·心路】先想再答。', limits: { thinkMs: 8000 } },
    { id: 'c_t1', type: 'text', title: '【夹具C】文本题', required: true, rows: 1, maxLen: 30 },
    {
      id: 'c_g', type: 'group', title: '【夹具C】内容创作', text: '', layout: 'column',
      subs: [
        { id: 'c_s1', type: 'text', title: '广告语', required: true, rows: 1 },
        { id: 'c_s2', type: 'text', title: '创作说明（选填）', required: false, rows: 2 }
      ]
    },
    { id: 'c_r2', type: 'rating', title: '【夹具C】打分题二', min: 1, max: 5 },
    { id: 'c_end', type: 'debrief', title: '【夹具C】结束说明', text: '【夹具C】到此结束。' }
  ];
}

// 夹具 D：专门验证「超时锁死 → 重试开新窗口 → 落库记重试/超时」
function fixtureD() {
  return [
    { id: 'd_msg', type: 'message', title: '开场', text: '【夹具D】开场。' },
    { id: 'd_t', type: 'text', title: '【夹具D】按时作答', required: true, rows: 1, limits: { minSubmit: 10, maxAnswer: 20 } },
    { id: 'd_end', type: 'debrief', title: '【夹具D】结束说明', text: '【夹具D】结束。' }
  ];
}

// 由夹具推导的期望值（不写死数字）
function expectations(items) {
  const units = items.filter((it) => it.type !== 'message');
  const rows = units.reduce((n, it) => n + (it.type === 'group' ? it.subs.length : 1), 0);
  // 落库里 itemType='text' 的行 = 题组里的文本子题 + 独立文本题（两者都按行存正文）
  const textRows = items.filter((it) => it.type === 'text').length
    + items.filter((it) => it.type === 'group').reduce((n, g) => n + g.subs.filter((s) => s.type === 'text').length, 0);
  return {
    unitCount: units.length,
    rowCount: rows,
    textRows,
    expectSeq: units.map((it) => `${it.type}:${it.id}`),
    itemCount: items.length
  };
}

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  console.log('平台行为层自检（自带夹具，不依赖实验内容）');
  console.log(`服务：${BASE}\n`);

  const { request, login, bindAdmin } = makeHttp(BASE, ADMIN_PASSWORD);
  const token = await login();
  const admin = bindAdmin(token);

  // 清掉上次可能的残留
  for (const q of (await admin('/api/admin/questionnaires')).questionnaires) {
    if (q.title === Q_A || q.title === Q_B) await admin('/api/admin/questionnaire/delete', { body: { id: q.id, force: true } });
  }

  const itemsA = fixture(TASK_TEXT_A);
  const itemsB = fixture(TASK_TEXT_B);
  const expect = expectations(itemsA);
  const qA = (await admin('/api/admin/questionnaire/create', { body: { title: Q_A, items: itemsA } })).questionnaire;
  const qB = (await admin('/api/admin/questionnaire/create', { body: { title: Q_B, items: itemsB } })).questionnaire;

  section('[1] 夹具与题目模型');
  check('问卷不再携带问卷级计时默认值（参数只在题目上）', qA.timing === undefined, JSON.stringify(qA.timing));
  const types = [...new Set(qA.items.map((i) => i.type))].sort();
  check('题型覆盖都在白名单内', types.every((t) => ['message', 'gate', 'debrief', 'group', 'rating', 'single', 'multi', 'text', 'rank', 'confirm'].includes(t)), types.join(','));
  check(`题目数 = ${expect.itemCount}`, qA.items.length === expect.itemCount, String(qA.items.length));
  const groups = qA.items.filter((i) => i.type === 'group');
  check('题组保留子题', groups.length === 1 && groups[0].subs.length === 2, JSON.stringify(groups.map((g) => g.subs.length)));
  const fb = qA.items.find((i) => i.id === 'feedback');
  check('思考内容随题目保存', !!fb && String(fb.thinking || '').length === THINKING_TEXT.length);
  check('题目级门控按题目保存', !!fb && fb.limits.thinkMs === 8000, JSON.stringify(fb && fb.limits));
  check('已删除的参数不会留在题目上', !!fb && fb.limits.delay === undefined, JSON.stringify(fb && fb.limits));

  section('[2] 走查：流程完整性 + 同问卷两次逐字一致');
  const recA = {};
  const recB = {};
  const sesA = await walk({ request, questionnaireId: qA.id, record: recA });
  const sesB = await walk({ request, questionnaireId: qA.id, record: recB });
  check('流程走完（会话已完成）', recA.finished && recB.finished);
  check(`环节序列 = 夹具推导的 ${expect.unitCount} 个作答单元`,
    JSON.stringify(recA.seen) === JSON.stringify(expect.expectSeq),
    `实际 ${recA.seen.length} 项`);
  const aiA = aiTexts(recA.messages);
  const aiB = aiTexts(recB.messages);
  check('同问卷两次走查 AI 消息条数一致', aiA.length === aiB.length, `${aiA.length} vs ${aiB.length}`);
  check('同问卷两次走查 AI 消息逐字一致', aiA.length === aiB.length && aiA.every((t, i) => t === aiB[i]));

  section('[3] 跨组：差异恰为任务要求一处');
  const sesC = await walk({ request, questionnaireId: qB.id });
  const aiC = aiTexts(sesC.messages);
  const diff = [];
  for (let i = 0; i < Math.max(aiA.length, aiC.length); i += 1) if (aiA[i] !== aiC[i]) diff.push(i + 1);
  check('两组 AI 消息条数一致', aiA.length === aiC.length, `${aiA.length} vs ${aiC.length}`);
  check('两组差异恰为 1 处（任务要求）', diff.length === 1, `差异位置 ${diff.join(', ')}`);
  check('差异内容就是那处任务要求', diff.length === 1 && aiC[diff[0] - 1] === TASK_TEXT_B, String(aiC[diff[0] - 1] || '').slice(0, 24));

  section('[4] 计时门控（真实门控值，靠回拨快进，不等待）');
  check('触发过作答前强制等待', recA.flags.wait);
  check('触发过最短提交 / 最长作答时间窗', recA.flags.window);
  check('题组承载最短提交 / 最长作答窗口', recA.flags.groupWindow === true, JSON.stringify(recA.flags));
  check('服务端拦截过未到时的提交（too_early）', recA.gates.rejected > 0,
    `拒绝 ${recA.gates.rejected} 次`);
  console.log(`  · 门控快进实况：一次走查被拒 ${recA.gates.rejected} 次，回拨合计 ${(recA.gates.fastForwardedMs / 1000).toFixed(0)}s`
    + `（若真等，单次就要 ${(recA.gates.fastForwardedMs / 60000).toFixed(1)} 分钟）`);

  section('[4b] 刷新点：清空聊天流且服务端记住清屏点');
  check('呈现刷新点题目前下发过清屏指令', recA.flags.cleared === true);
  const bootAfter = await request(`/api/bootstrap?q=${qA.id}&session=${sesA.sessionId}`);
  const visible = (bootAfter.data.messages || []).map((m) => m.content);
  check('清屏点之前的消息不再下发（刷新也看不到）',
    !visible.includes(TASK_TEXT_A) && !visible.some((t) => t === FEEDBACK_TEXT),
    `仍下发 ${visible.length} 条`);
  const allMsgs = await admin(`/api/admin/questionnaire/session?id=${qA.id}&sid=${sesA.sessionId}`);
  check('但清屏点之前的消息仍完整留在数据里（管理端可见）',
    allMsgs.messages.some((m) => RT.htmlToText(m.content) === TASK_TEXT_A));

  section('[5] 落库核验');
  const detail = await admin(`/api/admin/questionnaire/session?id=${qA.id}&sid=${sesA.sessionId}`);
  check(`作答记录 ${expect.rowCount} 行（题组按子题分行）`, detail.responses.length === expect.rowCount, String(detail.responses.length));
  check(`文本类作答按行落库 = ${expect.textRows} 行（题组子题 + 独立文本题）`,
    detail.responses.filter((r) => r.itemType === 'text' && r.text).length === expect.textRows,
    String(detail.responses.filter((r) => r.itemType === 'text' && r.text).length));
  check('单选题带对错判定', detail.responses.some((r) => r.itemType === 'single' && (r.isCorrect === '正确' || r.isCorrect === '错误')));
  check('呈现/作答时间戳齐全且顺序合理',
    detail.responses.every((r) => r.presentedAt && r.answeredAt && Date.parse(r.presentedAt) <= Date.parse(r.answeredAt) + 1000));
  check('对话流含反馈全文', detail.messages.some((m) => RT.htmlToText(m.content) === FEEDBACK_TEXT));

  section('[6] 数据页与导出');
  const list = await admin(`/api/admin/questionnaire/sessions?id=${qA.id}`);
  check('会话列表含 2 位被试', list.sessions.length === 2, String(list.sessions.length));
  check(`会话作答进度 = ${expect.rowCount}`, list.sessions.every((s) => s.answerCount === expect.rowCount));
  const xlsxRes = await fetch(`${BASE}/api/admin/questionnaire/export.xlsx?id=${qA.id}`, { headers: { Authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await xlsxRes.arrayBuffer());
  check('xlsx 导出可用（PK 头）', xlsxRes.ok && buf.slice(0, 2).toString() === 'PK', `${buf.length} 字节`);
  const sheets = unzipSheetNames(buf);
  check('含「汇总（一被试一行）」与「作答明细」两个 sheet',
    sheets.includes('汇总（一被试一行）') && sheets.includes('作答明细'), sheets.join(' / '));
  const s1 = unzipEntry(buf, 'xl/worksheets/sheet1.xml');
  check('汇总表含被试自填编号列', /被试自填编号/.test(s1));
  check('汇总表带上了被试在知情同意页填的编号', /AUTO-01/.test(s1));

  section('[7] 中途退出与恢复窗口三态');
  const settings = (await admin('/api/admin/settings')).settings;
  const partial = await request('/api/session', { body: { q: qA.id } });
  const partialId = partial.data.session.id;
  const inWindow = await request(`/api/bootstrap?q=${qA.id}&session=${partialId}`);
  check('窗口内重进：可恢复进行中的会话', inWindow.ok && !!inWindow.data.session);
  await admin('/api/admin/settings', { body: { resumeWindowHours: 24 } });
  backdateSession(partialId, 100);
  const outWindow = await request(`/api/bootstrap?q=${qA.id}&session=${partialId}`);
  check('超窗重进：返回空会话（重新开始）', outWindow.ok && outWindow.data.session === null);
  const stillThere = await admin(`/api/admin/questionnaire/session?id=${qA.id}&sid=${partialId}`);
  check('超窗后旧会话仍保留在数据中', !!stillThere.session && stillThere.session.status === 'in_progress');
  await admin('/api/admin/settings', { body: { resumeWindowHours: 0 } });
  const unlimited = await request(`/api/bootstrap?q=${qA.id}&session=${partialId}`);
  check('窗口设为 0（不限制）：可继续恢复', unlimited.ok && !!unlimited.data.session);

  section('[8] 本轮改动：消息式题面 / 题号口径 / 消息清屏点 / 思考参数 / 回放重建');
  const itemsC = fixtureC();
  const qC = (await admin('/api/admin/questionnaire/create', { body: { title: Q_C, items: itemsC } })).questionnaire;
  const recFix = {};
  const sesFix = await walk({ request, questionnaireId: qC.id, record: recFix });

  // 题号：知情同意页不占号，只有需要作答的题目从 1 开始
  check('题号只数需要作答的题目（知情同意不占号）',
    recFix.qnos.c_gate === 0 && recFix.qnos.c_r1 === 1 && recFix.qnos.c_t1 === 2 && recFix.qnos.c_g === 3 && recFix.qnos.c_r2 === 4,
    JSON.stringify(recFix.qnos));
  check('文本题 / 全文本题组按消息式题面呈现（题号照常下发）',
    recFix.qnos.c_t1 === 2 && recFix.qnos.c_g === 3);
  check('打分题仍是题卡（不占题号的是页面，不是所有题）', recFix.qnos.c_r1 === 1 && recFix.qnos.c_r2 === 4);

  // 清屏点：消息上也能配「呈现前清空」
  const adminDetailFix = await admin(`/api/admin/questionnaire/session?id=${qC.id}&sid=${sesFix.sessionId}`);
  const bootFix = await request(`/api/bootstrap?q=${qC.id}&session=${sesFix.sessionId}`);
  const replayFix = bootFix.data.replay || [];
  const kindsFix = replayFix.map((e) => e.kind);
  check('消息上的「呈现前清空」触发清屏指令', recFix.flags.cleared === true);
  check('清屏点之前的消息不再下发（含被清掉的开场材料）',
    !replayFix.some((e) => e.kind === 'message' && String(e.content).includes('开场材料')));
  check('清屏点之前的数据仍完整留在管理端（可回查）',
    adminDetailFix.messages.some((m) => RT.htmlToText(m.content).includes('开场材料'))
      && adminDetailFix.messages.some((m) => RT.htmlToText(m.content).includes('这条消息没配思考过程')));

  // 回放重建：消息 / 用户气泡 / 已作答卡片三类，且按题目顺序
  check('重进下发回放时间线', replayFix.length > 0, `${replayFix.length} 项`);
  check('回放含消息 / 用户气泡 / 已作答卡片三类',
    kindsFix.includes('message') && kindsFix.includes('user') && kindsFix.includes('card'),
    JSON.stringify([...new Set(kindsFix)]));
  check('文本题与全文本题组的作答在回放里是用户气泡（原文回显）',
    replayFix.filter((e) => e.kind === 'user' && (e.itemId === 'c_t1' || e.itemId === 'c_g')).length === 2
      && replayFix.some((e) => e.kind === 'user' && e.itemId === 'c_t1' && e.content === '作品1'),
    JSON.stringify(replayFix.filter((e) => e.kind === 'user').map((e) => [e.itemId, String(e.content).slice(0, 14)])));
  check('打分题在回放里是已作答卡片（题干 + 回显 + 题号）',
    replayFix.filter((e) => e.kind === 'card').length === 1
      && replayFix.some((e) => e.kind === 'card' && e.itemId === 'c_r2' && e.qno === 4 && String(e.echo).includes('我的选择')),
    JSON.stringify(replayFix.filter((e) => e.kind === 'card').map((e) => [e.itemId, e.qno])));
  check('清屏点之前的已答卡片也不再出现（只重建清屏点之后的）',
    !replayFix.some((e) => e.itemId === 'c_r1'));
  check('页面类题目（知情同意 / 结束说明）不进聊天流',
    !replayFix.some((e) => e.itemId === 'c_gate' || e.itemId === 'c_end'));
  check('回放里的已作答卡片排在消息之后',
    kindsFix.indexOf('card') > kindsFix.indexOf('message'));

  // 思考参数：配了才出现；没配不凭空冒「正在思考」
  const thinkFix = replayFix.find((e) => e.kind === 'message' && String(e.content).includes('带思考'));
  const plainFix = replayFix.find((e) => e.kind === 'message' && String(e.content).includes('这条消息没配思考过程'));
  check('配了思考过程的消息带思考稿与时长（8 秒）',
    Boolean(thinkFix) && Number(thinkFix.thinkMs) === 8000 && String(thinkFix.thinking).includes('心路'));
  check('没配思考的消息不带「思考中」提示（thinkMs = 0）',
    Boolean(plainFix) && Number(plainFix.thinkMs) === 0, plainFix ? String(plainFix.thinkMs) : '（未找到）');

  // 富文本：正文按清洗后的 HTML 下发（旧数据的标题并入正文；脚本注入的标签被脱壳）
  const introFix = adminDetailFix.messages.find((m) => RT.htmlToText(m.content).includes('开场材料'));
  check('正文以 HTML 下发且脚本注入被清洗', Boolean(introFix) && !/script|onclick/i.test(introFix.content));
  check('页面类题目的标题并入正文（h1）',
    (qC.items.find((i) => i.id === 'c_gate').html || '').startsWith('<h1>'));
  check('题组正文里带上作答约定（可编辑，不再硬编码在输入框提示里）',
    String(qC.items.find((i) => i.id === 'c_g').html || '').includes('第一行填'));

  section('[9] 本轮改动：心跳 / 太久未提交自动作废 / 导出排除 / 超时锁死与重试');
  // 心跳：页面开着时每分钟一次，只刷新活动时间
  const hb = await request('/api/heartbeat', { body: { sessionId: sesFix.sessionId } });
  check('心跳接口可用（刷新最近活动时间）', hb.ok && hb.data.ok === true, JSON.stringify(hb.data).slice(0, 80));

  // 超时锁死 + 重试开新窗口（夹具 D）
  const itemsD = fixtureD();
  const qD = (await admin('/api/admin/questionnaire/create', { body: { title: Q_D, items: itemsD } })).questionnaire;
  const sesD = (await request('/api/session', { body: { q: qD.id } })).data;
  const sidD = sesD.session.id;
  // 走到文本题：回拨 80 秒 → 远超「最短提交 10 秒 + 最长作答 20 秒 + 宽限 30 秒」
  fastForwardGates(sidD, 80 * 1000);
  const lateSubmit = await request('/api/step', { body: { sessionId: sidD, text: '迟到的回答' } });
  check('超时后提交被拒（window_closed）',
    lateSubmit.status === 409 && lateSubmit.data.error === 'window_closed',
    `${lateSubmit.status} ${lateSubmit.data.error || ''}`);
  const retried = await request('/api/step/retry', { body: { sessionId: sidD } });
  check('「重试」可给本题开一个新窗口（重新计时）',
    retried.ok && retried.data.retried === true && Number(retried.data.action.deadlineMs) > Number(retried.data.nowMs),
    JSON.stringify({ retried: retried.data.retried, deadline: retried.data.action && retried.data.action.deadlineMs }));
  fastForwardGates(sidD, 15 * 1000);      // 新窗口也有「最短提交 10 秒」：回拨到窗口内再提交
  const afterRetry = await request('/api/step', { body: { sessionId: sidD, text: '重试后的回答' } });
  check('新窗口内可以正常提交', afterRetry.ok === true, JSON.stringify(afterRetry.data).slice(0, 100));
  const detailD = await admin(`/api/admin/questionnaire/session?id=${qD.id}&sid=${sidD}`);
  const rowD = (detailD.responses || [])[0] || {};
  check('重试次数与「曾超时」落库', rowD.retryCount === 1 && rowD.timedOut === true,
    JSON.stringify({ retryCount: rowD.retryCount, timedOut: rowD.timedOut }));

  // 太久未提交 → 下次打开自动作废（数据留档、设备释放）
  await backdateActivity(sidD, 999);
  const bootAbandoned = await request(`/api/bootstrap?q=${qD.id}&session=${sidD}`);
  check('「太久没提交」的会话在下次打开时被作废（不再续做）', bootAbandoned.ok && !bootAbandoned.data.session);
  const listD = await admin(`/api/admin/questionnaire/sessions?id=${qD.id}`);
  const rowAbandoned = listD.sessions.find((x) => x.id === sidD) || {};
  check('作废后的会话仍留档（状态 = 已作废）',
    rowAbandoned.status === 'abandoned' && rowAbandoned.statusLabel === '已作废',
    JSON.stringify({ status: rowAbandoned.status, label: rowAbandoned.statusLabel }));
  const detailAbandoned = await admin(`/api/admin/questionnaire/session?id=${qD.id}&sid=${sidD}`);
  check('作废不影响已作答的数据（管理端仍能看到回答）',
    (detailAbandoned.responses || []).some((r) => String(r.optionLabel || '').includes('重试后的回答')));

  // 导出默认排除作废会话
  const expClean = await fetch(`${BASE}/api/admin/questionnaire/export.xlsx?id=${qD.id}`, { headers: { Authorization: `Bearer ${token}` } });
  const bufClean = Buffer.from(await expClean.arrayBuffer());
  const expAll = await fetch(`${BASE}/api/admin/questionnaire/export.xlsx?id=${qD.id}&includeAbandoned=1`, { headers: { Authorization: `Bearer ${token}` } });
  const bufAll = Buffer.from(await expAll.arrayBuffer());
  check('导出默认排除「已作废」会话（带 includeAbandoned=1 时才包含）',
    bufClean.slice(0, 2).toString() === 'PK' && bufAll.slice(0, 2).toString() === 'PK' && bufAll.length > bufClean.length,
    `默认 ${bufClean.length} 字节 / 含作废 ${bufAll.length} 字节`);

  await admin('/api/admin/questionnaire/delete', { body: { id: qD.id, force: true } });

  section('[10] 手机预览：真 iframe 的数据源（内存会话，不落库）');
  const pvCreated = await admin('/api/admin/preview', { body: { items: fixtureC() } });
  check('预览会话可创建并拿到 iframe 地址',
    Boolean(pvCreated.previewId) && String(pvCreated.url || '').startsWith('/chat?preview='),
    JSON.stringify(pvCreated).slice(0, 80));
  const pvId = pvCreated.previewId;
  const pvEmpty = await request(`/api/preview/bootstrap?preview=${pvId}`);
  check('没带会话时预览返回空会话（与真实端同一条分支）',
    pvEmpty.ok && pvEmpty.data.session === null);
  const pvBoot = await request('/api/preview/session', { body: { previewId: pvId } });
  check('预览能建会话并取到初始负载（与真实端同一套状态机）',
    pvBoot.ok && pvBoot.data.session && pvBoot.data.action && pvBoot.data.action.type === 'gate',
    JSON.stringify(pvBoot.data && pvBoot.data.action && pvBoot.data.action.type));
  const pvStep = await request('/api/preview/step', {
    body: { previewId: pvId, sessionId: pvBoot.data.session.id, consent: true, text: 'PV-01', elapsedMs: 300 }
  });
  check('预览里可以继续作答（返回下一题）',
    pvStep.ok && pvStep.data.action && pvStep.data.action.type !== 'gate',
    JSON.stringify(pvStep.data && pvStep.data.action && pvStep.data.action.type));
  const pvInDb = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(pvBoot.data.session.id).n);
  check('预览会话不写数据库（内存会话，管理端数据页看不到）', Number(pvInDb) === 0, String(pvInDb));
  const pvExpired = await request('/api/preview/session', { body: { previewId: 'nope123' } });
  check('预览会话失效时给出可读提示', pvExpired.status === 404 && pvExpired.data.error === 'preview_expired');

  // 进度跳转：把前 N 个单元合成「已作答」，直接停在第 N 题
  const pvSeek = await request('/api/preview/seek', {
    body: { previewId: pvId, sessionId: pvBoot.data.session.id, index: 3 }
  });
  // 夹具 C 的作答单元顺序：c_gate / c_r1 / c_t1 / c_g / c_r2 / c_end → index 3 = 题组 c_g（题号 3，因为知情同意不占号）
  check('预览可跳进度（直接到第 N 个作答单元）',
    pvSeek.ok && pvSeek.data.answeredCount === 3 && pvSeek.data.action && pvSeek.data.action.itemId === 'c_g',
    JSON.stringify({ answered: pvSeek.data.answeredCount, item: pvSeek.data.action && pvSeek.data.action.itemId }));
  const seekKinds = (pvSeek.data.replay || []).map((e) => e.kind);
  const seekIds = (pvSeek.data.replay || []).map((e) => e.itemId || (e.item && e.item.itemId));
  // 夹具 C 在 c_r1 之后有一条带 refresh 的消息（c_mid）：清屏点之前的作答必须被清掉 ——
  // 这与真实会话完全一致（[8] 段已单独断言真实路径同样不出现 c_r1 的卡片）
  check('跳过的那部分在回放里表现为已作答（清屏点之后的用户气泡）',
    seekKinds.includes('user'), JSON.stringify([...new Set(seekKinds)]));
  check('清屏点之前跳过的那部分被清掉（与真实会话同一套清屏语义）',
    !seekIds.includes('c_r1'), JSON.stringify(seekIds.filter(Boolean)));
  // 题号口径：滑块 / 题号框传的是 qno（与卡面「第 N 题」一致），不是作答单元序号 ——
  // 夹具 C 的单元：c_gate / c_r1 / c_t1 / c_g / c_r2 / c_end，题号 1..4（知情同意不占号）
  const pvQno = await request('/api/preview/seek', {
    body: { previewId: pvId, sessionId: pvBoot.data.session.id, qno: 4 }
  });
  check('按题号跳转：输 4 就停在第 4 题（不再整体偏一位）',
    pvQno.ok && pvQno.data.action && pvQno.data.action.itemId === 'c_r2' && pvQno.data.action.qno === 4,
    JSON.stringify({ item: pvQno.data.action && pvQno.data.action.itemId, qno: pvQno.data.action && pvQno.data.action.qno }));
  check('负载里给出真实题数（进度条分母）与当前题号',
    pvQno.data.totalQuestions === 4 && pvQno.data.currentQno === 4,
    JSON.stringify({ totalQuestions: pvQno.data.totalQuestions, currentQno: pvQno.data.currentQno }));

  // 呈现前清空（refresh）在预览里也要生效：跳到清屏点之后，清屏点之前的已作答不出现在回放里
  const pvRefreshItems = [
    { id: 'rf1', type: 'rating', title: '清屏前第 1 题', min: 1, max: 5 },
    { id: 'rf2', type: 'rating', title: '清屏前第 2 题', min: 1, max: 5, limits: { refresh: 1 } },
    { id: 'rf3', type: 'rating', title: '清屏后第 3 题', min: 1, max: 5 }
  ];
  const pvRf = await admin('/api/admin/preview', { body: { items: pvRefreshItems } });
  const rfBoot = await request('/api/preview/session', { body: { previewId: pvRf.previewId } });
  const rfSid = rfBoot.data.session && rfBoot.data.session.id;
  const rfStep = await request('/api/preview/step', {
    body: { previewId: pvRf.previewId, sessionId: rfSid, itemId: 'rf1', value: 5, ack: true }
  });
  check('预览提交到位（清屏夹具第 2 题带 refresh）', rfStep.ok, JSON.stringify(rfStep.data).slice(0, 80));
  const rfSeekAt = await request('/api/preview/seek', { body: { previewId: pvRf.previewId, sessionId: rfSid, qno: 2 } });
  check('预览里跳到清屏点本身：先清屏再呈现该题（清屏点之前的已作答不在回放里）',
    rfSeekAt.ok && rfSeekAt.data.clearStream === true
      && !(rfSeekAt.data.replay || []).some((e) => e.itemId === 'rf1' || (e.item && e.item.itemId === 'rf1')),
    JSON.stringify({ clearStream: rfSeekAt.data.clearStream, ids: (rfSeekAt.data.replay || []).map((e) => e.itemId || e.kind) }).slice(0, 160));
  const rfSeek = await request('/api/preview/seek', { body: { previewId: pvRf.previewId, sessionId: rfSid, qno: 3 } });
  const rfIds = (rfSeek.data.replay || []).map((e) => e.itemId || (e.item && e.item.itemId));
  check('预览里跳到清屏点之后：清屏前的已作答不出现、清屏点之后的仍保留',
    rfSeek.ok && !rfIds.includes('rf1') && rfIds.includes('rf2'),
    JSON.stringify({ ids: rfIds.filter(Boolean), clearStream: rfSeek.data.clearStream }).slice(0, 160));

  // 销毁：点「刷新预览」时管理端会先销毁旧预览（不等 30 分钟空闲回收）
  const pvDoomed = await admin('/api/admin/preview', { body: { items: pvRefreshItems } });
  const destroy1 = await request('/api/preview/destroy', { body: { previewId: pvDoomed.previewId } });
  const afterDestroy = await request('/api/preview/session', { body: { previewId: pvDoomed.previewId } });
  const destroy2 = await request('/api/preview/destroy', { body: { previewId: pvDoomed.previewId } });
  check('预览可被立即销毁（销毁后同 id 一律 404，重复销毁也安全）',
    destroy1.ok && destroy1.data.destroyed === true && afterDestroy.status === 404 && destroy2.ok,
    JSON.stringify({ destroyed: destroy1.data.destroyed, after: afterDestroy.status, again: destroy2.status }));

  // 倍速：等待过程中切速度要立刻按新倍速跑完（重算本题的呈现时刻）
  const pvWait = await admin('/api/admin/preview', { body: { items: [
    { id: 'wt1', type: 'rating', title: '强制阅读 40 秒', min: 1, max: 5, limits: { wait: 40 } },
    { id: 'wt2', type: 'debrief', title: '结束', text: '完' }
  ] } });
  const wtBoot = await request('/api/preview/session', { body: { previewId: pvWait.previewId } });
  const beforeLeft = wtBoot.data.action.availableAtMs - wtBoot.data.nowMs;
  const speedRes = await request('/api/preview/speed', { body: { previewId: pvWait.previewId, speed: 20 } });
  const wtAfter = await request('/api/preview/bootstrap', {});
  const wtAgain = await request(`/api/preview/bootstrap?preview=${pvWait.previewId}&session=${wtBoot.data.session.id}`);
  const afterLeft = wtAgain.data.action.availableAtMs - wtAgain.data.nowMs;
  check('预览里改倍速会立刻重算当前这道题的等待（40 秒 → 约 2 秒）',
    speedRes.ok && beforeLeft > 30000 && afterLeft < 4000 && afterLeft > 0,
    `改前剩余 ${Math.round(beforeLeft / 1000)}s / 改后剩余 ${Math.round(afterLeft / 1000)}s`);
  check('负载带 timeScale（客户端倒计时按「设定秒数 × 倍速」显示，而不是缩水后的值）',
    wtAgain.data.timeScale === 20 && wtAgain.data.action.waitSec === 40,
    JSON.stringify({ timeScale: wtAgain.data.timeScale, waitSec: wtAgain.data.action.waitSec }));

  // 重复 / 迟到的提交带错 itemId：忽略并把最新进度回给客户端（不记到下一题上）
  const dup = await request('/api/preview/step', {
    body: { previewId: pvId, sessionId: pvBoot.data.session.id, itemId: 'not-the-current-one', ack: true }
  });
  check('itemId 不匹配的提交被忽略（不会静默记到下一题）',
    dup.status === 404 || (dup.ok && dup.data.ignored === true) || (dup.ok && dup.data.action),
    JSON.stringify(dup.data).slice(0, 100));

  // 预览（模拟试卷）只是内存态：从答题到结束，一行都不该写进数据库
  const pvNoDbItems = [
    { id: 'nd_gate', type: 'gate', title: '知情同意', text: '请阅读并同意', check: '我同意', button: '开始实验' },
    { id: 'nd_r1', type: 'rating', title: '预览题 1', min: 1, max: 5 },
    { id: 'nd_t1', type: 'text', title: '预览题 2', required: true },
    { id: 'nd_r2', type: 'rating', title: '预览题 3', min: 1, max: 5 },
    { id: 'nd_end', type: 'debrief', title: '结束说明', text: '感谢参与' }
  ];
  const dbCounts = () => withDb((db) => {
    const out = {};
    for (const name of ['sessions', 'messages', 'responses', 'questionnaires', 'experiments']) {
      out[name] = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
    }
    return out;
  });
  const pvNoDb = await admin('/api/admin/preview', { body: { items: pvNoDbItems } });
  const ndBoot = await request('/api/preview/session', { body: { previewId: pvNoDb.previewId } });
  const ndSid = ndBoot.data.session && ndBoot.data.session.id;
  const countsBefore = dbCounts();
  const liveQBefore = (await admin('/api/admin/questionnaires')).questionnaires.reduce((n, q) => n + q.sessionCount, 0);
  let pvAnswered = 0;
  for (let i = 0; i < 8; i += 1) {
    const boot = await request(`/api/preview/bootstrap?preview=${pvNoDb.previewId}&session=${ndSid}`);
    const a = boot.data.action;
    if (!a || !a.type) break;
    const body = { previewId: pvNoDb.previewId, sessionId: ndSid, itemId: a.itemId, ack: true };
    if (a.type === 'gate') { body.consent = true; body.text = 'PV-01'; }
    else if (a.type === 'rating') body.value = 5;
    else if (a.type === 'text') body.text = '预览试填内容';
    else if (!['debrief', 'confirm'].includes(a.type)) break;
    const out = await request('/api/preview/step', { body });
    if (!out.ok) break;
    pvAnswered += 1;
  }
  const pvFinished = await request('/api/preview/finish', { body: { previewId: pvNoDb.previewId, sessionId: ndSid } });
  const countsAfter = dbCounts();
  const liveQAfter = (await admin('/api/admin/questionnaires')).questionnaires.reduce((n, q) => n + q.sessionCount, 0);
  const changed = Object.keys(countsBefore).filter((k) => countsBefore[k] !== countsAfter[k]);
  check('预览里能正常作答并走完（模拟试卷可跑通）',
    pvAnswered >= 3 && pvFinished.ok,
    `预览作答 ${pvAnswered} 次，结束状态 ${pvFinished.data.session && pvFinished.data.session.status}`);
  check('预览全程不写库（5 张表行数一行未变）', changed.length === 0,
    changed.length ? changed.map((k) => k + ' ' + countsBefore[k] + '→' + countsAfter[k]).join('；') : 'sessions/messages/responses/questionnaires/experiments 均未变');
  check('预览不会增加任何问卷的被试会话数', liveQBefore === liveQAfter, `${liveQBefore} → ${liveQAfter}`);
  const pvGhost = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(ndSid).n);
  check('预览会话 id 不在数据库里', pvGhost === 0, String(pvGhost));

  // 倍速：预览的门控计时按倍速缩短（真实会话不受影响）
  const pvSpeedItems = [
    { id: 'sp1', type: 'confirm', title: '确认', text: '停留一下', button: '继续', limits: { wait: 40 } },
    { id: 'sp2', type: 'debrief', title: '结束', text: '完' }
  ];
  const pvS1 = await admin('/api/admin/preview', { body: { items: pvSpeedItems } });
  const b1 = await request(`/api/preview/session`, { body: { previewId: pvS1.previewId } });
  const waitBefore = b1.data.action.availableAtMs - b1.data.nowMs;
  await request('/api/preview/speed', { body: { previewId: pvS1.previewId, speed: 20 } });
  const b2 = await request(`/api/preview/session`, { body: { previewId: pvS1.previewId } });
  const waitAfter = b2.data.action.availableAtMs - b2.data.nowMs;
  check('预览倍速会缩短门控计时（40 秒 → 约 2 秒）',
    waitBefore > 30000 && waitAfter < 5000, `倍速前 ${Math.round(waitBefore / 1000)}s / 倍速后 ${Math.round(waitAfter / 1000)}s`);


  section('[10.4] 登录：记住密码（30 天签名 token）与改倍速后的窗口折算');
  const loginPlain = await request('/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD } });
  const loginRemember = await request('/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD, remember: true } });
  const tokenExp = (token) => {
    try { return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8')).exp || 0; } catch { return 0; }
  };
  const plainDays = (tokenExp(loginPlain.data.token) - Date.now()) / 86400000;
  const rememberDays = (tokenExp(loginRemember.data.token) - Date.now()) / 86400000;
  check('登录默认签发 1 天的 token', plainDays > 0.9 && plainDays < 1.1, plainDays.toFixed(2) + ' 天');
  check('勾「记住密码」签发 30 天的 token', rememberDays > 29 && rememberDays < 31, rememberDays.toFixed(2) + ' 天');
  const meRemember = await request('/api/auth/me', { token: loginRemember.data.token });
  check('记住密码的 token 可正常使用', meRemember.ok && meRemember.data.user && meRemember.data.user.username === 'admin',
    JSON.stringify(meRemember.data).slice(0, 80));
  const tampered = String(loginRemember.data.token).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  const badToken = await request('/api/auth/me', { token: tampered });
  check('篡改签名的 token 被拒（签名校验有效）', badToken.status === 401, String(badToken.status));
  const secretRow = withDb((db) => db.prepare("SELECT value FROM settings WHERE key = 'auth_secret'").get());
  check('签名密钥持久化在 settings（服务重启后 token 仍然有效）',
    !!secretRow && String(secretRow.value).length >= 32, secretRow ? String(secretRow.value).length + ' 字符' : '缺失');

  // 改倍速：最短提交 / 最长作答窗口必须一起折算 —— 否则客户端按新倍速显示会变成「设定值 × 倍速」
  const pvGate = await admin('/api/admin/preview', { body: { items: [
    { id: 'gm1', type: 'text', title: '最短提交 50 秒', required: true, limits: { minSubmit: 50, maxAnswer: 50 } },
    { id: 'gm2', type: 'debrief', title: '结束', text: '完' }
  ] } });
  const gmBoot = await request('/api/preview/session', { body: { previewId: pvGate.previewId } });
  const gmSid = gmBoot.data.session && gmBoot.data.session.id;
  const gmBefore = gmBoot.data.action;
  const leftBefore = gmBefore.minSubmitAtMs - gmBoot.data.nowMs;
  const ddlBefore = gmBefore.deadlineMs - gmBoot.data.nowMs;
  await request('/api/preview/speed', { body: { previewId: pvGate.previewId, speed: 10 } });
  const gmAfter = await request(`/api/preview/bootstrap?preview=${pvGate.previewId}&session=${gmSid}`);
  const gmAct = gmAfter.data.action;
  const leftAfter = gmAct.minSubmitAtMs - gmAfter.data.nowMs;
  const ddlAfter = gmAct.deadlineMs - gmAfter.data.nowMs;
  check('改倍速后「最短提交」窗口立刻按新倍速缩短（50s → 约 5s）',
    leftBefore > 45000 && leftAfter < 7000 && leftAfter > 0,
    `${Math.round(leftBefore / 1000)}s → ${Math.round(leftAfter / 1000)}s`);
  check('改倍速后「最长作答」窗口同样缩短（50s → 约 5s）',
    ddlBefore > 45000 && ddlAfter < 7000 && ddlAfter > 0,
    `${Math.round(ddlBefore / 1000)}s → ${Math.round(ddlAfter / 1000)}s`);
  // 连续切速：剩余时间只按比例折算**一次**（曾经的 bug：会话在 Map 里有两个键，被折算两遍 → 倍速被平方）
  const pvChain = await admin('/api/admin/preview', { body: { items: [
    { id: 'ch_wait', type: 'rating', title: '等待 100 秒', min: 1, max: 5, limits: { wait: 100, maxAnswer: 600 } },
    { id: 'ch_end', type: 'debrief', title: '结束', text: '完' }
  ], speed: 1 } });
  const chBoot = await request('/api/preview/session', { body: { previewId: pvChain.previewId } });
  const chSid = chBoot.data.session && chBoot.data.session.id;
  const chain = [];
  for (const sp of [1, 20, 5, 10]) {
    await request('/api/preview/speed', { body: { previewId: pvChain.previewId, speed: sp } });
    const b = await request(`/api/preview/bootstrap?preview=${pvChain.previewId}&session=${chSid}`);
    chain.push({ sp, left: Math.round((b.data.action.availableAtMs - b.data.nowMs) / 100) / 10, ts: b.data.timeScale });
  }
  check('连续切速只折算一次（1× 剩 100s → 20× 约 5s；若折算两次会变成 0.25s）',
    chain[1].left > 3 && chain[1].left < 7 && chain[1].ts === 20,
    chain.map((x) => x.sp + '×:' + x.left + 's').join(' → '));
  check('切到慢档会把剩余时间按比例拉长（20× → 5×：约 5s → 约 20s）',
    chain[2].left > 12 && chain[2].left < 30, chain.map((x) => x.sp + '×:' + x.left + 's').join(' → '));

  // 已经结束的窗口不许「复活」：切到更慢的倍速时，早就走完的强制等待不能要求重新等一遍
  const pvAlive = await admin('/api/admin/preview', { body: { items: [
    { id: 'al_wait', type: 'rating', title: '强制等待 4 秒', min: 1, max: 5, limits: { wait: 4, maxAnswer: 600 } },
    { id: 'al_end', type: 'debrief', title: '结束', text: '完' }
  ], speed: 20 } });
  const alBoot = await request('/api/preview/session', { body: { previewId: pvAlive.previewId } });
  const alSid = alBoot.data.session && alBoot.data.session.id;
  await new Promise((r) => setTimeout(r, 600));                        // 20× 下 4 秒只需 0.2 秒，等它走完
  const alBefore = await request(`/api/preview/bootstrap?preview=${pvAlive.previewId}&session=${alSid}`);
  const alLeftBefore = alBefore.data.action.availableAtMs - alBefore.data.nowMs;
  await request('/api/preview/speed', { body: { previewId: pvAlive.previewId, speed: 5 } });
  const alAfter = await request(`/api/preview/bootstrap?preview=${pvAlive.previewId}&session=${alSid}`);
  const alLeftAfter = alAfter.data.action.availableAtMs - alAfter.data.nowMs;
  check('切到更慢的倍速，已经结束的强制等待不会「复活」',
    alLeftBefore < 0 && alLeftAfter < 0,
    `切速前 ${Math.round(alLeftBefore)}ms / 切 5× 后 ${Math.round(alLeftAfter)}ms`);

  check('倒计时显示 = 设定秒数（真实剩余 × 倍速，不会变成 500 秒）',
    Math.abs((leftAfter * gmAct.timeScale) / 1000 - gmAct.minSubmitSec) < 1.5,
    `显示约 ${Math.round((leftAfter * gmAct.timeScale) / 1000)}s / 设定 ${gmAct.minSubmitSec}s`);

  section('[10.5] 富文本字号：复制过来的字号识别（吸附到号数档位，且幂等）');
  const RT2 = require('../public/assets/richtext.js');
  const sizeCases = [
    ['<span style="font-size:12.0pt">x</span>', 16, '小四'],
    ['<span style="font-size:11pt">x</span>', 14, '五号'],
    ['<span style="font-size:13.5pt">x</span>', 19, '四号'],
    ['<span style="font-size:36pt">x</span>', 48, '小初'],
    ['<span style="font-size:48px">x</span>', 48, '小初'],
    ['<span style="font-size:1.2em">x</span>', 16, '小四'],
    ['<font size="4">x</font>', 19, '四号'],
    ['<span style="font-size:52px">x</span>', 48, '小初']
  ];
  const sizeBad = sizeCases.filter(([html, want]) => {
    const out = RT2.sanitizeHtml(html);
    const m = /font-size:\s*(\d+)px/.exec(out);
    return !m || Number(m[1]) !== want;
  });
  check('粘贴 / 复制的字号折算并吸附到最近号数档位（pt / em / font size / 大字号）',
    sizeBad.length === 0, sizeBad.map(([h]) => h + ' → ' + RT2.sanitizeHtml(h)).join('；'));
  const idemBad = sizeCases.filter(([html]) => {
    const a = RT2.sanitizeHtml(html);
    return RT2.sanitizeHtml(a) !== a || RT2.sanitizeHtml(RT2.sanitizeHtml(a)) !== a;
  });
  check('字号清洗是幂等的（粘贴 → 保存 → 被试端渲染三次不漂移）', idemBad.length === 0,
    idemBad.map(([h]) => h).join('；'));
  check('档位表与编辑器下拉同源（11 档，正文 14px）',
    RT2.FONT_SIZE_PRESETS.length === 11 && RT2.BODY_FONT_PX === 14 && RT2.FONT_SIZE_PRESETS.some((x) => x.px === 48 && x.label === '小初'),
    JSON.stringify(RT2.FONT_SIZE_PRESETS.map((x) => x.label + x.px)));

  section('[11] 清理与设置还原');
  await admin('/api/admin/questionnaire/delete', { body: { id: qC.id, force: true } });
  await admin('/api/admin/questionnaire/delete', { body: { id: qA.id, force: true } });
  await admin('/api/admin/questionnaire/delete', { body: { id: qB.id, force: true } });
  const restQ = (await admin('/api/admin/questionnaires')).questionnaires;
  check('夹具问卷已清理', restQ.every((q) => q.title !== Q_A && q.title !== Q_B && q.title !== Q_C && q.title !== Q_D));
  await admin('/api/admin/settings', { body: { resumeWindowHours: settings.resumeWindowHours } });
  const restored = (await admin('/api/admin/settings')).settings;
  check('全局设置已还原', restored.resumeWindowHours === settings.resumeWindowHours);

  console.log(`\n断言通过 ${passed} 项，失败 ${failures.length} 项`);
  console.log(`总耗时 ${((Date.now() - RUN_STARTED) / 1000).toFixed(1)}s（门控靠回拨快进，不真实等待）`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('ALL PASS ✓');
}

main().catch((err) => { console.error('平台层自检异常：', err.message); process.exit(1); });
