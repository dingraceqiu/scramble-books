/**
 * 云端同步引擎：
 * - 登录后 pullCloudData()：拉取云端快照。云端有数据 → 整库替换本地（以云端为准）后原地重新水合界面；
 *   云端为空 → 把本地现有数据推上去（首次登录迁移本地书库）。
 * - 登录期间本地任何改动 → schedulePush() 防抖 1.5s 推送整库快照（last-write-wins）。
 * - 登出时按用户选择保留或清空本地数据。
 *
 * 数据快照直接取自 IndexedDB（store 全部 write-through，它是事实来源），
 * 阅读偏好取自 localStorage 的 zustand persist 键。
 */
import type { CloudReaderPrefs, CloudSnapshotV1, CloudSnapshotV2 } from '../types';
import * as db from './db';
import * as api from './cloudApi';
import {
  deserializeCloudSnapshot,
  serializeCloudSnapshot,
  snapshotSizeDiagnostics,
} from './cloudSnapshot';
import { useAuth } from '../store/useAuth';
import { useStore } from '../store/useStore';
import { useReaderPrefs } from '../store/useReaderPrefs';
import i18n from '../i18n';

const READER_PREFS_KEY = 'scrollbook-reader-prefs';

function readReaderPrefs(): CloudReaderPrefs {
  try {
    const raw = localStorage.getItem(READER_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { state?: unknown };
    const state = (parsed && typeof parsed === 'object' && 'state' in parsed
      ? (parsed as { state: CloudReaderPrefs }).state
      : parsed) as CloudReaderPrefs | undefined;
    return state ?? {};
  } catch {
    return {};
  }
}

export async function buildSnapshot(): Promise<CloudSnapshotV2> {
  const data = await db.loadAll();
  const documents = await db.getAllDocuments();
  const complete: CloudSnapshotV1 = {
    version: 1,
    books: data.books,
    documents,
    units: data.units,
    progress: data.progress,
    highlights: data.highlights,
    notes: data.notes,
    marks: data.marks,
    knowledgePoints: data.knowledgePoints,
    quizAttempts: data.quizAttempts,
    readerPrefs: readReaderPrefs(),
  };
  const wire = serializeCloudSnapshot(complete);
  if (import.meta.env.DEV) {
    console.info('[sync] snapshot-size', snapshotSizeDiagnostics(wire, complete));
  }
  return wire;
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
 * 云端快照已写入本地持久层后，原地重新加载各内存 store。
 * 注意：不要用 window.location.reload()——启动路径每次都会拉取云端，
 * 「云端有数据 → 刷新」会形成无限刷新循环。
 */
export async function rehydrateAfterPull(): Promise<void> {
  await useStore.getState().hydrate();
  await useReaderPrefs.persist.rehydrate();
}

/**
 * 登录/注册成功后调用：
 * 1. 拉取云端快照；
 * 2. 云端有数据 → 写入本地（IndexedDB + 阅读偏好），返回 'replaced'（调用方原地重新水合）；
 * 3. 云端为空 → 推送本地快照作为云端初始数据，返回 'uploaded'。
 */
export async function pullCloudData(): Promise<'replaced' | 'uploaded' | 'empty'> {
  const { token, setSyncStatus } = useAuth.getState();
  if (!token) return 'empty';
  setSyncStatus('syncing');
  try {
    const { data } = await api.pullSync(token);
    if (data && Array.isArray(data.books)) {
      const restored = deserializeCloudSnapshot(data);
      let migrationError: Error | null = null;
      pushGate = true;
      try {
        await db.replaceAllData({
          books: restored.books,
          documents: Array.isArray(restored.documents) ? restored.documents : [],
          units: Array.isArray(restored.units) ? restored.units : [],
          progress: restored.progress && typeof restored.progress === 'object' ? restored.progress : {},
          highlights: Array.isArray(restored.highlights) ? restored.highlights : [],
          notes: Array.isArray(restored.notes) ? restored.notes : [],
          marks: restored.marks ?? db.DEFAULT_MARKS,
          knowledgePoints: Array.isArray(restored.knowledgePoints) ? restored.knowledgePoints : [],
          quizAttempts: Array.isArray(restored.quizAttempts) ? restored.quizAttempts : [],
        });
        writeReaderPrefs(restored.readerPrefs);
        // V1 数据先完整恢复到本地，再用同一份内存数据原子覆盖为 V2；绝不先清空云端。
        if (data.version === 1) {
          try {
            await api.pushSync(token, serializeCloudSnapshot(restored));
          } catch (error) {
            migrationError = error instanceof Error ? error : new Error(String(error));
            console.warn('[sync] V1 restored but V2 cloud migration will retry on next push:', error);
          }
        }
      } finally {
        pushGate = false;
      }
      if (migrationError) setSyncStatus('error', migrationError.message);
      else setSyncStatus('ok');
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

function writeReaderPrefs(prefs: CloudReaderPrefs | null | undefined): void {
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

  // 业务数据：按不可变引用判断真实业务字段变化；避免只比较数组长度而漏掉阅读进度、
  // 笔记内容、AI 标题、KP/Quiz attempt 等“数量不变但内容变化”的同步。
  let prev: {
    books: unknown;
    units: unknown;
    progress: unknown;
    highlights: unknown;
    notes: unknown;
    marks: unknown;
    knowledgePoints: unknown;
    quizAttempts: unknown;
  } | null = null;
  useStore.subscribe((state) => {
    if (useAuth.getState().mode !== 'cloud' || pushGate) return;
    const next = {
      books: state.books,
      units: state.units,
      progress: state.progress,
      highlights: state.highlights,
      notes: state.notes,
      marks: state.marks,
      knowledgePoints: state.knowledgePoints,
      quizAttempts: state.quizAttempts,
    };
    if (prev && Object.keys(next).every((key) => {
      const field = key as keyof typeof next;
      return next[field] === prev?.[field];
    })) return;
    prev = next;
    schedulePush();
  });

  // 阅读偏好（字号/主题/书签/位置/划线颜色）
  useReaderPrefs.subscribe(() => {
    if (useAuth.getState().mode !== 'cloud' || pushGate) return;
    schedulePush();
  });
}
