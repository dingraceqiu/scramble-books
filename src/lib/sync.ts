/**
 * 云端同步引擎：
 * - 登录后 pullCloudData()：拉取云端快照。云端有数据 → 整库替换本地（以云端为准）后刷新页面；
 *   云端为空 → 把本地现有数据推上去（首次登录迁移本地书库）。
 * - 登录期间本地任何改动 → schedulePush() 防抖 1.5s 推送整库快照（last-write-wins）。
 * - 登出时按用户选择保留或清空本地数据。
 *
 * 数据快照直接取自 IndexedDB（store 全部 write-through，它是事实来源），
 * 阅读偏好取自 localStorage 的 zustand persist 键。
 */
import type { CloudSnapshot } from '../types';
import * as db from './db';
import * as api from './cloudApi';
import { useAuth } from '../store/useAuth';
import { useStore } from '../store/useStore';
import { useReaderPrefs } from '../store/useReaderPrefs';
import i18n from '../i18n';

const READER_PREFS_KEY = 'scrollbook-reader-prefs';

function readReaderPrefs(): CloudSnapshot['readerPrefs'] {
  try {
    const raw = localStorage.getItem(READER_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { state?: unknown };
    const state = (parsed && typeof parsed === 'object' && 'state' in parsed
      ? (parsed as { state: CloudSnapshot['readerPrefs'] }).state
      : parsed) as CloudSnapshot['readerPrefs'] | undefined;
    return state ?? {};
  } catch {
    return {};
  }
}

export async function buildSnapshot(): Promise<CloudSnapshot> {
  const data = await db.loadAll();
  const documents = await db.getAllDocuments();
  return {
    version: 1,
    books: data.books,
    documents,
    units: data.units,
    progress: data.progress,
    highlights: data.highlights,
    notes: data.notes,
    marks: data.marks,
    readerPrefs: readReaderPrefs(),
  };
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushing = false;
let queued = false;

export function schedulePush(): void {
  const { mode, token } = useAuth.getState();
  if (mode !== 'cloud' || !token) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushNow();
  }, 1500);
}

export async function pushNow(): Promise<void> {
  const { mode, token, setSyncStatus } = useAuth.getState();
  if (mode !== 'cloud' || !token) return;
  if (pushing) {
    queued = true;
    return;
  }
  pushing = true;
  setSyncStatus('syncing');
  try {
    const snap = await buildSnapshot();
    await api.pushSync(token, snap);
    setSyncStatus('ok');
  } catch (e) {
    const msg = e instanceof api.ApiError && e.status === 0
      ? i18n.t('account.offlineHint')
      : (e instanceof Error ? e.message : i18n.t('account.syncFailed'));
    setSyncStatus('error', msg);
    console.warn('[sync] push failed:', e);
  } finally {
    pushing = false;
    if (queued) {
      queued = false;
      void pushNow();
    }
  }
}

/**
 * 登录/注册成功后调用：
 * 1. 拉取云端快照；
 * 2. 云端有数据 → 写入本地（IndexedDB + 阅读偏好），返回 'replaced'（调用方刷新页面）；
 * 3. 云端为空 → 推送本地快照作为云端初始数据，返回 'uploaded'。
 */
export async function pullCloudData(): Promise<'replaced' | 'uploaded' | 'empty'> {
  const { token, setSyncStatus } = useAuth.getState();
  if (!token) return 'empty';
  setSyncStatus('syncing');
  try {
    const { data } = await api.pullSync(token);
    if (data && Array.isArray(data.books)) {
      pushGate = true;
      try {
        await db.replaceAllData({
          books: data.books,
          documents: Array.isArray(data.documents) ? data.documents : [],
          units: Array.isArray(data.units) ? data.units : [],
          progress: data.progress && typeof data.progress === 'object' ? data.progress : {},
          highlights: Array.isArray(data.highlights) ? data.highlights : [],
          notes: Array.isArray(data.notes) ? data.notes : [],
          marks: data.marks ?? db.DEFAULT_MARKS,
        });
        writeReaderPrefs(data.readerPrefs);
      } finally {
        pushGate = false;
      }
      setSyncStatus('ok');
      return 'replaced';
    }
    // 云端为空：迁移本地数据上云
    const snap = await buildSnapshot();
    await api.pushSync(token, snap);
    setSyncStatus('ok');
    return 'uploaded';
  } catch (e) {
    setSyncStatus('error', e instanceof Error ? e.message : i18n.t('account.syncFailed'));
    throw e;
  }
}

function writeReaderPrefs(prefs: CloudSnapshot['readerPrefs'] | null | undefined): void {
  try {
    if (!prefs || typeof prefs !== 'object') return;
    const hasContent =
      prefs.settings || prefs.bookmarks || prefs.positions || prefs.highlightColor;
    if (!hasContent) return;
    // zustand persist 存储格式：{ state: {...}, version: 0 }
    localStorage.setItem(READER_PREFS_KEY, JSON.stringify({ state: prefs, version: 0 }));
  } catch {
    // localStorage 不可用时忽略（偏好不同步不影响数据主体）
  }
}

/** 登出：保留本地数据则什么都不做；不保留则清空 IndexedDB + 阅读偏好 */
export async function clearLocalData(): Promise<void> {
  await db.clearAllData();
  try {
    localStorage.removeItem(READER_PREFS_KEY);
  } catch {
    // ignore
  }
}

// ---------- 自动推送订阅 ----------

let started = false;
/** 拉取云端数据替换本地期间临时关闭推送，避免「替换」本身触发回推 */
let pushGate = false;

export function setPushGate(v: boolean): void {
  pushGate = v;
}

/**
 * 订阅数据变更：云端模式下，业务数据（books/units/progress/highlights/notes/marks）
 * 或阅读偏好发生任何变化都防抖推送整库。
 * 在应用启动时调用一次。
 */
export function startSyncSubscriptions(): void {
  if (started) return;
  started = true;

  // 业务数据：只关心数据字段，忽略 view/search 等纯 UI 状态
  let prev: string | null = null;
  useStore.subscribe((state) => {
    if (useAuth.getState().mode !== 'cloud' || pushGate) return;
    const sizes: unknown[] = [
      state.books.length,
      state.units.length,
      Object.keys(state.progress).length,
      state.highlights.length,
      state.notes.length,
      Object.keys(state.marks.favorites ?? {}).length,
    ];
    const sig = sizes.join('|');
    if (sig === prev) return;
    prev = sig;
    schedulePush();
  });

  // 阅读偏好（字号/主题/书签/位置/划线颜色）
  useReaderPrefs.subscribe(() => {
    if (useAuth.getState().mode !== 'cloud' || pushGate) return;
    schedulePush();
  });
}
