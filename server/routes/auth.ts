import { Router, type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as db from '../lib/cloudDb';
import type { CloudUser } from '../../src/types';

/**
 * 账号与邀请码路由：
 * - POST /api/auth/register  邮箱 + 密码 + 邀请码注册
 * - POST /api/auth/login     邮箱 + 密码登录
 * - POST /api/auth/logout    登出（销毁当前会话）
 * - GET  /api/auth/me        当前登录用户
 *
 * 管理员（邀请码生成）：
 * - POST /api/admin/invites  header `x-admin-key` = ADMIN_KEY（服务器启动时打印到日志）
 * - GET  /api/admin/invites  查看邀请码列表
 */
export const authRouter = Router();
export const adminRouter = Router();

/** 已鉴权请求：会话守卫把用户与 token 挂在 req 上 */
export type AuthedRequest = Request & { user?: CloudUser; authToken?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validEmail(email: unknown): email is string {
  return typeof email === 'string' && EMAIL_RE.test(email.trim()) && email.length <= 200;
}

/** 要求登录的路由守卫 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  const user = db.getSessionUser(token);
  if (!user) {
    res.status(401).json({ error: '登录已过期，请重新登录' });
    return;
  }
  (req as AuthedRequest).user = user;
  (req as AuthedRequest).authToken = token;
  next();
}

function publicUser(u: CloudUser): CloudUser {
  return { id: u.id, email: u.email, createdAt: u.createdAt };
}

authRouter.post('/register', async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      email?: unknown;
      password?: unknown;
      inviteCode?: unknown;
    };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';

    if (!validEmail(email)) {
      res.status(400).json({ error: '邮箱格式不正确' });
      return;
    }
    if (password.length < 6 || password.length > 200) {
      res.status(400).json({ error: '密码至少 6 位' });
      return;
    }
    if (!inviteCode) {
      res.status(400).json({ error: '请输入邀请码' });
      return;
    }
    const code = db.findInviteCode(inviteCode);
    if (!code || code.usedAt) {
      res.status(403).json({ error: '邀请码无效或已被使用' });
      return;
    }
    if (db.findUserByEmail(email)) {
      res.status(409).json({ error: '该邮箱已注册，请直接登录' });
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    const user = db.createUser(email, hash);
    // 注册即建用户后再消费邀请码；消费失败（并发竞争）则回滚为已创建账号可直接登录，
    // 但这里更稳妥的做法是强校验：code 已在上方确认未使用，此处事务再抢一次。
    const consumed = db.consumeInviteCode(inviteCode, user.id);
    if (!consumed) {
      // 极小概率：码在确认与消费之间被另一请求用掉。账号已建，提示直接登录即可。
      res.status(409).json({ error: '邀请码刚被使用，请直接登录' });
      return;
    }
    db.touchLogin(user.id);
    const session = db.createSession(user.id);
    res.json({ user: publicUser(user), token: session.token, expiresAt: session.expiresAt });
  } catch (e) {
    console.error('[auth] register failed:', e);
    res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});

authRouter.post('/login', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!validEmail(email) || !password) {
      res.status(400).json({ error: '请输入邮箱和密码' });
      return;
    }
    const found = db.getUserPasswordHash(email);
    if (!found) {
      res.status(401).json({ error: '邮箱或密码不正确' });
      return;
    }
    const ok = await bcrypt.compare(password, found.hash);
    if (!ok) {
      res.status(401).json({ error: '邮箱或密码不正确' });
      return;
    }
    db.touchLogin(found.user.id);
    const session = db.createSession(found.user.id);
    res.json({
      user: publicUser(found.user),
      token: session.token,
      expiresAt: session.expiresAt,
    });
  } catch (e) {
    console.error('[auth] login failed:', e);
    res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

authRouter.post('/logout', requireAuth, (req: AuthedRequest, res) => {
  if (req.authToken) db.deleteSession(req.authToken);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

// ---------- 管理员：邀请码 ----------

/**
 * 管理员密钥：优先环境变量 ADMIN_KEY；未配置时在服务器启动时自动生成一个，
 * 打印到服务日志（data 目录下还会写一份 admin-key.txt 方便查看）。
 */
export function adminKeyGuard(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers['x-admin-key'];
  const expected = getAdminKey();
  if (!provided || provided !== expected) {
    res.status(403).json({ error: '无管理员权限' });
    return;
  }
  next();
}

let cachedAdminKey: string | null = null;

export function getAdminKey(): string {
  if (cachedAdminKey) return cachedAdminKey;
  if (process.env.ADMIN_KEY) {
    cachedAdminKey = process.env.ADMIN_KEY;
    return cachedAdminKey;
  }
  cachedAdminKey = bootAdminKey();
  return cachedAdminKey;
}

function bootAdminKey(): string {
  const isProd = process.env.COZE_PROJECT_ENV === 'PROD';
  const dir = isProd ? '/tmp' : path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, 'admin-key.txt');
  try {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // 首次运行，继续生成
  }
  const key = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(keyFile, key, 'utf8');
  return key;
}

adminRouter.post('/invites', adminKeyGuard, (req, res) => {
  const body = (req.body ?? {}) as { count?: unknown };
  const count = typeof body.count === 'number' && body.count > 0 && body.count <= 50
    ? Math.floor(body.count)
    : 5;
  const codes = db.createInviteCodes(count);
  res.json({ codes });
});

adminRouter.get('/invites', adminKeyGuard, (_req, res) => {
  res.json({ codes: db.listInviteCodes() });
});
