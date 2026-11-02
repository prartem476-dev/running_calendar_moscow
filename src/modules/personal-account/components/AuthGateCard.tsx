import React from 'react';
import {
  Lock,
  ShieldCheck,
  Trophy,
  BarChart2,
  UserPlus,
  LogIn,
  Zap,
  KeyRound,
} from 'lucide-react';
import { playClick } from '../soundEffects';
import { authService } from '../authService';
import { AuthModalInitialTab } from '../types';

export interface AuthGateCardProps {
  feature?: 'leaderboard' | 'stats' | 'leagues';
  customTitle?: string;
  customSubtitle?: string;
  soundEnabled?: boolean;
  onOpenAuthModal: (initialTab: AuthModalInitialTab) => void;
}

export const AuthGateCard: React.FC<AuthGateCardProps> = ({
  feature = 'stats',
  customTitle,
  customSubtitle,
  soundEnabled = true,
  onOpenAuthModal,
}) => {
  const registeredCount = authService.getRegisteredPublicUsers().length;
  const isLeaderboard = feature === 'leaderboard' || feature === 'leagues';

  const title =
    customTitle ||
    (isLeaderboard
      ? 'Рейтинг доступен только авторизованным пользователям'
      : 'Статистика доступна только авторизованным пользователям');

  const subtitle =
    customSubtitle ||
    (isLeaderboard
      ? 'Зарегистрируйтесь за 5 секунд, чтобы участвовать в таблице лидеров и сохранять свои достижения!'
      : 'Войдите или создайте безопасный профиль, чтобы сохранять персональную статистику, историю и рекорды!');

  return (
    <div
      id={`auth-gate-${feature}`}
      className="w-full rounded-3xl bg-slate-900/95 border border-slate-800 p-5 sm:p-6 shadow-xl flex flex-col items-center text-center gap-4 animate-fadeIn select-none"
    >
      {/* Locked Feature Icon Badge */}
      <div className="relative">
        <div
          className={`w-16 h-16 rounded-3xl flex items-center justify-center border-2 shadow-lg ${
            isLeaderboard
              ? 'bg-amber-500/15 border-amber-400/50 text-amber-400'
              : 'bg-emerald-500/15 border-emerald-400/50 text-emerald-400'
          }`}
        >
          {isLeaderboard ? (
            <Trophy className="w-8 h-8" />
          ) : (
            <BarChart2 className="w-8 h-8" />
          )}
        </div>
        <div className="absolute -bottom-1.5 -right-1.5 w-7 h-7 rounded-xl bg-slate-950 border border-slate-700 flex items-center justify-center text-amber-400 shadow">
          <Lock className="w-3.5 h-3.5" />
        </div>
      </div>

      {/* Main Message */}
      <div className="flex flex-col items-center gap-1.5 max-w-md">
        <span className="text-[11px] font-mono font-extrabold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
          🔒 Требуется авторизация
        </span>
        <h3 className="text-lg sm:text-xl font-black text-white leading-snug mt-1">
          {title}
        </h3>
        <p className="text-xs sm:text-sm font-bold text-slate-300 leading-relaxed">
          {subtitle}
        </p>
      </div>

      {/* 3 Security & Simplicity Pillars */}
      <div className="w-full grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-left">
        <div className="p-3 rounded-2xl bg-slate-950/85 border border-slate-800/90 flex items-start gap-2.5">
          <Zap className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-xs font-extrabold text-white">За 5 секунд</div>
            <div className="text-[11px] font-bold text-slate-300 mt-0.5">
              Только никнейм и пароль или 4-значный PIN-код
            </div>
          </div>
        </div>

        <div className="p-3 rounded-2xl bg-slate-950/85 border border-slate-800/90 flex items-start gap-2.5">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-xs font-extrabold text-white">Без личных данных</div>
            <div className="text-[11px] font-bold text-slate-300 mt-0.5">
              Не просим телефон и почту — 0% спама и утечек
            </div>
          </div>
        </div>

        <div className="p-3 rounded-2xl bg-slate-950/85 border border-slate-800/90 flex items-start gap-2.5">
          <KeyRound className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-xs font-extrabold text-white">Криптозащита</div>
            <div className="text-[11px] font-bold text-slate-300 mt-0.5">
              Хеширование PBKDF2-SHA256 и резервный ключ
            </div>
          </div>
        </div>
      </div>

      {/* Primary & Secondary Action Buttons */}
      <div className="w-full flex flex-col sm:flex-row items-center gap-2.5 pt-1">
        <button
          id={`btn-gate-register-${feature}`}
          type="button"
          onClick={() => {
            playClick(soundEnabled);
            onOpenAuthModal('register');
          }}
          className="w-full sm:flex-1 min-h-[48px] py-3 px-5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm sm:text-base flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 cursor-pointer transition-all active:scale-98"
        >
          <UserPlus className="w-4 h-4 shrink-0" />
          <span>Быстрая регистрация</span>
        </button>

        <button
          id={`btn-gate-login-${feature}`}
          type="button"
          onClick={() => {
            playClick(soundEnabled);
            onOpenAuthModal('login');
          }}
          className="w-full sm:w-auto min-h-[48px] py-3 px-5 rounded-2xl bg-slate-800 hover:bg-slate-750 border border-slate-700 text-slate-100 font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 cursor-pointer transition-colors"
        >
          <LogIn className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>Войти {registeredCount > 0 ? `(${registeredCount})` : ''}</span>
        </button>
      </div>
    </div>
  );
};
