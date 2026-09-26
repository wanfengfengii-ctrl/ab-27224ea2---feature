/*
 * verify.js — 一次性校核入口：单元测试 → 构建 → 遮挡判定冒烟。
 * 任一步骤失败即以非零退出码终止；全部通过退出码 0。
 */
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const steps = [
  ['单元测试（node --test）', ['--test']],
  ['构建（scripts/build.js）', ['scripts/build.js']],
  ['遮挡判定冒烟（scripts/smoke.js）', ['scripts/smoke.js']],
];

for (let i = 0; i < steps.length; i++) {
  const [name, args] = steps[i];
  console.log(`\n===== [${i + 1}/${steps.length}] ${name} =====`);
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✗ 步骤失败：${name}（退出码 ${r.status}）`);
    process.exit(r.status || 1);
  }
  console.log(`✓ ${name}`);
}
console.log('\n全部校核步骤通过');
