import { Router } from 'express';
import * as db from '../lib/cloudDb';
import { requireAuth, type AuthedRequest } from './auth';
import type { CloudSnapshot } from '../../src/types';

/**
 * 云端数据同步（整库快照，MVP）：
 * - GET /api/sync  拉取云端快照（无数据时返回 { data: null, updatedAt: 0 }）
 * - PUT /api/sync  推送整库快照（覆盖云端；body 上限由 express.json limit 控制）
 * - DELETE /api/sync 清空云端副本（登出并选择清空时调用）
 *
 * 冲突策略（MVP）：以最近一次写入为准（last-write-wins）。
 * 前端拉取到云端数据后用云端替换本地；本地任何改动防抖推送整库。
 */
export const syncRouter = Router();

const SNAPSHOT_MAX_BYTES = 60 * 1024 * 1024; // 60MB（含封面 dataURL）

function isSnapshot(v: unknown): v is CloudSnapshot {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<CloudSnapshot>;
  return (
    Array.isArray(s.books) &&
    Array.isArray(s.documents) &&
    Array.isArray(s.units) &&
    typeof s.progress === 'object' &&
    s.progress !== null &&
    Array.isArray(s.highlights) &&
    Array.isArray(s.notes) &&
    typeof s.marks === 'object' &&
    s.marks !== null
  );
}

syncRouter.get('/sync', requireAuth, (req: AuthedRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  const row = db.getUserData(req.user.id);
  if (!row) {
    res.json({ data: null, updatedAt: 0 });
    return;
  }
  try {
    res.json({ data: JSON.parse(row.data) as CloudSnapshot, updatedAt: row.updatedAt });
  } catch (e) {
    console.error('[sync] corrupted cloud data, ignoring:', e);
    res.json({ data: null, updatedAt: 0 });
  }
});

syncRouter.put('/sync', requireAuth, (req: AuthedRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  const snapshot = (req.body ?? {}) as { data?: unknown };
  if (!isSnapshot(snapshot.data)) {
    res.status(400).json({ error: '数据格式不正确' });
    return;
  }
  const json = JSON.stringify(snapshot.data);
  if (json.length > SNAPSHOT_MAX_BYTES) {
    res.status(413).json({ error: '数据超出 60MB 上限' });
    return;
  }
  try {
    const updatedAt = db.putUserData(req.user.id, json);
    res.json({ ok: true, updatedAt });
  } catch (e) {
    console.error('[sync] put failed:', e);
    res.status(500).json({ error: '云端保存失败' });
  }
});

syncRouter.delete('/sync', requireAuth, (req: AuthedRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  db.putUserData(req.user.id, JSON.stringify({
    version: 1,
    books: [],
    documents: [],
    units: [],
    progress: {},
    highlights: [],
    notes: [],
    marks: { favorites: {}, unitFeedback: {}, bookScore: {}, topicScore: {} },
    readerPrefs: {},
  } satisfies CloudSnapshot));
  res.json({ ok: true });
});
