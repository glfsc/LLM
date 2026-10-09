// 本地模拟被试：向指定问卷灌入若干条模拟作答数据
// 走的是被试端真实接口（/api/session → /api/step → /api/finish），与手机扫码提交完全同一条路径，
// 因此可用于在电脑上完整验证「被试提交 → 管理端数据页可见 → 导出 Excel」这条链路。
//
// 用法：先启动服务（npm start，或双击「启动预实验.bat」），再执行：
//   node scripts/simulate-subjects.js                 # 对第一份问卷模拟 5 位被试（快速模式）
//   node scripts/simulate-subjects.js --n 20          # 模拟 20 位
//   node scripts/simulate-subjects.js --q uegnugph    # 指定问卷 id（用 --list 查看）
//   node scripts/simulate-subjects.js --incomplete 2  # 额外留 2 份中途退出（状态：进行中）
//   node scripts/simulate-subjects.js --real          # 直接写入源问卷并按真实计时（忠实但很慢）
//   node scripts/simulate-subjects.js --list          # 只列出问卷，不产生数据
//   BASE=http://localhost:3000 ADMIN_PASSWORD=admin123 node scripts/simulate-subjects.js
//
// 两种模式：
//   快速（默认）：不改动源问卷，而是建一份「源问卷名（模拟数据）」的副本，去掉题目级计时门控，
//                数据灌进副本。原因是实验题的门控（如「内容创作」最短 180 秒）写在题目级 limits 上、
//                优先于问卷默认值，不绕过就只能按真实节奏等。副本可随时在管理端删除。
//   真实（--real）：直接写入源问卷，按真实计时跑，含全部硬性门控，每位被试约数分钟。
// 两种模式写入的作答耗时（elapsed_ms）都是真实量级，导出里的「耗时」列可直接用于核对格式。
'use strict';

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { n: 5, incomplete: 0, q: null, list: false, real: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--real') out.real = true;
    else if (a === '--n') out.n = Number(argv[++i]) || 0;
    else if (a === '--q') out.q = argv[++i] || null;
    else if (a === '--incomplete') out.incomplete = Number(argv[++i]) || 0;
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`未知参数：${a}`); out.help = true; }
  }
  return out;
}

let token = '';
async function request(route, options = {}) {
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + route, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// 按题型生成「有变化」的作答：同一批被试之间数值不同，便于在数据页看出差异
function answerBody(action, subject, seed) {
  const pick = (n) => 1 + ((subject * 3 + seed) % n);
  switch (action.type) {
    case 'gate': return { consent: true };
    // 阅读确认页（如「用户阅读AI反馈」）：服务端要的是 ack，漏了会被拒（invalid_answer）
    case 'confirm': return { ack: true };
    case 'debrief': return { ack: true };
    case 'rating': return { value: 1 + ((subject * 2 + seed) % 5) };
    case 'single': return { value: pick(action.options.length) };
    case 'multi': {
      const opts = action.options.map((o) => o.value);
      const first = opts[(subject + seed) % opts.length];
      const second = opts[(subject + seed + 1) % opts.length];
      return { values: first === second ? [first] : [first, second] };
    }
    case 'rank': {
      const order = action.options.map((o) => o.value);
      if (subject % 2 === 1) order.reverse();
      return { order };
    }
    case 'text': return { text: `模拟被试${subject}的作品${seed}` };
    case 'group': return {
      answers: (action.subs || []).map((sub) => (sub.type === 'text'
        ? { text: `模拟被试${subject}的作品${seed}` }
        : { value: 1 + ((subject + seed) % Math.max(1, (sub.options || []).length || 3)) }))
    };
    default: return {};
  }
}

// 走完一位被试的完整流程；stopEarly=true 时答完两个单元就离开，留一条「进行中」记录
async function runSubject(questionnaireId, subject, stopEarly) {
  const created = await request('/api/session', { body: { q: questionnaireId } });
  if (!created.ok) throw new Error(`创建会话失败：${JSON.stringify(created.data)}`);
  const sessionId = created.data.session.id;
  let action = created.data.action;

  let guard = 0;
  let seed = 0;
  let answered = 0;
  while (action && guard++ < 200) {
    if (action.type === 'text' || action.type === 'group') seed += 1;
    // 每位被试的作答耗时不同，导出后「耗时」列不会千篇一律
    const elapsedMs = 700 + ((subject * 137 + answered * 89) % 2200);
    const res = await request('/api/step', {
      body: { sessionId, elapsedMs, ...answerBody(action, subject, seed) }
    });
    if (res.status === 400 && res.data.error === 'too_early') {
      await sleep(Math.max(0, (res.data.availableAtMs || 0) - Date.now()) + 60);
      continue;
    }
    if (!res.ok) throw new Error(`作答失败：${JSON.stringify(res.data)}`);
    answered += 1;
    action = res.data.action;
    if (res.data.session && res.data.session.status === 'completed') break;
    if (stopEarly && answered >= 2) break;
  }
  const finished = !action;
  if (action && !stopEarly) await request('/api/finish', { body: { sessionId } });
  return { sessionId, answered, completed: finished };
}

// 快速模式的安全实现：不改动原问卷，而是建一份「去掉题目级计时门控」的副本，
// 数据灌进副本，原问卷配置与数据完全不受影响。重复执行会复用同一份副本。
// 之所以要单独建副本：实验题里有硬性门控（如内容创作最短 180 秒），
// 这些门控写在题目级 limits 上、优先于问卷默认值，直接改问卷默认值无法绕过。
async function ensureFastTarget(target, knownQuestionnaires) {
  const copyTitle = `${target.title}（模拟数据）`;
  const existing = knownQuestionnaires.find((q) => q.title === copyTitle);
  if (existing) {
    console.log(`复用已有模拟问卷：${copyTitle}（${existing.id}）`);
    return existing.id;
  }

  const got = await request('/api/admin/questionnaire?id=' + encodeURIComponent(target.id));
  if (!got.ok) throw new Error(`读取问卷失败：${JSON.stringify(got.data)}`);
  const src = got.data.questionnaire;
  const stripped = (src.items || []).map((it) => {
    const copy = { ...it };
    delete copy.limits; // 去掉题目级门控，作答不再需要等待
    return copy;
  });

  const created = await request('/api/admin/questionnaire/create', {
    body: { title: copyTitle, items: stripped }
  });
  if (!created.ok) throw new Error(`创建模拟问卷失败：${JSON.stringify(created.data)}`);
  console.log(`已创建模拟问卷：${copyTitle}（${created.data.questionnaire.id}）`);
  return created.data.questionnaire.id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node scripts/simulate-subjects.js [--n 5] [--q <问卷id>] [--incomplete 2] [--real] [--list]');
    console.log('      BASE=http://localhost:3000（默认）  ADMIN_PASSWORD=admin123（默认）');
    return;
  }

  const login = await request('/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD } });
  if (!login.ok) {
    console.error(`登录失败（${login.status}）：${JSON.stringify(login.data)}`);
    console.error(`请确认服务已启动（${BASE}），且管理员密码正确（当前 ADMIN_PASSWORD=${ADMIN_PASSWORD}）。`);
    process.exit(1);
  }
  token = login.data.token;

  const listed = await request('/api/admin/questionnaires');
  const questionnaires = (listed.data.questionnaires || []).filter((q) => (q.itemCount || 0) > 0);
  if (!questionnaires.length) {
    console.error('没有可用问卷（题目数为 0）。请先在管理端创建问卷，并确认用的是管理员账号。');
    process.exit(1);
  }

  if (args.list) {
    console.log('可用问卷：');
    for (const q of questionnaires) console.log(`  ${q.id}  ${q.title}  （题目 ${q.itemCount} 道，现有数据 ${q.sessionCount} 份）`);
    return;
  }

  const source = args.q ? questionnaires.find((q) => q.id === args.q) : questionnaires[0];
  if (!source) {
    console.error(`找不到问卷 ${args.q}。可用：${questionnaires.map((q) => q.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`源问卷：${source.title}（${source.id}，题目 ${source.itemCount} 道）`);
  let targetId = source.id;
  if (args.real) {
    console.log('模式：真实（直接写入源问卷，按真实计时；含硬性门控，每位被试可能数分钟）');
  } else {
    console.log('模式：快速（数据写入「模拟数据」副本，去掉题目级门控；源问卷不受影响）');
    targetId = await ensureFastTarget(source, questionnaires);
  }
  console.log(`开始模拟 ${args.n} 位完成被试${args.incomplete ? ` + ${args.incomplete} 位中途退出` : ''}…`);
  console.log('');

  const run = async () => {
    let done = 0;
    for (let i = 1; i <= args.n; i++) {
      const r = await runSubject(targetId, i, false);
      done += 1;
      console.log(`  ✓ 被试 ${i}：作答 ${r.answered} 题，状态 ${r.completed ? '已完成' : '进行中'}（${r.sessionId.slice(0, 8)}）`);
    }
    for (let i = 1; i <= args.incomplete; i++) {
      const r = await runSubject(targetId, 100 + i, true);
      console.log(`  ⏸ 被试 ${100 + i}：中途退出，作答 ${r.answered} 题，状态 进行中（${r.sessionId.slice(0, 8)}）`);
    }
    return done + args.incomplete;
  };

  const added = await run();

  const after = await request('/api/admin/questionnaire/sessions?id=' + encodeURIComponent(targetId));
  const total = after.ok ? (after.data.sessions || []).length : '?';
  console.log('');
  console.log(`模拟完成：本次新增 ${added} 份，该问卷现有数据 ${total} 份。`);
  if (!args.real) {
    console.log('数据在「模拟数据」副本上（原问卷未改动）。管理端「数据」页选择该副本即可查看并导出 Excel。');
    console.log('不再需要时，在管理端删除这份副本即可（原问卷与真实数据不受影响）。');
  } else {
    console.log('在管理端「数据」页即可看到这些记录，并可直接导出 Excel。');
  }
}

main().catch((err) => {
  console.error('执行失败：', err.message);
  console.error(`请确认服务已启动：${BASE}`);
  process.exit(1);
});
