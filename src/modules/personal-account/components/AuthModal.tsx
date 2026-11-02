import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Lock,
  UserPlus,
  LogIn,
  KeyRound,
  Dices,
  X,
  Check,
  Copy,
  LogOut,
  Eye,
  EyeOff,
  AlertCircle,
  Sparkles,
  Trophy,
  BarChart2,
  UserCheck,
  Send,
  Trash2,
  FileText,
  Users,
  Gift,
} from 'lucide-react';
import {
  PublicAuthUser,
  AuthMethod,
  AuthModalInitialTab,
  AccountQuickStatItem,
} from '../types';
import {
  authService,
  AUTH_AVATAR_OPTIONS,
  AUTH_CITY_OPTIONS,
  generateRandomNickname,
} from '../authService';
import { ACCOUNT_CONFIG } from '../accountConfig';
import { isTelegramWebApp } from '../telegramBridge';
import { playClick, playSuccess, playError } from '../soundEffects';
import {
  detectIncomingReferralCode,
  loadReferralState,
  AMBASSADOR_AVATAR_EMOJI,
  AMBASSADOR_REQUIRED_INVITES,
} from '../referralService';

export interface AuthModalProps {
  currentUser: PublicAuthUser | null;
  soundEnabled?: boolean;
  initialTab?: AuthModalInitialTab;
  /** Универсальные карточки быстрого перехода в профиле (например, Рейтинг, Статистика) */
  quickLinks?: AccountQuickStatItem[];
  /** Показывать ли блок реферальной программы и Амбассадора */
  enableReferrals?: boolean;
  onSuccessAuth: (
    user: PublicAuthUser,
    isNewRegistration: boolean,
    referralCodeUsed?: string
  ) => void;
  onLogout: () => void;
  onDeleteAccount?: () => void;
  onUpdateUser: (user: PublicAuthUser) => void;
  onOpenReferrals?: () => void;
  onClose: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  currentUser,
  soundEnabled = true,
  initialTab,
  quickLinks = [],
  enableReferrals = true,
  onSuccessAuth,
  onLogout,
  onDeleteAccount,
  onUpdateUser,
  onOpenReferrals,
  onClose,
}) => {
  const registeredUsers = authService.getRegisteredPublicUsers();
  const defaultTab: AuthModalInitialTab = currentUser
    ? 'profile'
    : initialTab || (registeredUsers.length > 0 ? 'login' : 'register');

  const [activeTab, setActiveTab] = useState<AuthModalInitialTab>(defaultTab);

  // Состояние регистрации
  const [regNickname, setRegNickname] = useState<string>(() => generateRandomNickname());
  const [regAvatar, setRegAvatar] = useState<string>(AUTH_AVATAR_OPTIONS[0] || '🦉');
  const [regCity, setRegCity] = useState<string>(AUTH_CITY_OPTIONS[0] || 'Москва');
  const [regMethod, setRegMethod] = useState<AuthMethod>('pin');
  const [regSecret, setRegSecret] = useState<string>('');
  const [regReferralCode, setRegReferralCode] = useState<string>(
    () => detectIncomingReferralCode() || ''
  );
  const [showSecret, setShowSecret] = useState<boolean>(false);

  // Пост-регистрационный показ резервного ключа
  const [generatedRecoveryCode, setGeneratedRecoveryCode] = useState<string | null>(null);
  const [pendingNewUser, setPendingNewUser] = useState<PublicAuthUser | null>(null);
  const [copiedRecovery, setCopiedRecovery] = useState<boolean>(false);

  // Состояние входа
  const [loginNickname, setLoginNickname] = useState<string>(
    registeredUsers[0]?.nickname || ''
  );
  const [loginSecret, setLoginSecret] = useState<string>('');

  // Состояние восстановления по ключу
  const [recNickname, setRecNickname] = useState<string>(
    registeredUsers[0]?.nickname || ''
  );
  const [recCode, setRecCode] = useState<string>('');
  const [recNewSecret, setRecNewSecret] = useState<string>('');

  // Состояние редактирования профиля
  const [editNickname, setEditNickname] = useState<string>(currentUser?.nickname || '');
  const [editAvatar, setEditAvatar] = useState<string>(
    currentUser?.avatar || AUTH_AVATAR_OPTIONS[0] || '🦉'
  );
  const [editCity, setEditCity] = useState<string>(
    currentUser?.city || AUTH_CITY_OPTIONS[0] || 'Москва'
  );
  const [profileSavedToast, setProfileSavedToast] = useState<boolean>(false);

  // Статусы
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState<boolean>(false);

  useEffect(() => {
    if (currentUser) {
      setEditNickname(currentUser.nickname);
      setEditAvatar(currentUser.avatar);
      setEditCity(currentUser.city || AUTH_CITY_OPTIONS[0] || 'Москва');
    }
  }, [currentUser]);

  const handleRandomizeNickname = () => {
    playClick(soundEnabled);
    setRegNickname(generateRandomNickname());
    setErrorMsg(null);
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsSubmitting(true);

    const res = await authService.register({
      nickname: regNickname,
      secret: regSecret,
      avatar: regAvatar,
      city: regCity,
      authMethod: regMethod,
    });

    setIsSubmitting(false);

    if (!res.success || !res.user) {
      playError(soundEnabled);
      setErrorMsg(res.error || 'Ошибка регистрации');
      return;
    }

    playSuccess(soundEnabled);
    if (res.recoveryCode) {
      setGeneratedRecoveryCode(res.recoveryCode);
      setPendingNewUser(res.user);
    } else {
      onSuccessAuth(res.user, true, regReferralCode.trim() || undefined);
    }
  };

  const handleCompleteRegistrationAfterRecovery = () => {
    playClick(soundEnabled);
    if (pendingNewUser) {
      onSuccessAuth(pendingNewUser, true, regReferralCode.trim() || undefined);
    }
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsSubmitting(true);

    const res = await authService.login({
      nickname: loginNickname,
      secret: loginSecret,
    });

    setIsSubmitting(false);

    if (!res.success || !res.user) {
      playError(soundEnabled);
      setErrorMsg(res.error || 'Неверный никнейм или код доступа');
      return;
    }

    playSuccess(soundEnabled);
    onSuccessAuth(res.user, false);
  };

  const handleRecoverSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsSubmitting(true);

    const res = await authService.recoverAccount({
      nickname: recNickname,
      recoveryCode: recCode,
      newSecret: recNewSecret,
      newAuthMethod: /^\d{4}$/.test(recNewSecret.trim()) ? 'pin' : 'password',
    });

    setIsSubmitting(false);

    if (!res.success || !res.user) {
      playError(soundEnabled);
      setErrorMsg(res.error || 'Не удалось восстановить доступ');
      return;
    }

    playSuccess(soundEnabled);
    onSuccessAuth(res.user, false);
  };

  const handleTelegramOneTap = async () => {
    playClick(soundEnabled);
    setErrorMsg(null);
    setIsSubmitting(true);
    const res = await authService.loginWithTelegram();
    setIsSubmitting(false);

    if (!res.success || !res.user) {
      playError(soundEnabled);
      setErrorMsg(res.error || 'Не удалось войти через Telegram');
      return;
    }

    playSuccess(soundEnabled);
    onSuccessAuth(res.user, Boolean(res.isNewUser));
  };

  const handleSaveProfileUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    setErrorMsg(null);

    const res = authService.updateProfile(currentUser.id, {
      nickname: editNickname,
      avatar: editAvatar,
      city: editCity,
    });

    if (!res.success || !res.user) {
      playError(soundEnabled);
      setErrorMsg(res.error || 'Не удалось обновить профиль');
      return;
    }

    playSuccess(soundEnabled);
    onUpdateUser(res.user);
    setProfileSavedToast(true);
    setTimeout(() => setProfileSavedToast(false), 2500);
  };

  const referralState = currentUser ? loadReferralState(currentUser.id) : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md animate-fadeIn select-none overflow-y-auto">
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-6 shadow-2xl flex flex-col gap-4 my-auto max-h-[92vh] overflow-y-auto">
        {/* Top Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
              {currentUser ? (
                <UserCheck className="w-5 h-5" />
              ) : (
                <ShieldCheck className="w-5 h-5" />
              )}
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-black text-white leading-tight">
                {currentUser
                  ? 'Личный кабинет'
                  : generatedRecoveryCode
                  ? 'Профиль создан!'
                  : 'Безопасная авторизация'}
              </h3>
              <p className="text-xs font-bold text-slate-300 font-mono">
                {currentUser
                  ? 'Доступ к рейтингу и статистике открыт'
                  : 'Без телефона, почты и личных данных'}
              </p>
            </div>
          </div>

          <button
            id="btn-close-auth-modal"
            type="button"
            onClick={() => {
              playClick(soundEnabled);
              if (pendingNewUser) {
                onSuccessAuth(pendingNewUser, true, regReferralCode.trim() || undefined);
              } else {
                onClose();
              }
            }}
            className="w-8 h-8 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 flex items-center justify-center transition-colors cursor-pointer shrink-0"
            aria-label="Закрыть окно авторизации"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* =============================================================== */}
        {/* VIEW A: POST-REGISTRATION RECOVERY CODE STEP                    */}
        {/* =============================================================== */}
        {generatedRecoveryCode && pendingNewUser ? (
          <div className="flex flex-col gap-4 animate-fadeIn">
            <div className="p-4 rounded-2xl bg-emerald-500/15 border border-emerald-500/40 flex items-center gap-3">
              <span className="text-3xl shrink-0">{pendingNewUser.avatar}</span>
              <div className="min-w-0">
                <div className="text-xs font-mono font-extrabold text-emerald-400 uppercase">
                  Аккаунт активирован
                </div>
                <div className="text-base font-black text-white truncate">
                  {pendingNewUser.nickname}
                </div>
                <div className="text-xs font-bold text-slate-200">
                  {pendingNewUser.city} • Профиль подключен
                </div>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-slate-950 border border-amber-500/40 flex flex-col gap-2.5">
              <div className="flex items-center gap-2 text-xs font-mono font-extrabold text-amber-400">
                <KeyRound className="w-4 h-4 shrink-0" />
                <span>Ваш резервный ключ восстановления:</span>
              </div>
              <p className="text-xs font-bold text-slate-200 leading-relaxed">
                Так как мы не запрашиваем ваш телефон или почту, сохраните этот код. С его помощью вы сможете сбросить PIN-код, если забудете его:
              </p>

              <div className="p-3 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-between gap-2">
                <span className="font-mono font-black text-sm sm:text-base text-amber-300 tracking-wider select-all">
                  {generatedRecoveryCode}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    playClick(soundEnabled);
                    navigator.clipboard.writeText(
                      `Никнейм: ${pendingNewUser.nickname}\nРезервный ключ: ${generatedRecoveryCode}`
                    );
                    setCopiedRecovery(true);
                    setTimeout(() => setCopiedRecovery(false), 2500);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs flex items-center gap-1 cursor-pointer shrink-0"
                >
                  {copiedRecovery ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Скопировано</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Скопировать</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <button
              id="btn-finish-registration"
              type="button"
              onClick={handleCompleteRegistrationAfterRecovery}
              className="w-full min-h-[48px] py-3 px-4 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm sm:text-base flex items-center justify-center gap-2 shadow-lg cursor-pointer transition-transform active:scale-98"
            >
              <Sparkles className="w-4 h-4" />
              <span>Отлично, продолжить</span>
            </button>
          </div>
        ) : currentUser ? (
          /* =============================================================== */
          /* VIEW B: LOGGED-IN USER PROFILE & SECURITY                       */
          /* =============================================================== */
          <div className="flex flex-col gap-4 animate-fadeIn">
            {/* Active User Summary Banner */}
            <div className="p-4 rounded-2xl bg-gradient-to-r from-emerald-500/15 via-slate-950 to-amber-500/10 border border-emerald-500/35 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-12 h-12 rounded-2xl bg-slate-800 border border-emerald-400/50 flex items-center justify-center text-2xl shrink-0">
                  {currentUser.avatar}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-black text-white truncate">
                      {currentUser.nickname}
                    </span>
                    <span className="text-[10px] font-mono font-extrabold px-2 py-0.5 rounded-full bg-emerald-500 text-slate-950">
                      АВТОРИЗОВАН
                    </span>
                  </div>
                  <div className="text-xs font-bold text-slate-300 mt-0.5">
                    📍 {currentUser.city} • Защита:{' '}
                    {currentUser.authMethod === 'pin'
                      ? 'PIN (PBKDF2)'
                      : currentUser.authMethod === 'telegram'
                      ? 'Telegram ID'
                      : 'Пароль (PBKDF2)'}
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Navigation Cards */}
            {quickLinks.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {quickLinks.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      playClick(soundEnabled);
                      onClose();
                      item.onClick();
                    }}
                    className="p-2.5 sm:p-3 rounded-2xl bg-slate-950 hover:bg-slate-850 border border-slate-800 hover:border-emerald-500/40 flex items-center gap-2 text-left transition-all cursor-pointer min-w-0"
                  >
                    {item.icon === 'trophy' ? (
                      <Trophy className="w-4 h-4 sm:w-5 sm:h-5 text-amber-400 shrink-0" />
                    ) : item.icon === 'users' ? (
                      <Users className="w-4 h-4 sm:w-5 sm:h-5 text-amber-400 shrink-0" />
                    ) : (
                      <BarChart2 className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-400 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-xs font-extrabold text-white truncate">
                        {item.label}
                      </div>
                      <div className="text-[10px] sm:text-[11px] font-mono font-bold text-emerald-400 truncate">
                        {item.valueText}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Dedicated Friends & Ambassador Section */}
            {enableReferrals && onOpenReferrals && referralState && (
              <div className="p-3.5 rounded-2xl bg-slate-950/90 border border-emerald-500/35 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-amber-400/40 flex items-center justify-center text-emerald-400 shrink-0">
                    <Users className="w-5 h-5 text-amber-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs sm:text-sm font-extrabold text-white flex items-center gap-1.5 flex-wrap">
                      <span>Друзья и рефералы</span>
                      <span className="text-[10px] font-mono font-black px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 tabular-nums">
                        {referralState.invitedFriends.length}/{AMBASSADOR_REQUIRED_INVITES}
                      </span>
                    </div>
                    <div className="text-[11px] font-bold text-slate-300 truncate">
                      {referralState.isAmbassador
                        ? '💎 Скин Амбассадора разблокирован'
                        : `Пригласите ${AMBASSADOR_REQUIRED_INVITES} друзей → статус Амбассадора 💎`}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    playClick(soundEnabled);
                    onClose();
                    onOpenReferrals();
                  }}
                  className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs shrink-0 cursor-pointer transition-colors"
                >
                  Друзья →
                </button>
              </div>
            )}

            {/* Edit Nickname / Avatar / City Form */}
            <form
              onSubmit={handleSaveProfileUpdate}
              className="flex flex-col gap-3 p-3.5 rounded-2xl bg-slate-950/90 border border-slate-800"
            >
              <div className="text-xs font-extrabold text-slate-200">
                Настройки профиля:
              </div>

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                {(referralState?.isAmbassador
                  ? [AMBASSADOR_AVATAR_EMOJI, ...AUTH_AVATAR_OPTIONS]
                  : AUTH_AVATAR_OPTIONS
                ).map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      playClick(soundEnabled);
                      setEditAvatar(emoji);
                    }}
                    className={`w-9 h-9 rounded-xl text-lg flex items-center justify-center shrink-0 transition-all cursor-pointer border ${
                      editAvatar === emoji
                        ? 'bg-emerald-500/20 border-emerald-400 scale-105 shadow'
                        : 'bg-slate-900 border-slate-800 hover:bg-slate-800'
                    }`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-mono font-bold text-slate-300 block mb-1">
                    Никнейм:
                  </label>
                  <input
                    type="text"
                    maxLength={20}
                    value={editNickname}
                    onChange={(e) => setEditNickname(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs font-bold text-white focus:outline-none focus:border-emerald-400"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-mono font-bold text-slate-300 block mb-1">
                    Город:
                  </label>
                  <select
                    value={editCity}
                    onChange={(e) => setEditCity(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs font-bold text-white focus:outline-none focus:border-emerald-400"
                  >
                    {AUTH_CITY_OPTIONS.map((city) => (
                      <option key={city} value={city}>
                        {city}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {errorMsg && (
                <div className="p-2.5 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-300 text-xs font-bold flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {profileSavedToast && (
                <div className="p-2.5 rounded-xl bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Профиль успешно обновлён!</span>
                </div>
              )}

              <button
                type="submit"
                className="w-full py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
              >
                <Check className="w-4 h-4" />
                <span>Сохранить изменения</span>
              </button>
            </form>

            {/* Logout & Account Deletion Controls (RuStore & 152-FZ compliance) */}
            <div className="pt-2 border-t border-slate-800 flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-2">
                <button
                  id="btn-auth-logout"
                  type="button"
                  onClick={() => {
                    playClick(soundEnabled);
                    onLogout();
                  }}
                  className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-extrabold flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Выйти из профиля</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    playClick(soundEnabled);
                    onClose();
                  }}
                  className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black cursor-pointer transition-colors"
                >
                  Готово
                </button>
              </div>

              {!confirmDeleteAccount ? (
                <button
                  id="btn-auth-delete-init"
                  type="button"
                  onClick={() => {
                    playClick(soundEnabled);
                    setConfirmDeleteAccount(true);
                  }}
                  className="w-full py-2 px-3 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-300 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Удалить аккаунт и данные с устройства</span>
                </button>
              ) : (
                <div className="p-3 rounded-2xl bg-rose-950/60 border border-rose-500/40 flex flex-col gap-2 animate-fadeIn">
                  <div className="text-xs font-extrabold text-rose-200">
                    Удалить профиль «{currentUser.nickname}» и все данные с устройства?
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      id="btn-auth-delete-confirm"
                      type="button"
                      onClick={() => {
                        playClick(soundEnabled);
                        if (onDeleteAccount) {
                          onDeleteAccount();
                        } else {
                          authService.deleteAccount(currentUser.id);
                          onLogout();
                        }
                      }}
                      className="flex-1 py-2 px-3 rounded-xl bg-rose-500 hover:bg-rose-400 text-white text-xs font-black flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Да, удалить навсегда</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        playClick(soundEnabled);
                        setConfirmDeleteAccount(false);
                      }}
                      className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 cursor-pointer"
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* =============================================================== */
          /* VIEW C: GUEST REGISTRATION / LOGIN / RECOVERY                   */
          /* =============================================================== */
          <div className="flex flex-col gap-3.5 animate-fadeIn">
            <div className="grid grid-cols-2 gap-1.5 p-1.5 rounded-2xl bg-slate-950 border border-slate-800">
              <button
                id="tab-auth-register"
                type="button"
                onClick={() => {
                  playClick(soundEnabled);
                  setActiveTab('register');
                  setErrorMsg(null);
                }}
                className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs sm:text-sm font-extrabold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  activeTab === 'register'
                    ? 'bg-emerald-500 text-slate-950 font-black shadow-sm'
                    : 'text-slate-200 hover:text-white hover:bg-slate-800/50'
                }`}
              >
                <UserPlus className="w-4 h-4 shrink-0" />
                <span>Регистрация</span>
              </button>

              <button
                id="tab-auth-login"
                type="button"
                onClick={() => {
                  playClick(soundEnabled);
                  setActiveTab('login');
                  setErrorMsg(null);
                }}
                className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs sm:text-sm font-extrabold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  activeTab === 'login' || activeTab === 'recover'
                    ? 'bg-emerald-500 text-slate-950 font-black shadow-sm'
                    : 'text-slate-200 hover:text-white hover:bg-slate-800/50'
                }`}
              >
                <LogIn className="w-4 h-4 shrink-0" />
                <span>
                  Вход {registeredUsers.length > 0 ? `(${registeredUsers.length})` : ''}
                </span>
              </button>
            </div>

            {isTelegramWebApp() && (
              <button
                type="button"
                onClick={handleTelegramOneTap}
                disabled={isSubmitting}
                className="w-full py-3 px-4 rounded-2xl bg-[#229ED9] hover:bg-[#1E8CC0] text-white font-black text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg cursor-pointer transition-all"
              >
                <Send className="w-4 h-4" />
                <span>Войти в 1 клик через Telegram</span>
              </button>
            )}

            {/* TAB 1: REGISTRATION */}
            {activeTab === 'register' && (
              <form onSubmit={handleRegisterSubmit} className="flex flex-col gap-3.5">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label
                      htmlFor="input-reg-nickname"
                      className="text-xs font-extrabold text-slate-200"
                    >
                      1. Ваш никнейм (без ФИО и телефона):
                    </label>
                    <button
                      type="button"
                      onClick={handleRandomizeNickname}
                      className="text-[11px] font-mono font-extrabold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 cursor-pointer"
                    >
                      <Dices className="w-3.5 h-3.5" />
                      <span>Случайный</span>
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input
                      id="input-reg-nickname"
                      type="text"
                      maxLength={20}
                      required
                      value={regNickname}
                      onChange={(e) => {
                        setRegNickname(e.target.value);
                        setErrorMsg(null);
                      }}
                      placeholder="Например: КиберСова"
                      className="sm:col-span-2 px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm font-bold text-white focus:outline-none focus:border-emerald-400"
                    />
                    <select
                      value={regCity}
                      onChange={(e) => setRegCity(e.target.value)}
                      aria-label="Город"
                      className="px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-xs font-bold text-slate-200 focus:outline-none focus:border-emerald-400"
                    >
                      {AUTH_CITY_OPTIONS.map((city) => (
                        <option key={city} value={city}>
                          {city}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label
                      htmlFor="input-reg-secret"
                      className="text-xs font-extrabold text-slate-200 flex items-center gap-1.5"
                    >
                      <Lock className="w-3.5 h-3.5 text-emerald-400" />
                      <span>
                        {regMethod === 'pin'
                          ? '2. Придумайте 4-значный PIN-код:'
                          : '2. Придумайте пароль (от 4 символов):'}
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        playClick(soundEnabled);
                        setRegMethod(regMethod === 'pin' ? 'password' : 'pin');
                        setRegSecret('');
                        setErrorMsg(null);
                      }}
                      className="text-[11px] font-mono font-bold text-slate-300 hover:text-emerald-400 cursor-pointer"
                    >
                      {regMethod === 'pin'
                        ? 'Использовать пароль'
                        : 'Использовать 4-значный PIN'}
                    </button>
                  </div>

                  <div className="relative">
                    <input
                      id="input-reg-secret"
                      type={showSecret ? 'text' : 'password'}
                      inputMode={regMethod === 'pin' ? 'numeric' : 'text'}
                      maxLength={regMethod === 'pin' ? 4 : 32}
                      required
                      value={regSecret}
                      onChange={(e) => {
                        const val =
                          regMethod === 'pin'
                            ? e.target.value.replace(/\D/g, '').slice(0, 4)
                            : e.target.value;
                        setRegSecret(val);
                        setErrorMsg(null);
                      }}
                      placeholder={
                        regMethod === 'pin'
                          ? '• • • • (4 цифры, например 2580)'
                          : 'Минимум 4 символа...'
                      }
                      className="w-full px-3.5 py-2.5 pr-10 rounded-xl bg-slate-950 border border-slate-700 text-sm font-mono font-bold text-white tracking-widest focus:outline-none focus:border-emerald-400"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecret(!showSecret)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
                      aria-label="Показать или скрыть код"
                    >
                      {showSecret ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                {enableReferrals && (
                  <div>
                    <label
                      htmlFor="input-reg-referral"
                      className="text-xs font-extrabold text-slate-200 flex items-center justify-between mb-1"
                    >
                      <span className="flex items-center gap-1.5">
                        <Gift className="w-3.5 h-3.5 text-amber-400" />
                        <span>3. Код приглашения от друга (необязательно):</span>
                      </span>
                    </label>
                    <input
                      id="input-reg-referral"
                      type="text"
                      maxLength={20}
                      value={regReferralCode}
                      onChange={(e) => setRegReferralCode(e.target.value.toUpperCase())}
                      placeholder={`Например: ${ACCOUNT_CONFIG.referralCodePrefix}-7K4M`}
                      className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono font-bold text-amber-300 uppercase focus:outline-none focus:border-amber-400"
                    />
                  </div>
                )}

                <div className="p-3 rounded-2xl bg-slate-950/90 border border-slate-800 flex items-start gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="text-[11px] font-bold text-slate-300 leading-relaxed">
                    <span className="text-emerald-400 font-extrabold">
                      Безопасность (152-ФЗ):
                    </span>{' '}
                    мы не собираем email и телефон. Ваш код шифруется алгоритмом{' '}
                    <span className="font-mono text-slate-200">PBKDF2-SHA256</span>.
                  </div>
                </div>

                {errorMsg && (
                  <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-300 text-xs font-bold flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span>{errorMsg}</span>
                  </div>
                )}

                <button
                  id="btn-submit-register"
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full min-h-[48px] py-3 px-4 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm sm:text-base flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 cursor-pointer transition-all active:scale-98"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>Создать профиль</span>
                </button>
              </form>
            )}

            {/* TAB 2: LOGIN */}
            {activeTab === 'login' && (
              <form onSubmit={handleLoginSubmit} className="flex flex-col gap-3.5">
                {registeredUsers.length > 0 && (
                  <div>
                    <span className="text-xs font-extrabold text-slate-200 block mb-1.5">
                      Выберите свой профиль на этом устройстве:
                    </span>
                    <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
                      {registeredUsers.map((u) => {
                        const isSelected =
                          loginNickname.toLowerCase() === u.nickname.toLowerCase();
                        return (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() => {
                              playClick(soundEnabled);
                              setLoginNickname(u.nickname);
                              setErrorMsg(null);
                            }}
                            className={`px-3 py-2 rounded-xl border flex items-center gap-2 shrink-0 transition-all cursor-pointer ${
                              isSelected
                                ? 'bg-emerald-500/20 border-emerald-400 text-white font-black shadow'
                                : 'bg-slate-950 border-slate-800 text-slate-300 hover:bg-slate-850 font-bold'
                            }`}
                          >
                            <span className="text-lg">{u.avatar}</span>
                            <span className="text-xs truncate max-w-[110px]">
                              {u.nickname}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div>
                  <label
                    htmlFor="input-login-nickname"
                    className="text-xs font-extrabold text-slate-200 block mb-1"
                  >
                    Ваш никнейм:
                  </label>
                  <input
                    id="input-login-nickname"
                    type="text"
                    required
                    maxLength={20}
                    value={loginNickname}
                    onChange={(e) => {
                      setLoginNickname(e.target.value);
                      setErrorMsg(null);
                    }}
                    placeholder="Введите ваш никнейм..."
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm font-bold text-white focus:outline-none focus:border-emerald-400"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label
                      htmlFor="input-login-secret"
                      className="text-xs font-extrabold text-slate-200"
                    >
                      PIN-код или пароль:
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        playClick(soundEnabled);
                        setRecNickname(loginNickname);
                        setActiveTab('recover');
                        setErrorMsg(null);
                      }}
                      className="text-[11px] font-mono font-bold text-amber-400 hover:text-amber-300 cursor-pointer"
                    >
                      Забыли PIN? Резервный ключ →
                    </button>
                  </div>

                  <div className="relative">
                    <input
                      id="input-login-secret"
                      type={showSecret ? 'text' : 'password'}
                      required
                      value={loginSecret}
                      onChange={(e) => {
                        setLoginSecret(e.target.value);
                        setErrorMsg(null);
                      }}
                      placeholder="Введите ваш PIN или пароль..."
                      className="w-full px-3.5 py-2.5 pr-10 rounded-xl bg-slate-950 border border-slate-700 text-sm font-mono font-bold text-white tracking-widest focus:outline-none focus:border-emerald-400"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecret(!showSecret)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
                      aria-label="Показать или скрыть код"
                    >
                      {showSecret ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                {errorMsg && (
                  <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-300 text-xs font-bold flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span>{errorMsg}</span>
                  </div>
                )}

                <button
                  id="btn-submit-login"
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full min-h-[48px] py-3 px-4 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm sm:text-base flex items-center justify-center gap-2 shadow-lg cursor-pointer transition-all active:scale-98"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Войти в профиль</span>
                </button>
              </form>
            )}

            {/* TAB 3: ACCOUNT RECOVERY BY BACKUP CODE */}
            {activeTab === 'recover' && (
              <form onSubmit={handleRecoverSubmit} className="flex flex-col gap-3">
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs font-bold text-amber-200 flex items-center justify-between">
                  <span>
                    Восстановление по ключу {ACCOUNT_CONFIG.recoveryCodePrefix}-XXXX-XXXX
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('login');
                      setErrorMsg(null);
                    }}
                    className="text-amber-400 underline ml-2 shrink-0 cursor-pointer"
                  >
                    Назад
                  </button>
                </div>

                <div>
                  <label className="text-xs font-extrabold text-slate-200 block mb-1">
                    Никнейм профиля:
                  </label>
                  <input
                    type="text"
                    required
                    value={recNickname}
                    onChange={(e) => setRecNickname(e.target.value)}
                    placeholder="Ваш никнейм"
                    className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-sm font-bold text-white focus:outline-none focus:border-emerald-400"
                  />
                </div>

                <div>
                  <label className="text-xs font-extrabold text-slate-200 block mb-1">
                    Резервный ключ ({ACCOUNT_CONFIG.recoveryCodePrefix}-XXXX-XXXX):
                  </label>
                  <input
                    type="text"
                    required
                    value={recCode}
                    onChange={(e) => setRecCode(e.target.value.toUpperCase())}
                    placeholder={`${ACCOUNT_CONFIG.recoveryCodePrefix}-XXXX-XXXX`}
                    className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-sm font-mono font-bold text-amber-300 uppercase focus:outline-none focus:border-emerald-400"
                  />
                </div>

                <div>
                  <label className="text-xs font-extrabold text-slate-200 block mb-1">
                    Новый 4-значный PIN-код:
                  </label>
                  <input
                    type="password"
                    required
                    maxLength={4}
                    inputMode="numeric"
                    value={recNewSecret}
                    onChange={(e) =>
                      setRecNewSecret(e.target.value.replace(/\D/g, '').slice(0, 4))
                    }
                    placeholder="• • • • (4 цифры)"
                    className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-sm font-mono font-bold text-white tracking-widest focus:outline-none focus:border-emerald-400"
                  />
                </div>

                {errorMsg && (
                  <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-300 text-xs font-bold flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span>{errorMsg}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full min-h-[46px] py-2.5 px-4 rounded-2xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-sm flex items-center justify-center gap-2 cursor-pointer"
                >
                  <KeyRound className="w-4 h-4" />
                  <span>Сбросить PIN и войти</span>
                </button>
              </form>
            )}
          </div>
        )}

        {/* Privacy Policy Footer Link */}
        <div className="pt-2 border-t border-slate-800/80 flex items-center justify-center">
          <a
            href={ACCOUNT_CONFIG.privacyPolicyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] font-mono font-bold text-slate-400 hover:text-emerald-400 flex items-center gap-1.5 transition-colors"
          >
            <FileText className="w-3.5 h-3.5 shrink-0" />
            <span>Политика конфиденциальности (152-ФЗ)</span>
          </a>
        </div>
      </div>
    </div>
  );
};
