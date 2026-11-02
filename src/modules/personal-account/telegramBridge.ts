/**
 * Мост интеграции с Telegram Mini Apps (Telegram WebApp).
 */

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        initDataUnsafe?: {
          user?: {
            id: number;
            first_name: string;
            last_name?: string;
            username?: string;
            language_code?: string;
            photo_url?: string;
          };
          start_param?: string;
        };
        themeParams?: Record<string, string>;
        isExpanded: boolean;
        viewportHeight: number;
        viewportStableHeight: number;
        expand: () => void;
        close: () => void;
        ready: () => void;
        HapticFeedback?: {
          impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
          notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
          selectionChanged: () => void;
        };
        openTelegramLink: (url: string) => void;
        shareToStory?: (media_url: string, params?: any) => void;
      };
    };
  }
}

export function isTelegramWebApp(): boolean {
  return typeof window !== 'undefined' && Boolean(window.Telegram?.WebApp?.initData);
}

export function getTelegramUser(): {
  id?: number;
  name?: string;
  username?: string;
  photoUrl?: string;
} | null {
  if (!isTelegramWebApp()) return null;
  const user = window.Telegram?.WebApp?.initDataUnsafe?.user;
  if (!user) return null;

  return {
    id: user.id,
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Игрок',
    username: user.username,
    photoUrl: user.photo_url,
  };
}

export function initTelegramWebApp(): void {
  if (typeof window === 'undefined') return;
  const tg = window.Telegram?.WebApp;
  if (tg) {
    try {
      tg.ready();
      tg.expand();
    } catch {}
  }
}
