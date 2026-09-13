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
import { CompletionToast } from './components/CompletionToast';
import { beginDogfoodSession } from './lib/dogfood';
import { startSyncSubscriptions, pullCloudData, rehydrateAfterPull } from './lib/sync';

export default function App() {
  const { hydrated, view, hydrate } = useStore();
  const { theme, toggle } = useTheme();
  const bootRef = useRef(false);

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    void (async () => {
      await hydrate();
      // dogfood session：记录阅读连续性（上次读的书 / 位置 / 覆盖率），本地保存
      const { books, progress, units } = useStore.getState();
      const last = Object.values(progress)
        .filter((p) => p.updatedAt > 0 && books.some((b) => b.id === p.bookId))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      beginDogfoodSession({
        books: books.length,
        lastBookId: last?.bookId ?? null,
        lastBookTitle: books.find((b) => b.id === last?.bookId)?.title ?? null,
        lastReadUnitCount: last?.readUnitIds.length ?? 0,
        units: units.length,
      });
      // 订阅本地数据变更（云端模式下自动防抖推送）；订阅在会话恢复前挂上，
      // 但 schedulePush 内部会检查 mode==='cloud'，未登录时不会发请求。
      startSyncSubscriptions();
      // 恢复登录态；若 token 有效进入云端模式，则以云端数据为准拉取一次
      await useAuth.getState().restoreSession();
      if (useAuth.getState().mode === 'cloud') {
        try {
          const result = await pullCloudData();
          // 云端有数据并已替换本地 → 原地重新加载各 store（含阅读偏好）。
          // 这里不能整页 reload：启动每次都会拉取云端，刷新会造成无限循环。
          if (result === 'replaced') await rehydrateAfterPull();
        } catch (e) {
          console.warn('[boot] cloud pull failed, continue with local data', e);
        }
      }
      // 后台把遗留的 mock 标题升级为 GLM 真 AI 标题（静默降级，不阻塞界面）
      useStore.getState().upgradeAiTitles();
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
      <CompletionToast />
    </Shell>
  );
}
