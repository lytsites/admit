from __future__ import annotations

import os
import re
import secrets
import sqlite3
import uuid
import shutil
import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, time as datetime_time, timezone, timedelta
from pathlib import Path
from typing import Annotated, Literal

import bcrypt
import jwt
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
DB_PATH = Path(os.getenv("DATABASE_PATH", str(ROOT / "data" / "motionclass.sqlite")))
JWT_SECRET = os.getenv("JWT_SECRET", "local-development-secret-change-before-deploy")
JWT_ALGORITHM = "HS256"


def connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_db() -> None:
    with connect_db() as connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS teachers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                invite_code TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS students (
                id TEXT PRIMARY KEY,
                teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS classes (
                id TEXT PRIMARY KEY,
                teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                invite_code TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS class_members (
                class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
                student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                PRIMARY KEY (class_id, student_id)
            );
            CREATE TABLE IF NOT EXISTS schedule_rules (
                id TEXT PRIMARY KEY,
                class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
                title TEXT NOT NULL DEFAULT 'Урок',
                day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
                start_time TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS schedule_exceptions (
                rule_id TEXT NOT NULL REFERENCES schedule_rules(id) ON DELETE CASCADE,
                occurrence_date TEXT NOT NULL,
                PRIMARY KEY (rule_id, occurrence_date)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_rule_slot ON schedule_rules(class_id, day_of_week, start_time);
            CREATE TABLE IF NOT EXISTS user_presence_sessions (
                connection_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                ended_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_user_presence ON user_presence_sessions(user_id, ended_at, last_seen_at);
            CREATE TABLE IF NOT EXISTS lessons (
                id TEXT PRIMARY KEY,
                class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                starts_at TEXT NOT NULL,
                started_at TEXT,
                status TEXT NOT NULL DEFAULT 'scheduled',
                lesson_type TEXT NOT NULL DEFAULT 'scheduled',
                ended_at TEXT,
                ended_by TEXT,
                schedule_rule_id TEXT REFERENCES schedule_rules(id) ON DELETE SET NULL,
                occurrence_date TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
                filename TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                content_type TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS lesson_boards (
                lesson_id TEXT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
                objects_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                revision INTEGER NOT NULL DEFAULT 0,
                active_page INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS lesson_board_pages (
                lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
                page_number INTEGER NOT NULL CHECK(page_number >= 1),
                objects_json TEXT NOT NULL DEFAULT '[]',
                PRIMARY KEY (lesson_id, page_number)
            );
            CREATE TABLE IF NOT EXISTS lesson_participant_sessions (
                connection_id TEXT PRIMARY KEY,
                lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                joined_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                left_at TEXT,
                reconnect_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_lesson_presence ON lesson_participant_sessions(lesson_id, user_id);
            CREATE TABLE IF NOT EXISTS lesson_participant_events (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL,
                lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                occurred_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lesson_events ON lesson_participant_events(lesson_id, occurred_at);
        """)
        lesson_columns = {row["name"] for row in connection.execute("PRAGMA table_info(lessons)")}
        for column, definition in (("status", "TEXT NOT NULL DEFAULT 'scheduled'"), ("lesson_type", "TEXT NOT NULL DEFAULT 'scheduled'"), ("ended_at", "TEXT"), ("ended_by", "TEXT"), ("schedule_rule_id", "TEXT REFERENCES schedule_rules(id) ON DELETE SET NULL"), ("occurrence_date", "TEXT")):
            if column not in lesson_columns:
                connection.execute(f"ALTER TABLE lessons ADD COLUMN {column} {definition}")
        board_columns = {row["name"] for row in connection.execute("PRAGMA table_info(lesson_boards)")}
        if "revision" not in board_columns:
            connection.execute("ALTER TABLE lesson_boards ADD COLUMN revision INTEGER NOT NULL DEFAULT 0")
        if "active_page" not in board_columns:
            connection.execute("ALTER TABLE lesson_boards ADD COLUMN active_page INTEGER NOT NULL DEFAULT 1")
        # Preserve existing single-sheet boards as page 1 during the migration.
        connection.execute("INSERT OR IGNORE INTO lesson_board_pages (lesson_id, page_number, objects_json) SELECT lesson_id, 1, objects_json FROM lesson_boards")
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_occurrence ON lessons(schedule_rule_id, occurrence_date) WHERE schedule_rule_id IS NOT NULL")
        connection.execute("UPDATE lessons SET status=CASE WHEN started_at IS NULL THEN 'scheduled' ELSE 'live' END WHERE status='scheduled' AND started_at IS NOT NULL")
        connection.execute("UPDATE lessons SET lesson_type='ad_hoc' WHERE title='Внеплановый урок'")
        class_columns = {row["name"] for row in connection.execute("PRAGMA table_info(classes)")}
        if "invite_code" not in class_columns:
            connection.execute("ALTER TABLE classes ADD COLUMN invite_code TEXT")
        for row in connection.execute("SELECT id FROM classes WHERE invite_code IS NULL OR invite_code='' ").fetchall():
            connection.execute("UPDATE classes SET invite_code=? WHERE id=?", (new_invite_code(connection), row["id"]))
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_invite_code ON classes(invite_code)")


def new_invite_code(connection: sqlite3.Connection) -> str:
    while True:
        code = secrets.token_urlsafe(9).replace("-", "A").replace("_", "B").upper()
        if not connection.execute("SELECT 1 FROM classes WHERE invite_code=?", (code,)).fetchone():
            return code


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_db()
    yield


app = FastAPI(title="MotionClass API", version="1.0.0", lifespan=lifespan)
board_connections: dict[str, set[WebSocket]] = {}
board_connections_lock = asyncio.Lock()
raised_hands: dict[str, dict[str, dict[str, str]]] = {}
audio_permissions: dict[str, set[str]] = {}
origins = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in origins],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)
bearer = HTTPBearer(auto_error=False)
UPLOADS_PATH = ROOT / "uploads"


def current_user(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]) -> dict:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Войдите в аккаунт.")
    try:
        claims = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return {"id": claims["sub"], "name": claims["name"], "email": claims["email"], "role": claims["role"]}
    except (jwt.InvalidTokenError, KeyError) as error:
        raise HTTPException(status_code=401, detail="Сессия истекла. Войдите снова.") from error


def class_for_user(connection: sqlite3.Connection, user: dict) -> sqlite3.Row | None:
    if user["role"] == "teacher":
        return connection.execute("SELECT * FROM classes WHERE teacher_id = ? ORDER BY created_at LIMIT 1", (user["id"],)).fetchone()
    return connection.execute("SELECT c.* FROM classes c JOIN class_members m ON m.class_id=c.id WHERE m.student_id=? LIMIT 1", (user["id"],)).fetchone()


def require_teacher(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Это действие доступно преподавателю.")
    return user


class Credentials(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=5, max_length=128)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str) -> str:
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Введите корректный адрес электронной почты.")
        return value.lower()


class Registration(Credentials):
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=2, max_length=80)
    role: Literal["teacher", "student"]
    inviteCode: str | None = Field(default=None, min_length=4, max_length=64)


class SitePresence(BaseModel):
    connectionId: str = Field(min_length=16, max_length=80)


def issue_token(user_id: str, name: str, email: str, role: str) -> str:
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": user_id, "name": name, "email": email, "role": role,
         "iat": now, "exp": now + timedelta(days=7)},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def public_user(row: sqlite3.Row, role: str) -> dict[str, str]:
    return {"id": row["id"], "name": row["name"], "email": row["email"], "role": role}


def auth_response(row: sqlite3.Row, role: str, *, status: int = 200, invite_code: str | None = None) -> dict:
    result = {"token": issue_token(row["id"], row["name"], row["email"], role),
              "user": public_user(row, role)}
    if invite_code:
        result["inviteCode"] = invite_code
    return result


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/register", status_code=201)
def register(payload: Registration) -> dict:
    user_id = str(uuid.uuid4())
    password_hash = bcrypt.hashpw(payload.password.encode(), bcrypt.gensalt()).decode()
    try:
        with connect_db() as connection:
            existing_user = connection.execute(
                "SELECT email FROM teachers WHERE email = ? UNION ALL "
                "SELECT email FROM students WHERE email = ? LIMIT 1",
                (payload.email, payload.email),
            ).fetchone()
            if existing_user is not None:
                raise HTTPException(status_code=409, detail="Аккаунт с такой почтой уже существует.")
            if payload.role == "teacher":
                invite_code = secrets.token_urlsafe(8).replace("-", "A").replace("_", "B").upper()
                connection.execute(
                    "INSERT INTO teachers (id, name, email, password_hash, invite_code) VALUES (?, ?, ?, ?, ?)",
                    (user_id, payload.name, payload.email, password_hash, invite_code),
                )
                row = connection.execute("SELECT id, name, email FROM teachers WHERE id = ?", (user_id,)).fetchone()
                return auth_response(row, "teacher")

            if not payload.inviteCode:
                raise HTTPException(status_code=400, detail="Введите код приглашения от преподавателя.")
            class_row = connection.execute("SELECT id, teacher_id FROM classes WHERE invite_code=?", (payload.inviteCode.upper(),)).fetchone()
            if class_row is None:
                raise HTTPException(status_code=400, detail="Код приглашения не найден. Проверьте его у преподавателя.")
            connection.execute(
                "INSERT INTO students (id, teacher_id, name, email, password_hash) VALUES (?, ?, ?, ?, ?)",
                (user_id, class_row["teacher_id"], payload.name, payload.email, password_hash),
            )
            connection.execute("INSERT INTO class_members (class_id, student_id) VALUES (?, ?)", (class_row["id"], user_id))
            row = connection.execute("SELECT id, name, email FROM students WHERE id = ?", (user_id,)).fetchone()
            return auth_response(row, "student")
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="Аккаунт с такой почтой уже существует.") from error


@app.post("/api/auth/login")
def login(payload: Credentials) -> dict:
    with connect_db() as connection:
        row = connection.execute(
            "SELECT id, name, email, password_hash, 'teacher' AS role FROM teachers WHERE email = ? "
            "UNION ALL SELECT id, name, email, password_hash, 'student' AS role FROM students WHERE email = ? LIMIT 1",
            (payload.email, payload.email),
        ).fetchone()
    if row is None or not bcrypt.checkpw(payload.password.encode(), row["password_hash"].encode()):
        raise HTTPException(status_code=401, detail="Неверная почта или пароль.")
    return auth_response(row, row["role"])


@app.get("/api/auth/me")
def me(user: dict = Depends(current_user)) -> dict:
    with connect_db() as connection:
        table = "teachers" if user["role"] == "teacher" else "students"
        row = connection.execute(f"SELECT id, name, email FROM {table} WHERE id = ?", (user["id"],)).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="Профиль не найден. Войдите снова.")
        return {"user": public_user(row, user["role"])}


@app.post("/api/presence/heartbeat")
def site_presence_heartbeat(payload: SitePresence, user: dict = Depends(current_user)) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    with connect_db() as connection:
        existing = connection.execute(
            "SELECT user_id FROM user_presence_sessions WHERE connection_id=?", (payload.connectionId,)
        ).fetchone()
        if existing and existing["user_id"] != user["id"]:
            raise HTTPException(status_code=409, detail="Идентификатор подключения уже используется.")
        connection.execute(
            "INSERT INTO user_presence_sessions (connection_id, user_id, last_seen_at, ended_at) VALUES (?, ?, ?, NULL) "
            "ON CONFLICT(connection_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, ended_at=NULL",
            (payload.connectionId, user["id"], now),
        )
    return {"online": True, "lastSeenAt": now}


@app.post("/api/presence/leave")
def site_presence_leave(payload: SitePresence, user: dict = Depends(current_user)) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    with connect_db() as connection:
        connection.execute(
            "UPDATE user_presence_sessions SET ended_at=? WHERE connection_id=? AND user_id=? AND ended_at IS NULL",
            (now, payload.connectionId, user["id"]),
        )
    return {"online": False}


class ProfileUpdate(BaseModel):
    name: str = Field(min_length=2, max_length=80)


@app.patch("/api/auth/me")
def update_profile(payload: ProfileUpdate, user: dict = Depends(current_user)) -> dict:
    table = "teachers" if user["role"] == "teacher" else "students"
    with connect_db() as connection:
        connection.execute(f"UPDATE {table} SET name=? WHERE id=?", (payload.name.strip(), user["id"]))
        row = connection.execute(f"SELECT id, name, email FROM {table} WHERE id=?", (user["id"],)).fetchone()
    return {"user": public_user(row, user["role"])}


@app.get("/api/classes")
def list_classes(user: dict = Depends(current_user)) -> list[dict]:
    with connect_db() as connection:
        if user["role"] == "teacher":
            rows = connection.execute("SELECT c.id, c.name, c.invite_code AS inviteCode, COUNT(m.student_id) AS studentCount FROM classes c LEFT JOIN class_members m ON m.class_id=c.id WHERE c.teacher_id=? GROUP BY c.id ORDER BY c.created_at", (user["id"],)).fetchall()
        else:
            rows = connection.execute("SELECT c.id, c.name, COUNT(m.student_id) AS studentCount FROM classes c JOIN class_members own ON own.class_id=c.id AND own.student_id=? LEFT JOIN class_members m ON m.class_id=c.id GROUP BY c.id", (user["id"],)).fetchall()
        return [dict(row) for row in rows]


@app.get("/api/classes/{class_id}")
def class_details(class_id: str, user: dict = Depends(current_user)) -> dict:
    with connect_db() as connection:
        if user["role"] == "teacher":
            row = connection.execute("SELECT * FROM classes WHERE id=? AND teacher_id=?", (class_id, user["id"])).fetchone()
        else:
            row = connection.execute("SELECT c.* FROM classes c JOIN class_members m ON m.class_id=c.id WHERE c.id=? AND m.student_id=?", (class_id, user["id"])).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Класс не найден.")
        students = connection.execute("""
            SELECT s.id, s.name, s.email,
                EXISTS (
                    SELECT 1 FROM user_presence_sessions ps
                    WHERE ps.user_id=s.id AND ps.ended_at IS NULL
                      AND julianday(ps.last_seen_at) >= julianday('now', '-45 seconds')
                ) AS online
            FROM students s
            JOIN class_members m ON m.student_id=s.id
            WHERE m.class_id=?
            ORDER BY s.name
        """, (class_id,)).fetchall()
        return {"id": row["id"], "name": row["name"], "inviteCode": row["invite_code"] if user["role"] == "teacher" else None, "students": [{**dict(student), "online": bool(student["online"])} for student in students]}


class ClassCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)


class ClassJoin(BaseModel):
    inviteCode: str = Field(min_length=4, max_length=64)


@app.post("/api/classes", status_code=201)
def create_class(payload: ClassCreate, user: dict = Depends(require_teacher)) -> dict:
    class_id = str(uuid.uuid4())
    invite_code = None
    with connect_db() as connection:
        invite_code = new_invite_code(connection)
        connection.execute("INSERT INTO classes (id, teacher_id, name, invite_code) VALUES (?, ?, ?, ?)", (class_id, user["id"], payload.name.strip(), invite_code))
    return {"id": class_id, "name": payload.name.strip(), "inviteCode": invite_code, "studentCount": 0}


@app.delete("/api/classes/{class_id}")
def delete_class(class_id: str, user: dict = Depends(require_teacher)) -> dict:
    with connect_db() as connection:
        classroom = connection.execute(
            "SELECT id FROM classes WHERE id=? AND teacher_id=?", (class_id, user["id"])
        ).fetchone()
        if classroom is None:
            raise HTTPException(status_code=404, detail="Класс не найден.")
        student_count = connection.execute(
            "SELECT COUNT(*) FROM class_members WHERE class_id=?", (class_id,)
        ).fetchone()[0]
        lesson_count = connection.execute(
            "SELECT COUNT(*) FROM lessons WHERE class_id=?", (class_id,)
        ).fetchone()[0]
        connection.execute("DELETE FROM classes WHERE id=?", (class_id,))
    return {"deleted": True, "studentCount": student_count, "lessonCount": lesson_count}


@app.post("/api/classes/join")
def join_class(payload: ClassJoin, user: dict = Depends(current_user)) -> dict:
    if user["role"] != "student":
        raise HTTPException(status_code=403, detail="Присоединиться к классу может только ученик.")
    with connect_db() as connection:
        classroom = connection.execute(
            "SELECT id, teacher_id FROM classes WHERE invite_code=?", (payload.inviteCode.strip().upper(),)
        ).fetchone()
        if classroom is None or classroom["teacher_id"] != connection.execute(
            "SELECT teacher_id FROM students WHERE id=?", (user["id"],)
        ).fetchone()["teacher_id"]:
            raise HTTPException(status_code=404, detail="Класс с таким кодом не найден у вашего преподавателя.")
        if connection.execute("SELECT 1 FROM class_members WHERE student_id=? LIMIT 1", (user["id"],)).fetchone():
            raise HTTPException(status_code=409, detail="Вы уже состоите в классе.")
        connection.execute("INSERT INTO class_members (class_id, student_id) VALUES (?, ?)", (classroom["id"], user["id"]))
        row = connection.execute("SELECT id, name FROM classes WHERE id=?", (classroom["id"],)).fetchone()
    return {"id": row["id"], "name": row["name"]}


class ScheduleRuleInput(BaseModel):
    classId: str
    dayOfWeek: int = Field(ge=0, le=6)
    startTime: datetime_time
    title: str = Field(default="Урок", min_length=1, max_length=120)


def materialize_schedule_rules(connection: sqlite3.Connection) -> None:
    now = datetime.now().astimezone()
    rules = connection.execute("SELECT id, class_id, title, day_of_week, start_time FROM schedule_rules").fetchall()
    for offset in range(29):
        occurrence_day = now.date() + timedelta(days=offset)
        for rule in rules:
            if occurrence_day.weekday() != rule["day_of_week"]:
                continue
            if connection.execute(
                "SELECT 1 FROM schedule_exceptions WHERE rule_id=? AND occurrence_date=?",
                (rule["id"], occurrence_day.isoformat()),
            ).fetchone():
                continue
            local_start = datetime.combine(occurrence_day, datetime_time.fromisoformat(rule["start_time"]), tzinfo=now.tzinfo)
            if local_start <= now:
                continue
            connection.execute(
                "INSERT OR IGNORE INTO lessons (id, class_id, title, starts_at, status, lesson_type, schedule_rule_id, occurrence_date) "
                "VALUES (?, ?, ?, ?, 'scheduled', 'scheduled', ?, ?)",
                (str(uuid.uuid4()), rule["class_id"], rule["title"], local_start.astimezone(timezone.utc).isoformat(), rule["id"], occurrence_day.isoformat()),
            )


def schedule_rule_dict(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "classId": row["classId"], "className": row["className"], "title": row["title"], "dayOfWeek": row["dayOfWeek"], "startTime": row["startTime"]}


@app.get("/api/schedule-rules")
def list_schedule_rules(user: dict = Depends(current_user)) -> list[dict]:
    with connect_db() as connection:
        if user["role"] == "teacher":
            rows = connection.execute(
                "SELECT r.id, r.class_id AS classId, c.name AS className, r.title, r.day_of_week AS dayOfWeek, r.start_time AS startTime "
                "FROM schedule_rules r JOIN classes c ON c.id=r.class_id WHERE c.teacher_id=? "
                "ORDER BY r.day_of_week, r.start_time, c.name", (user["id"],)
            ).fetchall()
        else:
            rows = connection.execute(
                "SELECT r.id, r.class_id AS classId, c.name AS className, r.title, r.day_of_week AS dayOfWeek, r.start_time AS startTime "
                "FROM schedule_rules r JOIN classes c ON c.id=r.class_id JOIN class_members m ON m.class_id=c.id "
                "WHERE m.student_id=? ORDER BY r.day_of_week, r.start_time", (user["id"],)
            ).fetchall()
        exceptions = connection.execute(
            "SELECT e.rule_id, e.occurrence_date FROM schedule_exceptions e "
            "JOIN schedule_rules r ON r.id=e.rule_id JOIN classes c ON c.id=r.class_id "
            + ("WHERE c.teacher_id=?" if user["role"] == "teacher" else "JOIN class_members m ON m.class_id=c.id WHERE m.student_id=?"),
            (user["id"],),
        ).fetchall()
        excluded_by_rule: dict[str, list[str]] = {}
        for exception in exceptions:
            excluded_by_rule.setdefault(exception["rule_id"], []).append(exception["occurrence_date"])
        return [{**schedule_rule_dict(row), "excludedDates": excluded_by_rule.get(row["id"], [])} for row in rows]


def owned_class(connection: sqlite3.Connection, class_id: str, teacher_id: str) -> sqlite3.Row | None:
    return connection.execute("SELECT id FROM classes WHERE id=? AND teacher_id=?", (class_id, teacher_id)).fetchone()


def apply_schedule_rule(connection: sqlite3.Connection, rule_id: str, payload: ScheduleRuleInput, teacher_id: str) -> dict:
    if owned_class(connection, payload.classId, teacher_id) is None:
        raise HTTPException(status_code=404, detail="Класс не найден.")
    start_time = payload.startTime.strftime("%H:%M")
    connection.execute(
        "INSERT INTO schedule_rules (id, class_id, title, day_of_week, start_time) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET class_id=excluded.class_id, title=excluded.title, day_of_week=excluded.day_of_week, start_time=excluded.start_time",
        (rule_id, payload.classId, payload.title.strip(), payload.dayOfWeek, start_time),
    )
    materialize_schedule_rules(connection)
    row = connection.execute(
        "SELECT r.id, r.class_id AS classId, c.name AS className, r.title, r.day_of_week AS dayOfWeek, r.start_time AS startTime "
        "FROM schedule_rules r JOIN classes c ON c.id=r.class_id WHERE r.id=?", (rule_id,)
    ).fetchone()
    return schedule_rule_dict(row)


@app.post("/api/schedule-rules", status_code=201)
def create_schedule_rule(payload: ScheduleRuleInput, user: dict = Depends(require_teacher)) -> dict:
    rule_id = str(uuid.uuid4())
    try:
        with connect_db() as connection:
            return apply_schedule_rule(connection, rule_id, payload, user["id"])
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="На это время для класса уже назначен урок.") from error


@app.patch("/api/schedule-rules/{rule_id}")
def update_schedule_rule(rule_id: str, payload: ScheduleRuleInput, user: dict = Depends(require_teacher)) -> dict:
    try:
        with connect_db() as connection:
            exists = connection.execute(
                "SELECT r.id FROM schedule_rules r JOIN classes c ON c.id=r.class_id WHERE r.id=? AND c.teacher_id=?",
                (rule_id, user["id"]),
            ).fetchone()
            if exists is None:
                raise HTTPException(status_code=404, detail="Правило расписания не найдено.")
            now = datetime.now(timezone.utc).isoformat()
            connection.execute("DELETE FROM lessons WHERE schedule_rule_id=? AND status='scheduled' AND julianday(starts_at)>julianday(?)", (rule_id, now))
            return apply_schedule_rule(connection, rule_id, payload, user["id"])
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="На это время для класса уже назначен урок.") from error


@app.delete("/api/schedule-rules/{rule_id}")
def delete_schedule_rule(rule_id: str, user: dict = Depends(require_teacher)) -> dict:
    with connect_db() as connection:
        exists = connection.execute(
            "SELECT r.id FROM schedule_rules r JOIN classes c ON c.id=r.class_id WHERE r.id=? AND c.teacher_id=?",
            (rule_id, user["id"]),
        ).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Правило расписания не найдено.")
        now = datetime.now(timezone.utc).isoformat()
        connection.execute("DELETE FROM lessons WHERE schedule_rule_id=? AND status='scheduled' AND julianday(starts_at)>julianday(?)", (rule_id, now))
        connection.execute("DELETE FROM schedule_rules WHERE id=?", (rule_id,))
    return {"deleted": True}


@app.delete("/api/schedule-rules/{rule_id}/occurrences/{occurrence_date}")
def delete_schedule_occurrence(rule_id: str, occurrence_date: str, user: dict = Depends(require_teacher)) -> dict:
    try:
        occurrence_day = datetime.strptime(occurrence_date, "%Y-%m-%d").date()
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Некорректная дата урока.") from error
    with connect_db() as connection:
        rule = connection.execute(
            "SELECT r.id, r.day_of_week FROM schedule_rules r JOIN classes c ON c.id=r.class_id "
            "WHERE r.id=? AND c.teacher_id=?", (rule_id, user["id"])
        ).fetchone()
        if rule is None:
            raise HTTPException(status_code=404, detail="Правило расписания не найдено.")
        if occurrence_day.weekday() != rule["day_of_week"]:
            raise HTTPException(status_code=422, detail="Дата не совпадает с днём этого урока.")
        lesson = connection.execute(
            "SELECT id, status FROM lessons WHERE schedule_rule_id=? AND occurrence_date=?",
            (rule_id, occurrence_date),
        ).fetchone()
        if lesson and lesson["status"] != "scheduled":
            raise HTTPException(status_code=409, detail="Уже начавшийся урок нельзя удалить из расписания.")
        connection.execute(
            "INSERT OR IGNORE INTO schedule_exceptions (rule_id, occurrence_date) VALUES (?, ?)",
            (rule_id, occurrence_date),
        )
        if lesson:
            connection.execute("DELETE FROM lessons WHERE id=?", (lesson["id"],))
    return {"deleted": True, "ruleId": rule_id, "occurrenceDate": occurrence_date}


@app.get("/api/lessons")
def list_lessons(user: dict = Depends(current_user)) -> list[dict]:
    with connect_db() as connection:
        materialize_schedule_rules(connection)
        now = datetime.now(timezone.utc).isoformat()
        connection.execute("UPDATE lessons SET started_at=starts_at, status='live' WHERE status='scheduled' AND julianday(starts_at) <= julianday('now')")
        connection.execute("INSERT OR IGNORE INTO lesson_boards (lesson_id) SELECT id FROM lessons WHERE status='live'")
        query = "SELECT l.id, l.title, l.starts_at AS startsAt, l.started_at AS startedAt, l.status, l.lesson_type AS lessonType, l.ended_at AS endedAt, l.schedule_rule_id AS scheduleRuleId, l.occurrence_date AS occurrenceDate, c.id AS classId, c.name AS className FROM lessons l JOIN classes c ON c.id=l.class_id"
        if user["role"] == "teacher":
            rows = connection.execute(query + " WHERE c.teacher_id=? ORDER BY l.starts_at", (user["id"],)).fetchall()
        else:
            rows = connection.execute(query + " JOIN class_members m ON m.class_id=c.id WHERE m.student_id=? ORDER BY l.starts_at", (user["id"],)).fetchall()
        return [dict(row) for row in rows]


class LessonCreate(BaseModel):
    classId: str
    title: str = Field(default="Урок", min_length=1, max_length=120)
    startsAt: str
    startNow: bool = False


class LessonReschedule(BaseModel):
    startsAt: datetime


@app.post("/api/lessons", status_code=201)
def create_lesson(payload: LessonCreate, user: dict = Depends(require_teacher)) -> dict:
    with connect_db() as connection:
        classroom = connection.execute("SELECT id FROM classes WHERE id=? AND teacher_id=?", (payload.classId, user["id"])).fetchone()
        if classroom is None:
            raise HTTPException(status_code=404, detail="Класс не найден.")
        lesson_id = str(uuid.uuid4())
        starts_at = datetime.now(timezone.utc).isoformat() if payload.startNow else payload.startsAt
        started_at = datetime.now(timezone.utc).isoformat() if payload.startNow else None
        lesson_status = "live" if payload.startNow else "scheduled"
        lesson_type = "ad_hoc" if payload.startNow else "scheduled"
        connection.execute("INSERT INTO lessons (id, class_id, title, starts_at, started_at, status, lesson_type) VALUES (?, ?, ?, ?, ?, ?, ?)", (lesson_id, payload.classId, payload.title, starts_at, started_at, lesson_status, lesson_type))
        class_name = connection.execute("SELECT name FROM classes WHERE id=?", (payload.classId,)).fetchone()["name"]
    status = "live" if payload.startNow else "scheduled"
    return {"id": lesson_id, "title": payload.title, "classId": payload.classId, "className": class_name, "startsAt": starts_at, "startedAt": started_at, "status": status, "lessonType": lesson_type, "endedAt": None}


@app.patch("/api/lessons/{lesson_id}")
def reschedule_lesson(lesson_id: str, payload: LessonReschedule, user: dict = Depends(require_teacher)) -> dict:
    starts_at = payload.startsAt
    if starts_at.tzinfo is None:
        raise HTTPException(status_code=422, detail="Укажите часовой пояс времени урока.")
    starts_at = starts_at.astimezone(timezone.utc)
    if starts_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=422, detail="Новое время начала должно быть в будущем.")
    starts_at_value = starts_at.isoformat()
    with connect_db() as connection:
        lesson = connection.execute(
            "SELECT l.id, l.title, l.class_id AS classId, l.status, l.lesson_type AS lessonType, c.name AS className "
            "FROM lessons l JOIN classes c ON c.id=l.class_id "
            "WHERE l.id=? AND c.teacher_id=?",
            (lesson_id, user["id"]),
        ).fetchone()
        if lesson is None:
            raise HTTPException(status_code=404, detail="Урок не найден.")
        if lesson["status"] != "scheduled" or lesson["lessonType"] != "scheduled":
            raise HTTPException(status_code=409, detail="Изменить время можно только у запланированного урока.")
        connection.execute("UPDATE lessons SET starts_at=? WHERE id=?", (starts_at_value, lesson_id))
    return {**dict(lesson), "startsAt": starts_at_value, "startedAt": None, "endedAt": None}


@app.post("/api/lessons/{lesson_id}/start")
def start_lesson(lesson_id: str, user: dict = Depends(require_teacher)) -> dict:
    with connect_db() as connection:
        row = connection.execute("SELECT l.id, l.status FROM lessons l JOIN classes c ON c.id=l.class_id WHERE l.id=? AND c.teacher_id=?", (lesson_id, user["id"])).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Урок не найден.")
        if row["status"] == "ended":
            raise HTTPException(status_code=409, detail="Завершённый урок нельзя начать повторно.")
        now = datetime.now(timezone.utc).isoformat()
        connection.execute("UPDATE lessons SET started_at=COALESCE(started_at, ?), status='live' WHERE id=?", (now, lesson_id))
        connection.execute("INSERT OR IGNORE INTO lesson_boards (lesson_id) VALUES (?)", (lesson_id,))
    return {"started": True, "status": "live", "startedAt": now}


@app.post("/api/lessons/{lesson_id}/end")
async def end_lesson(lesson_id: str, user: dict = Depends(require_teacher)) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    with connect_db() as connection:
        row = connection.execute("SELECT l.status FROM lessons l JOIN classes c ON c.id=l.class_id WHERE l.id=? AND c.teacher_id=?", (lesson_id, user["id"])).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Урок не найден.")
        if row["status"] == "ended":
            return {"ended": True, "status": "ended"}
        connection.execute("UPDATE lessons SET status='ended', ended_at=?, ended_by=? WHERE id=?", (now, user["id"], lesson_id))
        sessions = connection.execute("SELECT connection_id, user_id FROM lesson_participant_sessions WHERE lesson_id=? AND left_at IS NULL", (lesson_id,)).fetchall()
        for session in sessions:
            connection.execute("UPDATE lesson_participant_sessions SET left_at=? WHERE connection_id=?", (now, session["connection_id"]))
            connection.execute("INSERT INTO lesson_participant_events (id, connection_id, lesson_id, user_id, event_type, occurred_at) VALUES (?, ?, ?, ?, 'lesson_ended', ?)", (str(uuid.uuid4()), session["connection_id"], lesson_id, session["user_id"], now))
    raised_hands.pop(lesson_id, None)
    audio_permissions.pop(lesson_id, None)
    await broadcast_lesson_message(lesson_id, {"type": "lesson_ended", "endedAt": now})
    return {"ended": True, "status": "ended", "endedAt": now}


def participant_access(connection: sqlite3.Connection, lesson_id: str, user: dict) -> sqlite3.Row | None:
    if user["role"] == "teacher":
        return connection.execute("SELECT l.id, l.status FROM lessons l JOIN classes c ON c.id=l.class_id WHERE l.id=? AND c.teacher_id=?", (lesson_id, user["id"])).fetchone()
    return connection.execute("SELECT l.id, l.status FROM lessons l JOIN classes c ON c.id=l.class_id JOIN class_members m ON m.class_id=c.id WHERE l.id=? AND m.student_id=?", (lesson_id, user["id"])).fetchone()


class ParticipantConnection(BaseModel):
    connectionId: str = Field(min_length=16, max_length=80)


def write_presence_event(connection: sqlite3.Connection, connection_id: str, lesson_id: str, user_id: str, event_type: str, at: str) -> None:
    connection.execute("INSERT INTO lesson_participant_events (id, connection_id, lesson_id, user_id, event_type, occurred_at) VALUES (?, ?, ?, ?, ?, ?)", (str(uuid.uuid4()), connection_id, lesson_id, user_id, event_type, at))


@app.post("/api/lessons/{lesson_id}/presence/join")
async def join_lesson(lesson_id: str, payload: ParticipantConnection, user: dict = Depends(current_user)) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    with connect_db() as connection:
        lesson = participant_access(connection, lesson_id, user)
        if lesson is None:
            raise HTTPException(status_code=404, detail="Урок не найден.")
        if lesson["status"] != "live":
            raise HTTPException(status_code=409, detail="Урок ещё не начался или уже завершён.")
        existing = connection.execute("SELECT lesson_id, user_id, left_at FROM lesson_participant_sessions WHERE connection_id=?", (payload.connectionId,)).fetchone()
        if existing and (existing["lesson_id"] != lesson_id or existing["user_id"] != user["id"]):
            raise HTTPException(status_code=409, detail="Идентификатор подключения уже занят.")
        event_type = "reconnected" if existing and existing["left_at"] else "connected"
        connection.execute("INSERT INTO lesson_participant_sessions (connection_id, lesson_id, user_id, joined_at, last_seen_at, left_at, reconnect_count) VALUES (?, ?, ?, ?, ?, NULL, 0) ON CONFLICT(connection_id) DO UPDATE SET joined_at=CASE WHEN lesson_participant_sessions.left_at IS NULL THEN lesson_participant_sessions.joined_at ELSE excluded.joined_at END, last_seen_at=excluded.last_seen_at, reconnect_count=lesson_participant_sessions.reconnect_count + CASE WHEN lesson_participant_sessions.left_at IS NULL THEN 0 ELSE 1 END, left_at=NULL", (payload.connectionId, lesson_id, user["id"], now, now))
        if not existing or existing["left_at"]:
            write_presence_event(connection, payload.connectionId, lesson_id, user["id"], event_type, now)
    if not existing or existing["left_at"]:
        await broadcast_lesson_message(lesson_id, {"type": "participant_connected", "userId": user["id"], "name": user["name"], "role": user["role"]})
    return {"connected": True, "connectionId": payload.connectionId, "reconnected": event_type == "reconnected"}


@app.put("/api/lessons/{lesson_id}/presence/heartbeat")
def lesson_heartbeat(lesson_id: str, payload: ParticipantConnection, user: dict = Depends(current_user)) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    with connect_db() as connection:
        lesson = participant_access(connection, lesson_id, user)
        if lesson is None:
            raise HTTPException(status_code=404, detail="Урок не найден.")
        if lesson["status"] != "live":
            raise HTTPException(status_code=409, detail="Урок больше не активен.")
        updated = connection.execute("UPDATE lesson_participant_sessions SET last_seen_at=? WHERE connection_id=? AND lesson_id=? AND user_id=? AND left_at IS NULL", (now, payload.connectionId, lesson_id, user["id"]))
        if updated.rowcount == 0:
            raise HTTPException(status_code=409, detail="Подключение потеряно. Переподключитесь к уроку.")
    return {"connected": True, "lastSeenAt": now}


@app.post("/api/lessons/{lesson_id}/presence/leave")
def leave_lesson(lesson_id: str, payload: ParticipantConnection, user: dict = Depends(current_user)) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    with connect_db() as connection:
        connection.execute("UPDATE lesson_participant_sessions SET left_at=? WHERE connection_id=? AND lesson_id=? AND user_id=? AND left_at IS NULL", (now, payload.connectionId, lesson_id, user["id"]))
        if connection.execute("SELECT changes()").fetchone()[0]:
            write_presence_event(connection, payload.connectionId, lesson_id, user["id"], "disconnected", now)
    return {"connected": False}


@app.get("/api/lessons/{lesson_id}/participants")
def list_participants(lesson_id: str, user: dict = Depends(current_user)) -> list[dict]:
    with connect_db() as connection:
        if participant_access(connection, lesson_id, user) is None:
            raise HTTPException(status_code=404, detail="Урок не найден.")
        query = """
            SELECT p.user_id AS userId, p.name, p.role,
                MAX(CASE WHEN s.left_at IS NULL AND julianday(s.last_seen_at) >= julianday('now', '-45 seconds') THEN 1 ELSE 0 END) AS connected,
                MAX(s.last_seen_at) AS lastSeenAt
            FROM (
                SELECT t.id AS user_id, t.name, 'teacher' AS role, c.id AS class_id FROM teachers t JOIN classes c ON c.teacher_id=t.id
                UNION ALL
                SELECT st.id AS user_id, st.name, 'student' AS role, m.class_id FROM students st JOIN class_members m ON m.student_id=st.id
            ) p
            JOIN lessons l ON l.class_id=p.class_id AND l.id=?
            LEFT JOIN lesson_participant_sessions s ON s.lesson_id=l.id AND s.user_id=p.user_id
            GROUP BY p.user_id, p.name, p.role ORDER BY CASE p.role WHEN 'teacher' THEN 0 ELSE 1 END, p.name
        """
        return [dict(row) for row in connection.execute(query, (lesson_id,)).fetchall()]


@app.get("/api/lessons/{lesson_id}/events")
def lesson_events(lesson_id: str, user: dict = Depends(current_user)) -> list[dict]:
    with connect_db() as connection:
        if participant_access(connection, lesson_id, user) is None:
            raise HTTPException(status_code=404, detail="Урок не найден.")
        rows = connection.execute("SELECT e.event_type AS type, e.occurred_at AS occurredAt, e.user_id AS userId, COALESCE(t.name, s.name) AS name FROM lesson_participant_events e LEFT JOIN teachers t ON t.id=e.user_id LEFT JOIN students s ON s.id=e.user_id WHERE e.lesson_id=? ORDER BY e.occurred_at DESC LIMIT 100", (lesson_id,)).fetchall()
        return [dict(row) for row in rows]


def accessible_lesson(connection: sqlite3.Connection, lesson_id: str, user: dict) -> sqlite3.Row | None:
    if user["role"] == "teacher":
        return connection.execute("SELECT l.id FROM lessons l JOIN classes c ON c.id=l.class_id WHERE l.id=? AND c.teacher_id=?", (lesson_id, user["id"])).fetchone()
    return connection.execute("SELECT l.id FROM lessons l JOIN classes c ON c.id=l.class_id JOIN class_members m ON m.class_id=c.id WHERE l.id=? AND m.student_id=?", (lesson_id, user["id"])).fetchone()


async def broadcast_board_change(lesson_id: str, revision: int, objects: list[dict], page_number: int, page_count: int | None, exclude: WebSocket | None = None) -> None:
    async with board_connections_lock:
        sockets = [socket for socket in board_connections.get(lesson_id, set()) if socket is not exclude]
    stale: list[WebSocket] = []
    for socket in sockets:
        try:
            # Send the committed snapshot with the event. Clients can update immediately
            # without waiting for a second HTTP request (and without a stale poll winning).
            event = {"type": "board_updated", "revision": revision, "objects": objects, "pageNumber": page_number}
            if page_count is not None:
                event["pageCount"] = page_count
            await socket.send_json(event)
        except Exception:
            stale.append(socket)
    if stale:
        async with board_connections_lock:
            active = board_connections.get(lesson_id, set())
            for socket in stale:
                active.discard(socket)


async def broadcast_lesson_message(lesson_id: str, message: dict) -> None:
    async with board_connections_lock:
        sockets = list(board_connections.get(lesson_id, set()))
    stale: list[WebSocket] = []
    for socket in sockets:
        try:
            await socket.send_json(message)
        except Exception:
            stale.append(socket)
    if stale:
        async with board_connections_lock:
            active = board_connections.get(lesson_id, set())
            for socket in stale:
                active.discard(socket)


@app.websocket("/api/lessons/{lesson_id}/board/connect")
async def board_connect(websocket: WebSocket, lesson_id: str) -> None:
    await websocket.accept()
    try:
        auth_message = await websocket.receive_json()
        token = auth_message.get("token") if isinstance(auth_message, dict) else None
        if not token:
            await websocket.close(code=4401)
            return
        try:
            claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
            user = {"id": claims["sub"], "name": claims["name"], "email": claims["email"], "role": claims["role"]}
        except (jwt.InvalidTokenError, KeyError, TypeError):
            await websocket.close(code=4401)
            return
        with connect_db() as connection:
            if accessible_lesson(connection, lesson_id, user) is None:
                await websocket.close(code=4404)
                return
        async with board_connections_lock:
            board_connections.setdefault(lesson_id, set()).add(websocket)
        await websocket.send_json({"type": "ready"})
        for raised_user in raised_hands.get(lesson_id, {}).values():
            await websocket.send_json({"type": "raise_hand", **raised_user})
        if user["role"] == "teacher":
            for student_id in audio_permissions.get(lesson_id, set()):
                await websocket.send_json({"type": "audio_allowed", "userId": student_id})
        elif user["id"] in audio_permissions.get(lesson_id, set()):
            await websocket.send_json({"type": "audio_allowed", "userId": user["id"]})
        while True:
            message = json.loads(await websocket.receive_text())
            if isinstance(message, dict) and message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            if isinstance(message, dict) and message.get("type") == "raise_hand" and user["role"] == "student":
                raised_user = {"userId": user["id"], "name": user["name"]}
                raised_hands.setdefault(lesson_id, {})[user["id"]] = raised_user
                await broadcast_lesson_message(lesson_id, {"type": "raise_hand", **raised_user})
                continue
            if isinstance(message, dict) and message.get("type") == "raise_hand_reset" and user["role"] == "teacher":
                target_id = message.get("userId")
                if isinstance(target_id, str):
                    audio_permissions.get(lesson_id, set()).discard(target_id)
                    await broadcast_lesson_message(lesson_id, {"type": "audio_revoked", "userId": target_id})
                    raised_hands.get(lesson_id, {}).pop(target_id, None)
                    await broadcast_lesson_message(lesson_id, {"type": "raise_hand_reset", "userId": target_id})
                continue
            if isinstance(message, dict) and message.get("type") == "audio_allow" and user["role"] == "teacher":
                target_id = message.get("userId")
                if isinstance(target_id, str) and target_id in raised_hands.get(lesson_id, {}):
                    audio_permissions.setdefault(lesson_id, set()).add(target_id)
                    await broadcast_lesson_message(lesson_id, {"type": "audio_allowed", "userId": target_id})
                continue
            if isinstance(message, dict) and isinstance(message.get("type"), str) and message.get("type") in {"audio_signal", "audio_error"}:
                target_id = message.get("targetUserId")
                payload = message.get("signal") if message.get("type") == "audio_signal" else None
                if not isinstance(target_id, str):
                    continue
                if message.get("type") == "audio_signal":
                    if not isinstance(payload, dict) or len(json.dumps(payload)) > 20000:
                        continue
                    signal_type = payload.get("type")
                    if signal_type not in {"offer", "answer"} and not isinstance(payload.get("candidate"), str):
                        continue
                if user["role"] == "teacher":
                    authorized = target_id in audio_permissions.get(lesson_id, set())
                else:
                    with connect_db() as connection:
                        teacher = connection.execute("SELECT c.teacher_id FROM lessons l JOIN classes c ON c.id=l.class_id WHERE l.id=?", (lesson_id,)).fetchone()
                    authorized = user["id"] in audio_permissions.get(lesson_id, set()) and teacher is not None and target_id in {"teacher", teacher["teacher_id"]}
                    if authorized and teacher is not None:
                        target_id = teacher["teacher_id"]
                if authorized:
                    relay = {"type": message["type"], "fromUserId": user["id"], "toUserId": target_id}
                    if payload is not None:
                        relay["signal"] = payload
                    elif isinstance(message.get("detail"), str):
                        relay["detail"] = message["detail"][:240]
                    await broadcast_lesson_message(lesson_id, relay)
                continue
            if not isinstance(message, dict) or message.get("type") != "drag":
                continue
            item = message.get("object")
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                continue
            try:
                x, y = float(item["x"]), float(item["y"])
            except (KeyError, TypeError, ValueError):
                continue
            if not (0 <= x <= 100 and 0 <= y <= 100):
                continue
            item["x"], item["y"] = x, y
            with connect_db() as connection:
                if accessible_lesson(connection, lesson_id, user) is None:
                    await websocket.close(code=4404)
                    return
                lesson = connection.execute("SELECT status FROM lessons WHERE id=?", (lesson_id,)).fetchone()
                if lesson is None or lesson["status"] == "ended":
                    await websocket.send_json({"type": "board_error", "detail": "Урок завершён."})
                    continue
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("INSERT OR IGNORE INTO lesson_boards (lesson_id) VALUES (?)", (lesson_id,))
                board = connection.execute("SELECT active_page FROM lesson_boards WHERE lesson_id=?", (lesson_id,)).fetchone()
                page_number = int(message.get("pageNumber") or board["active_page"])
                if page_number != board["active_page"]:
                    continue
                page = connection.execute("SELECT objects_json FROM lesson_board_pages WHERE lesson_id=? AND page_number=?", (lesson_id, page_number)).fetchone()
                if page is None:
                    continue
                objects = json.loads(page["objects_json"])
                index = next((i for i, existing in enumerate(objects) if existing.get("id") == item["id"]), None)
                if index is None:
                    continue
                objects[index] = item
                encoded = json.dumps(objects, ensure_ascii=False)
                connection.execute("UPDATE lesson_board_pages SET objects_json=? WHERE lesson_id=? AND page_number=?", (encoded, lesson_id, page_number))
                connection.execute("UPDATE lesson_boards SET objects_json=?, updated_at=CURRENT_TIMESTAMP, revision=revision+1 WHERE lesson_id=?", (encoded, lesson_id))
                board = connection.execute("SELECT revision, active_page FROM lesson_boards WHERE lesson_id=?", (lesson_id,)).fetchone()
                revision = board["revision"]
            await broadcast_board_change(lesson_id, revision, objects, page_number, None, exclude=websocket)
    except WebSocketDisconnect:
        pass
    finally:
        async with board_connections_lock:
            sockets = board_connections.get(lesson_id)
            if sockets:
                sockets.discard(websocket)
                if not sockets:
                    board_connections.pop(lesson_id, None)
        if "user" in locals() and user.get("role") == "student":
            was_allowed = user["id"] in audio_permissions.get(lesson_id, set())
            audio_permissions.get(lesson_id, set()).discard(user["id"])
            if was_allowed:
                await broadcast_lesson_message(lesson_id, {"type": "audio_revoked", "userId": user["id"]})


@app.get("/api/lessons/{lesson_id}/board")
def get_board(lesson_id: str, user: dict = Depends(current_user)) -> dict:
    with connect_db() as connection:
        if accessible_lesson(connection, lesson_id, user) is None:
            raise HTTPException(status_code=404, detail="Урок не найден.")
        connection.execute("INSERT OR IGNORE INTO lesson_boards (lesson_id) VALUES (?)", (lesson_id,))
        row = connection.execute("SELECT objects_json, revision, active_page FROM lesson_boards WHERE lesson_id=?", (lesson_id,)).fetchone()
        connection.execute("INSERT OR IGNORE INTO lesson_board_pages (lesson_id, page_number, objects_json) VALUES (?, ?, ?)", (lesson_id, row["active_page"], row["objects_json"]))
        page = connection.execute("SELECT objects_json FROM lesson_board_pages WHERE lesson_id=? AND page_number=?", (lesson_id, row["active_page"])).fetchone()
        page_count = connection.execute("SELECT MAX(page_number) FROM lesson_board_pages WHERE lesson_id=?", (lesson_id,)).fetchone()[0] or 1
        return {"objects": json.loads(page["objects_json"]), "revision": row["revision"], "pageNumber": row["active_page"], "pageCount": page_count}


class BoardPageNavigation(BaseModel):
    direction: Literal["next", "previous"]


@app.post("/api/lessons/{lesson_id}/board/pages/navigate")
async def navigate_board_page(lesson_id: str, payload: BoardPageNavigation, user: dict = Depends(current_user)) -> dict:
    with connect_db() as connection:
        lesson = connection.execute("SELECT status FROM lessons WHERE id=?", (lesson_id,)).fetchone()
        if lesson is None or accessible_lesson(connection, lesson_id, user) is None:
            raise HTTPException(status_code=404, detail="Урок не найден.")
        if lesson["status"] == "ended":
            raise HTTPException(status_code=409, detail="Доска этого урока доступна только для просмотра.")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("INSERT OR IGNORE INTO lesson_boards (lesson_id) VALUES (?)", (lesson_id,))
        board = connection.execute("SELECT active_page, revision, objects_json FROM lesson_boards WHERE lesson_id=?", (lesson_id,)).fetchone()
        active_page = int(board["active_page"])
        page_count = connection.execute("SELECT MAX(page_number) FROM lesson_board_pages WHERE lesson_id=?", (lesson_id,)).fetchone()[0] or 1
        if payload.direction == "next":
            target_page = active_page + 1
            connection.execute("INSERT OR IGNORE INTO lesson_board_pages (lesson_id, page_number) VALUES (?, ?)", (lesson_id, target_page))
            page_count = max(page_count, target_page)
        else:
            target_page = max(1, active_page - 1)
            connection.execute("INSERT OR IGNORE INTO lesson_board_pages (lesson_id, page_number) VALUES (?, ?)", (lesson_id, target_page))
        target = connection.execute("SELECT objects_json FROM lesson_board_pages WHERE lesson_id=? AND page_number=?", (lesson_id, target_page)).fetchone()
        objects_json = target["objects_json"]
        connection.execute("UPDATE lesson_boards SET active_page=?, objects_json=?, updated_at=CURRENT_TIMESTAMP, revision=revision+1 WHERE lesson_id=?", (target_page, objects_json, lesson_id))
        revision = connection.execute("SELECT revision FROM lesson_boards WHERE lesson_id=?", (lesson_id,)).fetchone()["revision"]
        objects = json.loads(objects_json)
    await broadcast_board_change(lesson_id, revision, objects, target_page, page_count)
    return {"objects": objects, "revision": revision, "pageNumber": target_page, "pageCount": page_count}


class BoardUpdate(BaseModel):
    objects: list[dict] = Field(max_length=100)
    pageNumber: int | None = Field(default=None, ge=1)


@app.put("/api/lessons/{lesson_id}/board")
async def update_board(lesson_id: str, payload: BoardUpdate, user: dict = Depends(current_user)) -> dict:
    with connect_db() as connection:
        lesson = accessible_lesson(connection, lesson_id, user)
        if lesson is None:
            raise HTTPException(status_code=404, detail="Урок не найден.")
        if lesson["status"] == "ended":
            raise HTTPException(status_code=409, detail="Доска этого урока доступна только для просмотра.")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("INSERT OR IGNORE INTO lesson_boards (lesson_id) VALUES (?)", (lesson_id,))
        board = connection.execute("SELECT active_page FROM lesson_boards WHERE lesson_id=?", (lesson_id,)).fetchone()
        page_number = payload.pageNumber or board["active_page"]
        if connection.execute("SELECT 1 FROM lesson_board_pages WHERE lesson_id=? AND page_number=?", (lesson_id, page_number)).fetchone() is None:
            raise HTTPException(status_code=409, detail="Лист доски больше не существует.")
        encoded = json.dumps(payload.objects, ensure_ascii=False)
        connection.execute("UPDATE lesson_board_pages SET objects_json=? WHERE lesson_id=? AND page_number=?", (encoded, lesson_id, page_number))
        if page_number == board["active_page"]:
            connection.execute("UPDATE lesson_boards SET objects_json=?, updated_at=CURRENT_TIMESTAMP, revision=revision+1 WHERE lesson_id=?", (encoded, lesson_id))
        else:
            connection.execute("UPDATE lesson_boards SET updated_at=CURRENT_TIMESTAMP, revision=revision+1 WHERE lesson_id=?", (lesson_id,))
        board = connection.execute("SELECT revision, active_page FROM lesson_boards WHERE lesson_id=?", (lesson_id,)).fetchone()
        active_page = board["active_page"]
        active_objects = payload.objects if page_number == active_page else json.loads(connection.execute("SELECT objects_json FROM lesson_board_pages WHERE lesson_id=? AND page_number=?", (lesson_id, active_page)).fetchone()["objects_json"])
        revision = board["revision"]
        page_count = connection.execute("SELECT MAX(page_number) FROM lesson_board_pages WHERE lesson_id=?", (lesson_id,)).fetchone()[0] or 1
    await broadcast_board_change(lesson_id, revision, active_objects, active_page, page_count)
    return {"saved": True, "revision": revision}


class BoardObjectOperation(BaseModel):
    operation: Literal["upsert", "delete"]
    object: dict | None = None
    objectId: str | None = None
    pageNumber: int | None = Field(default=None, ge=1)


@app.post("/api/lessons/{lesson_id}/board/objects")
async def update_board_object(lesson_id: str, payload: BoardObjectOperation, user: dict = Depends(current_user)) -> dict:
    if payload.operation == "upsert" and (not payload.object or not isinstance(payload.object.get("id"), str)):
        raise HTTPException(status_code=422, detail="У объекта доски должен быть идентификатор.")
    if payload.operation == "delete" and not payload.objectId:
        raise HTTPException(status_code=422, detail="Не указан объект для удаления.")
    with connect_db() as connection:
        lesson = accessible_lesson(connection, lesson_id, user)
        if lesson is None:
            raise HTTPException(status_code=404, detail="Урок не найден.")
        status = connection.execute("SELECT status FROM lessons WHERE id=?", (lesson_id,)).fetchone()["status"]
        if status == "ended":
            raise HTTPException(status_code=409, detail="Доска этого урока доступна только для просмотра.")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("INSERT OR IGNORE INTO lesson_boards (lesson_id) VALUES (?)", (lesson_id,))
        board = connection.execute("SELECT active_page FROM lesson_boards WHERE lesson_id=?", (lesson_id,)).fetchone()
        page_number = payload.pageNumber or board["active_page"]
        page = connection.execute("SELECT objects_json FROM lesson_board_pages WHERE lesson_id=? AND page_number=?", (lesson_id, page_number)).fetchone()
        if page is None:
            raise HTTPException(status_code=409, detail="Лист доски больше не существует.")
        objects = json.loads(page["objects_json"])
        if payload.operation == "upsert":
            item = payload.object
            index = next((i for i, existing in enumerate(objects) if existing.get("id") == item["id"]), None)
            if index is None:
                if len(objects) >= 100:
                    raise HTTPException(status_code=409, detail="На доске достигнут лимит объектов.")
                objects.append(item)
            else:
                objects[index] = item
        else:
            objects = [item for item in objects if item.get("id") != payload.objectId]
        encoded = json.dumps(objects, ensure_ascii=False)
        connection.execute("UPDATE lesson_board_pages SET objects_json=? WHERE lesson_id=? AND page_number=?", (encoded, lesson_id, page_number))
        if page_number == board["active_page"]:
            connection.execute("UPDATE lesson_boards SET objects_json=?, updated_at=CURRENT_TIMESTAMP, revision=revision+1 WHERE lesson_id=?", (encoded, lesson_id))
        else:
            connection.execute("UPDATE lesson_boards SET updated_at=CURRENT_TIMESTAMP, revision=revision+1 WHERE lesson_id=?", (lesson_id,))
        board = connection.execute("SELECT revision, active_page FROM lesson_boards WHERE lesson_id=?", (lesson_id,)).fetchone()
        active_page = board["active_page"]
        active_objects = objects if page_number == active_page else json.loads(connection.execute("SELECT objects_json FROM lesson_board_pages WHERE lesson_id=? AND page_number=?", (lesson_id, active_page)).fetchone()["objects_json"])
        revision = board["revision"]
        page_count = connection.execute("SELECT MAX(page_number) FROM lesson_board_pages WHERE lesson_id=?", (lesson_id,)).fetchone()[0] or 1
    await broadcast_board_change(lesson_id, revision, active_objects, active_page, page_count)
    return {"objects": objects, "revision": revision}


@app.get("/api/storage")
def list_assets(user: dict = Depends(require_teacher)) -> list[dict]:
    with connect_db() as connection:
        return [dict(row) for row in connection.execute("SELECT id, filename, content_type AS contentType, created_at AS createdAt FROM assets WHERE teacher_id=? ORDER BY created_at DESC", (user["id"],)).fetchall()]


@app.post("/api/storage", status_code=201)
async def upload_asset(file: UploadFile = File(...), user: dict = Depends(require_teacher)) -> dict:
    if not (file.content_type or "").startswith(("image/", "video/")):
        raise HTTPException(status_code=400, detail="Можно загрузить изображение или видео.")
    asset_id = str(uuid.uuid4())
    UPLOADS_PATH.mkdir(parents=True, exist_ok=True)
    stored_name = f"{asset_id}{Path(file.filename or 'file').suffix[:12]}"
    destination = UPLOADS_PATH / stored_name
    with destination.open("wb") as output:
        shutil.copyfileobj(file.file, output)
    with connect_db() as connection:
        connection.execute("INSERT INTO assets (id, teacher_id, filename, stored_name, content_type) VALUES (?, ?, ?, ?, ?)", (asset_id, user["id"], Path(file.filename or "Файл").name, stored_name, file.content_type))
    return {"id": asset_id, "filename": Path(file.filename or "Файл").name, "contentType": file.content_type, "url": f"/api/storage/{asset_id}/file"}


@app.get("/api/storage/{asset_id}/file")
def get_asset(asset_id: str, user: dict = Depends(current_user)):
    from fastapi.responses import FileResponse

    with connect_db() as connection:
        if user["role"] == "teacher":
            asset = connection.execute("SELECT * FROM assets WHERE id=? AND teacher_id=?", (asset_id, user["id"])).fetchone()
        else:
            asset = connection.execute("SELECT a.* FROM assets a JOIN teachers t ON t.id=a.teacher_id JOIN students s ON s.teacher_id=t.id WHERE a.id=? AND s.id=?", (asset_id, user["id"])).fetchone()
    if asset is None:
        raise HTTPException(status_code=404, detail="Файл не найден.")
    return FileResponse(UPLOADS_PATH / asset["stored_name"], media_type=asset["content_type"], filename=asset["filename"])


FRONTEND_DIST = ROOT.parent / "frontend" / "dist"
if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
