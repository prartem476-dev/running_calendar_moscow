#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Гибридный веб-сервер и REST API для проекта «Беговой календарь Москвы и МО» (Python 3 + SQLite).
Совместим по базе running_calendar.db и маршрутам /api/* с server.mjs.
"""

import hashlib
import json
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import moscow_running_parser as parser_mod

ROOT_DIR = Path(__file__).resolve().parent
DB_PATH = ROOT_DIR / "running_calendar.db"
JSON_PATH = ROOT_DIR / "moscow_running_events.json"


def init_db() -> None:
    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.cursor()
    cur.executescript(
        """
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
        """
    )
    conn.commit()
    conn.close()


def generate_access_token() -> str:
    chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    g = lambda: "".join(secrets.choice(chars) for _ in range(4))
    return f"RUN-{g()}-{g()}-{g()}"


def normalize_token_input(raw: str) -> str:
    clean = re.sub(r"[^A-Z0-9]", "", (raw or "").upper())
    if clean.startswith("RUN") and len(clean) == 15:
        b = clean[3:]
        return f"RUN-{b[:4]}-{b[4:8]}-{b[8:12]}"
    return (raw or "").strip().upper()


def hash_password(password: str, salt_hex: str) -> str:
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_hex.encode("utf-8"), 100000, dklen=32)
    return dk.hex()


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
                        "user": {
                            "id": user["id"],
                            "accessToken": user["access_token"],
                            "email": user["email"] or "",
                            "nickname": user["nickname"] or "",
                            "createdAt": user["created_at"],
                        },
                        "cabinetData": cabinet_data,
                    },
                )
            finally:
                conn.close()

        return super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path

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
                password = str(body.get("password") or "")
                if len(password) < 4:
                    return self._send_json(400, {"ok": False, "error": "Пароль должен содержать минимум 4 символа"})

                access_token = normalize_token_input(body.get("accessToken") or "") or generate_access_token()
                if not re.match(r"^RUN-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$", access_token):
                    access_token = generate_access_token()

                email_raw = str(body.get("email") or "").strip().lower()
                email = email_raw if email_raw else None
                nickname = str(body.get("nickname") or "").strip()[:40]

                cur = conn.cursor()
                if cur.execute("SELECT id FROM users WHERE access_token = ?", (access_token,)).fetchone():
                    access_token = generate_access_token()
                if email and cur.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone():
                    return self._send_json(
                        409,
                        {"ok": False, "error": "Указанный Email уже привязан к другому токену. Войдите по нему."},
                    )

                user_id = secrets.token_hex(12)
                salt = secrets.token_hex(16)
                pw_hash = hash_password(password, salt)
                now_iso = datetime.now(timezone.utc).isoformat()
                cabinet_data = body.get("cabinetData") or {
                    "myRaces": {},
                    "myResults": [],
                    "manualRecords": {},
                    "updatedAt": now_iso,
                }

                cur.execute(
                    """
                    INSERT INTO users (id, access_token, email, nickname, password_salt, password_hash, cabinet_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        access_token,
                        email,
                        nickname,
                        salt,
                        pw_hash,
                        json.dumps(cabinet_data, ensure_ascii=False),
                        now_iso,
                        now_iso,
                    ),
                )
                session_token = secrets.token_hex(24)
                expires_at = (datetime.now(timezone.utc) + timedelta(days=90)).isoformat()
                cur.execute(
                    "INSERT INTO sessions (session_token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                    (session_token, user_id, now_iso, expires_at),
                )
                conn.commit()
                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "sessionToken": session_token,
                        "user": {
                            "id": user_id,
                            "accessToken": access_token,
                            "email": email or "",
                            "nickname": nickname,
                            "createdAt": now_iso,
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
                body = self._read_json()
                ident = str(body.get("identifier") or "").strip()
                password = str(body.get("password") or "")
                cur = conn.cursor()
                if "@" in ident:
                    row = cur.execute("SELECT * FROM users WHERE email = ?", (ident.lower(),)).fetchone()
                else:
                    row = cur.execute(
                        "SELECT * FROM users WHERE access_token = ?", (normalize_token_input(ident),)
                    ).fetchone()
                if not row:
                    return self._send_json(401, {"ok": False, "error": "Профиль не найден"})
                if hash_password(password, row["password_salt"]) != row["password_hash"]:
                    return self._send_json(401, {"ok": False, "error": "Неверный пароль"})

                now_iso = datetime.now(timezone.utc).isoformat()
                session_token = secrets.token_hex(24)
                expires_at = (datetime.now(timezone.utc) + timedelta(days=90)).isoformat()
                cur.execute(
                    "INSERT INTO sessions (session_token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                    (session_token, row["id"], now_iso, expires_at),
                )
                conn.commit()
                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "sessionToken": session_token,
                        "user": {
                            "id": row["id"],
                            "accessToken": row["access_token"],
                            "email": row["email"] or "",
                            "nickname": row["nickname"] or "",
                            "createdAt": row["created_at"],
                        },
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
                cur_pw = str(body.get("currentPassword") or "")
                new_pw = str(body.get("newPassword") or "")
                if len(new_pw) < 4:
                    return self._send_json(400, {"ok": False, "error": "Минимум 4 символа"})
                if hash_password(cur_pw, user["password_salt"]) != user["password_hash"]:
                    return self._send_json(401, {"ok": False, "error": "Текущий пароль неверен"})
                new_salt = secrets.token_hex(16)
                new_hash = hash_password(new_pw, new_salt)
                conn.execute(
                    "UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?",
                    (new_salt, new_hash, datetime.now(timezone.utc).isoformat(), user["id"]),
                )
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
            try:
                user = self._get_auth_user(conn)
                if not user:
                    return self._send_json(401, {"ok": False, "error": "Сессия недействительна"})
                body = self._read_json()
                now_iso = datetime.now(timezone.utc).isoformat()
                nickname = (
                    str(body.get("nickname") or "").strip()[:40]
                    if "nickname" in body
                    else user["nickname"]
                )
                email = user["email"]
                if "email" in body:
                    clean_email = str(body.get("email") or "").strip().lower()
                    email = clean_email if clean_email else None
                cabinet_data = body.get("cabinetData") or json.loads(user["cabinet_json"] or "{}")
                cabinet_data["updatedAt"] = now_iso
                conn.execute(
                    "UPDATE users SET nickname = ?, email = ?, cabinet_json = ?, updated_at = ? WHERE id = ?",
                    (nickname, email, json.dumps(cabinet_data, ensure_ascii=False), now_iso, user["id"]),
                )
                conn.commit()
                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "updatedAt": now_iso,
                        "user": {
                            "id": user["id"],
                            "accessToken": user["access_token"],
                            "email": email or "",
                            "nickname": nickname,
                            "createdAt": user["created_at"],
                        },
                        "cabinetData": cabinet_data,
                    },
                )
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
