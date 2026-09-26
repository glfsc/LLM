// 重置实验数据库：删除 data.db（含 -wal/-shm）后重新建表并灌入论文种子文本。
// 注意：会清空全部问卷、会话、消息与作答记录；仅用于测试数据重建。
// 用法：node scripts/reset-db.js（服务需先停止，避免文件占用）
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'data.db');

for (const f of [file, `${file}-wal`, `${file}-shm`]) {
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    console.log(`已删除：${f}`);
  }
}

const store = require('../db');
const scenarios = store.listScenarios();
console.log(`数据库已重建：${scenarios.length} 个情景，${store.listQuestionnaires().length} 份问卷`);
for (const s of scenarios) {
  const groups = store.listGroupsByScenario(s.id).map((g) => g.id).join(', ');
  const tasks = store.listTasks(s.id).map((t) => t.play_count).join('+');
  console.log(`  - ${s.id}（${s.name}）任务[${tasks}] 组[${groups}]`);
}
