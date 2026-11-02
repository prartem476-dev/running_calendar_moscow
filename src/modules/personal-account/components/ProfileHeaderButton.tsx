import React from 'react';
import { LogIn } from 'lucide-react';
import { PublicAuthUser } from '../types';
import { playClick } from '../soundEffects';

export interface ProfileHeaderButtonProps {
  currentUser: PublicAuthUser | null;
  soundEnabled?: boolean;
  onClick: () => void;
}

/**
 * Готовая кнопка для шапки приложения:
 * - Для гостя: контрастная кнопка «Войти»
 * - Для авторизованного пользователя: бейдж с эмодзи-аватаром и никнеймом
 */
export const ProfileHeaderButton: React.FC<ProfileHeaderButtonProps> = ({
  currentUser,
  soundEnabled = true,
  onClick,
}) => {
  return (
    <button
      id="btn-header-auth"
      type="button"
      onClick={() => {
        playClick(soundEnabled);
        onClick();
      }}
      title={
        currentUser
          ? `Профиль: ${currentUser.nickname}`
          : 'Войти или зарегистрироваться'
      }
      className={`h-9 sm:h-10 px-2.5 sm:px-3.5 rounded-xl border transition-all flex items-center justify-center gap-1.5 cursor-pointer shrink-0 ${
        currentUser
          ? 'border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 font-extrabold'
          : 'border-emerald-400 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black shadow-sm'
      }`}
    >
      {currentUser ? (
        <>
          <span className="text-sm leading-none shrink-0">{currentUser.avatar}</span>
          <span className="text-xs font-extrabold truncate max-w-[72px] sm:max-w-[110px] text-white">
            {currentUser.nickname}
          </span>
        </>
      ) : (
        <>
          <LogIn className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
          <span className="text-xs tracking-tight">Войти</span>
        </>
      )}
    </button>
  );
};
