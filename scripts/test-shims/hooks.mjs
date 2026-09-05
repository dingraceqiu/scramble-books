
const here = new URL('.', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // 内存 IndexedDB（idb API 子集）
  if (specifier === 'idb') {
    return { url: `${here}idb.mjs`, shortCircuit: true };
  }
  // i18next 系列包（src/i18n/index.ts 在测试里不会被加载，这里兜底防误引）
  if (specifier === 'i18next' || specifier === 'react-i18next' || specifier === 'i18next-browser-languagedetector') {
    return { url: `${here}i18n.mjs`, shortCircuit: true };
  }
  // 业务代码里的相对导入 ../i18n → src/i18n/index.ts（依赖 JSON import attributes，Node 下不可用）
  if (specifier === '../i18n' || specifier === './i18n') {
    return { url: `${here}i18n.mjs`, shortCircuit: true };
  }
  // 业务源码（src/ 下）的相对导入不带扩展名 → 补 .ts
  if (specifier.startsWith('.') && context.parentURL?.includes('/projects/src/')) {
    const clean = specifier.split('?')[0];
    if (!/\.(ts|tsx|mjs|js|json)$/.test(clean)) {
      try {
        return await nextResolve(`${specifier}.ts`, context);
      } catch {
        /* 目录解析失败则回退默认行为 */
      }
    }
  }
  return nextResolve(specifier, context);
}
