/*
 * build.js — 纯前端构建：语法检查、HTML 引用校验、拷贝到 dist/ 并生成构建信息。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const FILES = ['index.html', 'styles.css', 'src/geometry.js', 'src/validate.js', 'src/app.js'];

for (const f of FILES) {
  if (!fs.existsSync(path.join(root, f))) {
    console.error(`缺少文件：${f}`);
    process.exit(1);
  }
}

for (const f of FILES.filter((f) => f.endsWith('.js'))) {
  execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'inherit' });
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !/^https?:/.test(u) && !u.startsWith('#'));
for (const r of refs) {
  if (!FILES.includes(r)) {
    console.error(`index.html 引用了未纳入构建的文件：${r}`);
    process.exit(1);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
for (const f of FILES) {
  const to = path.join(dist, f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, f), to);
}
fs.writeFileSync(
  path.join(dist, 'build-info.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), files: FILES }, null, 2) + '\n'
);
console.log(`构建完成：dist/（${FILES.length} 个文件）`);
