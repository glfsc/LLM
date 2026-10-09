// 并发基线测量：一位被试的请求数 + 单请求服务端耗时 + 并发提交压测（用于评估 2C2G 承载能力）
// 用法：先启动服务，再执行 npm run probe（可用 CONCURRENCY=300 调整并发规模）
'use strict';

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PROBE_EXP = '压测探针模板';
const PROBE_Q = '压测探针问卷';

async function req(route, options = {}) {
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

let token = '';
const admin = async (route, options = {}) => {
  const r = await req(route, { ...options, token });
  if (!r.ok) throw new Error(`${route} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

async function cleanup() {
  for (const q of (await admin('/api/admin/questionnaires')).questionnaires) {
    if (q.title === PROBE_Q) await admin('/api/admin/questionnaire/delete', { body: { id: q.id, force: true } });
  }
  for (const e of (await admin('/api/admin/experiments')).experiments) {
    if (e.name === PROBE_EXP) await admin('/api/admin/experiment/delete', { body: { id: e.id } });
  }
}

async function main() {
  token = (await req('/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD } })).data.token;
  await cleanup();

  // 探针问卷：复制组别3 模板并把题目级参数清零（wait / minSubmit / maxAnswer 归零），便于快速走完
  const exp = (await admin('/api/admin/experiment/create', { body: { name: PROBE_EXP, copyFrom: 'group3-high-clarity' } })).experiment;
  const items = exp.items.map((it) => ({ ...it, limits: {} }));
  await admin('/api/admin/experiment/update', { body: { id: exp.id, name: PROBE_EXP, items } });
  const g3 = (await admin('/api/admin/questionnaires')).questionnaires.find((x) => /组别3/.test(x.title));
  const q = (await admin('/api/admin/questionnaire/create', { body: { title: PROBE_Q, copyFrom: g3.id } })).questionnaire;
  const qFull = (await admin(`/api/admin/questionnaire?id=${q.id}`)).questionnaire;
  const cleanItems = qFull.items.map((it) => ({ ...it, limits: {} }));
  await admin('/api/admin/questionnaire/update', { body: { id: q.id, title: PROBE_Q, items: cleanItems } });

  // ---- 一位被试的请求数与单请求耗时
  const timings = [];
  let requestCount = 0;
  const timed = async (label, fn) => {
    const t0 = performance.now();
    const out = await fn();
    const ms = performance.now() - t0;
    requestCount += 1;
    timings.push({ label, ms });
    return out;
  };

  await timed('GET /api/bootstrap（首屏）', () => req(`/api/bootstrap?q=${q.id}`));
  const session = await timed('POST /api/session（建会话）', () => req('/api/session', { body: { q: q.id } }));
  const sessionId = session.data.session.id;
  let action = session.data.action;

  const body = (a) => {
    if (a.type === 'gate') return { consent: true };
    if (a.type === 'debrief') return { ack: true };
    if (a.type === 'rating') return { value: 3 };
    if (a.type === 'single') return { value: 1 };
    if (a.type === 'multi') return { values: [1] };
    if (a.type === 'rank') return { order: a.options.map((o) => o.value) };
    if (a.type === 'group') return { answers: (a.subs || []).map((sub) => (sub.type === 'text' ? { text: '压测文案' } : sub.type === 'rating' ? { value: Number(sub.min) || 1 } : { value: 1 })) };
    return { text: '压测文案' };
  };

  let guard = 0;
  while (action && guard++ < 60) {
    const r = await timed(`POST /api/step（${action.type}）`, () => req('/api/step', { body: { sessionId, elapsedMs: 500, ...body(action) } }));
    if (!r.ok) throw new Error('step 失败: ' + JSON.stringify(r.data));
    action = r.data.action;
    if (r.data.session.status === 'completed') break;
  }
  await timed('GET /api/bootstrap（结单后刷新）', () => req(`/api/bootstrap?q=${q.id}&session=${sessionId}`));

  const sorted = [...timings].sort((a, b) => a.ms - b.ms);
  const avg = timings.reduce((n, t) => n + t.ms, 0) / timings.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const max = sorted[sorted.length - 1];

  console.log('一位被试的完整流程：');
  console.log(`  服务器请求总数：${requestCount} 次（其中作答提交 ${timings.filter((t) => t.label.startsWith('POST /api/step')).length} 次）`);
  console.log(`  单请求服务端耗时：平均 ${avg.toFixed(1)}ms · p95 ${p95.ms.toFixed(1)}ms · 最大 ${max.ms.toFixed(1)}ms（含网络往返）`);
  console.log(`  最慢的 3 次：${sorted.slice(-3).map((t) => `${t.label}=${t.ms.toFixed(0)}ms`).join(' | ')}`);

  // ---- 并发提交压测
  const concurrency = Number(process.env.CONCURRENCY) || 300;
  const sessions = [];
  for (let i = 0; i < concurrency; i += 1) {
    const r = await req('/api/session', { body: { q: q.id } });
    sessions.push({ id: r.data.session.id, action: r.data.action });
  }
  const t0 = performance.now();
  const results = await Promise.all(sessions.map((s) => req('/api/step', { body: { sessionId: s.id, elapsedMs: 400, ...body(s.action) } })));
  const wall = performance.now() - t0;
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n并发压测（${concurrency} 个会话同一时刻提交同一步作答）：`);
  console.log(`  成功 ${ok}/${concurrency} · 总耗时 ${wall.toFixed(0)}ms · 等效 ${(concurrency / (wall / 1000)).toFixed(0)} QPS`);

  await admin('/api/admin/questionnaire/delete', { body: { id: q.id, force: true } });
  await admin('/api/admin/experiment/delete', { body: { id: exp.id } });
  console.log('\n探针数据已清理');
}

main().catch((err) => { console.error('压测异常：', err.message); process.exit(1); });
