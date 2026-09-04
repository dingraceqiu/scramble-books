import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * 全局渲染错误边界：任何子树在 render 阶段抛错时，
 * 展示一个可「刷新恢复」的界面而不是整页白屏。
 * 数据都在 IndexedDB / localStorage，刷新不会丢书。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[ErrorBoundary] render crashed:', error, info);
  }

  handleReload = (): void => {
    try {
      window.location.reload();
    } catch {
      /* noop */
    }
  };

  handleBack = (): void => {
    try {
      this.setState({ hasError: false, message: '' });
    } catch {
      window.location.reload();
    }
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-sm rounded-3xl bg-surface p-8 text-center shadow-card ring-1 ring-line">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-2xl">
            📚
          </div>
          <h1 className="mb-2 text-lg font-bold text-ink">Scramble Books</h1>
          <p className="mb-1 text-sm text-ink-soft">
            界面刚才出了点小问题，你的书和笔记都已保存在本地，不会丢失。
          </p>
          {this.state.message && (
            <p className="mb-4 break-words rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-muted">
              {this.state.message}
            </p>
          )}
          <div className="mt-5 flex justify-center gap-2">
            <button
              type="button"
              onClick={this.handleBack}
              className="rounded-full bg-surface-2 px-4 py-2 text-sm text-ink-soft transition-colors hover:text-ink"
            >
              重试
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              刷新页面
            </button>
          </div>
        </div>
      </div>
    );
  }
}
