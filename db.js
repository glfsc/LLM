// 数据层：SQLite（Node 内置 node:sqlite）—— 建表、种子数据与访问函数
// 模型：一切皆题目（item）。实验 = 可复用的题目模板（模板库）；问卷 = 一条链接 + 一列题目 + 计时默认值。
// 会话创建时把题目与计时快照进 sessions，此后修改模板 / 问卷不影响进行中的会话。
'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const path = require('node:path');
// 富文本清洗 / 互转（与浏览器共用同一份实现，见 public/assets/richtext.js）
const RT = require('./public/assets/richtext.js');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

// 并发与性能 pragma：WAL 提升提交吞吐，synchronous=NORMAL 避免每次提交 fsync
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA temp_store = MEMORY;
`);

db.exec(`
  -- 实验模板库：一套可复用的题目 + 计时默认值
  CREATE TABLE IF NOT EXISTS experiments (
    id          TEXT PRIMARY KEY,             -- 模板 ID（8 位短码）
    name        TEXT NOT NULL,
    timing_json TEXT NOT NULL DEFAULT '{}',   -- 计时默认值（题目未勾选时生效）
    items_json  TEXT NOT NULL DEFAULT '[]',   -- 题目列表
    created_at  TEXT,
    updated_at  TEXT
  );

  -- 问卷：一条通用链接（/chat?q=<id>）+ 一列题目 + 计时默认值
  CREATE TABLE IF NOT EXISTS questionnaires (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    timing_json TEXT NOT NULL DEFAULT '{}',
    items_json  TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT,
    updated_at  TEXT
  );

  -- 会话：题目与计时在创建时快照，此后修改不影响进行中的会话
  CREATE TABLE IF NOT EXISTS sessions (
    id                   TEXT PRIMARY KEY,
    questionnaire_id     TEXT NOT NULL,
    seq                  INTEGER,                 -- 问卷内编号（按进入顺序从 1 开始）
    status               TEXT NOT NULL DEFAULT 'in_progress',
    started_at           TEXT,
    ended_at             TEXT,
    duration_sec         INTEGER,
    user_agent           TEXT,
    items_json           TEXT NOT NULL DEFAULT '[]',
    timing_json          TEXT NOT NULL DEFAULT '{}',
    pending_presented_at TEXT,           -- 当前待作答单元的呈现时刻（服务端口径）
    active_at            TEXT,           -- 最近一次活动时间（心跳 / 提交 / 呈现）
    retry_json           TEXT,           -- 重试与超时统计（按作答单元）
    clear_seq            INTEGER         -- 清屏点：呈现某题 / 某消息前清空聊天流
  );

  -- 消息流：AI 消息 + 用户动作回显；visible_at = 定时消息（延迟发出）的可见时间
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    seq        INTEGER,
    created_at TEXT,
    visible_at TEXT,
    thinking   TEXT,             -- 该条消息的思考过程内容（留空 = 不显示思考面板）
    think_ms   INTEGER,          -- 该条消息的 AI 思考时长（毫秒；有思考内容时为面板时长）
    type_ms    INTEGER,          -- 该条消息的流式输出速度（毫秒/字）
    item_id    TEXT              -- 来源题目 id：消息题 = 该消息；回显 = 被回答的那道题
  );

  -- 作答记录：一行 = 一个作答单元
  --   presented_at 服务端记录的呈现时刻（用于门控与共用窗口）
  --   elapsed_ms   前端上报的作答耗时
  CREATE TABLE IF NOT EXISTS responses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    item_id      TEXT NOT NULL,
    item_index   INTEGER NOT NULL,     -- 题目在问卷中的位置
    item_type    TEXT NOT NULL,
    unit_index   INTEGER NOT NULL DEFAULT 0,  -- 作答单元序号（题组的多道子题同属一个单元）
    sub_index    INTEGER NOT NULL DEFAULT 0,  -- 题组内子题序号（非题组为 0）
    value        INTEGER,
    value_text   TEXT NOT NULL DEFAULT '',
    option_label TEXT NOT NULL DEFAULT '',
    presented_at TEXT,
    answered_at  TEXT,
    elapsed_ms   INTEGER,
    retry_count  INTEGER,        -- 该题提交前的重试次数（超时后点「重试」重新计时）
    timed_out    INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- 用户账号：普通主试（user）/ 管理员（admin）；密码只存盐值 + scrypt 摘要
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    username   TEXT NOT NULL UNIQUE,
    pass_hash  TEXT NOT NULL,
    salt       TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'user',
    avatar     TEXT,
    created_at TEXT,
    updated_at TEXT
  );

  -- 热点索引
  CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_session  ON messages(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_messages_visible  ON messages(session_id, visible_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_question ON sessions(questionnaire_id, seq);
`);

// 旧库升级：为实验 / 问卷补充创建者（已有数据归管理员）
function ensureColumn(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
}
// 同上，但补的是整数列（如 sessions.clear_seq）
function ensureColumnInt(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER`);
}
ensureColumn('experiments', 'owner_id');
ensureColumn('questionnaires', 'owner_id');
ensureColumn('messages', 'thinking');
ensureColumn('messages', 'item_id');
ensureColumn('sessions', 'active_at');        // 最近一次活动（心跳 / 提交），用于「太久未提交」自动作废
ensureColumn('sessions', 'retry_json');       // 每道题的重试次数（{"unitIndex":{"retries":n,"timedOut":1}}）
ensureColumnInt('responses', 'retry_count');  // 该题提交前的重试次数
ensureColumnInt('responses', 'timed_out');    // 是否曾经到点未交（0/1）
ensureColumnInt('sessions', 'clear_seq');

// 旧库升级：早期版本遗留的表一并清理（本轮为重建式升级，不做数据迁移）
for (const t of [
  'survey_answers', 'survey_messages', 'survey_sessions', 'survey_questions', 'surveys',
  'questionnaire_experiments', 'scenario_tasks', 'groups', 'scenarios'
]) {
  db.exec(`DROP TABLE IF EXISTS ${t}`);
}

// ---------------------------------------------------------------- 题目模型
// 题型：消息/页面类 + 需要作答的题目；量表 = 多道打分题，创作 = 多道文本题，不再有专用题型。
const ITEM_TYPES = ['message', 'gate', 'confirm', 'debrief', 'group', 'rating', 'single', 'multi', 'text', 'rank'];

// 「题目」口径：只有需要被试作答的题型才计入题号（消息、知情同意页、确认页、结束说明都只是页面）。
// 管理端（编排卡、大纲、预览、试填）与服务端（units 的 qno）共用这一份白名单。
const QUESTION_TYPES = ['group', 'rating', 'single', 'multi', 'text', 'rank'];

// 题目层级（仅用于管理端大纲分组，1 级最高；不影响被试端呈现）
const ITEM_LEVELS = [0, 1, 2, 3, 4];      // 0 = 默认（顶层）；1–4 = 依次缩进

// 可作为「题组」子题的题型（子题不允许再嵌套题组）
const SUB_ITEM_TYPES = ['rating', 'single', 'multi', 'text', 'rank'];

const ITEM_TYPE_LABELS = {
  message: '消息/材料',
  gate: '知情同意页',
  confirm: '阅读确认页',
  debrief: '结束说明页',
  group: '题组（多子题）',
  rating: '打分题',
  single: '单选',
  multi: '多选',
  text: '文本题',
  rank: '排序'
};

// 知情同意页的两种形态（题型仍是一个，只有形态差异）
const GATE_VARIANTS = ['plain', 'id'];

// 「插入题目」菜单的二级项：键 = itemDefaults 的键，值 = 二级菜单里显示的名字。
// 没出现在这里的题型就是一级项，直接插入。
const ITEM_VARIANTS = {
  gate: [
    { key: 'gate', label: '知情同意页（仅勾选同意）' },
    { key: 'gateId', label: '知情同意页（需填被试编号）' }
  ]
};

// 各题型可添加的参数（题目下方「参数区」里按需添加，没添加就整块不显示）
// 消息类题目额外可配 AI 思考时长与流式输出速度；refresh = 呈现该题前清空聊天流（刷新点）
const ITEM_LIMITS = {
  message: ['refresh', 'thinkMs', 'typeMs'],
  gate: ['refresh'],
  confirm: ['refresh', 'wait'],
  debrief: ['refresh'],
  group: ['refresh', 'wait', 'minSubmit', 'maxAnswer'],
  rating: ['refresh', 'wait', 'minSubmit', 'maxAnswer'],
  single: ['refresh', 'wait'],
  multi: ['refresh', 'wait'],
  text: ['refresh', 'wait', 'minSubmit', 'maxAnswer'],
  rank: ['refresh', 'wait']
};

// 题目参数：作答门控（秒）+ 呈现节奏（毫秒）+ 刷新点（开关）
// 默认值只在代码里定义一处（DEFAULT_LIMITS）——不再有「问卷级默认值 + 题目覆盖」两层，
// 作者不必在心算「这题到底生效的是哪个值」，未配置的参数一律回落到这里。
const LIMIT_KEYS = ['refresh', 'wait', 'minSubmit', 'maxAnswer', 'thinkMs', 'typeMs'];
const LIMIT_META = {
  refresh: { label: '呈现前清空聊天流', unit: '开关', hint: '呈现本题（或本条消息）之前，把屏内已呈现的内容整体清空。清屏点记在服务端：刷新页面也看不到清空之前的内容，数据仍完整保留在管理端' },
  wait: { label: '作答前强制等待', unit: '秒', hint: '需先停留 N 秒才能作答（如强制阅读）' },
  minSubmit: { label: '最短提交时间', unit: '秒', hint: '提交前的最短等待' },
  maxAnswer: { label: '最长作答时间', unit: '秒', hint: '到点自动提交已输入内容' },
  thinkMs: { label: 'AI 思考时长', unit: '毫秒', hint: '该消息配了思考内容时为「深度思考面板」时长；未配则只是「正在思考」转圈时长。0 = 不显示', group: 'rhythm' },
  typeMs: { label: '流式输出速度', unit: '毫秒/字', hint: '每字间隔；0 = 立即整段显示（数值越小越快）', group: 'rhythm' }
};
// 各参数的默认值与取值范围（门控以秒计，节奏以毫秒计，刷新点为 0/1）
const LIMIT_SPEC = {
  refresh: { def: 0, min: 0, max: 1 },
  wait: { def: 0, min: 0, max: 86400 },
  minSubmit: { def: 0, min: 0, max: 86400 },
  maxAnswer: { def: 0, min: 0, max: 86400 },
  thinkMs: { def: 420, min: 0, max: 10000 },
  typeMs: { def: 11, min: 0, max: 500 }
};
// 未配置任何参数时的生效值（服务端与两个前端共用同一份，避免兜底路径分叉）
const DEFAULT_LIMITS = LIMIT_KEYS.reduce((o, k) => { o[k] = LIMIT_SPEC[k].def; return o; }, {});

function toClampedInt(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 题目参数：仅保留该题型支持且作者确实添加了的项；未添加 = 键不存在 → 用 DEFAULT_LIMITS
// 按 LIMIT_SPEC 分键钳位（此前所有键统一钳到 86400，导致思考时长能存成 24 小时）
function normalizeLimits(type, raw) {
  const allowed = ITEM_LIMITS[type] || [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of allowed) {
    const v = src[k];
    if (v === null || v === undefined || String(v).trim() === '') continue;
    const spec = LIMIT_SPEC[k];
    out[k] = toClampedInt(v, spec.def, spec.min, spec.max);
  }
  return out;
}

function strList(raw, max) {
  return (Array.isArray(raw) ? raw : []).map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, max || 100);
}

// 题目归一化：落库 / 出库共用，保证数据结构稳定
function normalizeItem(raw, index) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const type = ITEM_TYPES.includes(src.type) ? src.type : 'message';
  const item = {
    id: String(src.id || '').trim() || `i${index + 1}`,
    type,
    title: String(src.title ?? '').trim(),
    limits: normalizeLimits(type, src.limits)
  };
  if (src.fromTemplateId) item.fromTemplateId = String(src.fromTemplateId);
  if (src.fromTemplateName) item.fromTemplateName = String(src.fromTemplateName);
  // 层级：仅用于管理端大纲分组；1 级是默认，不落库以保持 JSON 干净
  const level = toClampedInt(src.level, 0, 0, 4);
  if (level > 0) item.level = level;        // 0 = 默认，不落库，保持 JSON 干净
  if (type === 'message' || type === 'gate' || type === 'confirm' || type === 'debrief') item.text = String(src.text ?? '');
  // 思考过程：仅消息题可带。键不存在 = 作者没添加这个参数；
  // 空串一律视为未添加（旧版本保存时给每条消息都写了 thinking:''，这里顺带清掉）
  if (type === 'message' && src.thinking != null && String(src.thinking).length > 0) item.thinking = String(src.thinking);
  if (type === 'confirm') item.button = String(src.button ?? '');
  if (type === 'gate') {
    item.check = String(src.check ?? '');
    item.button = String(src.button ?? '');
    // 知情同意页有两种形态：plain = 只勾选同意；id = 勾选之外还要填被试编号才能进入
    item.variant = GATE_VARIANTS.includes(src.variant) ? src.variant : 'plain';
    item.idLabel = String(src.idLabel ?? '');
    item.idPlaceholder = String(src.idPlaceholder ?? '');
  }
  if (type === 'rating') {
    const min = toClampedInt(src.min, 1, 0, 10);
    item.min = min;
    item.max = toClampedInt(src.max, Math.max(min + 1, 5), min + 1, 12);
    item.anchor = String(src.anchor ?? '');
  }
  if (type === 'single' || type === 'multi' || type === 'rank') {
    item.options = strList(src.options, 50);
    if (type === 'single') {
      const c = toClampedInt(src.correct, 0, 0, Math.max(item.options.length, 1));
      item.correct = c > item.options.length ? 0 : c;
    }
  }
  if (type === 'text') {
    item.required = src.required == null ? true : !!src.required;
    item.rows = toClampedInt(src.rows, 1, 1, 12);
    item.maxLen = toClampedInt(src.maxLen, 0, 0, 5000);
    item.placeholder = String(src.placeholder ?? '');
  }
  if (type === 'group') {
    // 题组：一个单元内呈现多道子题、一次提交（如「广告语 + 创作说明」）
    item.text = String(src.text ?? '');                 // 题组说明（可选）
    item.layout = src.layout === 'row' ? 'row' : 'column';
    const subs = [];
    (Array.isArray(src.subs) ? src.subs : []).forEach((raw2, i) => {
      const sub = normalizeItem(raw2, i);
      if (!SUB_ITEM_TYPES.includes(sub.type)) return;   // 子题不允许 message/gate/debrief/group
      sub.limits = {};                                 // 计时限制只挂在题组上
      sub.id = String(raw2 && raw2.id || `s${i + 1}`);
      delete sub.level;                                // 层级只属于顶层题目
      delete sub.fromTemplateId;
      delete sub.fromTemplateName;
      subs.push(sub);
    });
    item.subs = subs;
  }
  // 正文（被试可见）：html 是唯一来源，text 是它的纯文本镜像（列表 / 导出 / 自检按纯文本用）。
  // 旧数据（只有 title / text）在这里做幂等迁移：标题并入正文，避免「标题不可见 / 不可改」。
  item.html = richContentOf(type, src, item);
  item.text = RT.htmlToText(item.html);
  return item;
}

// 结束说明的收尾小字：并入正文（可编辑），不再硬编码在被试端
const DEBRIEF_CLOSING = '本次实验已结束，您可以关闭本页面。';
// 两段文本题组的作答约定：并入题组正文（可编辑），不再硬编码在输入框提示里
function textSubsHint(item) {
  const subs = Array.isArray(item.subs) ? item.subs : [];
  if (subs.length !== 2 || !subs.every((s) => s && s.type === 'text')) return '';
  const [a, b] = subs;
  const aTitle = a.title || '第一项';
  const bTitle = b.title || '第二项';
  const mark = (sub, title) => (sub.required === false && !/选填|可选|不必填/.test(title) ? '（选填）' : '');
  return `（在下方输入框作答：第一行填「${aTitle}」${mark(a, aTitle)}；其余行填「${bTitle}」${mark(b, bTitle)}）`;
}

function richContentOf(type, src, item) {
  const title = item.title || '';
  const hasHtml = src.html != null && String(src.html).trim() !== '';
  if (hasHtml) return RT.sanitizeHtml(String(src.html));
  const text = String(src.text ?? '');
  if (type === 'message') return RT.textToHtml(text) || RT.textToHtml(title);
  if (type === 'gate' || type === 'confirm' || type === 'debrief') {
    const head = title ? `<h1>${RT.escapeText(title)}</h1>` : '';
    let body = text;
    if (type === 'debrief' && body.trim() && !body.includes('关闭本页面')) body = `${body}\n\n${DEBRIEF_CLOSING}`;
    return head + RT.textToHtml(body);
  }
  if (type === 'group') {
    const head = title ? `<p><strong>${RT.escapeText(title)}</strong></p>` : '';
    return head + RT.textToHtml(text) + RT.textToHtml(textSubsHint(item));
  }
  // 需要作答的题目：题干即正文
  return RT.textToHtml(title) || RT.textToHtml(text);
}

function normalizeItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  list.forEach((r, i) => {
    const item = normalizeItem(r, i);
    while (seen.has(item.id)) item.id = `${item.id}_x`;
    seen.add(item.id);
    out.push(item);
  });
  return out;
}

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text || 'null');
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- 默认内容
const DEFAULT_GATE = {
  type: 'gate',
  title: '知情同意说明',
  text:
    '您好！非常感谢您参加本次实验！\n\n' +
    '请您仔细阅读以下信息，并按实验要求完成各项任务。所有任务的答案均无对错之分，您按照自己的真实情况如实填写即可。\n\n' +
    '实验结束后，您将获得报酬，统一在所有任务完成后发放。您有权在任何时间退出实验且不必承担后果，但中途退出实验将不能获得相应报酬。\n\n' +
    '本实验所收集的信息将只供科学研究使用，我们将对您的数据进行保密，所涉及的公开发表物不会出现您的身份信息。\n\n' +
    '如果您勾选并开始作答，即意味着：您已阅读上述信息；您自愿同意参加本次实验，并会认真对待本次实验。否则，请关闭页面退出本实验。',
  check: '我已阅读上述信息，自愿同意参加本次实验',
  button: '开始实验'
};

const DEFAULT_DEBRIEF = {
  type: 'debrief',
  title: '实验说明',
  text:
    '感谢你参与本次研究。本次研究旨在考察：面对负面信息的时候，个体的创造力会提升还是会下降。\n\n' +
    '需要向你说明的是：为了保证所有参与者接收到内容完全一致的反馈，你所收到的评价意见及其回应，都是由研究团队预先设定的标准化内容，由系统按统一规则返回，并非针对你个人作品的个性化判断。你所提交的作品已被匿名保存，仅用于学术分析，不会用于任何实际的工作评价。\n\n' +
    '如果你对本次研究有任何疑问，请通过以下方式联系我们：\n' +
    '实验组联系方式：周颖 zyingzhou@whut.edu.cn'
};

// 新建问卷的默认题目：欢迎语（空）、知情同意页、结束语（空）、结束说明页
function defaultQuestionnaireItems() {
  return normalizeItems([
    { id: 'welcome', type: 'message', title: '欢迎语（留空则跳过）', text: '' },
    { id: 'consent', ...DEFAULT_GATE },
    { id: 'end', type: 'message', title: '结束语（留空则跳过）', text: '' },
    { id: 'debrief', ...DEFAULT_DEBRIEF, title: '9 · 致谢与事后解释' }
  ]);
}

// 「+ 插入题目」时的默认模板
function itemDefaults() {
  return {
    message: { type: 'message', title: '新材料', text: '' },
    gate: { ...DEFAULT_GATE },
    gateId: { ...DEFAULT_GATE, variant: 'id', title: '知情同意说明（含编号）', idLabel: '被试编号', idPlaceholder: '请填写实验者提供的编号' },
    // 阅读确认页：先停留 N 秒（在「参数」里加「作答前强制等待」）才能点继续
    confirm: { type: 'confirm', title: '阅读确认页', text: '请确认你已阅读完上面的内容。', button: '我已阅读完' },
    debrief: { ...DEFAULT_DEBRIEF },
    rating: { type: 'rating', title: '新打分题', min: 1, max: 5, anchor: '1 = 完全不同意　·　5 = 完全同意' },
    single: { type: 'single', title: '单选题', options: ['选项 A', '选项 B'], correct: 0 },
    multi: { type: 'multi', title: '多选题', options: ['选项 A', '选项 B', '选项 C'] },
    text: { type: 'text', title: '新文本题', required: true, rows: 1, maxLen: 0, placeholder: '请输入…' },
    // 只给框架：不含预设子题，子题由用户在编辑页自行插入
    group: { type: 'group', title: '新题组', text: '', layout: 'column', subs: [] },
    rank: { type: 'rank', title: '请排序', options: ['项目 1', '项目 2', '项目 3'] }
  };
}

// ---------------------------------------------------------------- 实验文档内容
const TASK_INFO =
  '欢迎参与本次创造力实验，你即将开始一项工作任务，下面是本次任务的具体信息。\n\n' +
  '你目前就职于 A 饮品公司市场部，担任内容创作助理。你的日常工作包括参与新品文案撰写、整理产品卖点、协助制作传播物料等。\n\n' +
  '公司即将上线一款新品——轻野·青柠气泡水。这款产品的特点是：0 糖 0 卡、真实青柠风味、气泡感强、随时饮用无负担；目标人群是 18-30 岁的城市年轻白领，他们注重健康，同时也看重口感与情绪体验。品牌主张是“把日常过成户外”（Everyday, Outdoors）。\n\n' +
  '今天，品牌创意组要求你为这款新品创作一条广告语（slogan），该广告语将用于新品首发的线上主视觉与短视频片尾。\n\n' +
  '请阅读接下来的任务要求，然后开始你的创作。';

const REQUIRE_HIGH =
  '【青柠气泡水 新品广告语创作任务简介】\n\n' +
  '一、产品信息\n' +
  '1. 品牌名：轻野（LIGHTWILD）\n' +
  '2. 产品名：轻野·青柠气泡水\n' +
  '3. 产品特点：0 糖 0 卡、真实青柠风味、气泡感强、随时饮用无负担\n' +
  '4. 目标人群：18-30 岁城市年轻白领，注重健康，同时看重口感与情绪体验\n' +
  '5. 品牌主张：把日常过成户外（Everyday, Outdoors）\n\n' +
  '二、创作要求\n' +
  '1. 广告语须为中文，字数控制在 8-20 字之间（含标点）。\n' +
  '2. 广告语须体现产品核心利益点（“清爽”或“0 糖无负担”）中的至少一项。\n' +
  '3. 广告语须与品牌主张“把日常过成户外”相呼应，体现年轻化的生活感，而非单纯描述产品口感。\n' +
  '4. 广告语须便于记忆与口头传播，避免使用生僻词与冗长句式。\n' +
  '5. 请勿直接套用饮品行业中的常见句式（如“清爽一夏”“一口畅快”“随时随地好心情”）。\n' +
  '6. 如需说明创作思路，可在广告语后附不超过 50 字的创作说明。\n\n' +
  '三、评价标准（满分 100 分）\n' +
  '品牌契合度（30 分）：是否准确传递产品利益点与品牌主张。\n' +
  '原创性（30 分）：表达是否新颖，是否避免了行业内的常见句式。\n' +
  '可记忆性（20 分）：是否朗朗上口、便于复述与二次传播。\n' +
  '可延展性（20 分）：能否支撑后续海报、短视频等传播物料的延展使用。\n\n' +
  '四、提交与评审\n' +
  '完成后，请将广告语与创作说明提交至对应窗口，由评审方进行统一评价。本次评价结果将作为你本季度项目分配与绩效评价的参考。';

const REQUIRE_LOW =
  '【青柠气泡水 新品广告语创作任务简介】\n\n' +
  '一、产品信息\n' +
  '1. 品牌名：轻野（LIGHTWILD）\n' +
  '2. 产品名：轻野·青柠气泡水\n' +
  '3. 产品特点：0 糖 0 卡、真实青柠风味、气泡感强、随时饮用无负担\n' +
  '4. 目标人群：18-30 岁城市年轻白领，注重健康，同时看重口感与情绪体验\n' +
  '5. 品牌主张：把日常过成户外（Everyday, Outdoors）\n\n' +
  '二、创作要求\n' +
  '1. 请为“轻野·青柠气泡水”这款新品创作一条广告语（slogan），用于新品首发宣传。\n' +
  '2. 请尽力把这条广告语创作好。\n\n' +
  '三、提交与评审\n' +
  '完成后，请将广告语提交至对应窗口，由评审方进行统一评价。本次评价结果将作为你本季度项目分配与绩效评价的参考。';

const CREATE_INTRO =
  '请在明确产品信息与任务要求后，在 5 分钟内完成内容创作；开始 3 分钟后，可以通过系统对话框向智能评估系统提交你的创作成果。';

const FEEDBACK_TEXT =
  '很感谢你的认真创作，我是轻野品牌创意智能评估系统。关于你提交的这条广告语，在我们关注的几个方面都存在明显的不足：\n\n' +
  '第一，原创性不够。“清爽”“轻负担”这一类表达在饮品行业中使用频率极高，缺乏区分度，很难让消费者把这句话与“轻野”联系在一起。\n\n' +
  '第二，表达不够凝练。文案的节奏感偏弱，读起来缺少记忆点，不利于二次传播。\n\n' +
  '第三，与品牌主张的关联停留在表层。“把日常过成户外”所强调的年轻化生活感，在你的文案中并没有被体现出来，读起来更像一句通用的产品描述，而不是“轻野”的声音。\n\n' +
  '第四，可延展性不足。这条广告语很难支撑后续海报与短视频的延展表达，落地时的空间相当有限。\n\n' +
  '坦白说，这次的完成度与我们的要求还有相当的距离，我对你这次的表现感到失望。';

// 反馈消息的「深度思考过程」：被试端在反馈正文之前以可折叠面板逐字呈现。
// 写作约束：只对照评价标准推演，不指认被试文本的具体字词（无法预判输入）；
// 结论与 FEEDBACK_TEXT 的四点一一对应，但措辞须改写，避免把注意力检测题变成送分题。
const FEEDBACK_THINKING =
  '用户把广告语和创作说明发过来了。先别急着下判断，把任务要求过一遍。\n' +
  '• 最硬的几条：体现“清爽”或“0 糖无负担”；呼应“把日常过成户外”；避开行业常见句式。\n' +
  '• 还要看：是否便于记忆、能否延展成海报和短视频。\n\n' +
  '先看品牌契合度。\n' +
  '• 这条文案读起来更像在描述产品本身，“日常 / 户外”那层松弛感没有被带出来。\n' +
  '• 等等，是不是我对“生活感”的理解太窄了？再想想——主张强调的是把户外的状态放进日常场景，不一定要出现“户外”两个字。\n' +
  '• 嗯，不管从哪个角度取，这句话里的生活感都是缺的。\n\n' +
  '再看原创性。\n' +
  '• “清爽”“轻负担”这个方向在饮品行业里出现频率太高，属于典型套路。\n' +
  '• 消费者很难把它跟某个具体品牌联系起来，区分度不够。\n\n' +
  '节奏也要看。\n' +
  '• 要求里说便于记忆、口头传播，这句整体偏平，重音落不到记忆点上。\n' +
  '• 后面要延展成海报、短视频文案的话，能撑的空间也很有限。\n\n' +
  '好，结论清楚了，整理一下反馈要点：\n' +
  '• 一、表达落入行业惯用套路，原创性不足。\n' +
  '• 二、品牌主张那层意思基本没带出来。\n' +
  '• 三、节奏偏弱，不够凝练。\n' +
  '• 四、延展空间有限。\n\n' +
  '就按这几条来写反馈。';

const CREATE2_INTRO = '请根据刚刚收到的反馈以及下面任务信息与任务要求，再次完成内容创作任务。';
const AGREEMENT_ANCHOR = '1 = 完全不同意　·　5 = 完全同意';
const FAIRNESS_ANCHOR = '1 = 非常正面　·　5 = 非常负面';

// 量表 = 一道指导语消息 + N 道打分题（sectionNo = 附件中的章节号，写进标题便于逐条对照）
function scaleItems(idPrefix, title, instruction, questions, anchor, sectionNo) {
  const head = sectionNo ? `${sectionNo} · ${title}` : title;
  const out = [{ id: `${idPrefix}_intro`, type: 'message', title: head, text: `${title}\n${instruction}` }];
  questions.forEach((q, i) => {
    out.push({ id: `${idPrefix}_${i + 1}`, type: 'rating', title: q, min: 1, max: 5, anchor });
  });
  return out;
}

// 创作 = 一道创作指引消息 + 一个题组（广告语 + 创作说明，同屏呈现、一次提交）
function creationItems(idPrefix, intro, sectionNo) {
  const tag = sectionNo ? `${sectionNo} · ` : '';
  const again = idPrefix === 'create2' ? '（再次）' : '';
  return [
    { id: `${idPrefix}_intro`, type: 'message', title: `${tag}内容创作 · 创作指引`, text: intro },
    {
      id: `${idPrefix}_work`,
      type: 'group',
      title: `${tag}内容创作${again}`,
      text: '',
      layout: 'column',
      limits: { minSubmit: 180, maxAnswer: 300 },
      subs: [
        { id: 'slogan', type: 'text', title: '广告语', required: true, rows: 1, maxLen: 20, placeholder: '请输入广告语（8–20 字）' },
        { id: 'note', type: 'text', title: '创作说明（选填）', required: false, rows: 2, maxLen: 50, placeholder: '可简要说明创作思路' }
      ]
    }
  ];
}

// 组别3 / 组别4 的题目（唯一差异：任务要求文本）
function experimentItems(requirementsText) {
  return [
    { id: 'task_info', type: 'message', title: '1 · 欢迎语与实验任务', text: TASK_INFO },
    { id: 'task_req', type: 'message', title: '2 · 任务要求', text: requirementsText },
    ...scaleItems('goal_clarity', '目标清晰度测量', '请根据刚才收到的任务材料，评价下列说法与你的实际感受的符合程度。', [
      '我清楚地知道这项创作任务的目标是什么。',
      '我对这项任务的具体要求有清晰的理解。',
      '我知道评价这件作品的标准是什么。',
      '我清楚自己应该朝着哪个方向努力。',
      '这项任务的要求是明确而具体的。'
    ], AGREEMENT_ANCHOR, '3'),
    ...creationItems('create1', CREATE_INTRO, '4'),
    // 思考面板时长 8 秒（题目覆盖问卷默认的 420ms）；不再用「延迟发出」——等待由思考面板承担
    { id: 'feedback', type: 'message', title: '5 · 负面反馈输出', text: FEEDBACK_TEXT, thinking: FEEDBACK_THINKING, limits: { thinkMs: 8000 } },
    { id: 'attention', type: 'single', title: '6 · 注意力检测', options: ['表达不够精炼', '可延展性不足', '格式不符合要求', '与品牌主张的关联停留在表层'], correct: 3, limits: { wait: 40 } },
    { id: 'source', type: 'single', title: '7 · 反馈来源识别', options: ['品牌创意组组长 PH', '品牌创意智能评估系统（AI 系统）'], correct: 2 },
    ...scaleItems('fairness', '反馈公平性', '你如何评价刚才收到的那条关于你作品的反馈？', [
      '我认为反馈者的评价是公正的。',
      '我认为这次反馈的内容是客观的。',
      '我认为反馈者对我的作品做出了合理的判断。',
      '我认为这次评价没有受到个人偏好的影响。',
      '我认为这次反馈给了我应得的评价。',
      '总体而言，我认为这次反馈的处理方式是公平的。'
    ], FAIRNESS_ANCHOR, '7'),
    ...scaleItems('meta_process', '元过程测量', '请回想你在这项任务中，尤其是收到反馈之后的感受，选择最符合的程度。', [
      '我在意这次评价会如何影响别人对我的看法。',
      '我会反复回想对方这个人是怎么看我的。',
      '我担心自己的专业能力受到质疑。',
      '我花了不少心思去想，这次评价对我的形象意味着什么。',
      '我感觉被评价的是我这个人，而不只是我的作品。'
    ], AGREEMENT_ANCHOR, '7'),
    ...scaleItems('task_process', '任务过程测量', '请回想你在收到反馈之后的真实想法与反应，选择最符合的程度。', [
      '收到反馈后，我更多的是在思考怎样调整我的创作方法。',
      '我在想有哪些具体的做法可以让我的这条广告语变得更好。',
      '我试着去分析我的作品与要求之间的差距究竟在哪里。',
      '我把注意力放在了改进作品的具体策略上。'
    ], AGREEMENT_ANCHOR, '7'),
    // 第 8 节：再次完成与开头一模一样的任务（指导语 + 任务信息 + 任务要求 + 创作）
    { id: 'create2_intro', type: 'message', title: '8 · 再次完成一模一样的任务（指导语）', text: CREATE2_INTRO },
    { id: 'task_info2', type: 'message', title: '8 · 任务信息（与开头一致）', text: TASK_INFO },
    { id: 'task_req2', type: 'message', title: '8 · 任务要求（与开头一致）', text: requirementsText },
    ...creationItems('create2', CREATE_INTRO, '8')
  ];
}

// ---------------------------------------------------------------- 设置
function nowIso() {
  return new Date().toISOString();
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value ?? ''));
}

const RESUME_WINDOW_DEFAULT_HOURS = 24;

function getResumeWindowHours() {
  const raw = getSetting('resume_window_hours');
  if (raw == null || String(raw).trim() === '') return RESUME_WINDOW_DEFAULT_HOURS;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return RESUME_WINDOW_DEFAULT_HOURS;
  return Math.min(n, 24 * 30);
}

// 「太久未提交」的判据：分钟数（0 = 不自动作废）。默认 30 分钟。
const ABANDON_AFTER_DEFAULT_MINUTES = 30;
function getAbandonAfterMinutes() {
  const raw = getSetting('abandon_after_minutes');
  if (raw == null || String(raw).trim() === '') return ABANDON_AFTER_DEFAULT_MINUTES;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return ABANDON_AFTER_DEFAULT_MINUTES;
  return Math.min(n, 24 * 60);
}
function setAbandonAfterMinutes(value) {
  const n = Math.round(Number(value));
  setSetting('abandon_after_minutes', String(Number.isFinite(n) && n >= 0 ? Math.min(n, 24 * 60) : ABANDON_AFTER_DEFAULT_MINUTES));
  return getAbandonAfterMinutes();
}

function setResumeWindowHours(value) {
  const n = Math.round(Number(value));
  setSetting('resume_window_hours', String(Number.isFinite(n) && n >= 0 ? Math.min(n, 24 * 30) : RESUME_WINDOW_DEFAULT_HOURS));
}

// ---------------------------------------------------------------- 用户账号
// 密码只存 scrypt 摘要 + 随机盐，不以明文或可逆形式落库
function hashPassword(password, salt) {
  return scryptSync(String(password), String(salt), 64).toString('hex');
}

function userPayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    avatar: row.avatar || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function getUserByName(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim()) || null;
}

function verifyPassword(row, password) {
  if (!row) return false;
  const expected = Buffer.from(row.pass_hash, 'hex');
  const actual = Buffer.from(hashPassword(password, row.salt), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function createUser({ username, password, role, avatar }) {
  const name = String(username || '').trim();
  if (!name) throw new Error('用户名不能为空');
  if (!password || String(password).length < 6) throw new Error('密码至少 6 位');
  if (getUserByName(name)) throw new Error('用户名已存在');
  const id = randomUUID();
  const now = nowIso();
  const salt = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users (id, username, pass_hash, salt, role, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, hashPassword(password, salt), salt, role === 'admin' ? 'admin' : 'user', avatar || null, now, now);
  return userPayload(getUser(id));
}

function updateUser(id, { username, role, password, avatar } = {}) {
  const row = getUser(id);
  if (!row) return null;
  const sets = ['updated_at = ?'];
  const args = [nowIso()];
  if (username != null) {
    const name = String(username).trim();
    if (!name) throw new Error('用户名不能为空');
    const dup = getUserByName(name);
    if (dup && dup.id !== id) throw new Error('用户名已存在');
    sets.push('username = ?');
    args.push(name);
  }
  if (role != null) {
    sets.push('role = ?');
    args.push(role === 'admin' ? 'admin' : 'user');
  }
  if (avatar != null) {
    sets.push('avatar = ?');
    args.push(avatar || null);
  }
  if (password) {
    if (String(password).length < 6) throw new Error('密码至少 6 位');
    const salt = randomBytes(16).toString('hex');
    sets.push('pass_hash = ?', 'salt = ?');
    args.push(hashPassword(password, salt), salt);
  }
  args.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return userPayload(getUser(id));
}

function updateUserPassword(id, newPassword) {
  return updateUser(id, { password: newPassword });
}

function deleteUser(id) {
  if (!getUser(id)) return { ok: false, reason: 'not_found' };
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { ok: true };
}

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC, rowid ASC').all().map(userPayload);
}

// 计时窗口以下为原设置区

// ---------------------------------------------------------------- 短码
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function makeCode(table) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = '';
    for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(code)) return code;
  }
  throw new Error('无法生成短码，请重试');
}

// ---------------------------------------------------------------- 实验模板库
function experimentPayload(row) {
  if (!row) return null;
  const items = normalizeItems(parseJson(row.items_json, []));
  return {
    id: row.id,
    name: row.name,
    items,
    itemCount: items.length,
    usedBy: countQuestionnairesUsingExperiment(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getExperiment(id) {
  return db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) || null;
}

function getExperimentPayload(id) {
  return experimentPayload(getExperiment(id));
}

function listExperiments(ownerId) {
  const rows = ownerId
    ? db.prepare('SELECT * FROM experiments WHERE owner_id = ? ORDER BY created_at ASC, rowid ASC').all(ownerId)
    : db.prepare('SELECT * FROM experiments ORDER BY created_at ASC, rowid ASC').all();
  return rows.map(experimentPayload);
}

// 统计有多少份问卷是从该模板插入过题目的（仅提示用：插入即复制，模板可自由删除）
function countQuestionnairesUsingExperiment(id) {
  let n = 0;
  for (const r of db.prepare('SELECT items_json FROM questionnaires').all()) {
    const items = parseJson(r.items_json, []);
    if (Array.isArray(items) && items.some((it) => it && it.fromTemplateId === id)) n += 1;
  }
  return n;
}

// 问卷级 timing_json 列保留（不动 schema），但已不再读写：
// 参数只配在题目上，未配置的回落到 DEFAULT_LIMITS。
const NO_TIMING = '{}';

function createExperiment({ name, items, copyFrom, ownerId }) {
  const source = copyFrom ? getExperimentPayload(copyFrom) : null;
  const id = makeCode('experiments');
  const now = nowIso();
  db.prepare('INSERT INTO experiments (id, name, timing_json, items_json, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      id,
      String(name),
      NO_TIMING,
      JSON.stringify(normalizeItems(source ? source.items : items || [])),
      ownerId || null,
      now,
      now
    );
  return getExperimentPayload(id);
}

function updateExperiment(id, { name, items }) {
  if (!getExperiment(id)) return null;
  db.prepare('UPDATE experiments SET name = ?, timing_json = ?, items_json = ?, updated_at = ? WHERE id = ?')
    .run(String(name), NO_TIMING, JSON.stringify(normalizeItems(items)), nowIso(), id);
  return getExperimentPayload(id);
}

function deleteExperiment(id) {
  if (!getExperiment(id)) return { ok: false, reason: 'not_found' };
  db.prepare('DELETE FROM experiments WHERE id = ?').run(id);
  return { ok: true };
}

// ---------------------------------------------------------------- 问卷
function questionnairePayload(row, { withItems = true } = {}) {
  if (!row) return null;
  const items = normalizeItems(parseJson(row.items_json, []));
  const payload = {
    id: row.id,
    title: row.title,
    itemCount: items.length,
    sessionCount: countSessionsByQuestionnaire(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (withItems) payload.items = items;
  return payload;
}

function getQuestionnaire(id) {
  return db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(id) || null;
}

function getQuestionnairePayload(id, opts) {
  return questionnairePayload(getQuestionnaire(id), opts);
}

function listQuestionnaires(ownerId) {
  const rows = ownerId
    ? db.prepare('SELECT * FROM questionnaires WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC').all(ownerId)
    : db.prepare('SELECT * FROM questionnaires ORDER BY created_at DESC, rowid DESC').all();
  return rows.map((r) => questionnairePayload(r, { withItems: false }));
}

function createQuestionnaire({ title, items, ownerId }) {
  const id = makeCode('questionnaires');
  const now = nowIso();
  const list = Array.isArray(items) && items.length ? items : defaultQuestionnaireItems();
  db.prepare('INSERT INTO questionnaires (id, title, timing_json, items_json, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, String(title || '未命名问卷'), NO_TIMING, JSON.stringify(normalizeItems(list)), ownerId || null, now, now);
  return getQuestionnairePayload(id);
}

function updateQuestionnaire(id, { title, items }) {
  if (!getQuestionnaire(id)) return null;
  db.prepare('UPDATE questionnaires SET title = ?, timing_json = ?, items_json = ?, updated_at = ? WHERE id = ?')
    .run(String(title || '未命名问卷'), NO_TIMING, JSON.stringify(normalizeItems(items)), nowIso(), id);
  return getQuestionnairePayload(id);
}

function copyQuestionnaire(sourceId, title, ownerId) {
  const src = getQuestionnairePayload(sourceId);
  if (!src) return null;
  return createQuestionnaire({
    title: String(title || '').trim() || `${src.title}（副本）`,
    items: src.items,
    ownerId
  });
}

function countSessionsByQuestionnaire(id) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE questionnaire_id = ?').get(id).n);
}

function deleteQuestionnaire(id, { force = false } = {}) {
  if (!getQuestionnaire(id)) return { ok: false, reason: 'not_found' };
  const sessionCount = countSessionsByQuestionnaire(id);
  if (sessionCount > 0 && !force) return { ok: false, reason: 'has_sessions', sessionCount };
  db.exec('BEGIN');
  try {
    const ids = db.prepare('SELECT id FROM sessions WHERE questionnaire_id = ?').all(id).map((r) => r.id);
    const delMsg = db.prepare('DELETE FROM messages WHERE session_id = ?');
    const delResp = db.prepare('DELETE FROM responses WHERE session_id = ?');
    for (const sid of ids) { delMsg.run(sid); delResp.run(sid); }
    db.prepare('DELETE FROM sessions WHERE questionnaire_id = ?').run(id);
    db.prepare('DELETE FROM questionnaires WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ok: true };
}

// 批量删除会话（数据页勾选删除）：连带清空消息与作答记录；只删属于该问卷的会话
function deleteSessions(questionnaireId, ids) {
  const wanted = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!wanted.length) return { ok: true, deleted: 0 };
  db.exec('BEGIN');
  try {
    const check = db.prepare('SELECT id FROM sessions WHERE id = ? AND questionnaire_id = ?');
    const delMsg = db.prepare('DELETE FROM messages WHERE session_id = ?');
    const delResp = db.prepare('DELETE FROM responses WHERE session_id = ?');
    const delSess = db.prepare('DELETE FROM sessions WHERE id = ?');
    let deleted = 0;
    for (const sid of wanted) {
      if (!check.get(sid, questionnaireId)) continue;
      delMsg.run(sid);
      delResp.run(sid);
      delSess.run(sid);
      deleted += 1;
    }
    db.exec('COMMIT');
    return { ok: true, deleted };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------- 会话
function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

function nextSessionSeq(questionnaireId) {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM sessions WHERE questionnaire_id = ?').get(questionnaireId);
  return Number(row.n);
}

function createSession({ questionnaireId, seq, items, userAgent }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, questionnaire_id, seq, status, started_at, active_at, user_agent, items_json, timing_json, pending_presented_at)
     VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, NULL)`
  ).run(id, questionnaireId, seq, nowIso(), nowIso(), userAgent || '', JSON.stringify(items), NO_TIMING);
  return getSession(id);
}

// 最近活动时间：被试端每分钟心跳一次；提交 / 呈现也会刷新。
// 用途：超过「未完成会话自动作废时限」的会话在被重新打开时置为「作废」，设备随即释放给下一位被试。
function touchSession(sessionId) {
  db.prepare('UPDATE sessions SET active_at = ? WHERE id = ?').run(nowIso(), sessionId);
}
function sessionLastActiveMs(session) {
  const iso = (session && (session.active_at || session.pending_presented_at || session.started_at)) || '';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}
// 作废：数据保留（导出时默认排除、数据页标「已作废」），设备释放
function abandonSession(id) {
  const session = getSession(id);
  if (!session || session.status !== 'in_progress') return session;
  const endedAt = nowIso();
  const duration = Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(session.started_at).getTime()) / 1000));
  db.prepare('UPDATE sessions SET status = ?, ended_at = ?, duration_sec = ?, pending_presented_at = NULL WHERE id = ?')
    .run('abandoned', endedAt, duration, id);
  return getSession(id);
}
// 重试 / 超时统计（按作答单元）
function bumpRetry(sessionId, unitIndex, timedOut) {
  const session = getSession(sessionId);
  if (!session) return null;
  let map = {};
  try { map = JSON.parse(session.retry_json || '{}') || {}; } catch { map = {}; }
  const cur = map[unitIndex] || { retries: 0, timedOut: 0 };
  cur.retries += 1;
  if (timedOut) cur.timedOut = 1;
  map[unitIndex] = cur;
  db.prepare('UPDATE sessions SET retry_json = ?, active_at = ? WHERE id = ?').run(JSON.stringify(map), nowIso(), sessionId);
  return cur;
}
// 只在「到点未交」时打一个标记（重试次数由 bumpRetry 单独 +1，避免一次超时被算成两次重试）
function markTimeout(sessionId, unitIndex) {
  const session = getSession(sessionId);
  if (!session) return null;
  let map = {};
  try { map = JSON.parse(session.retry_json || '{}') || {}; } catch { map = {}; }
  const cur = map[unitIndex] || { retries: 0, timedOut: 0 };
  cur.timedOut = 1;
  map[unitIndex] = cur;
  db.prepare('UPDATE sessions SET retry_json = ?, active_at = ? WHERE id = ?').run(JSON.stringify(map), nowIso(), sessionId);
  return cur;
}

function getRetryInfo(sessionId, unitIndex) {
  const session = getSession(sessionId);
  if (!session) return { retries: 0, timedOut: 0 };
  try {
    const map = JSON.parse(session.retry_json || '{}') || {};
    const cur = map[unitIndex] || {};
    return { retries: Number(cur.retries) || 0, timedOut: Number(cur.timedOut) || 0 };
  } catch { return { retries: 0, timedOut: 0 }; }
}

function setPendingPresentedAt(sessionId, iso) {
  db.prepare('UPDATE sessions SET pending_presented_at = ? WHERE id = ?').run(iso, sessionId);
}

function finishSession(id) {
  const session = getSession(id);
  if (!session) return null;
  if (session.status === 'completed') return session;
  const endedAt = nowIso();
  const duration = Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(session.started_at).getTime()) / 1000));
  db.prepare('UPDATE sessions SET status = ?, ended_at = ?, duration_sec = ?, pending_presented_at = NULL WHERE id = ?')
    .run('completed', endedAt, duration, id);
  return getSession(id);
}

// ---------------------------------------------------------------- 消息
// think_ms / type_ms：该条消息的呈现节奏（AI 思考时长、流式输出速度，毫秒）；
// 由发消息的题目覆盖，未覆盖则取问卷默认值——存在消息上，保证延迟消息经 bootstrap 拉取时节奏不丢。
function listMessages(sessionId) {
  return db.prepare('SELECT id, role, content, seq, created_at, visible_at, thinking, think_ms, type_ms, item_id FROM messages WHERE session_id = ? ORDER BY seq ASC').all(sessionId);
}

function listVisibleMessages(sessionId, now, clearSeq = 0) {
  // clearSeq：清屏点。被它挡住的更早消息不再返回，所以刷新 / 断线重进
  // 也看不到「清空之前」的内容——单靠前端清 DOM 挡不住刷新。
  return db.prepare(
    `SELECT id, role, content, seq, created_at, thinking, think_ms, type_ms, item_id FROM messages
      WHERE session_id = ? AND (visible_at IS NULL OR visible_at <= ?) AND COALESCE(seq, 0) > ?
      ORDER BY seq ASC`
  ).all(sessionId, now, Number(clearSeq) || 0);
}

// 清屏点读写：记住「清空发生在哪条消息之后」
function setClearSeq(sessionId, seq) {
  db.prepare('UPDATE sessions SET clear_seq = ? WHERE id = ?').run(Math.max(0, Number(seq) || 0), sessionId);
}
function maxMessageSeq(sessionId) {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE session_id = ?').get(sessionId);
  return Number(row.m) || 0;
}

function nextPendingVisibleAt(sessionId, now) {
  const row = db.prepare(
    'SELECT MIN(visible_at) AS v FROM messages WHERE session_id = ? AND visible_at IS NOT NULL AND visible_at > ?'
  ).get(sessionId, now);
  return row && row.v ? row.v : null;
}

// 最近一条消息的可见时刻（无定时消息则取创建时刻）：作答单元的呈现基准
function latestMessageAt(sessionId) {
  const row = db.prepare('SELECT visible_at, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId);
  if (!row) return null;
  return row.visible_at || row.created_at || null;
}

function addMessage(sessionId, role, content, visibleAt = null, rhythm = null) {
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE session_id = ?').get(sessionId);
  const seq = Number(maxSeq.m) + 1;
  const createdAt = nowIso();
  const thinkMs = rhythm && rhythm.thinkMs != null ? Number(rhythm.thinkMs) : null;
  const typeMs = rhythm && rhythm.typeMs != null ? Number(rhythm.typeMs) : null;
  const thinking = rhythm && rhythm.thinking ? String(rhythm.thinking) : null;
  const itemId = rhythm && rhythm.itemId ? String(rhythm.itemId) : null;
  const info = db.prepare('INSERT INTO messages (session_id, role, content, seq, created_at, visible_at, thinking, think_ms, type_ms, item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, role, content, seq, createdAt, visibleAt, thinking, thinkMs, typeMs, itemId);
  return {
    id: Number(info.lastInsertRowid), role, content, seq, created_at: createdAt,
    visible_at: visibleAt, thinking, think_ms: thinkMs, type_ms: typeMs, item_id: itemId
  };
}

// ---------------------------------------------------------------- 作答
function countResponses(sessionId) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM responses WHERE session_id = ?').get(sessionId).n);
}

function listResponses(sessionId) {
  return db.prepare('SELECT * FROM responses WHERE session_id = ? ORDER BY id ASC').all(sessionId);
}

function lastResponse(sessionId) {
  return db.prepare('SELECT * FROM responses WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) || null;
}

// 已完成的作答单元数（题组算一个单元，其多道子题同属一个 unit_index）
function countAnswerUnits(sessionId) {
  return Number(db.prepare('SELECT COUNT(DISTINCT unit_index) AS n FROM responses WHERE session_id = ?').get(sessionId).n);
}

// 第 index 个作答单元的首行（用于取呈现 / 作答时间）
function unitFirstResponse(sessionId, index) {
  return db.prepare('SELECT * FROM responses WHERE session_id = ? AND unit_index = ? ORDER BY sub_index ASC LIMIT 1').get(sessionId, index) || null;
}

function responseAt(sessionId, index) {
  return db.prepare('SELECT * FROM responses WHERE session_id = ? ORDER BY id ASC LIMIT 1 OFFSET ?').get(sessionId, index) || null;
}

function addResponse({ sessionId, itemId, itemIndex, itemType, unitIndex, subIndex, value, valueText, optionLabel, presentedAt, answeredAt, elapsedMs, retryCount, timedOut }) {
  const info = db.prepare(
    `INSERT INTO responses (session_id, item_id, item_index, item_type, unit_index, sub_index, value, value_text, option_label, presented_at, answered_at, elapsed_ms, retry_count, timed_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId, String(itemId), Number(itemIndex) || 0, String(itemType),
    Number(unitIndex) || 0, Number(subIndex) || 0,
    value == null ? null : Number(value), valueText == null ? '' : String(valueText), optionLabel || '',
    presentedAt || null, answeredAt || nowIso(), elapsedMs == null ? null : Number(elapsedMs),
    Number(retryCount) || 0, timedOut ? 1 : 0
  );
  return Number(info.lastInsertRowid);
}

// 会话摘要列表（数据页）
function listSessionSummaries(questionnaireId) {
  return db.prepare(
    'SELECT id, seq, status, started_at, ended_at, duration_sec, user_agent, active_at FROM sessions WHERE questionnaire_id = ? ORDER BY seq ASC'
  ).all(questionnaireId);
}

// ---------------------------------------------------------------- 数据页与导出
// 作废的会话（重做 / 太久没提交）默认不进导出：导出时传 includeAbandoned = false
function abandonFilter(includeAbandoned, alias = 's.') {
  return includeAbandoned ? '' : ` AND ${alias}status <> 'abandoned'`;
}

// 行级明细：一行 = 一个作答单元
function listResponseRows(questionnaireId, { includeAbandoned = true } = {}) {
  return db.prepare(
    `SELECT s.id AS session_id, s.seq, s.status AS session_status, s.started_at, s.ended_at, s.duration_sec,
            r.item_id, r.item_index, r.item_type, r.unit_index, r.sub_index, r.value, r.value_text, r.option_label,
            r.presented_at, r.answered_at, r.elapsed_ms, r.retry_count, r.timed_out
       FROM responses r JOIN sessions s ON s.id = r.session_id
      WHERE s.questionnaire_id = ?${abandonFilter(includeAbandoned)}
      ORDER BY s.seq ASC, r.id ASC`
  ).all(questionnaireId);
}

// 汇总（一被试一行）：按题目类型聚合
function listQuestionnaireSummaryRows(questionnaireId, { includeAbandoned = true } = {}) {
  const sessions = db.prepare(
    `SELECT id, seq, status, started_at, ended_at, duration_sec FROM sessions WHERE questionnaire_id = ?${abandonFilter(includeAbandoned, '')} ORDER BY seq ASC`
  ).all(questionnaireId);
  if (!sessions.length) return [];

  const byId = new Map();
  for (const s of sessions) {
    byId.set(s.id, {
      sessionId: s.id,
      seq: s.seq == null ? null : Number(s.seq),
      status: s.status,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      durationSec: s.duration_sec == null ? null : Number(s.duration_sec),
      scales: new Map(),      // 量表前缀 -> { sum, n }
      texts: new Map(),       // item_id -> { text, answeredAt, elapsedMs }
      choices: new Map(),     // item_id -> { value, label, itemType, answeredAt, elapsedMs }
      enteredCode: ''         // 知情同意页「含编号」形态里被试自己填的编号
    });
  }

  const rows = db.prepare(
    `SELECT session_id, item_id, sub_index, item_type, value, value_text, option_label, answered_at, elapsed_ms
       FROM responses WHERE session_id IN (SELECT id FROM sessions WHERE questionnaire_id = ?) ORDER BY id ASC`
  ).all(questionnaireId);

  for (const r of rows) {
    const acc = byId.get(r.session_id);
    if (!acc) continue;
    if (r.item_type === 'rating') {
      const prefix = String(r.item_id).replace(/_\d+$/, '');   // goal_clarity_3 → goal_clarity
      const cur = acc.scales.get(prefix) || { sum: 0, n: 0 };
      cur.sum += Number(r.value);
      cur.n += 1;
      acc.scales.set(prefix, cur);
    } else if (r.item_type === 'text') {
      let text = '';
      try {
        const obj = JSON.parse(r.value_text || 'null');
        text = obj && typeof obj === 'object' ? String(obj.text ?? '') : String(r.value_text || '');
      } catch {
        text = String(r.value_text || '');
      }
      acc.texts.set(`${r.item_id}#${r.sub_index}`, { text, answeredAt: r.answered_at, elapsedMs: r.elapsed_ms });
    } else if (r.item_type === 'single' || r.item_type === 'multi') {
      acc.choices.set(`${r.item_id}#${r.sub_index}`, {
        value: r.value, label: r.option_label, itemType: r.item_type,
        answeredAt: r.answered_at, elapsedMs: r.elapsed_ms
      });
    } else if (r.item_type === 'gate') {
      // 「含编号」形态的编号落在 value_text（普通形态为空）
      acc.enteredCode = String(r.value_text || '').trim();
    }
  }

  return sessions.map((s) => byId.get(s.id));
}

// ---------------------------------------------------------------- 初始化
function initSeed() {
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM experiments').get().n) > 0) return;
  const now = nowIso();
  const insert = db.prepare('INSERT INTO experiments (id, name, timing_json, items_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const t = NO_TIMING;
  db.exec('BEGIN');
  try {
    insert.run('group3-high-clarity', '组别3 · AI反馈 + 目标清晰度高', t, JSON.stringify(normalizeItems(experimentItems(REQUIRE_HIGH))), now, now);
    insert.run('group4-low-clarity', '组别4 · AI反馈 + 目标清晰度低', t, JSON.stringify(normalizeItems(experimentItems(REQUIRE_LOW))), now, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
initSeed();

function ensureSettings() {
  if (getSetting('resume_window_hours') == null) setResumeWindowHours(RESUME_WINDOW_DEFAULT_HOURS);
}
ensureSettings();

// 种子管理员：首次运行创建 admin（初始密码 admin123，登录后可在「个人设置」中修改；界面不展示）
function ensureAdminUser() {
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) > 0) return;
  createUser({ username: 'admin', password: 'admin123', role: 'admin' });
  // 将已有实验 / 问卷归属到管理员
  const admin = getUserByName('admin');
  db.prepare("UPDATE experiments SET owner_id = ? WHERE owner_id IS NULL").run(admin.id);
  db.prepare("UPDATE questionnaires SET owner_id = ? WHERE owner_id IS NULL").run(admin.id);
}
ensureAdminUser();

// 首次运行：为两个实验各建一份预设问卷（插入模板 = 复制题目）
function ensurePresetQuestionnaires() {
  if (getSetting('preset_questionnaires_seeded') === '1') return;
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM questionnaires').get().n) > 0) {
    setSetting('preset_questionnaires_seeded', '1');
    return;
  }
  const base = defaultQuestionnaireItems();
  for (const expId of ['group3-high-clarity', 'group4-low-clarity']) {
    const exp = getExperimentPayload(expId);
    if (!exp) continue;
    createQuestionnaire({
      title: exp.name,
      items: [
        ...base.slice(0, 2),                                                          // 欢迎语（空）+ 知情同意页
        ...exp.items.map((it) => ({ ...it, id: `${expId}__${it.id}`, fromTemplateId: exp.id, fromTemplateName: exp.name })),
        ...base.slice(2)                                                              // 结束语（空）+ 结束说明页
      ]
    });
  }
  setSetting('preset_questionnaires_seeded', '1');
}

module.exports = {
  ITEM_TYPES,
  QUESTION_TYPES,
  ITEM_LEVELS,
  ITEM_VARIANTS,
  GATE_VARIANTS,
  FEEDBACK_TEXT,
  FEEDBACK_THINKING,
  ITEM_TYPE_LABELS,
  ITEM_LIMITS,
  LIMIT_KEYS,
  LIMIT_META,
  LIMIT_SPEC,
  DEFAULT_LIMITS,
  itemDefaults,
  defaultQuestionnaireItems,
  normalizeItems,
  getSetting,
  setSetting,
  getResumeWindowHours,
  setResumeWindowHours,
  getUser,
  getUserByName,
  verifyPassword,
  createUser,
  updateUser,
  updateUserPassword,
  deleteUser,
  listUsers,
  getExperiment,
  getExperimentPayload,
  listExperiments,
  createExperiment,
  updateExperiment,
  deleteExperiment,
  getQuestionnaire,
  getQuestionnairePayload,
  listQuestionnaires,
  createQuestionnaire,
  updateQuestionnaire,
  copyQuestionnaire,
  deleteQuestionnaire,
  deleteSessions,
  countSessionsByQuestionnaire,
  getSession,
  nextSessionSeq,
  createSession,
  setPendingPresentedAt,
  finishSession,
  abandonSession,
  touchSession,
  sessionLastActiveMs,
  bumpRetry,
  markTimeout,
  getRetryInfo,
  getAbandonAfterMinutes,
  setAbandonAfterMinutes,
  listMessages,
  listVisibleMessages,
  setClearSeq,
  maxMessageSeq,
  nextPendingVisibleAt,
  latestMessageAt,
  addMessage,
  countResponses,
  countAnswerUnits,
  unitFirstResponse,
  listResponses,
  lastResponse,
  responseAt,
  addResponse,
  listSessionSummaries,
  listResponseRows,
  listQuestionnaireSummaryRows
};

// 初始化顺序：种子实验 → 设置 → 管理员 → 预设问卷 → 归属修复
ensurePresetQuestionnaires();

// 归属修复：预设问卷在 ensureAdminUser 的归属迁移「之后」才创建，会以 owner_id = NULL 入库；
// 而列表按 owner_id 过滤，NULL 不匹配任何账号，导致这些问卷对所有用户都不可见。
// 这里把仍无归属的实验 / 问卷统一挂到管理员名下。幂等，同时可修复既有库
// （含已分发的便携包首次建库）。
function ensureOwnershipAssigned() {
  const admin = getUserByName('admin')
    || db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC, rowid ASC LIMIT 1").get()
    || null;
  if (!admin) return;
  db.prepare('UPDATE experiments SET owner_id = ? WHERE owner_id IS NULL').run(admin.id);
  db.prepare('UPDATE questionnaires SET owner_id = ? WHERE owner_id IS NULL').run(admin.id);
}
ensureOwnershipAssigned();
