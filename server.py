"""BP Counter - учёт бонусных баллов GTA5RP.

Локальный веб-сервер на стандартной библиотеке (без зависимостей).
База данных - обычные .json файлы в папке data/.

Запуск:  python server.py [порт]
"""

import json
import os
import random
import re
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.path.join(BASE_DIR, "data")
USERS_DIR = os.path.join(DATA_DIR, "users")
TASKS_FILE = os.path.join(DATA_DIR, "tasks.json")

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8770

# Москва = UTC+3 круглый год (перехода на летнее время нет).
MSK = timezone(timedelta(hours=3))
RESET_HOUR = 7  # сутки начинаются в 07:00 по Москве

CODE_LENGTH = 16
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # без похожих символов
CODE_RE = re.compile(r"^[A-Z0-9]{16}$")

MAX_BODY = 256 * 1024
_lock = threading.Lock()

DEFAULT_TASKS = [
    {"id": "daily_login", "name": "Ежедневный вход", "bp": 5, "group": "Ежедневные"},
    {"id": "daily_case", "name": "Открыть ежедневный кейс", "bp": 10, "group": "Ежедневные"},
    {"id": "daily_quiz", "name": "Викторина", "bp": 15, "group": "Ежедневные"},
    {"id": "work_shift", "name": "Отработать смену на работе", "bp": 20, "group": "Работа"},
    {"id": "delivery", "name": "Развозка / доставка", "bp": 15, "group": "Работа"},
    {"id": "farm", "name": "Ферма / сбор ресурсов", "bp": 15, "group": "Работа"},
    {"id": "family_task", "name": "Семейное задание", "bp": 25, "group": "Активности"},
    {"id": "capture", "name": "Захват территории", "bp": 30, "group": "Активности"},
    {"id": "race", "name": "Гонка", "bp": 20, "group": "Активности"},
    {"id": "arena", "name": "Арена / ивент", "bp": 25, "group": "Активности"},
    {"id": "online_2h", "name": "2 часа онлайна", "bp": 10, "group": "Онлайн"},
    {"id": "online_5h", "name": "5 часов онлайна", "bp": 25, "group": "Онлайн"},
]


# ---------------------------------------------------------------- сутки/время

def now_msk():
    return datetime.now(MSK)


def day_key(dt=None):
    """Ключ игровых суток: сутки идут с 07:00 МСК до 07:00 МСК."""
    dt = dt or now_msk()
    return (dt - timedelta(hours=RESET_HOUR)).date().isoformat()


def next_reset(dt=None):
    dt = dt or now_msk()
    reset = dt.replace(hour=RESET_HOUR, minute=0, second=0, microsecond=0)
    if dt >= reset:
        reset += timedelta(days=1)
    return reset


# ------------------------------------------------------------------- хранение

def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_tasks():
    tasks = read_json(TASKS_FILE, None)
    if not tasks:
        write_json(TASKS_FILE, DEFAULT_TASKS)
        return list(DEFAULT_TASKS)
    return tasks


def user_path(code):
    return os.path.join(USERS_DIR, code + ".json")


def new_code():
    while True:
        code = "".join(random.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        if not os.path.exists(user_path(code)):
            return code


def blank_user(code):
    return {
        "code": code,
        "created": now_msk().isoformat(timespec="seconds"),
        "vip": False,
        "x2week": False,
        "day": day_key(),
        "done": [],
        "hidden": [],
        "progress": {},
        "routine": [],
        "custom": [],
        "total": 0,
        "history": {},
    }


def load_user(code):
    if not CODE_RE.match(code or ""):
        return None
    return read_json(user_path(code), None)


def all_tasks(user):
    return load_tasks() + list(user.get("custom", []))


def multiplier(user):
    return (2 if user.get("vip") else 1) * (2 if user.get("x2week") else 1)


def today_bp(user):
    by_id = {t["id"]: t for t in all_tasks(user)}
    hidden = set(user.get("hidden", []))
    base = sum(by_id[i]["bp"] for i in user.get("done", [])
               if i in by_id and i not in hidden)
    return base * multiplier(user)


def max_bp(user):
    """Личный потолок за день: всё доступное, с учётом множителя."""
    hidden = set(user.get("hidden", []))
    base = sum(t["bp"] for t in all_tasks(user) if t["id"] not in hidden)
    return base * multiplier(user)


def rollover(user):
    """Если наступили новые сутки - обнулить задания и записать вчерашний итог."""
    today = day_key()
    if user.get("day") == today:
        return False
    earned = today_bp(user)
    if earned:
        user.setdefault("history", {})[user.get("day", "?")] = earned
        user["total"] = user.get("total", 0) + earned
        # храним только последние 60 дней
        for old in sorted(user["history"])[:-60]:
            del user["history"][old]
    user["day"] = today
    user["done"] = []
    user["progress"] = {}
    return True


def normalize_routine(order, by_id):
    """Маршрут -> список шагов вида {"id": ..., "part": сколько действий за раз}.

    Задание со счётчиком можно разбить на несколько шагов (порт: 10 + 15),
    поэтому такие id разрешено повторять. Обычные задания — по одному разу.
    """
    clean = []
    seen = {}
    for item in order[:200]:
        if isinstance(item, dict):
            tid = str(item.get("id", ""))
            part = item.get("part")
        else:
            tid, part = str(item), None

        task = by_id.get(tid)
        if task is None:
            continue

        steps = task.get("steps") or 0
        seen[tid] = seen.get(tid, 0) + 1
        if seen[tid] > 1 and not steps:
            continue                      # дубли только у заданий со счётчиком
        if seen[tid] > 20:
            continue

        if steps:
            try:
                part = int(part)
            except (TypeError, ValueError):
                part = steps
            part = max(1, min(steps, part))
        else:
            part = None

        clean.append({"id": tid, "part": part})
    return clean


def public_state(user):
    return {
        "code": user["code"],
        "vip": bool(user.get("vip")),
        "x2week": bool(user.get("x2week")),
        "multiplier": multiplier(user),
        "done": user.get("done", []),
        "hidden": user.get("hidden", []),
        "progress": user.get("progress", {}),
        "routine": normalize_routine(user.get("routine", []),
                                     {t["id"]: t for t in all_tasks(user)}),
        "tasks": all_tasks(user),
        "today": today_bp(user),
        "max_today": max_bp(user),
        "total": user.get("total", 0),
        "day": user.get("day"),
        "history": user.get("history", {}),
        "next_reset": next_reset().isoformat(timespec="seconds"),
        "server_time": now_msk().isoformat(timespec="seconds"),
    }


def with_user(code, mutate=None):
    """Загрузить пользователя, применить изменения, сохранить. Под блокировкой."""
    with _lock:
        user = load_user(code)
        if user is None:
            return None
        changed = rollover(user)
        if mutate is not None:
            changed = bool(mutate(user)) or changed
        if changed:
            write_json(user_path(user["code"]), user)
        return public_state(user)


# --------------------------------------------------------------------- сервер

class Handler(BaseHTTPRequestHandler):
    server_version = "BPCounter"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # тихий лог

    # ---- вспомогательное

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, name):
        path = os.path.join(STATIC_DIR, name)
        if not os.path.isfile(path):
            self.send_json({"error": "not found"}, 404)
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(os.path.splitext(path)[1], "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    # ---- маршруты

    def do_GET(self):
        route = urlparse(self.path)
        path = route.path

        if path == "/":
            return self.send_file("index.html")
        if path in ("/app.js", "/style.css"):
            return self.send_file(path.lstrip("/"))

        if path == "/api/state":
            code = (parse_qs(route.query).get("code") or [""])[0].strip().upper()
            state = with_user(code)
            if state is None:
                return self.send_json({"error": "Код не найден"}, 404)
            return self.send_json(state)

        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        data = self.read_body()
        code = str(data.get("code", "")).strip().upper()

        if path == "/api/register":
            with _lock:
                user = blank_user(new_code())
                write_json(user_path(user["code"]), user)
            return self.send_json(public_state(user))

        if path == "/api/login":
            state = with_user(code)
            if state is None:
                return self.send_json({"error": "Такого кода нет"}, 404)
            return self.send_json(state)

        if path == "/api/task":
            task_id = str(data.get("id", ""))
            done = bool(data.get("done"))

            def mutate(user):
                by_id = {t["id"]: t for t in all_tasks(user)}
                if task_id not in by_id:
                    return False
                lst = user.setdefault("done", [])
                if done and task_id not in lst:
                    lst.append(task_id)
                elif not done and task_id in lst:
                    lst.remove(task_id)
                else:
                    return False
                # счётчик подтягиваем за галочкой: закрыли - полный, сняли - обнулили
                steps = by_id[task_id].get("steps")
                if steps:
                    user.setdefault("progress", {})[task_id] = steps if done else 0
                return True

            state = with_user(code, mutate)

        elif path == "/api/progress":
            task_id = str(data.get("id", ""))
            try:
                delta = int(data.get("delta", 0))
            except (TypeError, ValueError):
                delta = 0

            def mutate(user):
                by_id = {t["id"]: t for t in all_tasks(user)}
                task = by_id.get(task_id)
                if not task or not task.get("steps") or not delta:
                    return False
                steps = task["steps"]
                progress = user.setdefault("progress", {})
                value = min(steps, max(0, progress.get(task_id, 0) + delta))
                progress[task_id] = value

                # задание закрывается само, когда счётчик добит до конца
                lst = user.setdefault("done", [])
                if value >= steps and task_id not in lst:
                    lst.append(task_id)
                elif value < steps and task_id in lst:
                    lst.remove(task_id)
                return True

            state = with_user(code, mutate)

        elif path == "/api/hidden":
            task_id = str(data.get("id", ""))
            hide = bool(data.get("hidden"))

            def mutate(user):
                ids = {t["id"] for t in all_tasks(user)}
                if task_id not in ids:
                    return False
                lst = user.setdefault("hidden", [])
                if hide and task_id not in lst:
                    lst.append(task_id)
                    if task_id in user.get("done", []):
                        user["done"].remove(task_id)  # недоступное не считаем
                    user.get("progress", {}).pop(task_id, None)
                elif not hide and task_id in lst:
                    lst.remove(task_id)
                else:
                    return False
                return True

            state = with_user(code, mutate)

        elif path == "/api/routine":
            order = data.get("order")

            def mutate(user):
                if not isinstance(order, list):
                    return False
                clean = normalize_routine(order, {t["id"]: t for t in all_tasks(user)})
                if clean == user.get("routine", []):
                    return False
                user["routine"] = clean
                return True

            state = with_user(code, mutate)

        elif path == "/api/settings":
            def mutate(user):
                for key in ("vip", "x2week"):
                    if key in data:
                        user[key] = bool(data[key])
                return True

            state = with_user(code, mutate)

        elif path == "/api/custom/add":
            name = str(data.get("name", "")).strip()[:60]
            try:
                bp = max(1, min(100000, int(data.get("bp", 0))))
            except (TypeError, ValueError):
                bp = 0
            if not name or not bp:
                return self.send_json({"error": "Нужно название и количество BP"}, 400)

            def mutate(user):
                custom = user.setdefault("custom", [])
                if len(custom) >= 40:
                    return False
                custom.append({
                    "id": "c_%d" % random.getrandbits(32),
                    "name": name,
                    "bp": bp,
                    "group": "Свои задания",
                    "custom": True,
                })
                return True

            state = with_user(code, mutate)

        elif path == "/api/custom/remove":
            task_id = str(data.get("id", ""))

            def mutate(user):
                before = len(user.get("custom", []))
                user["custom"] = [t for t in user.get("custom", []) if t["id"] != task_id]
                if task_id in user.get("done", []):
                    user["done"].remove(task_id)
                return len(user["custom"]) != before

            state = with_user(code, mutate)

        elif path == "/api/reset":
            def mutate(user):
                user["done"] = []
                user["progress"] = {}
                return True

            state = with_user(code, mutate)

        else:
            return self.send_json({"error": "not found"}, 404)

        if state is None:
            return self.send_json({"error": "Код не найден"}, 404)
        return self.send_json(state)


def local_ip():
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    try:  # чтобы кириллица в консоли не ломала запуск
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    os.makedirs(USERS_DIR, exist_ok=True)
    load_tasks()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("BP Counter запущен")
    print("  на этом ПК:         http://localhost:%d" % PORT)
    print("  с других устройств: http://%s:%d" % (local_ip(), PORT))
    print("  сброс суток:        07:00 МСК (сейчас %s МСК)" % now_msk().strftime("%H:%M"))
    print("  Ctrl+C - выход")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
