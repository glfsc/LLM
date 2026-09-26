// 数据层：SQLite（Node 内置 node:sqlite）—— 建表、种子数据与访问函数
// 结构：情景（scenario，空间）→ 组（group，控制/干预）；所有文本固定存储，运行时不做任何生成。
'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  -- 情景（空间）：情境材料、单次/多次提问、研究2匹配文本
  CREATE TABLE IF NOT EXISTS scenarios (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    context_text     TEXT NOT NULL DEFAULT '',
    once_question    TEXT NOT NULL DEFAULT '',
    multi_question   TEXT NOT NULL DEFAULT '',
    r2_once_a        TEXT NOT NULL DEFAULT '',
    r2_once_b        TEXT NOT NULL DEFAULT '',
    r2_multi_a       TEXT NOT NULL DEFAULT '',
    r2_multi_b       TEXT NOT NULL DEFAULT '',
    rating_question  TEXT NOT NULL DEFAULT '',
    enabled          INTEGER NOT NULL DEFAULT 1,
    sort             INTEGER NOT NULL DEFAULT 0,
    updated_at       TEXT
  );

  -- 组：每个情景固定 2 组（控制 / 干预），差异在"研究3文本"
  CREATE TABLE IF NOT EXISTS groups (
    id           TEXT PRIMARY KEY,
    scenario_id  TEXT NOT NULL,
    name         TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'control',
    r3_once      TEXT NOT NULL DEFAULT '',
    r3_multi     TEXT NOT NULL DEFAULT '',
    enabled      INTEGER NOT NULL DEFAULT 1,
    updated_at   TEXT
  );

  -- 任务清单：情景包含哪些任务（单次 1 / 多次 100）及顺序
  CREATE TABLE IF NOT EXISTS scenario_tasks (
    scenario_id TEXT NOT NULL,
    sort        INTEGER NOT NULL,
    play_count  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (scenario_id, sort)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    scenario_id  TEXT NOT NULL,
    group_id     TEXT NOT NULL,
    uid          TEXT,
    status       TEXT NOT NULL DEFAULT 'in_progress',
    started_at   TEXT,
    ended_at     TEXT,
    duration_sec INTEGER,
    code         TEXT,
    user_agent   TEXT
  );

  -- 消息流：AI 消息 + 用户动作回显（role: assistant / user）
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    seq        INTEGER,
    created_at TEXT
  );

  -- 作答记录：决策 / 评分（含时间戳与耗时）
  CREATE TABLE IF NOT EXISTS responses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    scenario_id  TEXT NOT NULL,
    group_id     TEXT NOT NULL,
    task_index   INTEGER NOT NULL,
    play_count   INTEGER NOT NULL,
    phase        TEXT NOT NULL,
    value        INTEGER NOT NULL,
    option_label TEXT NOT NULL DEFAULT '',
    shown_at     TEXT,
    answered_at  TEXT,
    elapsed_ms   INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ---------------------------------------------------------------- 种子数据
// 全部文本来自论文《心理学报》补充材料 B1（情境）B3（GPT-4o 策略文本）B4（控制组对照文本）。
// 研究2匹配文本（r2_*）：被试决策后按其选择呈现对应文本；研究3文本（r3_*）：按组别呈现。
// 论文干预方向：单次博弈→说服选风险方案B；多次博弈→说服选确定方案A；控制组取对应选项的客观描述。

const SEED_SCENARIOS = [
  {
    id: 'medical',
    name: '医疗情景',
    context:
      '请您想象您是一名应急管理决策者。某种疾病预计在爆发时将导致600人死亡。您可以选择两种应急预案中的任意一个来应对该疾病。假设以下是这两种预案的科学估计结果：\n' +
      '如果采用方案A，将挽救200人的生命。\n' +
      '如果采用方案B，存在2/5的概率可以挽救600人的生命，且有3/5的概率没有人能够被挽救。',
    onceQuestion: '假设您选择的预案只会应用1次，您更倾向于选择哪种方案？',
    multiQuestion: '假设您选择的预案将应用100次，您更倾向于选择哪种方案？',
    r2OnceA:
      '在这种情况下，方案A的期望值计算为挽救200人的生命，显著地保障了一个稳定的结果。虽然方案B提供了较高的回报潜力（可能挽救600人的生命），但其60%的失败概率意味着没有人能够得救。因此，选择方案A的理性决策基于更高的确定性，最大化了挽救生命的预期收益，减少了潜在的风险，符合期望值最大化的原则。',
    r2OnceB:
      '选择方案B可以基于期望值的计算进行理性决策。尽管方案B存在较高的风险（3/5的概率没有人能被挽救），但它提供了2/5的概率挽救所有600人的生命，期望值为2/5×600 = 240人，显著高于方案A挽救的200人。尽管风险较大，方案B的期望收益更为可取，理性决策者应考虑期望值而非单次结果的波动。',
    r2MultiA:
      '在多次应用情境中，方案A更具理性。每次选择A将挽救200人的生命，长期来看，累计挽救生命的预期效果更为稳定。而方案B虽然存在高回报的可能，但每次损失的风险较大，且在多次应用中，未必能如期获得预期的效果。选择方案A能够最大化长期的期望收益，确保每次决策都带来稳定的回报，避免由于概率波动带来的不确定性。',
    r2MultiB:
      '在多次应用情境中，选择方案B将最大化期望收益。尽管存在3/5的概率无法挽救任何人，但2/5的高概率能够挽救所有600人的生命，带来极大的正回报。基于期望值的计算，方案B的期望收益为2/5×600 = 240人，而方案A的固定收益仅为200人。选择方案B可以通过多次应用保障长期的生命挽救效益，尽管短期内可能会有波动。',
    ratingQuestion: '您认为以上提供的决策依据与您在回答疾病问题时实际思考过程的相似程度如何？',
    control: {
      r3Once: '在实施方案B的情况下，根据概率分布将呈现两种结果：当40%概率事件发生时全体600人将成功获救；当60%概率事件发生时将无法实现任何人员获救。',
      r3Multi: '在实施方案A的情况下，科学评估表明，采取相应干预措施后，预计可以挽救200人的生命。这个数字反映了方案在应对疾病爆发时可能带来的效果。'
    },
    treat: {
      r3Once: '选择方案B可以基于期望值的计算进行理性决策。尽管方案B存在较高的风险（3/5的概率没有人能被挽救），但它提供了2/5的概率挽救所有600人的生命，期望值为2/5×600 = 240人，显著高于方案A挽救的200人。尽管风险较大，方案B的期望收益更为可取，理性决策者应考虑期望值而非单次结果的波动。',
      r3Multi: '在多次应用情境中，方案A更具理性。每次选择A将挽救200人的生命，长期来看，累计挽救生命的预期效果更为稳定。而方案B虽然存在高回报的可能，但每次损失的风险较大，且在多次应用中，未必能如期获得预期的效果。选择方案A能够最大化长期的期望收益，确保每次决策都带来稳定的回报，避免由于概率波动带来的不确定性。'
    }
  },
  {
    id: 'finance',
    name: '金融情景',
    context:
      '对于处理某一种财务紧急事件，存在两种可选的应急预案。假设对这两种预案的科学估计结果如下：\n' +
      '如果采用方案A，将获得5000元。\n' +
      '如果采用方案B，存在0.1%的概率可以获得600万元，且有99.9%的概率什么也得不到。',
    onceQuestion: '假设您选择的预案只会应用1次，您更倾向于选择哪种方案？',
    multiQuestion: '假设您选择的预案将应用100次，您更倾向于选择哪种方案？',
    r2OnceA:
      '选择方案A的理由：虽然方案B可能带来极高的回报，但其极低的概率（0.1%）意味着大多数情况下什么也得不到。相较之下，方案A提供确定的5000元收益，确保稳定回报，避免因风险过高而带来的心理压力和潜在损失。因此，从期望值角度考虑，方案A是理性决策的优选。',
    r2OnceB:
      '基于期望值的数学理性决策，选择方案B是更有利的选择。虽然方案B的高额回报概率极低，但其期望收益计算为0.001 × 6000000 = 6000元，明显高于方案A的5000元。因此，基于预期收益最大化原则，方案B提供了更大的潜在回报，适合那些愿意接受微小风险、追求高回报的决策者。',
    r2MultiA:
      '在面对财务紧急事件时，选择方案A将确保您每次获得稳定的5000元回报，而方案B虽然存在极低概率的高回报，但绝大部分情况下得不到任何收益。考虑长期的稳定性和风险控制，方案A提供了明确的收益，符合期望值最大化的理性决策。因此，选择方案A将有助于您在长期内保持稳定的财务状况。',
    r2MultiB:
      '选择方案B将会在多次应用中带来更高的长期回报。尽管每次仅有0.1%的概率成功，但一旦获胜，回报将是显著的600万元，足以覆盖多次未中奖的损失。通过多次应用，B方案的期望收益将显著大于A方案的固定5000元。随着应用次数的增加，成功的概率也会逐渐显现，长期来看，它为理性决策者提供了更高的期望收益。',
    ratingQuestion: '您认为以上提供的决策依据与您在回答财务问题时实际思考过程的相似程度如何？',
    control: {
      r3Once: '采用方案B时，存在0.1%的概率能够获得600万元，而在99.9%的情况下，将没有任何财务收益。这一评估结果基于对事件发生的概率计算。',
      r3Multi: '在实施方案A的情况下，将获得5000元的确定性资金，该数额为固定金额，不受概率性因素的影响，这个数字反映了选择方案A将会带来的效果。'
    },
    treat: {
      r3Once: '基于期望值的数学理性决策，选择方案B是更有利的选择。虽然方案B的高额回报概率极低，但其期望收益计算为0.001 × 6000000 = 6000元，明显高于方案A的5000元。因此，基于预期收益最大化原则，方案B提供了更大的潜在回报，适合那些愿意接受微小风险、追求高回报的决策者。',
      r3Multi: '在面对财务紧急事件时，选择方案A将确保您每次获得稳定的5000元回报，而方案B虽然存在极低概率的高回报，但绝大部分情况下得不到任何收益。考虑长期的稳定性和风险控制，方案A提供了明确的收益，符合期望值最大化的理性决策。因此，选择方案A将有助于您在长期内保持稳定的财务状况。'
    }
  },
  {
    id: 'creative',
    name: '内容创作情景',
    context:
      '假设您是一名自媒体账号的创作者，目前正在筹备新视频的发布。为了增加账号的粉丝关注量，现有两种新视频内容的制作方案可供选择。就每条新视频而言，两种方案的实施效果如下：\n' +
      '如果采用方案A，账号将获得300位粉丝的关注。\n' +
      '如果采用方案B，账号将有40%的概率获得1000位粉丝的关注，但同时也有60%的概率得不到任何关注。',
    onceQuestion: '假设您只能发布1条新视频，您需要从上述两种方案中选择一个，在这1条新视频的制作中实施。您更倾向选择哪一个方案？',
    multiQuestion: '假设您能发布100条新视频，您需要从上述两种方案中选择一个，在这100条新视频的制作中统一实施。您更倾向选择哪一个方案？',
    r2OnceA:
      '在仅有一次选择机会的情境中，方案A以100%概率带来300位粉丝，收益稳定、风险为零，是更理性的选择。相比之下，方案B虽有高回报的可能，但60%的失败概率意味着很可能一无所获。在无法承受失败损失、又希望确保增长的情况下，选择A更符合数学理性与稳健决策的原则。',
    r2OnceB:
      '尽管方案B存在一定风险，但其期望收益显著高于方案A。根据计算，B方案的期望粉丝增量为0.4×1000 + 0.6×0 = 400人，超过方案A的300人。这意味着，在当前只有一次发布机会的情境中，选择B更能最大化潜在收益，为账号带来更大曝光和增长机会，是更具理性的决策。',
    r2MultiA:
      '在需要反复发布视频的情境下，选择方案A更为明智。每条视频稳定带来300位粉丝，意味着100条视频将积累3万关注，无需承受波动带来的不确定性。而方案B的期望值仅为400位，虽看似更高，但60%的失败概率将频繁带来“零增长”的落空感，增加心理压力。多次应用中，稳定回报胜过不确定博弈，选择A是理性与稳健的双重保障。',
    r2MultiB:
      '在多次发布中，选择方案B将显著提升账号总体增长潜力。虽然单条视频有60%概率不增粉，但40%的成功率可带来1000粉丝，单次期望值为400人。若连续发布100条视频，预期可获得约40,000粉丝，远超方案A的30,000人。在长期操作下，高回报覆盖低收益，理性选择应基于期望值最大化与累计效应，方案B是更优解。',
    ratingQuestion: '您认为以上提供的决策依据与您在回答创作问题时实际思考过程的相似程度如何？',
    control: {
      r3Once: '在实施方案B的情况下，新发布的视频有40%的可能获得1000位粉丝关注，同时也存在60%的可能未能获得任何关注。',
      r3Multi: '在实施方案A的情况下，新发布的视频可带来300位粉丝的关注，该关注量为确定值，不受其他因素影响。'
    },
    treat: {
      r3Once: '尽管方案B存在一定风险，但其期望收益显著高于方案A。根据计算，B方案的期望粉丝增量为0.4×1000 + 0.6×0 = 400人，超过方案A的300人。这意味着，在当前只有一次发布机会的情境中，选择B更能最大化潜在收益，为账号带来更大曝光和增长机会，是更具理性的决策。',
      r3Multi: '在需要反复发布视频的情境下，选择方案A更为明智。每条视频稳定带来300位粉丝，意味着100条视频将积累3万关注，无需承受波动带来的不确定性。而方案B的期望值仅为400位，虽看似更高，但60%的失败概率将频繁带来“零增长”的落空感，增加心理压力。多次应用中，稳定回报胜过不确定博弈，选择A是理性与稳健的双重保障。'
    }
  },
  {
    id: 'marketing',
    name: '电商营销情景',
    context:
      '假设您目前在一家电商企业中任职，负责公司旗下电商店铺的日常运营工作。为提高店铺的营业收入，公司拟定了两种不同的营销方案。就每家店铺而言，两种方案的实施效果如下：\n' +
      '如果采用方案A，每家店铺每月可稳定获得2万元收入。\n' +
      '如果采用方案B，每家店铺每月有30%的概率获得10万元收入，但同时也有70%的概率得不到任何收入。',
    onceQuestion: '假设您当前仅负责1家店铺的运营，您需要从上述两种方案中选择一个，在这1家店铺中实施。您更倾向选择哪一个方案？',
    multiQuestion: '假设您当前负责100家店铺的运营，您需要从上述两种方案中选择一个，在这100家店铺中统一实施。您更倾向选择哪一个方案？',
    r2OnceA:
      '选择方案A，是理性决策者在单次任务中最优的选择。尽管方案B的高额收益看似诱人，但其70%概率带来的是0收益的高风险。相比之下，方案A提供的是稳定、可预期的2万元收入，无需承担巨大的不确定性。在只负责1家店铺的情境下，理性应优先考虑保底收益，避免因一次决策失败对整体绩效造成致命打击。',
    r2OnceB:
      '选择方案B是理性且值得尝试的决策。虽然有70%的概率无法获得收入，但30%的高回报（10万元）使得方案B的单次期望收益高达3万元，远高于方案A的固定收益2万元。在当前仅负责1家店铺的情况下，选择期望值更高的方案，有望在一次决策中实现收益最大化，是聪明运营者应有的判断。',
    r2MultiA:
      '在多次应用情境中，方案A的稳定收益远优于方案B的波动性结果。假设运营100家店铺，选择方案A将带来稳定的200万元月收入；而选择方案B，期望收益仅为100×（0.3×10万） = 300万元，看似更高，但其70%的失败概率将带来巨大不确定性和收入波动。理性决策应以期望值为基础，同时考虑风险可控性。选择A更利于企业稳健运营与长期发展。',
    r2MultiB:
      '在面对100家店铺的长期运营时，选择方案B更具理性优势。尽管单月存在70%的失败概率，但每家店铺的期望收益为0.3×10万 = 3万元，远高于方案A的2万元。放在多次应用中看，期望值在大数法则作用下趋于稳定，整体将实现更高总收入。只需部分店铺达成高收益，就足以覆盖其余店铺的损失，是追求利润最大化的理性选择。',
    ratingQuestion: '您认为以上提供的决策依据与您在回答营销问题时实际思考过程的相似程度如何？',
    control: {
      r3Once: '在实施方案B的情况下，每家店铺每月有30%的可能获得10万元收入，同时也存在70%的可能未能获得任何收入。',
      r3Multi: '在实施方案A的情况下，每家店铺每月可获得2万元的稳定收入，该数值在各月之间保持不变，具有固定的收益表现。'
    },
    treat: {
      r3Once: '选择方案B是理性且值得尝试的决策。虽然有70%的概率无法获得收入，但30%的高回报（10万元）使得方案B的单次期望收益高达3万元，远高于方案A的固定收益2万元。在当前仅负责1家店铺的情况下，选择期望值更高的方案，有望在一次决策中实现收益最大化，是聪明运营者应有的判断。',
      r3Multi: '在多次应用情境中，方案A的稳定收益远优于方案B的波动性结果。假设运营100家店铺，选择方案A将带来稳定的200万元月收入；而选择方案B，期望收益仅为100×（0.3×10万） = 300万元，看似更高，但其70%的失败概率将带来巨大不确定性和收入波动。理性决策应以期望值为基础，同时考虑风险可控性。选择A更利于企业稳健运营与长期发展。'
    }
  }
];

// 默认任务清单：单次 + 多次
const SEED_TASKS = [1, 100];

function nowIso() {
  return new Date().toISOString();
}

function initSeed() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM scenarios').get();
  if (Number(row.n) > 0) return;

  const insertScenario = db.prepare(
    `INSERT INTO scenarios (id, name, context_text, once_question, multi_question,
       r2_once_a, r2_once_b, r2_multi_a, r2_multi_b, rating_question, enabled, sort, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  const insertGroup = db.prepare(
    `INSERT INTO groups (id, scenario_id, name, role, r3_once, r3_multi, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  );
  const insertTask = db.prepare(
    'INSERT INTO scenario_tasks (scenario_id, sort, play_count) VALUES (?, ?, ?)'
  );

  db.exec('BEGIN');
  try {
    SEED_SCENARIOS.forEach((s, i) => {
      insertScenario.run(
        s.id, s.name, s.context, s.onceQuestion, s.multiQuestion,
        s.r2OnceA, s.r2OnceB, s.r2MultiA, s.r2MultiB, s.ratingQuestion, i + 1, nowIso()
      );
      insertGroup.run(`${s.id}-control`, s.id, '控制组', 'control', s.control.r3Once, s.control.r3Multi, nowIso());
      insertGroup.run(`${s.id}-treat`, s.id, '干预组', 'treat', s.treat.r3Once, s.treat.r3Multi, nowIso());
      SEED_TASKS.forEach((play, j) => insertTask.run(s.id, j + 1, play));
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (!getSetting('admin_password')) {
    setSetting('admin_password', 'admin123');
  }
}
initSeed();

// ---------------------------------------------------------------- 设置

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

// ---------------------------------------------------------------- 情景 / 组 / 任务

function getScenario(id) {
  return db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id) || null;
}

function listScenarios() {
  return db.prepare('SELECT * FROM scenarios ORDER BY sort ASC').all();
}

function getGroup(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id) || null;
}

function listGroups() {
  return db.prepare('SELECT * FROM groups ORDER BY rowid ASC').all();
}

function listGroupsByScenario(scenarioId) {
  return db
    .prepare("SELECT * FROM groups WHERE scenario_id = ? ORDER BY CASE role WHEN 'control' THEN 0 ELSE 1 END")
    .all(scenarioId);
}

function listTasks(scenarioId) {
  return db
    .prepare('SELECT sort, play_count FROM scenario_tasks WHERE scenario_id = ? ORDER BY sort ASC')
    .all(scenarioId);
}

// 整棵情景树保存（事务）：情景文本 + 任务清单 + 两个组的研究3文本
function saveScenarioTree(scenarioId, payload) {
  const scenario = getScenario(scenarioId);
  if (!scenario) return null;

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE scenarios SET name = ?, context_text = ?, once_question = ?, multi_question = ?,
         r2_once_a = ?, r2_once_b = ?, r2_multi_a = ?, r2_multi_b = ?, rating_question = ?,
         enabled = ?, updated_at = ? WHERE id = ?`
    ).run(
      String(payload.name), String(payload.contextText ?? ''), String(payload.onceQuestion ?? ''),
      String(payload.multiQuestion ?? ''), String(payload.r2OnceA ?? ''), String(payload.r2OnceB ?? ''),
      String(payload.r2MultiA ?? ''), String(payload.r2MultiB ?? ''), String(payload.ratingQuestion ?? ''),
      payload.enabled ? 1 : 0, nowIso(), scenarioId
    );

    db.prepare('DELETE FROM scenario_tasks WHERE scenario_id = ?').run(scenarioId);
    const insertTask = db.prepare('INSERT INTO scenario_tasks (scenario_id, sort, play_count) VALUES (?, ?, ?)');
    (payload.tasks || []).forEach((play, i) => insertTask.run(scenarioId, i + 1, Number(play) || 1));

    for (const g of payload.groups || []) {
      db.prepare(
        'UPDATE groups SET name = ?, r3_once = ?, r3_multi = ?, enabled = ?, updated_at = ? WHERE id = ? AND scenario_id = ?'
      ).run(String(g.name), String(g.r3Once ?? ''), String(g.r3Multi ?? ''), g.enabled ? 1 : 0, nowIso(), g.id, scenarioId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getScenario(scenarioId);
}

// ---------------------------------------------------------------- 会话与消息

function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

// 按 组别 + 被试编号 查找最近的会话（用于刷新恢复 / 跨设备恢复）
function findSessionByUid(groupId, uid) {
  return (
    db
      .prepare('SELECT * FROM sessions WHERE group_id = ? AND uid = ? ORDER BY started_at DESC LIMIT 1')
      .get(groupId, uid) || null
  );
}

function createSession({ scenarioId, groupId, uid, userAgent }) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO sessions (id, scenario_id, group_id, uid, status, started_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, scenarioId, groupId, uid || '', 'in_progress', nowIso(), userAgent || '');
  return getSession(id);
}

function listMessages(sessionId) {
  return db
    .prepare('SELECT id, role, content, seq, created_at FROM messages WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId);
}

function addMessage(sessionId, role, content) {
  const maxSeq = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE session_id = ?')
    .get(sessionId);
  const seq = Number(maxSeq.m) + 1;
  const createdAt = nowIso();
  const info = db
    .prepare('INSERT INTO messages (session_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, role, content, seq, createdAt);
  return { id: Number(info.lastInsertRowid), role, content, seq, created_at: createdAt };
}

// 完成码：6 位无易混字符
function makeCode() {
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY34679';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function finishSession(id) {
  const session = getSession(id);
  if (!session) return null;
  if (session.status === 'completed') return session;

  const endedAt = nowIso();
  const duration = Math.max(
    1,
    Math.round((new Date(endedAt).getTime() - new Date(session.started_at).getTime()) / 1000)
  );
  const code = session.code || makeCode();
  db.prepare(
    'UPDATE sessions SET status = ?, ended_at = ?, duration_sec = ?, code = ? WHERE id = ?'
  ).run('completed', endedAt, duration, code, id);
  return getSession(id);
}

// ---------------------------------------------------------------- 作答记录

function countResponses(sessionId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM responses WHERE session_id = ?').get(sessionId);
  return Number(row.n);
}

function listResponses(sessionId) {
  return db
    .prepare('SELECT * FROM responses WHERE session_id = ? ORDER BY id ASC')
    .all(sessionId);
}

function addResponse({ sessionId, scenarioId, groupId, taskIndex, playCount, phase, value, optionLabel, shownAt, answeredAt, elapsedMs }) {
  const info = db
    .prepare(
      `INSERT INTO responses (session_id, scenario_id, group_id, task_index, play_count, phase, value, option_label, shown_at, answered_at, elapsed_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId, scenarioId, groupId, taskIndex, playCount, phase, value,
      optionLabel || '', shownAt || null, answeredAt || nowIso(), elapsedMs == null ? null : elapsedMs
    );
  return Number(info.lastInsertRowid);
}

// 情景树 + 组（管理端序列化用）
function adminScenarioPayload(scenario) {
  return {
    id: scenario.id,
    name: scenario.name,
    contextText: scenario.context_text,
    onceQuestion: scenario.once_question,
    multiQuestion: scenario.multi_question,
    r2OnceA: scenario.r2_once_a,
    r2OnceB: scenario.r2_once_b,
    r2MultiA: scenario.r2_multi_a,
    r2MultiB: scenario.r2_multi_b,
    ratingQuestion: scenario.rating_question,
    enabled: Boolean(scenario.enabled),
    tasks: listTasks(scenario.id).map((t) => Number(t.play_count)),
    groups: listGroupsByScenario(scenario.id).map((g) => ({
      id: g.id,
      scenario_id: g.scenario_id,
      name: g.name,
      role: g.role,
      r3Once: g.r3_once,
      r3Multi: g.r3_multi,
      enabled: Boolean(g.enabled)
    }))
  };
}

module.exports = {
  getSetting,
  setSetting,
  getScenario,
  listScenarios,
  getGroup,
  listGroups,
  listGroupsByScenario,
  listTasks,
  saveScenarioTree,
  getSession,
  findSessionByUid,
  createSession,
  listMessages,
  addMessage,
  finishSession,
  countResponses,
  listResponses,
  addResponse,
  adminScenarioPayload
};
