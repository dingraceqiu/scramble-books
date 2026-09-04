/**
 * 云端账号与同步 API 客户端。
 * 所有请求同源打到 Express（/api/...）；token 由调用方（useAuth）管理。
 */
import type { CloudSnapshot, CloudUser } from '../types';

const TOKEN_KEY = 'scrollbook-cloud-token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 隐私模式下 localStorage 不可用：仅内存态生效
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string | null): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let resp: Response;
  try {
    resp = await fetch(path, { ...options, headers });
  } catch {
    throw new ApiError(0, '网络不可用，请检查连接后重试');
  }
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    // 非 JSON 响应
  }
  if (!resp.ok) {
    const msg =
      (body as { error?: string } | null)?.error ||
      (resp.status === 0 ? '网络不可用' : `请求失败（${resp.status}）`);
    throw new ApiError(resp.status, msg);
  }
  return body as T;
}

// ---------- 账号 ----------

export interface AuthResponse {
  user: CloudUser;
  token: string;
  expiresAt: number;
}

export function register(input: {
  email: string;
  password: string;
  inviteCode: string;
}): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function login(input: { email: string; password: string }): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function logout(token: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    '/api/auth/logout',
    { method: 'POST' },
    token,
  );
}

export function fetchMe(token: string): Promise<{ user: CloudUser | null }> {
  return request<{ user: CloudUser | null }>('/api/auth/me', {}, token);
}

// ---------- 数据同步 ----------

export interface SyncPullResult {
  data: CloudSnapshot | null;
  updatedAt: number;
}

export function pullSync(token: string): Promise<SyncPullResult> {
  return request<SyncPullResult>('/api/sync', {}, token);
}

export function pushSync(token: string, data: CloudSnapshot): Promise<{ ok: boolean; updatedAt: number }> {
  return request<{ ok: boolean; updatedAt: number }>(
    '/api/sync',
    { method: 'PUT', body: JSON.stringify({ data }) },
    token,
  );
}

export function clearCloudSync(token: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/sync', { method: 'DELETE' }, token);
}
