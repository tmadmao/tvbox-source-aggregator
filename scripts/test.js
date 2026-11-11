#!/usr/bin/env node
// 单元测试入口：esbuild 把每个 test/*.test.ts 打成一个 .mjs，再交给 node --test。
//
// 不引入 vitest/jest 的原因：这台机器与 NAS 都只装了现有依赖，加测试框架要么联网、
// 要么多一层 native 依赖；esbuild 已经是构建依赖，node:test 是 Node 18+ 内置。

const { build } = require('esbuild');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'test');
const outDir = path.join(root, '.test-dist');

if (!fs.existsSync(testDir)) {
  console.error('No test/ directory found');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const entries = fs.readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join(testDir, f));

if (entries.length === 0) {
  console.error('No *.test.ts files found');
  process.exit(1);
}

build({
  entryPoints: entries,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  sourcemap: false,
  logLevel: 'warning',
  // undici 是 CJS：打进 ESM 产物后它内部的 require('assert') 会变成
  // "Dynamic require is not supported" 直接抛错。保持外部依赖，交给 Node 原生互操作。
  external: ['undici'],
}).then(() => {
  const files = fs.readdirSync(outDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => path.join(outDir, f));
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(r.status == null ? 1 : r.status);
}).catch((err) => {
  console.error('Test build failed:', err);
  process.exit(1);
});
