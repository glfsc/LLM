// 走查脚本公共：直连数据库做「时间手术」
//
// 为什么需要它：服务端的计时门控是权威的（未到时就拒），而走查**不该真实等待**——
// 一次完整走查里 40 秒强制阅读 + 两处 180 秒最短提交，3 次走查就要等 20 分钟。
// 门控判到时只看两个时间戳，把这两处往前拨，服务端就认为等待已到时：
//   sessions.pending_presented_at  → availableAtMs（「N 秒后可提交」）
//   responses.presented_at         → 共用窗口的 startMs（server.js windowStartFor）
// 于是走查可以用**真实的门控值**而几乎不花时间。
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 与 db.js 同口径：默认项目根目录的 data.db，可用 DB_PATH 覆盖（服务端换了库位置，走查要跟着走）
const DB_FILE = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, '..', '..', 'data.db');

function withDb(fn) {
  const db = new DatabaseSync(DB_FILE);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// 把会话的开始时间往前拨（用于恢复窗口三态测试）
function backdateSession(sessionId, hoursAgo) {
  withDb((db) => {
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
      .run(new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString(), sessionId);
  });
}

// 快进：把门控的时间基准统一往前拨 deltaMs，让服务端认为等待已到时。
// 统一拨同一幅度，既让门控放行，也保持「呈现 ≤ 作答」的先后关系不变。
function fastForwardGates(sessionId, deltaMs) {
  if (!(deltaMs > 0)) return;
  withDb((db) => {
    const shift = (iso) => {
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? new Date(ms - deltaMs).toISOString() : iso;
    };
    const s = db.prepare('SELECT pending_presented_at FROM sessions WHERE id = ?').get(sessionId);
    if (s && s.pending_presented_at) {
      db.prepare('UPDATE sessions SET pending_presented_at = ? WHERE id = ?')
        .run(shift(s.pending_presented_at), sessionId);
    }
    const upd = db.prepare('UPDATE responses SET presented_at = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, presented_at FROM responses WHERE session_id = ?').all(sessionId)) {
      if (r.presented_at) upd.run(shift(r.presented_at), r.id);
    }
  });
}

// 把「最近活动时间」往前拨（用于「太久没提交自动作废」的测试）
function backdateActivity(sessionId, minutesAgo) {
  withDb((db) => {
    const iso = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
    db.prepare('UPDATE sessions SET active_at = ?, started_at = ? WHERE id = ?').run(iso, iso, sessionId);
  });
}

module.exports = { DB_FILE, withDb, backdateSession, fastForwardGates, backdateActivity };
