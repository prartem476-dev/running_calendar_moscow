import { ACCOUNT_CONFIG } from './accountConfig';
import { authService } from './authService';
import { PublicAuthUser } from './types';

/**
 * Формирует изолированный ключ localStorage для текущего пользователя или гостя.
 * - Авторизованный пользователь: `<baseKey>_<userId>`
 * - Гость: `<baseKey>_guest`
 */
export function getScopedKey(baseKey: string, explicitUserId?: string): string {
  if (explicitUserId) {
    return `${baseKey}_${explicitUserId}`;
  }
  const user = authService.getCurrentUser();
  return user ? `${baseKey}_${user.id}` : `${baseKey}_guest`;
}

/**
 * Универсальное чтение данных из мультиаккаунтного хранилища.
 */
export function loadScopedItem<T>(
  baseKey: string,
  fallback: T,
  explicitUserId?: string
): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const key = getScopedKey(baseKey, explicitUserId);
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Универсальная запись данных в мультиаккаунтное хранилище.
 */
export function saveScopedItem<T>(
  baseKey: string,
  data: T,
  explicitUserId?: string
): void {
  if (typeof window === 'undefined') return;
  try {
    const key = getScopedKey(baseKey, explicitUserId);
    localStorage.setItem(key, JSON.stringify(data));
  } catch {}
}

/**
 * Бесшовно переносит весь накопленный гостевой прогресс (`_guest`) в профиль
 * только что зарегистрированного пользователя (`_<user.id>`), после чего очищает гостевой кэш.
 */
export function migrateGuestDataToUser(
  user: PublicAuthUser,
  extraBaseKeys: string[] = []
): void {
  if (typeof window === 'undefined') return;
  try {
    const baseKeys = Array.from(
      new Set([...ACCOUNT_CONFIG.scopedStorageKeys, ...extraBaseKeys])
    );

    const isFirstRegisteredUser = authService.getRegisteredPublicUsers().length <= 1;

    for (const baseKey of baseKeys) {
      const userKey = `${baseKey}_${user.id}`;
      const guestKey = `${baseKey}_guest`;

      if (!localStorage.getItem(userKey)) {
        const guestData = localStorage.getItem(guestKey);
        const legacyData = isFirstRegisteredUser ? localStorage.getItem(baseKey) : null;
        const sourceData = guestData || legacyData;

        if (sourceData) {
          localStorage.setItem(userKey, sourceData);
        }
      }
      localStorage.removeItem(guestKey);
    }
  } catch {}
}

/**
 * Очищает временные гостевые данные при выходе из аккаунта или его удалении.
 */
export function clearGuestSessionData(extraBaseKeys: string[] = []): void {
  if (typeof window === 'undefined') return;
  try {
    const baseKeys = Array.from(
      new Set([...ACCOUNT_CONFIG.scopedStorageKeys, ...extraBaseKeys])
    );
    for (const baseKey of baseKeys) {
      localStorage.removeItem(`${baseKey}_guest`);
    }
  } catch {}
}
