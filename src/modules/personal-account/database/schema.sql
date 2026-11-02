-- ============================================================================
-- PORTABLE PERSONAL ACCOUNT: POSTGRESQL / SUPABASE SCHEMA (Zero-PII / 152-FZ)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. ТАБЛИЦА ПОЛЬЗОВАТЕЛЕЙ (Без телефона, почты и ФИО; хеширование PBKDF2-SHA256)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(128) PRIMARY KEY,
    nickname VARCHAR(32) NOT NULL UNIQUE,
    avatar VARCHAR(16) NOT NULL DEFAULT '🦉',
    city VARCHAR(64) NOT NULL DEFAULT 'Инкогнито',
    auth_method VARCHAR(16) NOT NULL CHECK (auth_method IN ('pin', 'password', 'telegram')),
    security_hash VARCHAR(256) NOT NULL,
    security_salt VARCHAR(128) NOT NULL,
    recovery_code_hash VARCHAR(256) NOT NULL,
    telegram_id BIGINT UNIQUE,
    rating_points INT NOT NULL DEFAULT 0,
    league_trophies INT NOT NULL DEFAULT 75,
    referral_code VARCHAR(16) UNIQUE,
    referred_by_code VARCHAR(16),
    invited_friends_count INT NOT NULL DEFAULT 0,
    is_ambassador BOOLEAN NOT NULL DEFAULT FALSE,
    ambassador_plate_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
    last_login_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_users_rating 
ON users(rating_points DESC, league_trophies DESC);

CREATE INDEX IF NOT EXISTS idx_users_referral_code
ON users(referral_code);

-- 2. ТАБЛИЦА ПОДПИСАННЫХ СЕССИЙ
CREATE TABLE IF NOT EXISTS user_sessions (
    token VARCHAR(128) PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    signature VARCHAR(256) NOT NULL,
    issued_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user 
ON user_sessions(user_id, expires_at DESC);

-- 3. ТАБЛИЦА РЕФЕРАЛЬНОЙ СИСТЕМЫ И АМБАССАДОРОВ
CREATE TABLE IF NOT EXISTS user_referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inviter_user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_user_id VARCHAR(128) NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    referral_code_used VARCHAR(16) NOT NULL,
    reward_coins INT NOT NULL DEFAULT 100,
    reward_rating INT NOT NULL DEFAULT 30,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_user_referrals_inviter
ON user_referrals(inviter_user_id, created_at DESC);
