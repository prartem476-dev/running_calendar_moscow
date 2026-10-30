#!/usr/bin/env node
/**
 * Гибридный веб-сервер и REST API для проекта «Беговой календарь Москвы и МО» (Node.js 22 + SQLite).
 * Обеспечивает:
 * - Раздачу веб-интерфейса (index.html, moscow_running_events.json, moscow_running_events.ics);
 * - Авторизацию без персональных данных (152-ФЗ) по анонимному Токену (RUN-XXXX-XXXX-XXXX) или Email + Пароль;
 * - Хранение и синхронизацию Личного кабинета бегуна в SQLite (running_calendar.db);
 * - Живой запуск инкрементального парсера новых стартов по API (/api/events/refresh).
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

function initDatabase() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      access_token TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      nickname TEXT DEFAULT '',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      cabinet_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
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
  db.close();
}

initDatabase();

function generateAccessToken() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const group = () =>
    Array.from({ length: 4 }, () => chars[crypto.randomInt(0, chars.length)]).join('');
  return `RUN-${group()}-${group()}-${group()}`;
}

function normalizeTokenInput(raw) {
  const clean = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (clean.startsWith('RUN') && clean.length === 15) {
    const body = clean.slice(3);
    return `RUN-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
  }
  return String(raw || '').trim().toUpperCase();
}

function hashPassword(password, saltHex) {
  return crypto.pbkdf2Sync(String(password), saltHex, 100000, 32, 'sha256').toString('hex');
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
    .prepare('SELECT user_id, expires_at FROM sessions WHERE session_token = ?')
    .get(sessionToken);
  if (!sess || sess.expires_at < nowIso) return null;

  const user = db
    .prepare(
      'SELECT id, access_token, email, nickname, password_salt, password_hash, cabinet_json, created_at, updated_at FROM users WHERE id = ?'
    )
    .get(sess.user_id);
  return user ? { ...user, sessionToken } : null;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

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

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const db = new DatabaseSync(DB_PATH);
    try {
      const body = await readJsonBody(req);
      const password = String(body.password || '');
      if (password.length < 4) {
        return sendJson(res, 400, { ok: false, error: 'Пароль должен содержать минимум 4 символа' });
      }

      let accessToken = body.accessToken ? normalizeTokenInput(body.accessToken) : generateAccessToken();
      if (!/^RUN-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(accessToken)) {
        accessToken = generateAccessToken();
      }

      const rawEmail = String(body.email || '').trim().toLowerCase();
      const email = rawEmail ? rawEmail : null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendJson(res, 400, { ok: false, error: 'Некорректный формат электронной почты' });
      }

      const nickname = String(body.nickname || '').trim().slice(0, 40);

      // Проверка уникальности токена и почты
      const existingToken = db.prepare('SELECT id FROM users WHERE access_token = ?').get(accessToken);
      if (existingToken) {
        accessToken = generateAccessToken();
      }
      if (email) {
        const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (existingEmail) {
          return sendJson(res, 409, {
            ok: false,
            error: 'Указанный Email уже привязан к другому токену. Войдите по нему на вкладке «Вход».',
          });
        }
      }

      const userId = crypto.randomBytes(12).toString('hex');
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = hashPassword(password, salt);
      const nowIso = new Date().toISOString();

      const initialCabinet =
        body.cabinetData && typeof body.cabinetData === 'object'
          ? body.cabinetData
          : { myRaces: {}, myResults: [], manualRecords: {}, updatedAt: nowIso };

      db.prepare(
        `INSERT INTO users (id, access_token, email, nickname, password_salt, password_hash, cabinet_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        userId,
        accessToken,
        email,
        nickname,
        salt,
        passwordHash,
        JSON.stringify(initialCabinet),
        nowIso,
        nowIso
      );

      const sessionToken = crypto.randomBytes(24).toString('hex');
      const expiresAt = new Date(Date.now() + 90 * 86400 * 1000).toISOString();
      db.prepare('INSERT INTO sessions (session_token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
        sessionToken,
        userId,
        nowIso,
        expiresAt
      );

      return sendJson(res, 200, {
        ok: true,
        sessionToken,
        user: {
          id: userId,
          accessToken,
          email: email || '',
          nickname,
          createdAt: nowIso,
        },
        cabinetData: initialCabinet,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    } finally {
      db.close();
    }
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const db = new DatabaseSync(DB_PATH);
    try {
      const body = await readJsonBody(req);
      const rawIdentifier = String(body.identifier || '').trim();
      const password = String(body.password || '');

      if (!rawIdentifier || !password) {
        return sendJson(res, 400, { ok: false, error: 'Введите ваш Токен (или Email) и пароль' });
      }

      let user = null;
      if (rawIdentifier.includes('@')) {
        user = db
          .prepare('SELECT * FROM users WHERE email = ?')
          .get(rawIdentifier.toLowerCase());
      } else {
        const normToken = normalizeTokenInput(rawIdentifier);
        user = db
          .prepare('SELECT * FROM users WHERE access_token = ?')
          .get(normToken);
      }

      if (!user) {
        return sendJson(res, 401, {
          ok: false,
          error: 'Профиль с таким Токеном или Email не найден на сервере',
        });
      }

      const computedHash = hashPassword(password, user.password_salt);
      if (computedHash !== user.password_hash) {
        return sendJson(res, 401, { ok: false, error: 'Неверный пароль' });
      }

      const nowIso = new Date().toISOString();
      const sessionToken = crypto.randomBytes(24).toString('hex');
      const expiresAt = new Date(Date.now() + 90 * 86400 * 1000).toISOString();
      db.prepare('INSERT INTO sessions (session_token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
        sessionToken,
        user.id,
        nowIso,
        expiresAt
      );

      let cabinetData = {};
      try {
        cabinetData = JSON.parse(user.cabinet_json || '{}');
      } catch {}

      return sendJson(res, 200, {
        ok: true,
        sessionToken,
        user: {
          id: user.id,
          accessToken: user.access_token,
          email: user.email || '',
          nickname: user.nickname || '',
          createdAt: user.created_at,
        },
        cabinetData,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    } finally {
      db.close();
    }
  }

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
        user: {
          id: user.id,
          accessToken: user.access_token,
          email: user.email || '',
          nickname: user.nickname || '',
          createdAt: user.created_at,
        },
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

      const nickname =
        body.nickname !== undefined ? String(body.nickname || '').trim().slice(0, 40) : user.nickname;

      let email = user.email;
      if (body.email !== undefined) {
        const cleanEmail = String(body.email || '').trim().toLowerCase();
        if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
          return sendJson(res, 400, { ok: false, error: 'Некорректный формат Email' });
        }
        if (cleanEmail && cleanEmail !== user.email) {
          const dup = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(cleanEmail, user.id);
          if (dup) {
            return sendJson(res, 409, { ok: false, error: 'Этот Email уже занят другим профилем' });
          }
        }
        email = cleanEmail || null;
      }

      const cabinetData =
        body.cabinetData && typeof body.cabinetData === 'object'
          ? { ...body.cabinetData, updatedAt: nowIso }
          : JSON.parse(user.cabinet_json || '{}');

      db.prepare(
        'UPDATE users SET nickname = ?, email = ?, cabinet_json = ?, updated_at = ? WHERE id = ?'
      ).run(nickname, email, JSON.stringify(cabinetData), nowIso, user.id);

      return sendJson(res, 200, {
        ok: true,
        updatedAt: nowIso,
        user: {
          id: user.id,
          accessToken: user.access_token,
          email: email || '',
          nickname,
          createdAt: user.created_at,
        },
        cabinetData,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    } finally {
      db.close();
    }
  }

  if (pathname === '/api/auth/change-password' && req.method === 'POST') {
    const db = new DatabaseSync(DB_PATH);
    try {
      const user = getAuthenticatedUser(req, db);
      if (!user) {
        return sendJson(res, 401, { ok: false, error: 'Сессия недействительна' });
      }
      const body = await readJsonBody(req);
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < 4) {
        return sendJson(res, 400, { ok: false, error: 'Новый пароль должен содержать минимум 4 символа' });
      }
      if (hashPassword(currentPassword, user.password_salt) !== user.password_hash) {
        return sendJson(res, 401, { ok: false, error: 'Текущий пароль введён неверно' });
      }
      const newSalt = crypto.randomBytes(16).toString('hex');
      const newHash = hashPassword(newPassword, newSalt);
      const nowIso = new Date().toISOString();
      db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?').run(
        newSalt,
        newHash,
        nowIso,
        user.id
      );
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    } finally {
      db.close();
    }
  }

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
