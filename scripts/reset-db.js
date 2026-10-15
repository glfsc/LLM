// 重置实验数据库：删除 data.db（含 -wal/-shm）后重新建表并灌入种子数据
// 种子内容：两个实验模板（组别3 / 组别4，题目逐字取自实验程序文档）+ 两份预设问卷 + 默认流程题目。
// 注意：会清空全部问卷、会话、消息与作答记录；仅用于测试数据重建。
// 用法：node scripts/reset-db.js（服务需先停止，避免文件占用）
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 与 db.js 同口径：默认项目根目录的 data.db，可用 DB_PATH 覆盖
const file = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, '..', 'data.db');

for (const f of [file, `${file}-wal`, `${file}-shm`]) {
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    console.log(`已删除：${f}`);
  }
}

const store = require('../db');
const experiments = store.listExperiments();
const questionnaires = store.listQuestionnaires();
console.log(`数据库已重建：${experiments.length} 个实验模板，${questionnaires.length} 份问卷`);

for (const e of experiments) {
  const counts = {};
  for (const it of e.items) counts[it.type] = (counts[it.type] || 0) + 1;
  const answerable = e.items.filter((i) => i.type !== 'message').length;
  const withLimits = e.items.filter((i) => Object.keys(i.limits).length);
  console.log(`  - ${e.id}（${e.name}）题目 ${e.itemCount} 道（作答 ${answerable}）`);
  console.log(`      题型分布：${Object.entries(counts).map(([k, v]) => `${store.ITEM_TYPE_LABELS[k]}×${v}`).join(' ')}`);
  console.log(`      计时限制：${withLimits.map((i) => `${i.title}[${Object.entries(i.limits).map(([k, v]) => `${store.LIMIT_META[k].label}=${v}${store.LIMIT_META[k].unit || ''}`).join('+')}]`).join(' ')}`);
}
for (const q of questionnaires) {
  console.log(`  - 问卷「${q.title}」/chat?q=${q.id} · 题目 ${q.itemCount} 道 · 数据 ${q.sessionCount} 份`);
}
console.log(`  恢复窗口：${store.getResumeWindowHours()} 小时（0 = 不限制）`);
