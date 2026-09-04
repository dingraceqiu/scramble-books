import { useEffect, useRef, useState } from 'react';
import { User, Loader2, LogOut, Cloud, RefreshCw, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../store/useAuth';
import { pullCloudData, pushNow, clearLocalData } from '../lib/sync';

type Tab = 'login' | 'register';

export function AccountButton() {
  const { t } = useTranslation();
  const { mode, syncStatus } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const dotClass =
    mode === 'cloud'
      ? syncStatus === 'syncing'
        ? 'bg-amber-400'
        : syncStatus === 'error'
          ? 'bg-red-500'
          : 'bg-emerald-500'
      : 'bg-transparent';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('account.title')}
        title={mode === 'cloud' ? t('account.cloudMode') : t('account.localMode')}
        className={`relative flex items-center justify-center rounded-full p-2 transition-colors hover:bg-surface-2 ${
          mode === 'cloud' ? 'text-accent' : 'text-muted hover:text-ink'
        }`}
      >
        {mode === 'cloud' ? <Cloud size={18} /> : <User size={18} />}
        <span
          className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-paper ${dotClass} ${
            syncStatus === 'syncing' ? 'animate-pulse' : ''
          }`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl bg-surface shadow-card-hover ring-1 ring-line">
          <PanelContent onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function PanelContent({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { mode, user, syncStatus, syncMessage, signIn, signUp, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmLogout, setConfirmLogout] = useState(false);

  const submit = async () => {
    setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(t('account.errEmail'));
      return;
    }
    if (password.length < 6) {
      setError(t('account.errPasswordShort'));
      return;
    }
    setBusy(true);
    try {
      if (tab === 'register') {
        if (password !== password2) {
          setError(t('account.errPasswordMismatch'));
          setBusy(false);
          return;
        }
        if (!inviteCode.trim()) {
          setError(t('account.errInviteRequired'));
          setBusy(false);
          return;
        }
        await signUp(email.trim(), password, inviteCode.trim());
      } else {
        await signIn(email.trim(), password);
      }
      // 登录/注册成功：拉取云端数据（云端有数据则替换本地并刷新页面）
      const result = await pullCloudData();
      if (result === 'replaced') {
        window.location.reload();
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('account.errGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const doLogout = async (keepLocal: boolean) => {
    setBusy(true);
    try {
      await signOut();
      if (!keepLocal) {
        await clearLocalData();
        window.location.reload();
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // ---------- 已登录：个人信息 ----------
  if (mode === 'cloud' && user) {
    return (
      <div className="p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Cloud size={18} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-bold">{user.email}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
              {syncStatus === 'syncing' && <RefreshCw size={11} className="animate-spin" />}
              {syncStatus === 'error' && <AlertCircle size={11} className="text-red-500" />}
              <span>
                {syncStatus === 'syncing'
                  ? t('account.syncing')
                  : syncStatus === 'error'
                    ? (syncMessage || t('account.syncFailed'))
                    : t('account.synced')}
              </span>
            </div>
          </div>
        </div>

        {syncStatus === 'error' && (
          <button
            type="button"
            onClick={() => void pushNow()}
            className="mt-3 w-full rounded-xl bg-surface-2 py-2 text-xs font-medium text-ink transition-colors hover:bg-line"
          >
            {t('account.retrySync')}
          </button>
        )}

        {!confirmLogout ? (
          <button
            type="button"
            onClick={() => setConfirmLogout(true)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-line py-2.5 text-sm font-medium text-muted transition-colors hover:border-red-300 hover:text-red-500"
          >
            <LogOut size={15} />
            {t('account.logout')}
          </button>
        ) : (
          <div className="mt-3 rounded-xl bg-surface-2 p-3">
            <p className="mb-3 text-xs leading-relaxed text-ink-soft">{t('account.logoutAsk')}</p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void doLogout(true)}
                className="flex-1 rounded-lg bg-surface py-2 text-xs font-medium ring-1 ring-line transition-colors hover:bg-line disabled:opacity-50"
              >
                {t('account.keepLocal')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void doLogout(false)}
                className="flex-1 rounded-lg bg-red-500 py-2 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {t('account.clearLocal')}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setConfirmLogout(false)}
              className="mt-2 w-full py-1 text-xs text-muted hover:text-ink"
            >
              {t('account.cancel')}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---------- 未登录：登录/注册 ----------
  return (
    <div className="p-5">
      <div className="mb-4">
        <div className="text-sm font-black">{t('account.title')}</div>
        <div className="mt-0.5 text-xs text-muted">{t('account.localHint')}</div>
      </div>

      <div className="mb-4 flex rounded-xl bg-surface-2 p-1 text-xs font-bold">
        {(['login', 'register'] as Tab[]).map((tb) => (
          <button
            key={tb}
            type="button"
            onClick={() => {
              setTab(tb);
              setError('');
            }}
            className={`flex-1 rounded-lg py-1.5 transition-colors ${
              tab === tb ? 'bg-surface text-accent shadow-sm' : 'text-muted hover:text-ink'
            }`}
          >
            {tb === 'login' ? t('account.login') : t('account.register')}
          </button>
        ))}
      </div>

      <form
        className="space-y-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('account.email')}
          autoComplete="email"
          className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-muted focus:border-accent"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('account.password')}
          autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
          className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-muted focus:border-accent"
        />
        {tab === 'register' && (
          <>
            <input
              type="password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              placeholder={t('account.passwordConfirm')}
              autoComplete="new-password"
              className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-muted focus:border-accent"
            />
            <input
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder={t('account.inviteCode')}
              autoCapitalize="characters"
              className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm uppercase tracking-widest outline-none transition-colors placeholder:normal-case placeholder:tracking-normal placeholder:text-muted focus:border-accent"
            />
          </>
        )}

        {error && (
          <div className="flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-2 text-xs leading-relaxed text-red-600 dark:bg-red-950/40 dark:text-red-300">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-sm font-bold text-white transition-colors hover:opacity-90 disabled:opacity-60"
        >
          {busy && <Loader2 size={15} className="animate-spin" />}
          {tab === 'login' ? t('account.loginSubmit') : t('account.registerSubmit')}
        </button>
      </form>

      <p className="mt-3 text-center text-[11px] leading-relaxed text-muted">
        {t('account.inviteHint')}
      </p>
    </div>
  );
}
