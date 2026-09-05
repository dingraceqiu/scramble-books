/**
 * 测试专用 i18n shim：替代 src/i18n/index.ts 与 i18next 系列包。
 * 只提供业务代码在 Node 测试里用到的面：language、t（返回 key）、事件占位。
 */
const listeners = {};

const i18n = {
  language: 'zh-CN',
  /** 测试里题目 stem 只需要确定性文本；泄漏断言以 options/evidence/explanation 为准 */
  t(key, opts) {
    if (opts && typeof opts === 'object') {
      return `${key}:${JSON.stringify(opts)}`;
    }
    return key;
  },
  on(event, fn) {
    (listeners[event] ??= []).push(fn);
  },
  off() {},
  use() {
    return i18n;
  },
  init() {
    return i18n;
  },
  changeLanguage(lng) {
    i18n.language = lng;
  },
};

export default i18n;
