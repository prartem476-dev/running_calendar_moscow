import { useState, useCallback } from 'react';
import { PublicAuthUser, AuthModalInitialTab } from './types';
import { authService } from './authService';
import { migrateGuestDataToUser, clearGuestSessionData } from './storageScope';
import {
  migrateGuestReferralsToUser,
  redeemFriendReferralCode,
} from './referralService';

export interface UsePersonalAccountOptions {
  /** Дополнительные базовые ключи localStorage для миграции из _guest и очистки при удалении */
  extraScopedKeys?: string[];
  /** Колбэк, вызываемый при каждой смене активного пользователя (вход / регистрация / выход / удаление) */
  onUserChanged?: (user: PublicAuthUser | null, isNewRegistration?: boolean) => void;
  /** Колбэк для показа уведомлений (тостов) в вашем приложении */
  onToast?: (message: string) => void;
}

/**
 * Готовый React-хук для подключения Личного кабинета в 5 строк кода.
 */
export function usePersonalAccount(options: UsePersonalAccountOptions = {}) {
  const { extraScopedKeys = [], onUserChanged, onToast } = options;

  const [currentUser, setCurrentUser] = useState<PublicAuthUser | null>(() =>
    authService.getCurrentUser()
  );
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [authModalTab, setAuthModalTab] = useState<AuthModalInitialTab>('register');

  const openAuthModal = useCallback((tab: AuthModalInitialTab = 'register') => {
    setAuthModalTab(tab);
    setIsAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setIsAuthModalOpen(false);
  }, []);

  /**
   * Проверяет, авторизован ли пользователь. Если нет — открывает модальное окно регистрации.
   */
  const requireAuth = useCallback(
    (actionIfAuthenticated: () => void, lockedMessage?: string) => {
      if (!currentUser) {
        openAuthModal('register');
        if (lockedMessage) {
          onToast?.(lockedMessage);
        }
        return false;
      }
      actionIfAuthenticated();
      return true;
    },
    [currentUser, openAuthModal, onToast]
  );

  const handleSuccessAuth = useCallback(
    (
      user: PublicAuthUser,
      isNewRegistration: boolean,
      referralCodeUsed?: string
    ) => {
      if (isNewRegistration) {
        migrateGuestDataToUser(user, extraScopedKeys);
        migrateGuestReferralsToUser(user.id);
      }

      setCurrentUser(user);

      if (isNewRegistration && referralCodeUsed) {
        const redeemRes = redeemFriendReferralCode(referralCodeUsed, user.id);
        if (redeemRes.success) {
          onToast?.(redeemRes.message);
        }
      } else {
        onToast?.(
          isNewRegistration
            ? `🎉 Профиль «${user.nickname}» создан!`
            : `👋 С возвращением, ${user.nickname}!`
        );
      }

      setIsAuthModalOpen(false);
      onUserChanged?.(user, isNewRegistration);
    },
    [extraScopedKeys, onToast, onUserChanged]
  );

  const handleLogout = useCallback(() => {
    authService.logout();
    clearGuestSessionData(extraScopedKeys);
    setCurrentUser(null);
    setIsAuthModalOpen(false);
    onToast?.('Вы вышли из профиля. Активирован гостевой режим.');
    onUserChanged?.(null, false);
  }, [extraScopedKeys, onToast, onUserChanged]);

  const handleDeleteAccount = useCallback(() => {
    if (currentUser) {
      authService.deleteAccount(currentUser.id, extraScopedKeys);
    }
    clearGuestSessionData(extraScopedKeys);
    setCurrentUser(null);
    setIsAuthModalOpen(false);
    onToast?.('🗑️ Профиль и все данные полностью удалены с устройства.');
    onUserChanged?.(null, false);
  }, [currentUser, extraScopedKeys, onToast, onUserChanged]);

  const handleUpdateUser = useCallback(
    (updatedUser: PublicAuthUser) => {
      setCurrentUser(updatedUser);
      onUserChanged?.(updatedUser, false);
    },
    [onUserChanged]
  );

  return {
    currentUser,
    isAuthModalOpen,
    authModalTab,
    openAuthModal,
    closeAuthModal,
    requireAuth,
    handleSuccessAuth,
    handleLogout,
    handleDeleteAccount,
    handleUpdateUser,
  };
}
