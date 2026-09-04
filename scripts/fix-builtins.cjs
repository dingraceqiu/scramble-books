#!/usr/bin/env node
/**
 * 构建后处理：esbuild 打包 CJS 时会把内置模块 `node:sqlite` 错误改写为裸
 * `require("sqlite")`（node:sqlite 是 Node 22+ 实验内置，无 npm 包），
 * 生产启动时会 MODULE_NOT_FOUND。此脚本把产物中裸引用的 Node 内置模块
 * 重写回 `node:` 前缀。由 tsup.config.ts 的 onSuccess 调用。
 */
const { readFileSync, writeFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { builtinModules } = require('node:module');

const outDir = join(process.cwd(), 'dist-server');
const builtins = new Set(
  builtinModules.flatMap((m) => (m.startsWith('node:') ? [m, m.slice(5)] : [m])),
);

for (const file of readdirSync(outDir)) {
  if (!file.endsWith('.js')) continue;
  const path = join(outDir, file);
  const original = readFileSync(path, 'utf8');
  const fixed = original.replace(/require\((['"])([a-z][a-z0-9_-]*)\1\)/g, (full, quote, mod) =>
    builtins.has(mod) ? `require(${quote}node:${mod}${quote})` : full,
  );
  if (fixed !== original) {
    writeFileSync(path, fixed);
    console.log(`[fix-builtins] ${file}: 裸内置模块引用已恢复 node: 前缀`);
  }
}
