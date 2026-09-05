import { register, registerHooks } from 'node:module';

/**
 * 测试 loader 注册入口：
 *   node --import ./scripts/test-shims/register.mjs --import tsx scripts/verify-persistence.ts
 * 把 'idb' 与 i18next 系列替换为内存 shim，使持久层/学习层可在 Node 中做集成验证。
 *
 * 双模式：
 * - Node 22.15+/23.5+ 用同步 registerHooks（同时拦截 require 与 import）。tsx 4.21 在
 *   新版 Node 上会把 CJS 包内的 .ts 测试脚本按 CJS 链路加载，require() 不会经过异步
 *   register() hooks，shim 会失效（真实 idb 被加载 → 全局 indexedDB 未定义）。
 * - 老 Node 回退到异步 register()（仅 ESM 链路，原有行为）。
 */
if (typeof registerHooks === 'function') {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return resolveShim(specifier, context, nextResolve);
    },
  });
} else {
  register('./hooks.mjs', import.meta.url);
}

function resolveShim(specifier, context, nextResolve) {
  const here = new URL('.', import.meta.url);

  // 内存 IndexedDB（idb API 子集）
  if (specifier === 'idb') {
    return { url: new URL('idb.mjs', here).href, shortCircuit: true };
  }
  // i18next 系列包（src/i18n/index.ts 在测试里不会被加载，这里兜底防误引）
  if (specifier === 'i18next' || specifier === 'react-i18next' || specifier === 'i18next-browser-languagedetector') {
    return { url: new URL('i18n.mjs', here).href, shortCircuit: true };
  }
  // 业务代码里的相对导入 ../i18n → src/i18n/index.ts（依赖 JSON import attributes，Node 下不可用）
  if (specifier === '../i18n' || specifier === './i18n') {
    return { url: new URL('i18n.mjs', here).href, shortCircuit: true };
  }
  // 业务源码（src/ 下）的相对导入不带扩展名 → 补 .ts
  if (specifier.startsWith('.') && context.parentURL?.includes('/projects/src/')) {
    const clean = specifier.split('?')[0];
    if (!/\.(ts|tsx|mjs|js|json)$/.test(clean)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* 目录解析失败则回退默认行为 */
      }
    }
  }
  return nextResolve(specifier, context);
}
