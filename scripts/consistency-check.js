// 一致性自检（统一题目模型）
// 验证目标：
//   1) 题目顺序与作答单元展开正确：38 道题 → 28 个作答单元（消息类自动跳过）
//   2) 同问卷两个会话按相同作答序列走完，AI 消息序列逐字一致
//   3) 组别3 / 组别4：仅「任务要求」两处不同，其余消息逐字一致
//   4) 计时门控（服务端权威）：延迟发出 / 作答前强制等待 / 最短提交 / 最长作答（共用窗口）
//   5) 落库：按题目记录（item_id / 题型 / 值 / 文本 / 呈现与作答时间戳 / 耗时）
//   6) 数据页与 xlsx 导出（汇总一被试一行 + 作答明细）
//   7) 中途退出恢复窗口三态；自检不留残留、不污染设置
// 用法：先启动服务（npm start），再执行：node scripts/consistency-check.js
'use strict';

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const zlib = require('node:zlib');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const DB_FILE = path.join(__dirname, '..', 'data.db');

const EXP_NAME = '自检实验模板';
const Q_NAME = '自检问卷';
const Q_NAME_2 = '自检问卷·组别4';
const TINY = { delay: 1, wait: 1, minSubmit: 1, maxAnswer: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

async function request(route, options = {}) {
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const res = await fetch(BASE + route, {
    method: options.body ? 'POST' : 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
}

let adminToken = '';
async function admin(route, options = {}) {
  const res = await request(route, { ...options, token: adminToken });
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

/* ---------------------------------------------------------------- zip 读取（校验 xlsx） */
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
function unzipSheetNames(buf) {
  return [...unzipEntry(buf, 'xl/workbook.xml').matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => m[1]);
}
function backdateSession(sessionId, hoursAgo) {
  const db = new DatabaseSync(DB_FILE);
  db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString(), sessionId);
  db.close();
}

/* ---------------------------------------------------------------- 驱动 */
// 确定性作答：按题型给出可预期的值
function answerBody(action, seed) {
  switch (action.type) {
    case 'gate': return { consent: true };
    case 'debrief': return { ack: true };
    case 'rating': return { value: 3 };
    case 'single': return { value: action.options.length >= 3 ? 3 : 2 };
    case 'multi': return { values: [1, Math.min(2, action.options.length)] };
    case 'rank': return { order: action.options.map((o) => o.value) };
    case 'text': return { text: `作品${seed}` };
    case 'group': return { answers: (action.subs || []).map((sub) => (sub.type === 'text' ? { text: `作品${seed}` } : { value: 1 })) };
    default: return {};
  }
}

async function walk(questionnaireId, { record } = {}) {
  const created = await request('/api/session', { body: { q: questionnaireId } });
  if (!created.ok) throw new Error('创建会话失败: ' + JSON.stringify(created.data));
  const sessionId = created.data.session.id;
  let action = created.data.action;
  const messages = created.data.messages.map((m) => ({ role: m.role, content: m.content }));

  let guard = 0;
  let seed = 0;
  const seen = [];
  const flags = { delay: false, wait: false, window: false, shared: false, autoSubmit: false };

  while (action && guard++ < 120) {
    if (!seen.includes(`${action.type}:${action.itemId}`)) seen.push(`${action.type}:${action.itemId}`);
    if (action.availableAtMs && action.availableAtMs > (action.nowMs || 0)) flags.wait = true;
    if (action.minSubmitAtMs || action.deadlineMs) flags.window = true;
    if (action.sharedWindow) flags.shared = true;
    if (action.type === 'group' && (action.minSubmitAtMs || action.deadlineMs)) flags.groupWindow = true;

    if (action.type === 'text' || action.type === 'group') seed += 1;
    const res = await request('/api/step', { body: { sessionId, elapsedMs: 400, ...answerBody(action, seed) } });
    if (res.status === 400 && res.data.error === 'too_early') {
      await sleep(Math.max(0, (res.data.availableAtMs || 0) - Date.now()) + 60);
      continue;
    }
    if (!res.ok) throw new Error('step 失败: ' + JSON.stringify(res.data));
    if (res.data.pendingAt) flags.delay = true;
    messages.push({ role: 'user', content: '(echo)' });
    for (const m of res.data.messages) messages.push({ role: m.role, content: m.content });
    action = res.data.action;
    if (res.data.session.status === 'completed') break;
  }
  if (record) Object.assign(record, { seen, flags, messages, sessionId, finished: !action });
  return { sessionId, messages, action, seen, flags };
}

/* ---------------------------------------------------------------- 主流程 */

async function cleanup() {
  const login = await request('/api/admin/login', { body: { password: ADMIN_PASSWORD } });
  if (!login.ok) throw new Error('管理端登录失败，请确认服务已启动');
  adminToken = login.data.token;
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
  console.log('一致性自检（统一题目模型）');
  console.log(`服务：${BASE}\n`);
  await cleanup();

  // 0) 自检模板：复制组别3 并把题目级计时改小，便于快速走查
  const base = (await admin('/api/admin/experiment?id=group3-high-clarity')).experiment;
  const tinyItems = base.items.map((it) => {
    const limits = { ...it.limits };
    if (limits.delay) limits.delay = TINY.delay;
    if (limits.wait) limits.wait = TINY.wait;
    if (limits.minSubmit) limits.minSubmit = TINY.minSubmit;
    if (limits.maxAnswer) limits.maxAnswer = TINY.maxAnswer;
    return { ...it, limits };
  });
  const exp = (await admin('/api/admin/experiment/create', { body: { name: EXP_NAME, copyFrom: 'group3-high-clarity' } })).experiment;
  await admin('/api/admin/experiment/update', { body: { id: exp.id, name: EXP_NAME, timing: { delay: 0, wait: 0, minSubmit: 0, maxAnswer: 0 }, items: tinyItems } });

  // 问卷1：默认 4 题 + 插入自检模板题目 + 收尾
  const q1 = (await admin('/api/admin/questionnaire/create', { body: { title: Q_NAME, timing: { delay: 0, wait: 0, minSubmit: 0, maxAnswer: 0 } } })).questionnaire;
  const parts = [...q1.items];
  const tail = parts.splice(parts.length - 2, 2);
  const copies = tinyItems.map((it, i) => ({ ...it, id: `t0_${i}_${it.id}`, fromTemplateId: exp.id, fromTemplateName: EXP_NAME }));
  const q1Full = (await admin('/api/admin/questionnaire/update', { body: { id: q1.id, title: Q_NAME, timing: q1.timing, items: [...parts, ...copies, ...tail] } })).questionnaire;

  // 问卷2：复制组别4 的原始问卷（用于组间逐字比对）
  const g4 = (await admin('/api/admin/questionnaires')).questionnaires.find((x) => /组别4/.test(x.title));
  const q2Full = (await admin('/api/admin/questionnaire/create', { body: { title: Q_NAME_2, copyFrom: g4.id } })).questionnaire;

  console.log('\n[1] 题目模型与作答单元展开');
  check('自检问卷题目数 = 2 + 36 + 2 = 40', q1Full.items.length === 40, String(q1Full.items.length));
  const uniqTypes = [...new Set(q1Full.items.map((i) => i.type))].sort();
  check('使用到的题型都在 9 种之内', uniqTypes.every((t) => ['message', 'gate', 'debrief', 'group', 'rating', 'single', 'multi', 'text', 'rank'].includes(t)), uniqTypes.join(','));
  check('量表 = 多道打分题（20 道打分题）', q1Full.items.filter((i) => i.type === 'rating').length === 20);
  const groups = q1Full.items.filter((i) => i.type === 'group');
  check('创作 = 2 个题组（各 2 道文本子题）',
    groups.length === 2 && groups.every((g) => g.subs.length === 2 && g.subs.every((x) => x.type === 'text')),
    JSON.stringify(groups.map((g) => g.subs.map((x) => x.title))));
  check('作答门控默认全为 0（无限制）', ['delay', 'wait', 'minSubmit', 'maxAnswer'].every((k) => q1Full.timing[k] === 0), JSON.stringify(q1Full.timing));
  check('呈现节奏默认值（思考 420ms / 流式 11ms 每字）',
    q1Full.timing.thinkMs === 420 && q1Full.timing.typeMs === 11, JSON.stringify(q1Full.timing));

  console.log('\n[2] 同问卷逐字一致 + 环节序列');
  const recA = {};
  const recB = {};
  const sesA = await walk(q1Full.id, { record: recA });
  const sesB = await walk(q1Full.id, { record: recB });
  check('流程走完（会话已完成）', recA.finished && recB.finished);
  // 期望序列直接由问卷题目推导：除 message 外每道题一个作答单元
  const expectSeq = q1Full.items.filter((it) => it.type !== 'message').map((it) => `${it.type}:${it.id}`);
  check('环节序列与预期一致（28 个作答单元）', JSON.stringify(recA.seen) === JSON.stringify(expectSeq),
    `实际 ${recA.seen.length} 项：${recA.seen.join(' ')}`);
  const aiA = recA.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  const aiB = recB.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  check('同问卷两会话 AI 消息条数一致', aiA.length === aiB.length, `${aiA.length} vs ${aiB.length}`);
  check('同问卷两会话 AI 消息逐字一致', aiA.every((t, i) => t === aiB[i]),
    aiA.length === aiB.length ? `首个差异 ${aiA.findIndex((t, i) => t !== aiB[i]) + 1}` : '');

  console.log('\n[3] 组别3 / 组别4 差异');
  const sesC = await walk(q2Full.id, {});
  const aiC = sesC.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  const diff = [];
  for (let i = 0; i < Math.max(aiA.length, aiC.length); i += 1) if (aiA[i] !== aiC[i]) diff.push(i + 1);
  check('两组消息条数一致', aiA.length === aiC.length, `${aiA.length} vs ${aiC.length}`);
  check('两组差异恰为「任务要求」两处', diff.length === 2, `差异位置 ${diff.join(', ')}`);
  if (diff.length === 2) {
    const [p1, p2] = diff;
    check('差异内容为任务要求且组内两处相同',
      aiA[p1 - 1].startsWith('【青柠气泡水') && aiA[p1 - 1] === aiA[p2 - 1] && aiC[p1 - 1] === aiC[p2 - 1] && aiA[p1 - 1] !== aiC[p1 - 1]);
  }

  console.log('\n[4] 计时门控');
  check('触发过延迟发出的等待', recA.flags.delay);
  check('触发过作答前强制等待', recA.flags.wait);
  check('触发过最短提交 / 最长作答时间窗', recA.flags.window);
  check('创作题组承载最短提交 / 最长作答窗口', recA.flags.groupWindow === true, JSON.stringify(recA.flags));

  console.log('\n[5] 落库核验');
  const detail = await admin(`/api/admin/questionnaire/session?id=${q1Full.id}&sid=${sesA.sessionId}`);
  // 题组一次提交写入多行（2 个题组 × 2 子题），故总行数 = 26 单元 + 2 额外子题 = 28
  check('作答记录 28 行（26 个作答单元，其中 2 个题组各多 1 行子题）', detail.responses.length === 28, String(detail.responses.length));
  check('题组子题按行落库（含文本）', detail.responses.filter((r) => r.itemType === 'text' && r.text).length === 4);
  check('单选题带对错判定', detail.responses.some((r) => r.itemType === 'single' && (r.isCorrect === '正确' || r.isCorrect === '错误')));
  check('量表题标签归入量表', detail.responses.some((r) => /目标清晰度测量 第 1 题/.test(r.itemLabel)));
  check('呈现/作答时间戳齐全且顺序合理',
    detail.responses.every((r) => r.presentedAt && r.answeredAt && Date.parse(r.presentedAt) <= Date.parse(r.answeredAt) + 1000));
  check('对话流含延迟反馈全文', detail.messages.some((m) => m.content.startsWith('很感谢你的认真创作')));

  console.log('\n[6] 数据页与导出');
  const list = await admin(`/api/admin/questionnaire/sessions?id=${q1Full.id}`);
  check('会话列表含 2 位被试', list.sessions.length === 2, String(list.sessions.length));
  check('会话作答进度 = 28', list.sessions.every((s) => s.answerCount === 28));
  const xlsxRes = await fetch(`${BASE}/api/admin/questionnaire/export.xlsx?id=${q1Full.id}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const buf = Buffer.from(await xlsxRes.arrayBuffer());
  check('xlsx 导出可用（PK 头）', xlsxRes.ok && buf.slice(0, 2).toString() === 'PK', `${buf.length} 字节`);
  const sheets = unzipSheetNames(buf);
  check('含「汇总（一被试一行）」与「作答明细」两个 sheet',
    sheets.includes('汇总（一被试一行）') && sheets.includes('作答明细'), sheets.join(' / '));
  const s1 = unzipEntry(buf, 'xl/worksheets/sheet1.xml');
  check('汇总表含量表均分与两次作品列',
    /目标清晰度测量（均分）/.test(s1) && /广告语/.test(s1) && /创作说明（选填）/.test(s1) && /注意力检测·是否正确/.test(s1));
  check('汇总表含被试作品文本', /作品1|作品2/.test(s1));

  console.log('\n[7] 中途退出与恢复窗口');
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

  console.log('\n[8] 清理与设置还原');
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

  console.log(`\n断言通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('ALL PASS ✓');
}

main().catch((err) => { console.error('自检异常：', err.message); process.exit(1); });
