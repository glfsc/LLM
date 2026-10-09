// 重建两个预设问卷（组别3 / 组别4）：一条实验模板 → 一条问卷链接。
// 幂等：同名问卷已存在则更新其题目与计时（不动已有数据），不存在则新建。
// 题目构成由 db.js 的 presetQuestionnaireItems 统一给出：知情同意页 + 模板题目（整组复制）+ 结束说明页。
// 用法：node scripts/seed-presets.js（服务需先停止，避免文件占用）
'use strict';

const store = require('../db');

const PRESETS = [
  { experimentId: 'group3-high-clarity', title: '组别3 · AI反馈 + 目标清晰度高' },
  { experimentId: 'group4-low-clarity', title: '组别4 · AI反馈 + 目标清晰度低' }
];

function main() {
  const existing = store.listQuestionnaires();
  let created = 0;
  let updated = 0;

  for (const preset of PRESETS) {
    const exp = store.getExperimentPayload(preset.experimentId);
    if (!exp) {
      console.error(`✗ 缺少实验模板：${preset.experimentId}（请先 node scripts/reset-db.js 重建种子）`);
      process.exitCode = 1;
      continue;
    }

    const items = store.presetQuestionnaireItems(exp);
    const answerable = items.filter((i) => i.type !== 'message').length;

    const hit = existing.find((q) => q.title === preset.title);
    if (hit) {
      store.updateQuestionnaire(hit.id, { title: preset.title, items });
      updated += 1;
      console.log(`↻ 已更新：${preset.title}`);
      console.log(`   /chat?q=${hit.id}   题目 ${items.length} 道（需作答 ${answerable}）· 已有 ${hit.sessionCount} 份数据，未受影响`);
    } else {
      const q = store.createQuestionnaire({ title: preset.title, items });
      created += 1;
      console.log(`+ 已创建：${preset.title}`);
      console.log(`   /chat?q=${q.id}   题目 ${items.length} 道（需作答 ${answerable}）`);
    }
    console.log(`   来源模板：${exp.name} · 计时参数逐题设置（问卷级默认已取消）`);
  }

  console.log(`\n预设问卷处理完成：新建 ${created} 份，更新 ${updated} 份，共 ${store.listQuestionnaires().length} 份问卷`);
  console.log(`恢复窗口：${store.getResumeWindowHours()} 小时（0 = 不限制）`);
}

main();
