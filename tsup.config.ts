import { defineConfig, type Options } from 'tsup';
import type { Plugin } from 'esbuild';

/**
 * 生产 bundle 策略：
 * 我们自己的 server/ 源码打进单文件 dist-server/server.js；
 * **所有第三方依赖（express、bcryptjs、coze-coding-dev-sdk 及其 @langchain/jiti 依赖树等）
 * 与 Node 内置模块一律保持外部**，生产环境 pnpm install 后从 node_modules 加载。
 * 原因：coze SDK 依赖树含 import.meta / ESM 动态解析（jiti、import-meta-resolve），
 * 打进 CJS 单文件会在运行时崩溃；esbuild 还会把 node:sqlite 错写成裸 require("sqlite")。
 * 注：本仓库后端源码只依赖运行时 dependencies，devDependencies（vite/tsup）不会被打进。
 */
const externalAllNodeModules: Plugin = {
  name: 'external-all-node-modules',
  setup(build) {
    // 任何非相对路径、非内置的 import 都标记为外部（node_modules 里的包）
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      // Node 内置（含 node: 前缀）交给 esbuild 默认处理
      if (args.path.startsWith('node:')) return null;
      return { path: args.path, external: true };
    });
  },
};

export default defineConfig((options: Options) => ({
  entry: ['server/server.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist-server',
  splitting: false,
  minify: !options.watch,
  sourcemap: false,
  // 不 bundle 任何第三方包：node_modules 全部外部，仅我们自己的源码进 bundle
  noExternal: [/^[./]/],
  esbuildPlugins: [externalAllNodeModules],
  // 保险：显式声明已知大块头外部依赖
  external: [
    'vite',
    'coze-coding-dev-sdk',
    '@langchain/core',
    '@langchain/openai',
    '@supabase/supabase-js',
    'openai',
    'pg',
    'pg-native',
    'axios',
    'express',
    'bcryptjs',
  ],
  // esbuild 打包 CJS 时可能把 node:sqlite 等实验内置模块错写为裸 require("sqlite")，
  // 构建后由 scripts/fix-builtins.cjs 恢复 node: 前缀。
  onSuccess: options.watch ? undefined : 'node scripts/fix-builtins.cjs',
}));
