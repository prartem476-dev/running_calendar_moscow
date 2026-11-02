# Portable Personal Account Kit (Privacy-First / 152-ФЗ / RuStore / Telegram Mini Apps)

Готовый к копированию (`drop-in`) пакет Личного кабинета для любого React + TypeScript + Tailwind CSS проекта. Полностью отвязан от игровой логики квиза.

---

## Состав пакета

```text
portable-personal-account/
├── accountConfig.ts                 # Единственный файл настройки под ваш бренд/приложение
├── types.ts                         # TypeScript-интерфейсы (AuthUser, PublicAuthUser, AuthSession и др.)
├── authService.ts                   # Ядро авторизации (PBKDF2-SHA256, DLP 152-ФЗ, сессии, брутфорс-защита)
├── storageScope.ts                  # Мультиаккаунтное хранилище (<key>_<userId> vs <key>_guest) и миграция гостя
├── referralService.ts               # Опциональная реферальная система и статус Амбассадора (💎)
├── telegramBridge.ts                # 1-Tap вход через Telegram Mini App
├── soundEffects.ts                  # Автономный синтезатор звуков (Web Audio API, 0 внешних файлов)
├── usePersonalAccount.ts            # React-хук подключения личного кабинета в 5 строк кода
├── index.ts                         # Единая точка экспорта (Barrel file)
├── components/
│   ├── AuthModal.tsx                # Модальное окно (Регистрация / Вход / Сброс / Профиль / Удаление)
│   ├── AuthGateCard.tsx             # Карточка-заглушка для закрытых от гостей разделов
│   └── ProfileHeaderButton.tsx      # Готовая кнопка для Header («Войти» или «Аватар + Никнейм»)
├── database/
│   └── schema.sql                   # SQL-миграция PostgreSQL / Supabase (users, user_sessions, user_referrals)
└── public/
    └── privacy.html                 # Готовая страница Политики конфиденциальности (152-ФЗ / RuStore)
```

---

## Быстрый старт (за 2 минуты)

### Шаг 1. Скопируйте папку в ваш проект
Скопируйте папку `portable-personal-account` в `src/modules/personal-account` вашего нового приложения, а файл `public/privacy.html` положите в папку `public/` корня проекта.

Убедитесь, что в проекте установлен пакет иконок:
```bash
npm install lucide-react
```

### Шаг 2. Настройте `accountConfig.ts`
Откройте `accountConfig.ts` и укажите префиксы вашего приложения:
```ts
export const ACCOUNT_CONFIG = {
  appPrefix: 'my_new_app',
  recoveryCodePrefix: 'MYAPP', // Генерирует ключи MYAPP-XXXX-XXXX
  referralCodePrefix: 'INV',   // Генерирует инвайты INV-XXXXX
  scopedStorageKeys: [
    'my_new_app_stats_v1',
    'my_new_app_progress_v1',
  ],
  // ...
};
```

### Шаг 3. Используйте `loadScopedItem` и `saveScopedItem` для данных приложения
Чтобы данные гостя автоматически переносились в профиль при регистрации, а разные аккаунты на одном устройстве имели изолированные данные:
```ts
import { loadScopedItem, saveScopedItem } from './modules/personal-account';

const STATS_KEY = 'my_new_app_stats_v1';

export function loadAppStats(userId?: string) {
  return loadScopedItem(STATS_KEY, { score: 0, itemsCompleted: 0 }, userId);
}

export function saveAppStats(stats: { score: 0; itemsCompleted: 0 }, userId?: string) {
  saveScopedItem(STATS_KEY, stats, userId);
}
```

### Шаг 4. Подключите хук и компоненты в `App.tsx`

```tsx
import React, { useState } from 'react';
import {
  usePersonalAccount,
  ProfileHeaderButton,
  AuthModal,
  AuthGateCard,
  loadScopedItem,
} from './modules/personal-account';

export default function App() {
  const [toast, setToast] = useState<string | null>(null);

  const {
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
  } = usePersonalAccount({
    onToast: (msg) => setToast(msg),
    onUserChanged: (user) => {
      // Перезагрузите стейты вашего приложения для нового user?.id
      console.log('Активный профиль изменен:', user?.nickname || 'Гость');
    },
  });

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4">
      {/* Шапка с кнопкой входа / профиля */}
      <header className="flex items-center justify-between max-w-2xl mx-auto py-3">
        <h1 className="text-lg font-black">Моё Приложение</h1>
        <ProfileHeaderButton
          currentUser={currentUser}
          onClick={() => openAuthModal(currentUser ? 'profile' : 'register')}
        />
      </header>

      {/* Пример закрытого раздела (доступен только авторизованным) */}
      <main className="max-w-2xl mx-auto mt-6">
        {!currentUser ? (
          <AuthGateCard
            feature="stats"
            onOpenAuthModal={(tab) => openAuthModal(tab)}
          />
        ) : (
          <div className="p-6 rounded-3xl bg-slate-900 border border-slate-800">
            <h2 className="text-xl font-black">
              Добро пожаловать, {currentUser.avatar} {currentUser.nickname}!
            </h2>
            <p className="text-sm text-slate-300 mt-1">
              Город: {currentUser.city} • ID: {currentUser.id}
            </p>
          </div>
        )}
      </main>

      {/* Модальное окно Личного кабинета */}
      {isAuthModalOpen && (
        <AuthModal
          currentUser={currentUser}
          initialTab={authModalTab}
          onSuccessAuth={handleSuccessAuth}
          onLogout={handleLogout}
          onDeleteAccount={handleDeleteAccount}
          onUpdateUser={handleUpdateUser}
          onClose={closeAuthModal}
        />
      )}
    </div>
  );
}
```
