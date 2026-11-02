export type AuthMethod = 'pin' | 'password' | 'telegram';

export type AuthModalInitialTab = 'register' | 'login' | 'recover' | 'profile';

/**
 * Полная запись пользователя во внутреннем хранилище (содержит PBKDF2-хеши и соль).
 * Никогда не передается напрямую в UI.
 */
export interface AuthUser {
  id: string;
  nickname: string;
  avatar: string;
  city: string;
  authMethod: AuthMethod;
  createdAt: string;
  lastLoginAt: string;
  securityHash: string;
  securitySalt: string;
  recoveryCodeHash: string;
  telegramId?: number;
  referralCode?: string;
  referredByCode?: string;
}

/**
 * Безопасный публичный профиль пользователя для использования в UI.
 */
export interface PublicAuthUser {
  id: string;
  nickname: string;
  avatar: string;
  city: string;
  authMethod: AuthMethod;
  createdAt: string;
  lastLoginAt: string;
  referralCode?: string;
  referredByCode?: string;
}

/**
 * Подписанная сессия в localStorage.
 */
export interface AuthSession {
  userId: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

/**
 * Карточка быстрого перехода внутри Личного кабинета (например: Рейтинг, Статистика, Друзья).
 */
export interface AccountQuickStatItem {
  id: string;
  label: string;
  valueText: string;
  icon?: 'trophy' | 'stats' | 'users';
  onClick: () => void;
}

export interface ReferredFriend {
  id: string;
  nickname: string;
  avatar: string;
  city: string;
  joinedAt: string;
  bonusAwarded: number;
  isVerified: boolean;
}

export interface ReferralState {
  referralCode: string;
  referredByCode: string | null;
  welcomeBonusClaimed: boolean;
  invitedFriends: ReferredFriend[];
  claimedMilestones: number[];
  isAmbassador: boolean;
  ambassadorPlateEnabled: boolean;
}
