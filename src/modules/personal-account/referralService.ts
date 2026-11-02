import { ACCOUNT_CONFIG } from './accountConfig';
import { authService } from './authService';
import { ReferralState, ReferredFriend } from './types';

const STORAGE_KEY_REFERRAL = `${ACCOUNT_CONFIG.appPrefix}_referrals_v1`;
const STORAGE_KEY_PENDING_REF = `${ACCOUNT_CONFIG.appPrefix}_pending_ref_code_v1`;

export const AMBASSADOR_REQUIRED_INVITES = ACCOUNT_CONFIG.ambassadorRequiredInvites;
export const AMBASSADOR_AVATAR_EMOJI = ACCOUNT_CONFIG.ambassadorAvatarEmoji;

function getScopedReferralKey(explicitUserId?: string): string {
  if (explicitUserId) {
    return `${STORAGE_KEY_REFERRAL}_${explicitUserId}`;
  }
  const user = authService.getCurrentUser();
  return user ? `${STORAGE_KEY_REFERRAL}_${user.id}` : `${STORAGE_KEY_REFERRAL}_guest`;
}

/**
 * Генерирует детерминированный или случайный реферальный код формата PREFIX-XXXXX.
 */
export function generateReferralCode(seed?: string): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  if (seed) {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    let code = '';
    let val = hash >>> 0;
    for (let i = 0; i < 5; i++) {
      code += alphabet[val % alphabet.length];
      val = Math.floor(val / alphabet.length) ^ ((hash >>> (i * 3)) & 0xff);
    }
    return `${ACCOUNT_CONFIG.referralCodePrefix}-${code}`;
  }

  let randomPart = '';
  for (let i = 0; i < 5; i++) {
    randomPart += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${ACCOUNT_CONFIG.referralCodePrefix}-${randomPart}`;
}

export function createInitialReferralState(explicitUserId?: string): ReferralState {
  const user = authService.getCurrentUser();
  const seedId = explicitUserId || user?.id;
  return {
    referralCode: generateReferralCode(seedId),
    referredByCode: null,
    welcomeBonusClaimed: false,
    invitedFriends: [],
    claimedMilestones: [],
    isAmbassador: false,
    ambassadorPlateEnabled: true,
  };
}

export function loadReferralState(explicitUserId?: string): ReferralState {
  const fallback = createInitialReferralState(explicitUserId);
  if (typeof window === 'undefined') return fallback;

  try {
    const key = getScopedReferralKey(explicitUserId);
    const raw = localStorage.getItem(key);
    if (!raw) {
      localStorage.setItem(key, JSON.stringify(fallback));
      return fallback;
    }
    const parsed = JSON.parse(raw);
    const invitedFriends: ReferredFriend[] = Array.isArray(parsed.invitedFriends)
      ? parsed.invitedFriends
      : [];
    const claimedMilestones: number[] = Array.isArray(parsed.claimedMilestones)
      ? parsed.claimedMilestones
      : [];
    const isAmbassador =
      Boolean(parsed.isAmbassador) ||
      invitedFriends.length >= AMBASSADOR_REQUIRED_INVITES ||
      claimedMilestones.includes(AMBASSADOR_REQUIRED_INVITES);

    return {
      referralCode: parsed.referralCode || fallback.referralCode,
      referredByCode: parsed.referredByCode || null,
      welcomeBonusClaimed: Boolean(parsed.welcomeBonusClaimed),
      invitedFriends,
      claimedMilestones,
      isAmbassador,
      ambassadorPlateEnabled:
        typeof parsed.ambassadorPlateEnabled === 'boolean'
          ? parsed.ambassadorPlateEnabled
          : true,
    };
  } catch {
    return fallback;
  }
}

export function saveReferralState(state: ReferralState, explicitUserId?: string): void {
  if (typeof window === 'undefined') return;
  try {
    const key = getScopedReferralKey(explicitUserId);
    localStorage.setItem(key, JSON.stringify(state));
  } catch {}
}

/**
 * Автоматически определяет входящий реферальный код из URL (?ref=CODE / ?invite=CODE)
 * или из параметра запуска Telegram Mini App (start_param = ref_CODE).
 */
export function detectIncomingReferralCode(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const urlRef = params.get('ref') || params.get('invite');
    const tgStartParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
    let detected: string | null = null;

    if (urlRef && urlRef.trim().length >= 4) {
      detected = urlRef.trim().toUpperCase();
    } else if (tgStartParam && tgStartParam.startsWith('ref_')) {
      detected = tgStartParam.replace(/^ref_/i, '').trim().toUpperCase();
    }

    if (detected) {
      const ownState = loadReferralState();
      if (detected !== ownState.referralCode.toUpperCase()) {
        localStorage.setItem(STORAGE_KEY_PENDING_REF, detected);
        return detected;
      }
    }

    return localStorage.getItem(STORAGE_KEY_PENDING_REF);
  } catch {
    return null;
  }
}

export function clearPendingReferralCode(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY_PENDING_REF);
  } catch {}
}

export function getReferralShareLink(referralCode: string): string {
  if (
    typeof window !== 'undefined' &&
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1' &&
    !window.location.protocol.startsWith('capacitor') &&
    !window.location.protocol.startsWith('file')
  ) {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}?ref=${encodeURIComponent(referralCode)}`;
  }
  return `${ACCOUNT_CONFIG.storeOrWebUrl}?ref=${encodeURIComponent(referralCode)}`;
}

/**
 * Добавляет приглашенного друга в счетчик пользователя и разблокирует статус Амбассадора при достижении порога.
 */
export function recordInvitedFriend(
  friendInfo?: Partial<ReferredFriend>,
  explicitUserId?: string
): {
  referralState: ReferralState;
  justUnlockedAmbassador: boolean;
  friendAdded: ReferredFriend;
} {
  const current = loadReferralState(explicitUserId);
  const now = new Date();
  const dateFormatted = now.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  const newFriend: ReferredFriend = {
    id: friendInfo?.id || `ref_usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    nickname: friendInfo?.nickname || 'Новый друг',
    avatar: friendInfo?.avatar || '🦊',
    city: friendInfo?.city || 'По приглашению',
    joinedAt: friendInfo?.joinedAt || dateFormatted,
    bonusAwarded: friendInfo?.bonusAwarded ?? 100,
    isVerified: true,
  };

  const nextFriends = [newFriend, ...current.invitedFriends];
  const wasAmbassador = current.isAmbassador;
  const nowAmbassador =
    wasAmbassador || nextFriends.length >= AMBASSADOR_REQUIRED_INVITES;
  const justUnlockedAmbassador = !wasAmbassador && nowAmbassador;

  const updatedReferral: ReferralState = {
    ...current,
    invitedFriends: nextFriends,
    isAmbassador: nowAmbassador,
    ambassadorPlateEnabled: justUnlockedAmbassador ? true : current.ambassadorPlateEnabled,
  };

  saveReferralState(updatedReferral, explicitUserId);

  return {
    referralState: updatedReferral,
    justUnlockedAmbassador,
    friendAdded: newFriend,
  };
}

/**
 * Активирует реферальный код друга (и начисляет приглашение владельцу кода, если он зарегистрирован на этом устройстве).
 */
export function redeemFriendReferralCode(
  rawCode: string,
  explicitUserId?: string
): {
  success: boolean;
  referralState: ReferralState;
  message: string;
} {
  const currentRef = loadReferralState(explicitUserId);
  const cleanCode = rawCode.trim().toUpperCase();

  if (!cleanCode || cleanCode.length < 4) {
    return {
      success: false,
      referralState: currentRef,
      message: `Введите корректный код приглашения (например, ${ACCOUNT_CONFIG.referralCodePrefix}-7K4M)`,
    };
  }

  if (cleanCode === currentRef.referralCode.toUpperCase()) {
    return {
      success: false,
      referralState: currentRef,
      message: 'Нельзя использовать собственный реферальный код',
    };
  }

  if (currentRef.welcomeBonusClaimed || currentRef.referredByCode) {
    return {
      success: false,
      referralState: currentRef,
      message: 'Вы уже активировали реферальный код приглашения ранее',
    };
  }

  const updatedRef: ReferralState = {
    ...currentRef,
    referredByCode: cleanCode,
    welcomeBonusClaimed: true,
  };
  saveReferralState(updatedRef, explicitUserId);
  clearPendingReferralCode();

  // Если владелец кода есть на этом же устройстве — автоматически засчитываем ему приглашение
  const currentUser = authService.getCurrentUser();
  const allUsers = authService.getRegisteredPublicUsers();
  for (const u of allUsers) {
    if (currentUser && u.id === currentUser.id) continue;
    const uRef = loadReferralState(u.id);
    if (uRef.referralCode.toUpperCase() === cleanCode) {
      recordInvitedFriend(
        {
          id: currentUser?.id || `guest_${Date.now()}`,
          nickname: currentUser?.nickname || 'Новый участник',
          avatar: currentUser?.avatar || '🦉',
          city: currentUser?.city || 'По приглашению',
        },
        u.id
      );
      break;
    }
  }

  return {
    success: true,
    referralState: updatedRef,
    message: `🎁 Код приглашения ${cleanCode} успешно активирован!`,
  };
}

export function migrateGuestReferralsToUser(userId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const guestKey = `${STORAGE_KEY_REFERRAL}_guest`;
    const userKey = `${STORAGE_KEY_REFERRAL}_${userId}`;
    const guestRaw = localStorage.getItem(guestKey);
    if (guestRaw && !localStorage.getItem(userKey)) {
      const parsed = JSON.parse(guestRaw);
      localStorage.setItem(
        userKey,
        JSON.stringify({
          ...parsed,
          referralCode: parsed.referralCode || generateReferralCode(userId),
        })
      );
    }
    localStorage.removeItem(guestKey);
  } catch {}
}
