/**
 * GLM（智谱）大模型客户端。
 *
 * 通过 OpenAI 兼容接口调用 https://open.bigmodel.cn/api/paas/v4/chat/completions。
 * 密钥来自环境变量 GLM_API_KEY（不进代码仓库）；模型默认 glm-4-flash-250414（免费档），
 * 可用 GLM_MODEL 覆盖。密钥未配置时 glmAvailable() 返回 false，调用方自行降级
 * （分类走规则投票 / 标题走本地 mock），绝不阻塞主流程。
 */

const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const GLM_API_KEY = (process.env.GLM_API_KEY || '').trim();
const GLM_MODEL = (process.env.GLM_MODEL || 'glm-4-flash-250414').trim();

export function glmAvailable(): boolean {
  return GLM_API_KEY.length > 0;
}

export function glmModelName(): string {
  return GLM_MODEL;
}

interface GlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 调用 GLM chat 接口，返回首条回复文本。
 * 网络异常/限流/鉴权失败统一抛错，由调用方决定降级策略。
 */
export async function glmChat(
  messages: GlmMessage[],
  opts: { temperature?: number; timeoutMs?: number; maxTokens?: number } = {},
): Promise<string> {
  if (!glmAvailable()) throw new Error('GLM_API_KEY 未配置');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45000);
  try {
    const res = await fetch(GLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: GLM_MODEL,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 1024,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GLM HTTP ${res.status}: ${body.slice(0, 120)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('GLM 返回空内容');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型回复中提取第一个 JSON 对象/数组（容忍 ```json 围栏与前后说明文字） */
export function extractJson<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const openChar = text[start];
  const closeChar = openChar === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
