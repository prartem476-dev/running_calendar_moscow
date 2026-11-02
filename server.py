#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Гибридный веб-сервер и REST API для проекта «Беговой календарь Москвы и МО» (Python 3 + SQLite).
Реализует архитектуру Portable Personal Account Kit (Privacy-First / 152-ФЗ / Zero-PII)
и полностью совместим по базе running_calendar.db и маршрутам /api/* с server.mjs.
"""

import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import moscow_running_parser as parser_mod

ROOT_DIR = Path(__file__).resolve().parent
DB_PATH = ROOT_DIR / "running_calendar.db"
JSON_PATH = ROOT_DIR / "moscow_running_events.json"

SESSION_SECRET_SALT = "moscow_run_session_hmac_v1"
SESSION_DURATION_DAYS = 30
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_DURATION_SECONDS = 30
RECOVERY_CODE_PREFIX = "RUN"

LOCKOUT_MAP: dict[str, dict[str, float]] = {}


def sanitize_nickname(raw: str) -> str:
    clean = re.sub(r'[<>"\'`&/\\]', "", str(raw or ""))
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean[:20]


def validate_safe_nickname(nickname: str) -> tuple[bool, str | None]:
    clean = sanitize_nickname(nickname)
    if len(clean) < 2:
        return False, "Никнейм должен содержать минимум 2 символа"
    if "@" in clean or re.search(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", clean):
        return False, "В целях безопасности не используйте email в качестве никнейма"
    digits_only = re.sub(r"\D", "", clean)
    if len(digits_only) >= 7:
        return False, "В целях безопасности не указывайте номер телефона в никнейме"
    return True, None


def generate_recovery_code() -> str:
    alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    part1 = "".join(secrets.choice(alphabet) for _ in range(4))
    part2 = "".join(secrets.choice(alphabet) for _ in range(4))
    return f"{RECOVERY_CODE_PREFIX}-{part1}-{part2}"


def derive_secret_hash(secret: str, salt: str) -> str:
    dk = hashlib.pbkdf2_hmac(
        "sha256",
        str(secret or "").strip().encode("utf-8"),
        str(salt or "").encode("utf-8"),
        100000,
        dklen=32,
    )
    return dk.hex()


def get_lockout_remaining(client_key: str = "global") -> int:
    rec = LOCKOUT_MAP.get(client_key)
    if rec and rec["locked_until"] > time.time():
        return int(rec["locked_until"] - time.time()) + 1
    return 0


def record_failed_attempt(client_key: str = "global") -> tuple[bool, int, int]:
    rec = LOCKOUT_MAP.get(client_key, {"attempts": 0, "locked_until": 0.0})
    next_attempts = int(rec["attempts"]) + 1
    if next_attempts >= MAX_FAILED_ATTEMPTS:
        LOCKOUT_MAP[client_key] = {
            "attempts": 0,
            "locked_until": time.time() + LOCKOUT_DURATION_SECONDS,
        }
        return True, LOCKOUT_DURATION_SECONDS, 0
    LOCKOUT_MAP[client_key] = {"attempts": next_attempts, "locked_until": 0.0}
    return False, 0, MAX_FAILED_ATTEMPTS - next_attempts


def clear_failed_attempts(client_key: str = "global") -> None:
    LOCKOUT_MAP.pop(client_key, None)


def init_db() -> None:
    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.cursor()
    cur.executescript(
        """
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
        """
    )
    existing_cols = {row[1] for row in cur.execute("PRAGMA table_info(users)").fetchall()}
    for col_name, col_def in [
        ("avatar", "TEXT NOT NULL DEFAULT '🦉'"),
        ("city", "TEXT NOT NULL DEFAULT 'Москва'"),
        ("auth_method", "TEXT NOT NULL DEFAULT 'password'"),
        ("security_hash", "TEXT NOT NULL DEFAULT ''"),
        ("security_salt", "TEXT NOT NULL DEFAULT ''"),
        ("recovery_code_hash", "TEXT NOT NULL DEFAULT ''"),
        ("telegram_id", "INTEGER"),
        ("referral_code", "TEXT"),
        ("referred_by_code", "TEXT"),
        ("last_login_at", "TEXT NOT NULL DEFAULT ''"),
    ]:
        if col_name not in existing_cols:
            try:
                cur.execute(f"ALTER TABLE users ADD COLUMN {col_name} {col_def}")
            except Exception:
                pass

    sess_cols = {row[1] for row in cur.execute("PRAGMA table_info(sessions)").fetchall()}
    if "signature" not in sess_cols:
        try:
            cur.execute("ALTER TABLE sessions ADD COLUMN signature TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass

    conn.commit()
    conn.close()


def to_public_user(row: sqlite3.Row | dict) -> dict:
    d = dict(row)
    return {
        "id": d["id"],
        "nickname": d["nickname"],
        "avatar": d.get("avatar") or "🦉",
        "city": d.get("city") or "Москва",
        "authMethod": d.get("auth_method") or "password",
        "createdAt": d["created_at"],
        "lastLoginAt": d.get("last_login_at") or d.get("updated_at") or d["created_at"],
        "referralCode": d.get("referral_code") or None,
        "referredByCode": d.get("referred_by_code") or None,
    }


class CalendarAPIHandler(SimpleHTTPRequestHandler):
    def _send_json(self, status: int, data: dict) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def _get_auth_user(self, conn: sqlite3.Connection):
        auth = self.headers.get("Authorization") or ""
        if not auth.startswith("Bearer "):
            return None
        session_token = auth[7:].strip()
        now_iso = datetime.now(timezone.utc).isoformat()
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        sess = cur.execute(
            "SELECT user_id, expires_at FROM sessions WHERE session_token = ?", (session_token,)
        ).fetchone()
        if not sess or sess["expires_at"] < now_iso:
            return None
        user = cur.execute("SELECT * FROM users WHERE id = ?", (sess["user_id"],)).fetchone()
        return dict(user, sessionToken=session_token) if user else None

    def do_OPTIONS(self) -> None:
        self._send_json(200, {"ok": True})

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            updated_at = ""
            if JSON_PATH.exists():
                try:
                    updated_at = json.loads(JSON_PATH.read_text(encoding="utf-8")).get("updated_at", "")
                except Exception:
                    pass
            return self._send_json(200, {"ok": True, "mode": "hybrid-sqlite-server", "updated_at": updated_at})

        if path == "/api/events":
            if JSON_PATH.exists():
                raw = JSON_PATH.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(raw)
                return
            return self._send_json(404, {"ok": False, "error": "База событий не найдена"})

        if path == "/api/cabinet":
            conn = sqlite3.connect(str(DB_PATH))
            try:
                user = self._get_auth_user(conn)
                if not user:
                    return self._send_json(401, {"ok": False, "error": "Сессия недействительна"})
                cabinet_data = json.loads(user["cabinet_json"] or "{}")
                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "user": to_public_user(user),
                        "cabinetData": cabinet_data,
                    },
                )
            finally:
                conn.close()

        return super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        client_key = self.client_address[0] if self.client_address else "local"

        if path == "/api/events/refresh":
            try:
                parser_mod.main()
                payload = json.loads(JSON_PATH.read_text(encoding="utf-8"))
                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "updated_at": payload.get("updated_at"),
                        "updated_at_human": payload.get("updated_at_human"),
                        "total_events": payload.get("total_events"),
                        "main_races_count": payload.get("main_races_count"),
                        "parkruns_count": payload.get("parkruns_count"),
                        "new_events_count": payload.get("new_events_count"),
                        "last_run_added_count": payload.get("last_run_added_count"),
                        "recent_new_events": payload.get("recent_new_events", []),
                        "payload": payload,
                    },
                )
            except Exception as exc:
                return self._send_json(500, {"ok": False, "error": str(exc)})

        if path == "/api/auth/register":
            conn = sqlite3.connect(str(DB_PATH))
            conn.row_factory = sqlite3.Row
            try:
                body = self._read_json()
                clean_name = sanitize_nickname(body.get("nickname") or "")
                valid, err_msg = validate_safe_nickname(clean_name)
                if not valid:
                    return self._send_json(400, {"ok": False, "error": err_msg})

                method = body.get("authMethod") if body.get("authMethod") in ("pin", "password", "telegram") else "password"
                secret = str(body.get("secret") or "").strip()

                if not body.get("securityHash"):
                    if method == "pin" and not re.match(r"^\d{4}$", secret):
                        return self._send_json(400, {"ok": False, "error": "PIN-код должен состоять ровно из 4 цифр"})
                    if method == "password" and len(secret) < 4:
                        return self._send_json(400, {"ok": False, "error": "Пароль должен содержать минимум 4 символа"})

                cur = conn.cursor()
                if cur.execute("SELECT id FROM users WHERE LOWER(nickname) = LOWER(?)", (clean_name,)).fetchone():
                    return self._send_json(
                        409,
                        {"ok": False, "error": "Этот никнейм уже занят. Выберите другой или войдите в свой профиль."},
                    )

                user_id = body.get("id") or f"usr_{int(time.time() * 1000)}_{secrets.token_hex(6)}"
                salt = body.get("securitySalt") or secrets.token_hex(16)
                sec_hash = body.get("securityHash") or derive_secret_hash(secret, salt)
                recovery_code = body.get("recoveryCode") or generate_recovery_code()
                rec_hash = body.get("recoveryCodeHash") or derive_secret_hash(recovery_code.upper(), salt)

                avatar = str(body.get("avatar") or "🦉").strip()
                city = sanitize_nickname(body.get("city") or "Москва") or "Москва"
                referral_code = str(body.get("referralCode") or "").strip().upper() or None
                referred_by = str(body.get("referredByCode") or "").strip().upper() or None
                now_iso = datetime.now(timezone.utc).isoformat()
                cabinet_data = body.get("cabinetData") or {
                    "myRaces": {},
                    "myResults": [],
                    "manualRecords": {},
                    "updatedAt": now_iso,
                }

                existing_cols = {row[1] for row in cur.execute("PRAGMA table_info(users)").fetchall()}
                if "access_token" in existing_cols:
                    cur.execute(
                        """
                        INSERT INTO users (id, access_token, nickname, avatar, city, auth_method, password_salt, password_hash, security_salt, security_hash, recovery_code_hash, referral_code, referred_by_code, cabinet_json, created_at, last_login_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            user_id,
                            user_id,
                            clean_name,
                            avatar,
                            city,
                            method,
                            salt,
                            sec_hash,
                            salt,
                            sec_hash,
                            rec_hash,
                            referral_code,
                            referred_by,
                            json.dumps(cabinet_data, ensure_ascii=False),
                            now_iso,
                            now_iso,
                            now_iso,
                        ),
                    )
                else:
                    cur.execute(
                        """
                        INSERT INTO users (id, nickname, avatar, city, auth_method, security_salt, security_hash, recovery_code_hash, referral_code, referred_by_code, cabinet_json, created_at, last_login_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            user_id,
                            clean_name,
                            avatar,
                            city,
                            method,
                            salt,
                            sec_hash,
                            rec_hash,
                            referral_code,
                            referred_by,
                            json.dumps(cabinet_data, ensure_ascii=False),
                            now_iso,
                            now_iso,
                            now_iso,
                        ),
                    )

                session_token = secrets.token_hex(24)
                expires_at = (datetime.now(timezone.utc) + timedelta(days=SESSION_DURATION_DAYS)).isoformat()
                cur.execute(
                    "INSERT INTO sessions (session_token, user_id, signature, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
                    (session_token, user_id, "", now_iso, expires_at),
                )
                conn.commit()
                clear_failed_attempts(client_key)
                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "sessionToken": session_token,
                        "recoveryCode": recovery_code,
                        "user": {
                            "id": user_id,
                            "nickname": clean_name,
                            "avatar": avatar,
                            "city": city,
                            "authMethod": method,
                            "createdAt": now_iso,
                            "lastLoginAt": now_iso,
                            "referralCode": referral_code,
                            "referredByCode": referred_by,
                        },
                        "cabinetData": cabinet_data,
                    },
                )
            finally:
                conn.close()

        if path == "/api/auth/login":
            conn = sqlite3.connect(str(DB_PATH))
            conn.row_factory = sqlite3.Row
            try:
                lock_sec = get_lockout_remaining(client_key)
                if lock_sec > 0:
                    return self._send_json(
                        429, {"ok": False, "error": f"Слишком много попыток. Подождите {lock_sec} сек."}
                    )

                body = self._read_json()
                clean_name = sanitize_nickname(body.get("nickname") or body.get("identifier") or "")
                secret = str(body.get("secret") or body.get("password") or "").strip()
                if not clean_name or not secret:
                    return self._send_json(400, {"ok": False, "error": "Введите никнейм и код доступа"})

                cur = conn.cursor()
                row = cur.execute("SELECT * FROM users WHERE LOWER(nickname) = LOWER(?)", (clean_name,)).fetchone()
                if not row:
                    record_failed_attempt(client_key)
                    return self._send_json(401, {"ok": False, "error": "Неверный никнейм или код доступа"})

                salt = row["security_salt"] or row["password_salt"] or ""
                stored_hash = row["security_hash"] or row["password_hash"] or ""
                if derive_secret_hash(secret, salt) != stored_hash:
                    locked, sec_left, att_left = record_failed_attempt(client_key)
                    if locked:
                        return self._send_json(
                            429,
                            {"ok": False, "error": f"Защита от подбора: вход заблокирован на {sec_left} сек."},
                        )
                    return self._send_json(
                        401,
                        {"ok": False, "error": f"Неверный код доступа (осталось попыток: {att_left})"},
                    )

                clear_failed_attempts(client_key)
                now_iso = datetime.now(timezone.utc).isoformat()
                cur.execute(
                    "UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?",
                    (now_iso, now_iso, row["id"]),
                )
                session_token = secrets.token_hex(24)
                expires_at = (datetime.now(timezone.utc) + timedelta(days=SESSION_DURATION_DAYS)).isoformat()
                cur.execute(
                    "INSERT INTO sessions (session_token, user_id, signature, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
                    (session_token, row["id"], "", now_iso, expires_at),
                )
                conn.commit()
                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "sessionToken": session_token,
                        "user": to_public_user(row),
                        "cabinetData": json.loads(row["cabinet_json"] or "{}"),
                    },
                )
            finally:
                conn.close()

        if path == "/api/auth/recover":
            conn = sqlite3.connect(str(DB_PATH))
            conn.row_factory = sqlite3.Row
            try:
                lock_sec = get_lockout_remaining(client_key)
                if lock_sec > 0:
                    return self._send_json(
                        429, {"ok": False, "error": f"Слишком много попыток. Подождите {lock_sec} сек."}
                    )

                body = self._read_json()
                clean_name = sanitize_nickname(body.get("nickname") or "")
                rec_code = str(body.get("recoveryCode") or "").strip().upper()
                new_secret = str(body.get("newSecret") or "").strip()
                method = body.get("newAuthMethod") or ("pin" if re.match(r"^\d{4}$", new_secret) else "password")

                if len(new_secret) < 4:
                    return self._send_json(400, {"ok": False, "error": "Минимум 4 символа"})

                cur = conn.cursor()
                row = cur.execute("SELECT * FROM users WHERE LOWER(nickname) = LOWER(?)", (clean_name,)).fetchone()
                if not row:
                    record_failed_attempt(client_key)
                    return self._send_json(401, {"ok": False, "error": "Профиль не найден или неверный резервный ключ"})

                salt = row["security_salt"] or row["password_salt"] or ""
                if derive_secret_hash(rec_code, salt) != row["recovery_code_hash"]:
                    record_failed_attempt(client_key)
                    return self._send_json(401, {"ok": False, "error": "Неверный резервный ключ восстановления"})

                new_hash = derive_secret_hash(new_secret, salt)
                now_iso = datetime.now(timezone.utc).isoformat()
                cur.execute(
                    "UPDATE users SET security_hash = ?, auth_method = ?, last_login_at = ?, updated_at = ? WHERE id = ?",
                    (new_hash, method, now_iso, now_iso, row["id"]),
                )
                session_token = secrets.token_hex(24)
                expires_at = (datetime.now(timezone.utc) + timedelta(days=SESSION_DURATION_DAYS)).isoformat()
                cur.execute(
                    "INSERT INTO sessions (session_token, user_id, signature, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
                    (session_token, row["id"], "", now_iso, expires_at),
                )
                conn.commit()
                clear_failed_attempts(client_key)
                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "sessionToken": session_token,
                        "user": to_public_user(row),
                        "cabinetData": json.loads(row["cabinet_json"] or "{}"),
                    },
                )
            finally:
                conn.close()

        if path == "/api/auth/change-password":
            conn = sqlite3.connect(str(DB_PATH))
            try:
                user = self._get_auth_user(conn)
                if not user:
                    return self._send_json(401, {"ok": False, "error": "Сессия недействительна"})
                body = self._read_json()
                cur_pw = str(body.get("currentPassword") or body.get("currentSecret") or "").strip()
                new_pw = str(body.get("newPassword") or body.get("newSecret") or "").strip()
                new_method = body.get("newAuthMethod") or ("pin" if re.match(r"^\d{4}$", new_pw) else "password")
                if len(new_pw) < 4:
                    return self._send_json(400, {"ok": False, "error": "Минимум 4 символа"})
                salt = user.get("security_salt") or user.get("password_salt") or ""
                stored_hash = user.get("security_hash") or user.get("password_hash") or ""
                if derive_secret_hash(cur_pw, salt) != stored_hash:
                    return self._send_json(401, {"ok": False, "error": "Текущий пароль / PIN неверен"})
                new_hash = derive_secret_hash(new_pw, salt)
                conn.execute(
                    "UPDATE users SET security_hash = ?, auth_method = ?, updated_at = ? WHERE id = ?",
                    (new_hash, new_method, datetime.now(timezone.utc).isoformat(), user["id"]),
                )
                conn.commit()
                return self._send_json(200, {"ok": True, "authMethod": new_method})
            finally:
                conn.close()

        if path == "/api/auth/delete":
            conn = sqlite3.connect(str(DB_PATH))
            try:
                user = self._get_auth_user(conn)
                if user:
                    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
                    conn.execute("DELETE FROM users WHERE id = ?", (user["id"],))
                    conn.commit()
                return self._send_json(200, {"ok": True})
            finally:
                conn.close()

        if path == "/api/auth/logout":
            conn = sqlite3.connect(str(DB_PATH))
            try:
                user = self._get_auth_user(conn)
                if user:
                    conn.execute("DELETE FROM sessions WHERE session_token = ?", (user["sessionToken"],))
                    conn.commit()
                return self._send_json(200, {"ok": True})
            finally:
                conn.close()

        return self._send_json(404, {"ok": False, "error": "Маршрут не найден"})

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/cabinet":
            conn = sqlite3.connect(str(DB_PATH))
            conn.row_factory = sqlite3.Row
            try:
                user = self._get_auth_user(conn)
                if not user:
                    return self._send_json(401, {"ok": False, "error": "Сессия недействительна"})
                body = self._read_json()
                now_iso = datetime.now(timezone.utc).isoformat()
                nickname = user["nickname"]
                if "nickname" in body:
                    clean_name = sanitize_nickname(body.get("nickname") or "")
                    valid, err_msg = validate_safe_nickname(clean_name)
                    if not valid:
                        return self._send_json(400, {"ok": False, "error": err_msg})
                    dup = conn.execute(
                        "SELECT id FROM users WHERE LOWER(nickname) = LOWER(?) AND id != ?",
                        (clean_name, user["id"]),
                    ).fetchone()
                    if dup:
                        return self._send_json(
                            409, {"ok": False, "error": "Этот никнейм уже занят другим пользователем"}
                        )
                    nickname = clean_name
                avatar = str(body.get("avatar") or user.get("avatar") or "🦉").strip()
                city = sanitize_nickname(body.get("city") or user.get("city") or "Москва") or "Инкогнито"
                cabinet_data = body.get("cabinetData") or json.loads(user["cabinet_json"] or "{}")
                cabinet_data["updatedAt"] = now_iso
                conn.execute(
                    "UPDATE users SET nickname = ?, avatar = ?, city = ?, cabinet_json = ?, updated_at = ? WHERE id = ?",
                    (nickname, avatar, city, json.dumps(cabinet_data, ensure_ascii=False), now_iso, user["id"]),
                )
                conn.commit()
                user["nickname"] = nickname
                user["avatar"] = avatar
                user["city"] = city
                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "updatedAt": now_iso,
                        "user": to_public_user(user),
                        "cabinetData": cabinet_data,
                    },
                )
            finally:
                conn.close()
        return self._send_json(404, {"ok": False, "error": "Маршрут не найден"})

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/auth/account":
            conn = sqlite3.connect(str(DB_PATH))
            try:
                user = self._get_auth_user(conn)
                if user:
                    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
                    conn.execute("DELETE FROM users WHERE id = ?", (user["id"],))
                    conn.commit()
                return self._send_json(200, {"ok": True})
            finally:
                conn.close()
        return self._send_json(404, {"ok": False, "error": "Маршрут не найден"})


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", "3000"))
    host = os.environ.get("HOST", "127.0.0.1")
    os.chdir(ROOT_DIR)
    server = ThreadingHTTPServer((host, port), CalendarAPIHandler)
    print(f"🚀 Python API-сервер запущен: http://{host}:{port}")
    server.serve_forever()
