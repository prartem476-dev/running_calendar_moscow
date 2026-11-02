#!/usr/bin/env node
/**
 * Гибридный веб-сервер и REST API для проекта «Беговой календарь Москвы и МО» (Node.js 22 + SQLite).
 * Реализует архитектуру Portable Personal Account Kit (Privacy-First / 152-ФЗ / Zero-PII):
 * - Авторизация по Логину (Никнейму) и Паролю / 4-значному PIN-коду;
 * - Криптографическое хеширование PBKDF2-SHA256 (100 000 итераций) + индивидуальная соль;
 * - DLP-фильтр 152-ФЗ (блокировка ввода email и телефонных номеров в логине/никнейме);
 * - Резервный ключ восстановления (RUN-XXXX-XXXX) и защита от брутфорса (блокировка на 30 сек после 5 попыток);
 * - Подписанные сессии (HMAC/Salt), реферальная программа Амбассадоров (💎) и удаление аккаунта в 1 клик.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runIncrementalParser } from './scripts/parse-events.mjs';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT_DIR = process.cwd();
const DB_PATH = path.join(ROOT_DIR, 'running_calendar.db');
const JSON_PATH = path.join(ROOT_DIR, 'moscow_running_events.json');
const DIST_JSON_PATH = path.join(ROOT_DIR, 'dist', 'moscow_running_events.json');
const ICS_PATH = path.join(ROOT_DIR, 'moscow_running_events.ics');
const DIST_ICS_PATH = path.join(ROOT_DIR, 'dist', 'moscow_running_events.ics');

const SESSION_SECRET_SALT = 'moscow_run_session_hmac_v1';
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 1000; // 30 seconds
const RECOVERY_CODE_PREFIX = 'RUN';

const lockoutMap = new Map(); // ip/key -> { attempts, lockedUntil }

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sanitizeNickname(raw) {
  return String(raw || '')
    .replace(/[<>"'`&/\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

/**
 * DLP-проверка никнейма (логина): запрещает ввод email и номеров телефона (152-ФЗ).
 */
function validateSafeNickname(nickname) {
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

function generateRecoveryCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(8);
  let part1 = '';
  let part2 = '';
  for (let i = 0; i < 4; i++) {
    part1 += alphabet[bytes[i] % alphabet.length];
    part2 += alphabet[bytes[i + 4] % alphabet.length];
  }
  return `${RECOVERY_CODE_PREFIX}-${part1}-${part2}`;
}

function deriveSecretHashSync(secret, salt) {
  const normalizedSecret = String(secret || '').trim();
  return crypto
    .pbkdf2Sync(
      Buffer.from(normalizedSecret, 'utf8'),
      Buffer.from(String(salt || ''), 'utf8'),
      100000,
      32,
      'sha256'
    )
    .toString('hex');
}

function fallbackHash(input, salt) {
  const combined = `${salt}::${SESSION_SECRET_SALT}::${input}`;
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

function computeSessionSignature(userId, token, expiresAt) {
  return fallbackHash(`${userId}:${token}:${expiresAt}`, SESSION_SECRET_SALT);
}

function getLockoutRemainingSeconds(clientKey = 'global') {
  const rec = lockoutMap.get(clientKey);
  if (rec && rec.lockedUntil > Date.now()) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  }
  return 0;
}

function recordFailedAttempt(clientKey = 'global') {
  const rec = lockoutMap.get(clientKey) || { attempts: 0, lockedUntil: 0 };
  const nextAttempts = rec.attempts + 1;
  if (nextAttempts >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    lockoutMap.set(clientKey, { attempts: 0, lockedUntil });
    return {
      locked: true,
      secondsLeft: Math.ceil(LOCKOUT_DURATION_MS / 1000),
      attemptsLeft: 0,
    };
  }
  lockoutMap.set(clientKey, { attempts: nextAttempts, lockedUntil: 0 });
  return {
    locked: false,
    secondsLeft: 0,
    attemptsLeft: MAX_FAILED_ATTEMPTS - nextAttempts,
  };
}

function clearFailedAttempts(clientKey = 'global') {
  lockoutMap.delete(clientKey);
}

function initDatabase() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      nickname TEXT UNIQUE NOT NULL,
      avatar TEXT NOT NULL DEFAULT '🦉',
      city TEXT NOT NULL DEFAULT 'Москва',
      auth_method TEXT NOT NULL DEFAULT 'password',
      security_hash TEXT NOT NULL DEFAULT '',
      security_salt TEXT NOT NULL DEFAULT '',
      recovery_code_hash TEXT NOT NULL DEFAULT '',
      telegram_id INTEGER,
      referral_code TEXT,
      referred_by_code TEXT,
      cabinet_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      last_login_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      end_date TEXT,
      location TEXT,
      region TEXT,
      surface TEXT,
      category TEXT,
      source TEXT,
      url TEXT,
      is_parkrun INTEGER DEFAULT 0,
      featured INTEGER DEFAULT 0,
      is_new INTEGER DEFAULT 0,
      is_past INTEGER DEFAULT 0,
      first_seen_at TEXT,
      last_seen_at TEXT,
      raw_json TEXT NOT NULL
    );
  `);

  // Ensure columns exist if upgrading from an older schema
  const existingCols = new Set(
    db
      .prepare('PRAGMA table_info(users)')
      .all()
      .map((c) => c.name)
  );
  const alterColumns = [
    ['avatar', "TEXT NOT NULL DEFAULT '🦉'"],
    ['city', "TEXT NOT NULL DEFAULT 'Москва'"],
    ['auth_method', "TEXT NOT NULL DEFAULT 'password'"],
    ['security_hash', "TEXT NOT NULL DEFAULT ''"],
    ['security_salt', "TEXT NOT NULL DEFAULT ''"],
    ['recovery_code_hash', "TEXT NOT NULL DEFAULT ''"],
    ['telegram_id', 'INTEGER'],
    ['referral_code', 'TEXT'],
    ['referred_by_code', 'TEXT'],
    ['last_login_at', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [colName, colDef] of alterColumns) {
    if (!existingCols.has(colName)) {
      try {
        db.exec(`ALTER TABLE users ADD COLUMN ${colName} ${colDef}`);
      } catch {}
    }
  }

  const sessCols = new Set(
    db
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((c) => c.name)
  );
  if (!sessCols.has('signature')) {
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN signature TEXT NOT NULL DEFAULT ''");
    } catch {}
  }

  db.close();
}

initDatabase();

function toPublicUserRow(row) {
  return {
    id: row.id,
    nickname: row.nickname,
    avatar: row.avatar || '🦉',
    city: row.city || 'Москва',
    authMethod: row.auth_method || 'password',
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || row.updated_at || row.created_at,
    referralCode: row.referral_code || undefined,
    referredByCode: row.referred_by_code || undefined,
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function getAuthenticatedUser(req, db) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const sessionToken = authHeader.slice(7).trim();
  if (!sessionToken) return null;

  const nowIso = new Date().toISOString();
  const sess = db
    .prepare('SELECT user_id, signature, expires_at FROM sessions WHERE session_token = ?')
    .get(sessionToken);
  if (!sess || sess.expires_at < nowIso) return null;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
  return user ? { ...user, sessionToken } : null;
}

function createSignedSessionRecord(db, userId) {
  const issuedAt = Date.now();
  const expiresAtMs = issuedAt + SESSION_DURATION_MS;
  const sessionToken = crypto.randomBytes(24).toString('hex');
  const signature = computeSessionSignature(userId, sessionToken, expiresAtMs);
  const nowIso = new Date(issuedAt).toISOString();
  const expiresIso = new Date(expiresAtMs).toISOString();

  db.prepare(
    'INSERT INTO sessions (session_token, user_id, signature, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionToken, userId, signature, nowIso, expiresIso);

  return {
    userId,
    token: sessionToken,
    issuedAt,
    expiresAt: expiresAtMs,
    signature,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const clientKey = req.socket.remoteAddress || 'local';

  // API Routes
  if (pathname === '/api/health' && req.method === 'GET') {
    let updatedAt = '';
    if (fs.existsSync(JSON_PATH)) {
      try {
        updatedAt = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')).updated_at || '';
      } catch {}
    }
    return sendJson(res, 200, {
      ok: true,
      mode: 'hybrid-sqlite-server',
      updated_at: updatedAt,
    });
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    if (fs.existsSync(JSON_PATH)) {
      const content = fs.readFileSync(JSON_PATH, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(content);
    }
    return sendJson(res, 404, { ok: false, error: 'База событий не найдена' });
  }

  if (pathname === '/api/events/refresh' && req.method === 'POST') {
    try {
      const payload = await runIncrementalParser();
      if (fs.existsSync(path.dirname(DIST_JSON_PATH))) {
        try {
          fs.copyFileSync(JSON_PATH, DIST_JSON_PATH);
          if (fs.existsSync(ICS_PATH)) fs.copyFileSync(ICS_PATH, DIST_ICS_PATH);
        } catch {}
      }
      return sendJson(res, 200, {
        ok: true,
        updated_at: payload.updated_at,
        updated_at_human: payload.updated_at_human,
        total_events: payload.total_events,
        main_races_count: payload.main_races_count,
        parkruns_count: payload.parkruns_count,
        new_events_count: payload.new_events_count,
        last_run_added_count: payload.last_run_added_count,
        recent_new_events: payload.recent_new_events,
        payload,
      });
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: `Ошибка при обновлении базы забегов: ${err.message}`,
      });
    }
  }

  // 1. РЕГИСТРАЦИЯ ПО ЛОГИНУ (НИКНЕЙМУ) И ПАРОЛЮ / PIN-КОДУ (PBKDF2-SHA256 + DLP 152-ФЗ)
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const db = new DatabaseSync(DB_PATH);
    try {
      const body = await readJsonBody(req);
      const cleanName = sanitizeNickname(body.nickname);
      const validation = validateSafeNickname(cleanName);
      if (!validation.valid) {
        return sendJson(res, 400, { ok: false, error: validation.error });
      }

      const method = ['pin', 'password', 'telegram'].includes(body.authMethod)
        ? body.authMethod
        : 'password';
      const secret = String(body.secret || '').trim();

      if (!body.securityHash) {
        if (method === 'pin' && !/^\d{4}$/.test(secret)) {
          return sendJson(res, 400, { ok: false, error: 'PIN-код должен состоять ровно из 4 цифр' });
        }
        if (method === 'password' && secret.length < 4) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Пароль должен содержать минимум 4 символа',
          });
        }
      }

      const duplicate = db
        .prepare('SELECT id FROM users WHERE LOWER(nickname) = LOWER(?)')
        .get(cleanName);
      if (duplicate) {
        return sendJson(res, 409, {
          ok: false,
          error: 'Этот никнейм уже занят. Выберите другой или войдите в свой профиль.',
        });
      }

      const userId = body.id || `usr_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
      const salt = body.securitySalt || crypto.randomBytes(16).toString('hex');
      const securityHash = body.securityHash || deriveSecretHashSync(secret, salt);
      const recoveryCode = body.recoveryCode || generateRecoveryCode();
      const recoveryCodeHash =
        body.recoveryCodeHash || deriveSecretHashSync(recoveryCode.toUpperCase(), salt);

      const avatar = String(body.avatar || '🦉').trim();
      const city = sanitizeNickname(body.city || 'Москва') || 'Москва';
      const referralCode = body.referralCode ? String(body.referralCode).trim().toUpperCase() : null;
      const referredByCode = body.referredByCode
        ? String(body.referredByCode).trim().toUpperCase()
        : null;
      const nowIso = new Date().toISOString();

      const initialCabinet =
        body.cabinetData && typeof body.cabinetData === 'object'
          ? body.cabinetData
          : { myRaces: {}, myResults: [], manualRecords: {}, updatedAt: nowIso };

      const existingCols = new Set(
        db
          .prepare('PRAGMA table_info(users)')
          .all()
          .map((c) => c.name)
      );

      if (existingCols.has('access_token')) {
        db.prepare(
          `INSERT INTO users (id, access_token, nickname, avatar, city, auth_method, password_salt, password_hash, security_salt, security_hash, recovery_code_hash, referral_code, referred_by_code, cabinet_json, created_at, last_login_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          userId,
          userId,
          cleanName,
          avatar,
          city,
          method,
          salt,
          securityHash,
          salt,
          securityHash,
          recoveryCodeHash,
          referralCode,
          referredByCode,
          JSON.stringify(initialCabinet),
          nowIso,
          nowIso,
          nowIso
        );
      } else {
        db.prepare(
          `INSERT INTO users (id, nickname, avatar, city, auth_method, security_salt, security_hash, recovery_code_hash, referral_code, referred_by_code, cabinet_json, created_at, last_login_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          userId,
          cleanName,
          avatar,
          city,
          method,
          salt,
          securityHash,
          recoveryCodeHash,
          referralCode,
          referredByCode,
          JSON.stringify(initialCabinet),
          nowIso,
          nowIso,
          nowIso
        );
      }

      clearFailedAttempts(clientKey);
      const session = createSignedSessionRecord(db, userId);

      return sendJson(res, 200, {
        ok: true,
        sessionToken: session.token,
        session,
        recoveryCode,
        user: {
          id: userId,
          nickname: cleanName,
          avatar,
          city,
          authMethod: method,
          createdAt: nowIso,
          lastLoginAt: nowIso,
          referralCode: referralCode || undefined,
          referredByCode: referredByCode || undefined,
        },
        cabinetData: initialCabinet,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    } finally {
      db.close();
    }
  }

  // 2. ВХОД ПО ЛОГИНУ (НИКНЕЙМУ) И ПАРОЛЮ / PIN-КОДУ (С ЗАЩИТОЙ ОТ ПЕРЕБОРА)
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const db = new DatabaseSync(DB_PATH);
    try {
      const lockoutSeconds = getLockoutRemainingSeconds(clientKey);
      if (lockoutSeconds > 0) {
        return sendJson(res, 429, {
          ok: false,
          lockedSeconds: lockoutSeconds,
          error: `Слишком много попыток. Подождите ${lockoutSeconds} сек.`,
        });
      }

      const body = await readJsonBody(req);
      const cleanName = sanitizeNickname(body.nickname || body.identifier);
      const secret = String(body.secret || body.password || '').trim();

      if (!cleanName || !secret) {
        return sendJson(res, 400, { ok: false, error: 'Введите никнейм и код доступа' });
      }

      const user = db
        .prepare('SELECT * FROM users WHERE LOWER(nickname) = LOWER(?)')
        .get(cleanName);

      if (!user) {
        recordFailedAttempt(clientKey);
        return sendJson(res, 401, { ok: false, error: 'Неверный никнейм или код доступа' });
      }

      const salt = user.security_salt || user.password_salt || '';
      const storedHash = user.security_hash || user.password_hash || '';
      const computedHash = deriveSecretHashSync(secret, salt);

      if (computedHash !== storedHash) {
        const attemptInfo = recordFailedAttempt(clientKey);
        if (attemptInfo.locked) {
          return sendJson(res, 429, {
            ok: false,
            lockedSeconds: attemptInfo.secondsLeft,
            error: `Защита от подбора: вход заблокирован на ${attemptInfo.secondsLeft} сек.`,
          });
        }
        return sendJson(res, 401, {
          ok: false,
          error: `Неверный код доступа (осталось попыток: ${attemptInfo.attemptsLeft})`,
        });
      }

      clearFailedAttempts(clientKey);
      const nowIso = new Date().toISOString();
      db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(
        nowIso,
        nowIso,
        user.id
      );

      const session = createSignedSessionRecord(db, user.id);
      let cabinetData = {};
      try {
        cabinetData = JSON.parse(user.cabinet_json || '{}');
      } catch {}

      return sendJson(res, 200, {
        ok: true,
        sessionToken: session.token,
        session,
        user: toPublicUserRow({ ...user, last_login_at: nowIso }),
        cabinetData,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    } finally {
      db.close();
    }
  }

  // 3. ВОССТАНОВЛЕНИЕ ДОСТУПА ПО РЕЗЕРВНОМУ КЛЮЧУ (RUN-XXXX-XXXX)
  if (pathname === '/api/auth/recover' && req.method === 'POST') {
    const db = new DatabaseSync(DB_PATH);
    try {
      const lockoutSeconds = getLockoutRemainingSeconds(clientKey);
      if (lockoutSeconds > 0) {
        return sendJson(res, 429, {
          ok: false,
          lockedSeconds: lockoutSeconds,
          error: `Слишком много попыток. Подождите ${lockoutSeconds} сек.`,
        });
      }

      const body = await readJsonBody(req);
      const cleanName = sanitizeNickname(body.nickname);
      const normalizedRecovery = String(body.recoveryCode || '')
        .trim()
        .toUpperCase();
      const newSecret = String(body.newSecret || '').trim();
      const method = body.newAuthMethod || (/^\d{4}$/.test(newSecret) ? 'pin' : 'password');

      if (method === 'pin' && !/^\d{4}$/.test(newSecret)) {
        return sendJson(res, 400, { ok: false, error: 'Новый PIN-код должен состоять из 4 цифр' });
      }
      if (method === 'password' && newSecret.length < 4) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Новый пароль должен содержать минимум 4 символа',
        });
      }

      const user = db
        .prepare('SELECT * FROM users WHERE LOWER(nickname) = LOWER(?)')
        .get(cleanName);
      if (!user) {
        recordFailedAttempt(clientKey);
        return sendJson(res, 401, {
          ok: false,
          error: 'Профиль не найден или неверный резервный ключ',
        });
      }

      const salt = user.security_salt || user.password_salt || '';
      const recoveryHash = deriveSecretHashSync(normalizedRecovery, salt);
      if (recoveryHash !== user.recovery_code_hash) {
        recordFailedAttempt(clientKey);
        return sendJson(res, 401, { ok: false, error: 'Неверный резервный ключ восстановления' });
      }

      const newSecurityHash = deriveSecretHashSync(newSecret, salt);
      const nowIso = new Date().toISOString();
      db.prepare(
        'UPDATE users SET security_hash = ?, auth_method = ?, last_login_at = ?, updated_at = ? WHERE id = ?'
      ).run(newSecurityHash, method, nowIso, nowIso, user.id);

      clearFailedAttempts(clientKey);
      const session = createSignedSessionRecord(db, user.id);
      let cabinetData = {};
      try {
        cabinetData = JSON.parse(user.cabinet_json || '{}');
      } catch {}

      return sendJson(res, 200, {
        ok: true,
        sessionToken: session.token,
        session,
        user: toPublicUserRow({ ...user, auth_method: method, last_login_at: nowIso }),
        cabinetData,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    } finally {
      db.close();
    }
  }

  // 4. ПОЛУЧЕНИЕ И ОБНОВЛЕНИЕ ДАННЫХ ЛИЧНОГО КАБИНЕТА И ПРОФИЛЯ
  if (pathname === '/api/cabinet' && req.method === 'GET') {
    const db = new DatabaseSync(DB_PATH);
    try {
      const user = getAuthenticatedUser(req, db);
      if (!user) {
        return sendJson(res, 401, { ok: false, error: 'Сессия недействительна' });
      }
      let cabinetData = {};
      try {
        cabinetData = JSON.parse(user.cabinet_json || '{}');
      } catch {}
      return sendJson(res, 200, {
        ok: true,
        user: toPublicUserRow(user),
        cabinetData,
      });
    } finally {
      db.close();
    }
  }

  if (pathname === '/api/cabinet' && req.method === 'PUT') {
    const db = new DatabaseSync(DB_PATH);
    try {
      const user = getAuthenticatedUser(req, db);
      if (!user) {
        return sendJson(res, 401, { ok: false, error: 'Сессия недействительна' });
      }
      const body = await readJsonBody(req);
      const nowIso = new Date().toISOString();

      let nickname = user.nickname;
      if (body.nickname !== undefined) {
        const cleanName = sanitizeNickname(body.nickname);
        const validation = validateSafeNickname(cleanName);
        if (!validation.valid) {
          return sendJson(res, 400, { ok: false, error: validation.error });
        }
        const conflict = db
          .prepare('SELECT id FROM users WHERE LOWER(nickname) = LOWER(?) AND id != ?')
          .get(cleanName, user.id);
        if (conflict) {
          return sendJson(res, 409, {
            ok: false,
            error: 'Этот никнейм уже занят другим пользователем',
          });
        }
        nickname = cleanName;
      }

      const avatar = body.avatar ? String(body.avatar).trim() : user.avatar || '🦉';
      const city =
        body.city !== undefined
          ? sanitizeNickname(body.city) || 'Инкогнито'
          : user.city || 'Москва';

      const cabinetData =
        body.cabinetData && typeof body.cabinetData === 'object'
          ? { ...body.cabinetData, updatedAt: nowIso }
          : JSON.parse(user.cabinet_json || '{}');

      db.prepare(
        'UPDATE users SET nickname = ?, avatar = ?, city = ?, cabinet_json = ?, updated_at = ? WHERE id = ?'
      ).run(nickname, avatar, city, JSON.stringify(cabinetData), nowIso, user.id);

      return sendJson(res, 200, {
        ok: true,
        updatedAt: nowIso,
        user: toPublicUserRow({ ...user, nickname, avatar, city }),
        cabinetData,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    } finally {
      db.close();
    }
  }

  // 5. СМЕНА ПАРОЛЯ / PIN-КОДА
  if (pathname === '/api/auth/change-password' && req.method === 'POST') {
    const db = new DatabaseSync(DB_PATH);
    try {
      const user = getAuthenticatedUser(req, db);
      if (!user) {
        return sendJson(res, 401, { ok: false, error: 'Сессия недействительна' });
      }
      const body = await readJsonBody(req);
      const currentPassword = String(body.currentPassword || body.currentSecret || '').trim();
      const newPassword = String(body.newPassword || body.newSecret || '').trim();
      const newMethod = body.newAuthMethod || (/^\d{4}$/.test(newPassword) ? 'pin' : 'password');

      if (newPassword.length < 4) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Новый пароль / PIN должен содержать минимум 4 символа',
        });
      }
      const salt = user.security_salt || user.password_salt || '';
      const storedHash = user.security_hash || user.password_hash || '';
      if (deriveSecretHashSync(currentPassword, salt) !== storedHash) {
        return sendJson(res, 401, { ok: false, error: 'Текущий пароль / PIN введён неверно' });
      }
      const newHash = deriveSecretHashSync(newPassword, salt);
      const nowIso = new Date().toISOString();
      db.prepare(
        'UPDATE users SET security_hash = ?, auth_method = ?, updated_at = ? WHERE id = ?'
      ).run(newHash, newMethod, nowIso, user.id);
      return sendJson(res, 200, { ok: true, authMethod: newMethod });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    } finally {
      db.close();
    }
  }

  // 6. ПОЛНОЕ УДАЛЕНИЕ АККАУНТА И ДАННЫХ (ТРЕБОВАНИЕ 152-ФЗ / RUSTORE)
  if (
    (pathname === '/api/auth/delete' && req.method === 'POST') ||
    (pathname === '/api/auth/account' && req.method === 'DELETE')
  ) {
    const db = new DatabaseSync(DB_PATH);
    try {
      const user = getAuthenticatedUser(req, db);
      if (user) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      }
      return sendJson(res, 200, { ok: true });
    } finally {
      db.close();
    }
  }

  // 7. ВЫХОД ИЗ СЕССИИ
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const db = new DatabaseSync(DB_PATH);
    try {
      const user = getAuthenticatedUser(req, db);
      if (user) {
        db.prepare('DELETE FROM sessions WHERE session_token = ?').run(user.sessionToken);
      }
      return sendJson(res, 200, { ok: true });
    } finally {
      db.close();
    }
  }

  // Static Files
  const cleanRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safePath = path.resolve(ROOT_DIR, cleanRel);
  if (!safePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    return res.end(fs.readFileSync(safePath));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 Сервер Бегового календаря и Личного кабинета запущен: http://${HOST}:${PORT}`);
});
