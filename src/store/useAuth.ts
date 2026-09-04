/**
 * 账号与云端模式状态。
 * - 未登录：mode='local'，应用完全走 IndexedDB 本地模式（与旧版一致）。
 * - 登录后：mode='cloud'，数据以云端为准，本地改动防抖推送。
 *
 * token 持久化在 localStorage（scrollbook-cloud-token），刷新页面自动恢复会话；
 * 业务数据同步逻辑见 lib/sync.ts。
 */
import { create } from 'zustand';
import type { AppMode, CloudUser } from '../types';
import * as api from '../lib/cloudApi';

export type SyncStatus = 'idle' | 'syncing' | 'ok' | 'error' | 'offline';

interface AuthState {
  mode: AppMode;
  user: CloudUser | null;
  token: string | null;
  /** 会话恢复/登录流程进行中 */
  authReady: boolean;
  syncStatus: SyncStatus;
  syncMessage: string;

  /** 启动时用 localStorage 里的 token 恢复会话 */
  restoreSession: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, inviteCode: string) => Promise<void>;
  signOut: () => Promise<void>;
  setSyncStatus: (s: SyncStatus, message?: string) => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  mode: 'local',
  user: null,
  token: null,
  authReady: false,
  syncStatus: 'idle',
  syncMessage: '',

  restoreSession: async () => {
    const token = api.getStoredToken();
    if (!token) {
      set({ authReady: true });
      return;
    }
    try {
      const { user } = await api.fetchMe(token);
      if (user) {
        set({ user, token, mode: 'cloud', authReady: true });
      } else {
        api.setStoredToken(null);
        set({ authReady: true });
      }
    } catch {
      // 网络错误时保留 token（下次联网可再试），但不进入 cloud 模式
      api.setStoredToken(null);
      set({ authReady: true });
    }
  },

  signIn: async (email, password) => {
    const resp = await api.login({ email, password });
    api.setStoredToken(resp.token);
    set({ user: resp.user, token: resp.token, mode: 'cloud', syncStatus: 'syncing' });
  },

  signUp: async (email, password, inviteCode) => {
    const resp = await api.register({ email, password, inviteCode });
    api.setStoredToken(resp.token);
    set({ user: resp.user, token: resp.token, mode: 'cloud', syncStatus: 'syncing' });
  },

  signOut: async () => {
    const { token } = get();
    if (token) {
      try {
        await api.logout(token);
      } catch {
        // 即使服务端登出失败也清除本地会话
      }
    }
    api.setStoredToken(null);
    set({ user: null, token: null, mode: 'local', syncStatus: 'idle', syncMessage: '' });
  },

  setSyncStatus: (s, message) =>
    set({ syncStatus: s, syncMessage: message ?? '' }),
}));
