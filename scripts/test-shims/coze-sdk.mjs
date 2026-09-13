/**
 * coze-coding-dev-sdk 测试替身：SearchClient.webSearch 立即抛错，
 * 使 classify-book 的网页搜索分支在测试中确定性失败（走 GLM 兜底/判空），
 * 绝不在 CI 里发起真实网络请求。
 */
export class Config {
  constructor(_opts) {
    void _opts;
  }
}

export class SearchClient {
  constructor(_config, _headers) {
    void _config;
    void _headers;
  }
  async webSearch() {
    throw new Error('webSearch disabled in tests');
  }
}

export const HeaderUtils = {
  extractForwardHeaders() {
    return undefined;
  },
};
