// 并发基线测量：一位被试的请求数 + 单请求服务端耗时 + 并发突发的压测（用于评估 VPS 承载能力）
// 用法：先启动服务，再执行 npm run probe（可用 CONCURRENCY=300 调整并发规模）
'use strict';

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PROBE_Q = '压测探针问卷';

// 自带夹具：不复制任何实验内容，所以改文案、改题量、删预设问卷都不会让压测失效。
// 重量贴近真实问卷——长反馈正文（360+ 字）、题组双空、量表多题，测出来的开销才有参考意义。
const LONG_TEXT = '【压测夹具·反馈正文】请对照任务要求检查你的创作，以下逐条说明改进方向。'.repeat(6);
function fixtureItems() {
  return [
    { id: 'welcome', type: 'message', title: '欢迎语', text: '【压测夹具】欢迎参加。' },
    {
      id: 'consent', type: 'gate', title: '知情同意说明', text: '【压测夹具】请阅读并勾选同意。',
      check: '我已阅读并同意', button: '开始实验', variant: 'id', idLabel: '被试编号', idPlaceholder: '请填写编号'
    },
    { id: 'task', type: 'message', title: '任务要求', text: '【压测夹具·任务要求】请为新品写一句广告语，并说明创作思路。' },
    { id: 'sc_1', type: 'rating', title: '我清楚任务目标。', min: 1, max: 5, anchor: '1 = 完全不同意　·　5 = 完全同意' },
    { id: 'sc_2', type: 'rating', title: '我知道评价标准。', min: 1, max: 5, anchor: '1 = 完全不同意　·　5 = 完全同意' },
    { id: 'sc_3', type: 'rating', title: '我清楚努力方向。', min: 1, max: 5, anchor: '1 = 完全不同意　·　5 = 完全同意' },
    {
      id: 'work', type: 'group', title: '内容创作', text: '', layout: 'column',
      subs: [
        { id: 'slogan', type: 'text', title: '广告语', required: true, rows: 1, maxLen: 20, placeholder: '请输入广告语' },
        { id: 'note', type: 'text', title: '创作说明（选填）', required: false, rows: 2, maxLen: 50, placeholder: '可简要说明' }
      ]
    },
    { id: 'feedback', type: 'message', title: '负面反馈输出', text: LONG_TEXT, thinking: '【压测夹具·思考过程】先读题，再对照标准推演改进方向。' },
    { id: 'confirm', type: 'confirm', title: '阅读确认页', text: '【压测夹具】请确认你已阅读完上面的反馈。', button: '我已阅读完' },
    { id: 'attention', type: 'single', title: '注意力检测', options: ['选项甲', '选项乙', '选项丙'] },
    { id: 'debrief', type: 'debrief', title: '结束', text: '【压测夹具】已结束。' }
  ];
}

async function req(route, options = {}) {
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.headers) Object.assign(headers, options.headers);
  const res = await fetch(BASE + route, {
    method: options.body ? 'POST' : 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
}

// 每个模拟被试用自己的来源 IP：真实场景里被试各在各的网络，而「开始作答」是按 IP 限流的——
// 全用同一个 IP 会把「一个班同时扫码」误判成单源洪水（前提是本机直连，服务端才会信任这个头）
const xff = (i) => ({ 'X-Forwarded-For': `198.18.${Math.floor(i / 254)}.${(i % 254) + 1}` });

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
}

async function main() {
  const loginRes = await req('/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD } });
  if (!loginRes.ok) {
    throw new Error(loginRes.status === 429
      ? '管理端登录被限流（429）：同一账号/IP 每分钟登录次数超限，等 1 分钟再试；'
        + '或把 RATE_LOGIN_PER_MIN / RATE_LOGIN_USER_PER_MIN 调大后重启服务'
      : `管理端登录失败（${loginRes.status}）：请确认服务已启动、ADMIN_PASSWORD 正确`);
  }
  token = loginRes.data.token;
  await cleanup();

  // 探针问卷：直接用自带夹具建，不依赖任何实验内容；题目都没配计时参数，
  // wait / minSubmit / maxAnswer 都取默认 0，所以能立刻走完，不用真实等待
  const q = (await admin('/api/admin/questionnaire/create', { body: { title: PROBE_Q, items: fixtureItems() } })).questionnaire;

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
    // 知情同意页的「含编号」形态要求填编号，不填会被服务端拒
    if (a.type === 'gate') return { consent: true, text: '压测编号' };
    if (a.type === 'confirm' || a.type === 'debrief') return { ack: true };
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

  // ---- 并发「开始作答」压测：一个班同时扫码点开始的真实突发
  const concurrency = Number(process.env.CONCURRENCY) || 300;
  const startedAt = performance.now();
  const createRes = await Promise.all(Array.from({ length: concurrency }, (_, i) =>
    (async () => {
      const t = performance.now();
      const r = await req('/api/session', { headers: xff(i), body: { q: q.id } });
      return { ...r, ms: performance.now() - t };
    })()
  ));
  const createWall = performance.now() - startedAt;
  const createOk = createRes.filter((r) => r.ok);
  const failed = createRes.filter((r) => !r.ok);
  const cSorted = createOk.map((r) => r.ms).sort((a, b) => a - b);
  const cP95 = cSorted.length ? cSorted[Math.min(cSorted.length - 1, Math.floor(cSorted.length * 0.95))] : 0;
  const failedByStatus = failed.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  console.log(`\n并发压测 A（${concurrency} 人同一时刻「开始作答」）：`);
  console.log(`  成功 ${createOk.length}/${concurrency}${failed.length ? ` · 失败 ${JSON.stringify(failedByStatus)}` : ''}`);
  console.log(`  总耗时 ${createWall.toFixed(0)}ms · 等效 ${(createOk.length / (createWall / 1000)).toFixed(0)} QPS · 单请求 p95 ${cP95.toFixed(0)}ms`);
  if (failed.length) {
    const sample = failed.slice(0, 3).map((r) => `${r.status} ${r.data.error || ''}`).join(' | ');
    console.log(`  失败样例：${sample}`);
  }
  const sessions = createOk.map((r) => ({ id: r.data.session.id, action: r.data.action }));

  // ---- 并发提交压测：同一时刻提交同一步作答
  const t0 = performance.now();
  const results = await Promise.all(sessions.map((s) => req('/api/step', { body: { sessionId: s.id, elapsedMs: 400, ...body(s.action) } })));
  const wall = performance.now() - t0;
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n并发压测 B（${sessions.length} 个会话同一时刻提交同一步作答）：`);
  console.log(`  成功 ${ok}/${sessions.length} · 总耗时 ${wall.toFixed(0)}ms · 等效 ${(sessions.length / (wall / 1000)).toFixed(0)} QPS`);

  await admin('/api/admin/questionnaire/delete', { body: { id: q.id, force: true } });
  console.log('\n探针数据已清理');
}

main().catch((err) => { console.error('压测异常：', err.message); process.exit(1); });
