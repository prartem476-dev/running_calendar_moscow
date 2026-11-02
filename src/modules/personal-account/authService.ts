import { ACCOUNT_CONFIG } from './accountConfig';
import { AuthUser, PublicAuthUser, AuthSession, AuthMethod } from './types';
import { getTelegramUser } from './telegramBridge';

const STORAGE_KEY_USERS = `${ACCOUNT_CONFIG.appPrefix}_auth_users_v1`;
const STORAGE_KEY_SESSION = `${ACCOUNT_CONFIG.appPrefix}_auth_session_v1`;
const STORAGE_KEY_LOCKOUT = `${ACCOUNT_CONFIG.appPrefix}_auth_lockout_v1`;

const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * ACCOUNT_CONFIG.sessionDurationDays;
const MAX_FAILED_ATTEMPTS = ACCOUNT_CONFIG.maxFailedAttempts;
const LOCKOUT_DURATION_MS = ACCOUNT_CONFIG.lockoutDurationSeconds * 1000;

export const AUTH_AVATAR_OPTIONS = ACCOUNT_CONFIG.avatarOptions;
export const AUTH_CITY_OPTIONS = ACCOUNT_CONFIG.cityOptions;

interface LockoutRecord {
  attempts: number;
  lockedUntil: number;
}

/**
 * Генерирует безопасный случайный никнейм без персональных данных (152-ФЗ).
 */
export function generateRandomNickname(): string {
  const adjectives = ACCOUNT_CONFIG.randomAdjectives;
  const nouns = ACCOUNT_CONFIG.randomNouns;
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(10 + Math.random() * 89);
  return `${adj}${noun}${num}`;
}

/**
 * Очищает никнейм от опасных символов (защита от XSS).
 */
export function sanitizeNickname(raw: string): string {
  return raw
    .replace(/[<>"'`&/\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

/**
 * DLP-проверка никнейма: запрещает ввод email и номеров телефона (152-ФЗ).
 */
export function validateSafeNickname(nickname: string): { valid: boolean; error?: string } {
  const clean = sanitizeNickname(nickname);
  if (clean.length < 2) {
    return { valid: false, error: 'Никнейм должен содержать минимум 2 символа' };
  }
  if (clean.includes('@') || /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/.test(clean)) {
    return {
      valid: false,
      error: 'В целях безопасности не используйте email в качестве никнейма',
    };
  }
  const digitsOnly = clean.replace(/\D/g, '');
  if (digitsOnly.length >= 7) {
    return {
      valid: false,
      error: 'В целях безопасности не указывайте номер телефона в никнейме',
    };
  }
  return { valid: true };
}

function generateRandomHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Генерирует резервный ключ восстановления формата PREFIX-XXXX-XXXX.
 */
export function generateRecoveryCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Без спорных 0/O/1/I
  const bytes = new Uint8Array(8);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 8; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let part1 = '';
  let part2 = '';
  for (let i = 0; i < 4; i++) {
    part1 += alphabet[bytes[i] % alphabet.length];
    part2 += alphabet[bytes[i + 4] % alphabet.length];
  }
  return `${ACCOUNT_CONFIG.recoveryCodePrefix}-${part1}-${part2}`;
}

/**
 * Резервный детерминированный хеш (если Web Crypto Subtle недоступен в dev HTTP).
 */
function fallbackHash(input: string, salt: string): string {
  const combined = `${salt}::${ACCOUNT_CONFIG.sessionSecretSalt}::${input}`;
  let h1 = 0xdeadbeef ^ combined.length;
  let h2 = 0x41c6ce57 ^ combined.length;
  for (let round = 0; round < 1000; round++) {
    for (let i = 0; i < combined.length; i++) {
      const ch = combined.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0') +
    ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0')
  );
}

/**
 * Вычисляет криптографический хеш PBKDF2-SHA256 (100 000 итераций) через Web Crypto API.
 */
export async function deriveSecretHash(secret: string, salt: string): Promise<string> {
  const normalizedSecret = secret.trim();
  if (typeof window !== 'undefined' && window.crypto?.subtle) {
    try {
      const encoder = new TextEncoder();
      const keyMaterial = await window.crypto.subtle.importKey(
        'raw',
        encoder.encode(normalizedSecret),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
      );
      const derivedBits = await window.crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: encoder.encode(salt),
          iterations: 100000,
          hash: 'SHA-256',
        },
        keyMaterial,
        256
      );
      const hashArray = Array.from(new Uint8Array(derivedBits));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return fallbackHash(normalizedSecret, salt);
    }
  }
  return fallbackHash(normalizedSecret, salt);
}

function computeSessionSignature(userId: string, token: string, expiresAt: number): string {
  return fallbackHash(`${userId}:${token}:${expiresAt}`, ACCOUNT_CONFIG.sessionSecretSalt);
}

export function toPublicUser(user: AuthUser): PublicAuthUser {
  return {
    id: user.id,
    nickname: user.nickname,
    avatar: user.avatar,
    city: user.city,
    authMethod: user.authMethod,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    referralCode: user.referralCode,
    referredByCode: user.referredByCode,
  };
}

class AuthService {
  private loadUsersMap(): AuthUser[] {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY_USERS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveUsersMap(users: AuthUser[]): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(users));
    } catch {}
  }

  private getLockoutState(): LockoutRecord {
    if (typeof window === 'undefined') return { attempts: 0, lockedUntil: 0 };
    try {
      const raw = localStorage.getItem(STORAGE_KEY_LOCKOUT);
      if (!raw) return { attempts: 0, lockedUntil: 0 };
      return JSON.parse(raw);
    } catch {
      return { attempts: 0, lockedUntil: 0 };
    }
  }

  private saveLockoutState(record: LockoutRecord): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY_LOCKOUT, JSON.stringify(record));
    } catch {}
  }

  public getRemainingLockoutSeconds(): number {
    const state = this.getLockoutState();
    if (state.lockedUntil > Date.now()) {
      return Math.ceil((state.lockedUntil - Date.now()) / 1000);
    }
    return 0;
  }

  private recordFailedAttempt(): { locked: boolean; secondsLeft: number; attemptsLeft: number } {
    const current = this.getLockoutState();
    const nextAttempts = current.attempts + 1;
    if (nextAttempts >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
      this.saveLockoutState({ attempts: 0, lockedUntil });
      return {
        locked: true,
        secondsLeft: Math.ceil(LOCKOUT_DURATION_MS / 1000),
        attemptsLeft: 0,
      };
    }
    this.saveLockoutState({ attempts: nextAttempts, lockedUntil: 0 });
    return {
      locked: false,
      secondsLeft: 0,
      attemptsLeft: MAX_FAILED_ATTEMPTS - nextAttempts,
    };
  }

  private clearFailedAttempts(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem(STORAGE_KEY_LOCKOUT);
    } catch {}
  }

  public getRegisteredPublicUsers(): PublicAuthUser[] {
    return this.loadUsersMap().map(toPublicUser);
  }

  public getCurrentUser(): PublicAuthUser | null {
    if (typeof window === 'undefined') return null;
    try {
      const rawSession = localStorage.getItem(STORAGE_KEY_SESSION);
      if (!rawSession) return null;
      const session: AuthSession = JSON.parse(rawSession);

      if (!session.userId || !session.token || !session.expiresAt || !session.signature) {
        this.logout();
        return null;
      }

      if (Date.now() > session.expiresAt) {
        this.logout();
        return null;
      }

      const expectedSig = computeSessionSignature(
        session.userId,
        session.token,
        session.expiresAt
      );
      if (session.signature !== expectedSig) {
        this.logout();
        return null;
      }

      const users = this.loadUsersMap();
      const found = users.find((u) => u.id === session.userId);
      if (!found) {
        this.logout();
        return null;
      }

      return toPublicUser(found);
    } catch {
      return null;
    }
  }

  private createSession(userId: string): AuthSession {
    const issuedAt = Date.now();
    const expiresAt = issuedAt + SESSION_DURATION_MS;
    const token = generateRandomHex(24);
    const signature = computeSessionSignature(userId, token, expiresAt);
    const session: AuthSession = {
      userId,
      token,
      issuedAt,
      expiresAt,
      signature,
    };
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify(session));
      } catch {}
    }
    return session;
  }

  public async register(params: {
    nickname: string;
    secret: string;
    avatar: string;
    city?: string;
    authMethod?: AuthMethod;
  }): Promise<{
    success: boolean;
    user?: PublicAuthUser;
    recoveryCode?: string;
    error?: string;
  }> {
    const cleanName = sanitizeNickname(params.nickname);
    const validation = validateSafeNickname(cleanName);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const secret = params.secret.trim();
    const method: AuthMethod = params.authMethod || 'pin';

    if (method === 'pin' && !/^\d{4}$/.test(secret)) {
      return { success: false, error: 'PIN-код должен состоять ровно из 4 цифр' };
    }
    if (method === 'password' && secret.length < 4) {
      return { success: false, error: 'Пароль должен содержать минимум 4 символа' };
    }

    const users = this.loadUsersMap();
    const duplicate = users.find(
      (u) => u.nickname.toLowerCase() === cleanName.toLowerCase()
    );
    if (duplicate) {
      return {
        success: false,
        error: 'Этот никнейм уже занят. Выберите другой или войдите в свой профиль.',
      };
    }

    const salt = generateRandomHex(16);
    const securityHash = await deriveSecretHash(secret, salt);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await deriveSecretHash(recoveryCode.toUpperCase(), salt);

    const nowIso = new Date().toISOString();
    const newUser: AuthUser = {
      id: `usr_${Date.now()}_${generateRandomHex(6)}`,
      nickname: cleanName,
      avatar: params.avatar || AUTH_AVATAR_OPTIONS[0] || '🦉',
      city: (params.city || 'Инкогнито').trim(),
      authMethod: method,
      createdAt: nowIso,
      lastLoginAt: nowIso,
      securityHash,
      securitySalt: salt,
      recoveryCodeHash,
    };

    users.push(newUser);
    this.saveUsersMap(users);
    this.clearFailedAttempts();
    this.createSession(newUser.id);

    return {
      success: true,
      user: toPublicUser(newUser),
      recoveryCode,
    };
  }

  public async login(params: {
    nickname: string;
    secret: string;
  }): Promise<{
    success: boolean;
    user?: PublicAuthUser;
    error?: string;
  }> {
    const lockoutSeconds = this.getRemainingLockoutSeconds();
    if (lockoutSeconds > 0) {
      return {
        success: false,
        error: `Слишком много попыток. Подождите ${lockoutSeconds} сек.`,
      };
    }

    const cleanName = sanitizeNickname(params.nickname);
    const secret = params.secret.trim();
    if (!cleanName || !secret) {
      return { success: false, error: 'Введите никнейм и код доступа' };
    }

    const users = this.loadUsersMap();
    const found = users.find(
      (u) => u.nickname.toLowerCase() === cleanName.toLowerCase()
    );

    if (!found) {
      this.recordFailedAttempt();
      return { success: false, error: 'Неверный никнейм или код доступа' };
    }

    const computedHash = await deriveSecretHash(secret, found.securitySalt);
    if (computedHash !== found.securityHash) {
      const attemptInfo = this.recordFailedAttempt();
      if (attemptInfo.locked) {
        return {
          success: false,
          error: `Защита от подбора: вход заблокирован на ${attemptInfo.secondsLeft} сек.`,
        };
      }
      return {
        success: false,
        error: `Неверный код доступа (осталось попыток: ${attemptInfo.attemptsLeft})`,
      };
    }

    found.lastLoginAt = new Date().toISOString();
    this.saveUsersMap(users);
    this.clearFailedAttempts();
    this.createSession(found.id);

    return {
      success: true,
      user: toPublicUser(found),
    };
  }

  public async recoverAccount(params: {
    nickname: string;
    recoveryCode: string;
    newSecret: string;
    newAuthMethod?: AuthMethod;
  }): Promise<{
    success: boolean;
    user?: PublicAuthUser;
    error?: string;
  }> {
    const lockoutSeconds = this.getRemainingLockoutSeconds();
    if (lockoutSeconds > 0) {
      return {
        success: false,
        error: `Слишком много попыток. Подождите ${lockoutSeconds} сек.`,
      };
    }

    const cleanName = sanitizeNickname(params.nickname);
    const normalizedRecovery = params.recoveryCode.trim().toUpperCase();
    const newSecret = params.newSecret.trim();
    const method: AuthMethod = params.newAuthMethod || 'pin';

    if (method === 'pin' && !/^\d{4}$/.test(newSecret)) {
      return { success: false, error: 'Новый PIN-код должен состоять из 4 цифр' };
    }
    if (method === 'password' && newSecret.length < 4) {
      return { success: false, error: 'Новый пароль должен содержать минимум 4 символа' };
    }

    const users = this.loadUsersMap();
    const found = users.find(
      (u) => u.nickname.toLowerCase() === cleanName.toLowerCase()
    );

    if (!found) {
      this.recordFailedAttempt();
      return { success: false, error: 'Профиль не найден или неверный резервный ключ' };
    }

    const recoveryHash = await deriveSecretHash(normalizedRecovery, found.securitySalt);
    if (recoveryHash !== found.recoveryCodeHash) {
      this.recordFailedAttempt();
      return { success: false, error: 'Неверный резервный ключ восстановления' };
    }

    found.securityHash = await deriveSecretHash(newSecret, found.securitySalt);
    found.authMethod = method;
    found.lastLoginAt = new Date().toISOString();
    this.saveUsersMap(users);
    this.clearFailedAttempts();
    this.createSession(found.id);

    return {
      success: true,
      user: toPublicUser(found),
    };
  }

  public async loginWithTelegram(): Promise<{
    success: boolean;
    user?: PublicAuthUser;
    isNewUser?: boolean;
    error?: string;
  }> {
    const tgUser = getTelegramUser();
    if (!tgUser || !tgUser.id) {
      return {
        success: false,
        error: 'Telegram WebApp не обнаружен. Используйте вход по PIN-коду.',
      };
    }

    const users = this.loadUsersMap();
    const existing = users.find((u) => u.telegramId === tgUser.id);

    if (existing) {
      existing.lastLoginAt = new Date().toISOString();
      this.saveUsersMap(users);
      this.createSession(existing.id);
      return { success: true, user: toPublicUser(existing), isNewUser: false };
    }

    const baseName = sanitizeNickname(tgUser.name || tgUser.username || `Игрок${tgUser.id}`);
    const uniqueName = users.some((u) => u.nickname.toLowerCase() === baseName.toLowerCase())
      ? `${baseName.slice(0, 15)}_${String(tgUser.id).slice(-3)}`
      : baseName;

    const salt = generateRandomHex(16);
    const secretHash = await deriveSecretHash(`tg_${tgUser.id}`, salt);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await deriveSecretHash(recoveryCode, salt);
    const nowIso = new Date().toISOString();

    const newUser: AuthUser = {
      id: `usr_tg_${tgUser.id}`,
      nickname: uniqueName,
      avatar: '🚀',
      city: 'Telegram',
      authMethod: 'telegram',
      createdAt: nowIso,
      lastLoginAt: nowIso,
      securityHash: secretHash,
      securitySalt: salt,
      recoveryCodeHash,
      telegramId: tgUser.id,
    };

    users.push(newUser);
    this.saveUsersMap(users);
    this.createSession(newUser.id);

    return { success: true, user: toPublicUser(newUser), isNewUser: true };
  }

  public updateProfile(
    userId: string,
    updates: { nickname?: string; avatar?: string; city?: string }
  ): { success: boolean; user?: PublicAuthUser; error?: string } {
    const users = this.loadUsersMap();
    const target = users.find((u) => u.id === userId);
    if (!target) {
      return { success: false, error: 'Пользователь не найден' };
    }

    if (updates.nickname !== undefined) {
      const cleanName = sanitizeNickname(updates.nickname);
      const validation = validateSafeNickname(cleanName);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      const conflict = users.find(
        (u) => u.id !== userId && u.nickname.toLowerCase() === cleanName.toLowerCase()
      );
      if (conflict) {
        return { success: false, error: 'Этот никнейм уже занят другим пользователем' };
      }
      target.nickname = cleanName;
    }

    if (updates.avatar) {
      target.avatar = updates.avatar;
    }
    if (updates.city) {
      target.city = sanitizeNickname(updates.city) || 'Инкогнито';
    }

    this.saveUsersMap(users);
    return { success: true, user: toPublicUser(target) };
  }

  public logout(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem(STORAGE_KEY_SESSION);
    } catch {}
  }

  public deleteAccount(userId: string, extraScopedKeys: string[] = []): boolean {
    if (typeof window === 'undefined') return false;
    try {
      const users = this.loadUsersMap();
      const filtered = users.filter((u) => u.id !== userId);
      this.saveUsersMap(filtered);

      const allPrefixes = [
        ...ACCOUNT_CONFIG.scopedStorageKeys,
        `${ACCOUNT_CONFIG.appPrefix}_referrals_v1`,
        ...extraScopedKeys,
      ];
      for (const prefix of allPrefixes) {
        localStorage.removeItem(`${prefix}_${userId}`);
        localStorage.removeItem(`${prefix}_guest`);
      }

      this.logout();
      return true;
    } catch {
      return false;
    }
  }
}

export const authService = new AuthService();
