import { useEffect, useRef } from 'react';
import { useStore } from './store/useStore';
import { useAuth } from './store/useAuth';
import { useTheme } from './hooks/useTheme';
import { Shell } from './components/Shell';
import { Feed } from './components/Feed';
import { Library } from './components/Library';
import { Study } from './components/Study';
import { ReaderModal } from './components/ReaderModal';
import { ReaderView } from './components/ReaderView';
import { startSyncSubscriptions, pullCloudData } from './lib/sync';

export default function App() {
  const { hydrated, view, hydrate } = useStore();
  const { theme, toggle } = useTheme();
  const bootRef = useRef(false);

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    void (async () => {
      await hydrate();
      // 订阅本地数据变更（云端模式下自动防抖推送）；订阅在会话恢复前挂上，
      // 但 schedulePush 内部会检查 mode==='cloud'，未登录时不会发请求。
      startSyncSubscriptions();
      // 恢复登录态；若 token 有效进入云端模式，则以云端数据为准拉取一次
      await useAuth.getState().restoreSession();
      if (useAuth.getState().mode === 'cloud') {
        try {
          const result = await pullCloudData();
          // 云端有数据并已替换本地 → 刷新让各 store（含阅读偏好）从持久层重新加载
          if (result === 'replaced') window.location.reload();
        } catch (e) {
          console.warn('[boot] cloud pull failed, continue with local data', e);
        }
      }
    })();
  }, [hydrate]);

  if (!hydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <p className="reading-text text-sm text-muted">正在翻开你的书架…</p>
      </div>
    );
  }

  return (
    <Shell theme={theme} onToggleTheme={toggle}>
      {view === 'reader' ? (
        <ReaderView />
      ) : view === 'library' ? (
        <Library />
      ) : view === 'study' ? (
        <Study />
      ) : (
        <Feed />
      )}
      <ReaderModal />
    </Shell>
  );
}
