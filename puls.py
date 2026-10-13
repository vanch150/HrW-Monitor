"""
HR Monitor Pro — сервер.
FastAPI + Bleak (быстрый коннект по MAC + сканер) + WebSocket + HTTP-загрузка медиа + память сессии.
Не требует установки дополнительных пакетов в существующий venv.
"""
from __future__ import annotations

import asyncio
import base64
import csv
import io
import json
import logging
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import traceback
import webbrowser
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Final

BASE_DIR: Final[Path] = Path(__file__).resolve().parent
STATIC_DIR: Final[Path] = BASE_DIR / "static"
GIFS_DIR: Final[Path] = STATIC_DIR / "gifs"
REPORTS_DIR: Final[Path] = BASE_DIR / "reports"
DATA_FILE: Final[Path] = BASE_DIR / "hr_config_lite.json"
LOG_FILE: Final[Path] = BASE_DIR / "hr_monitor.log"

GIFS_DIR.mkdir(parents=True, exist_ok=True)

_handlers: list[logging.Handler] = [
    logging.FileHandler(LOG_FILE, encoding="utf-8")
]
if sys.stdout is not None:
    _handlers.append(logging.StreamHandler())

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=_handlers,
)
logger = logging.getLogger(__name__)


def _handle_uncaught_exception(exc_type: Any, exc_value: Any, exc_tb: Any) -> None:
    if issubclass(exc_type, KeyboardInterrupt):
        sys.__excepthook__(exc_type, exc_value, exc_tb)
        return
    logger.critical(
        "Неперехваченная ошибка при запуске:\n%s",
        "".join(traceback.format_exception(exc_type, exc_value, exc_tb)),
    )


sys.excepthook = _handle_uncaught_exception

import pystray
import uvicorn
from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw
from starlette.responses import JSONResponse, Response
from starlette.types import Scope

mimetypes.add_type("video/webm", ".webm")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/apng", ".apng")
mimetypes.add_type("image/gif", ".gif")

HR_SERVICE_UUID: Final = "0000180d-0000-1000-8000-00805f9b34fb"
HR_CHAR_UUID: Final = "00002a37-0000-1000-8000-00805f9b34fb"

HOST: Final[str] = os.getenv("HR_HOST", "127.0.0.1")
PORT: Final[int] = int(os.getenv("HR_PORT", 8000))

GIF_CATEGORIES: Final = ("low", "med", "high", "global")
MAX_MEDIA_SIZE: Final = 15 * 1024 * 1024  # 15 МБ
MAX_HISTORY_POINTS: Final = 60
DELTA_WINDOW_S: Final = 5.0

HR_INACTIVITY_TIMEOUT_S: Final = 30.0
BLE_DIRECT_TIMEOUT_S: Final = 6.0
BLE_SCAN_TIMEOUT_S: Final = 5.0
BLE_CONNECT_TIMEOUT_S: Final = 15.0

HEX_COLOR_RE: Final = re.compile(r"^#[0-9a-fA-F]{6}$")


def check_single_instance() -> None:
    """Не даём запустить второй экземпляр поверх уже занятого порта."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if sock.connect_ex(("127.0.0.1", PORT)) == 0:
            logger.error("Экземпляр уже запущен на порту %d. Выход.", PORT)
            sys.exit(0)


check_single_instance()

DEFAULT_SETTINGS: Final[dict[str, Any]] = {
    "layout": "classic",
    "mode_visual": "smart",
    "thresh_med": 100,
    "thresh_high": 140,
    "c_low": "#00ffcc",
    "c_med": "#ffaa00",
    "c_high": "#ff0055",
    "bpm_min": 50,
    "bpm_max": 200,
    "bg": True,
    "bg_opacity": 0.85,
    "pos": "pos-center",
    "size": 100,
    "showPeak": True,
    "showBar": True,
    "showGraph": True,
    "showHeader": False,
    "customTitle": "",
    "gif_scale": 1.0,
    "gif_pulse": False,
    "color_lerp": True,
    "number_anim": "odometer",
    "show_delta": True,
    "delta_threshold": 12,
    "graph_thresholds": True,
    "audio_enabled": False,
    "audio_volume": 0.35,
}

VALID_LAYOUTS: Final = {"classic", "cyber", "pill", "ecg", "arc"}
VALID_VISUAL_MODES: Final = {"one_gif", "smart", "icon"}
VALID_POSITIONS: Final = {
    "pos-center",
    "pos-left",
    "pos-right",
    "pos-top-left",
    "pos-top-center",
    "pos-top-right",
    "pos-bottom-left",
    "pos-bottom-center",
    "pos-bottom",
    "pos-bottom-right",
}
VALID_NUMBER_ANIMS: Final = {"odometer", "pop", "none"}

BOOL_SETTING_KEYS: Final = (
    "bg",
    "showPeak",
    "showBar",
    "showGraph",
    "showHeader",
    "gif_pulse",
    "color_lerp",
    "show_delta",
    "graph_thresholds",
    "audio_enabled",
)

app_state: dict[str, Any] = {
    "gifs": {cat: None for cat in GIF_CATEGORIES},
    "settings": dict(DEFAULT_SETTINGS),
    "last_device_address": None,
    "last_device_name": None,
}


class SessionMemory:
    """Хранит историю пульса, пик и статистику на сервере, чтобы сцены в OBS не сбрасывали данные."""

    def __init__(self) -> None:
        self.current_bpm: int | None = None
        self.peak_bpm: int = 0
        self.min_recorded_bpm: int = 0
        self.current_delta: int = 0
        self.hr_history: list[int] = []
        self.recent_window: deque[tuple[float, int]] = deque()
        self.samples_sum: int = 0
        self.samples_count: int = 0
        self.high_zone_seconds: float = 0.0
        self._last_sample_mono: float | None = None
        self.started_at: float = time.time()
        self.csv_rows: deque[tuple[str, int, str, int]] = deque(maxlen=14400)
        self.bt_status: str = "searching"
        self.device_name: str = ""
        self.sim_active: bool = False

    def reset(self) -> None:
        self.current_bpm = None
        self.peak_bpm = 0
        self.min_recorded_bpm = 0
        self.current_delta = 0
        self.hr_history = []
        self.recent_window.clear()
        self.samples_sum = 0
        self.samples_count = 0
        self.high_zone_seconds = 0.0
        self._last_sample_mono = None
        self.started_at = time.time()
        self.csv_rows.clear()

    def record_bpm(self, bpm: int, settings: dict[str, Any]) -> dict[str, Any]:
        now_mono = time.monotonic()
        if self._last_sample_mono is None:
            dt = 1.0
        else:
            dt = min(max(0.0, now_mono - self._last_sample_mono), 5.0)
        self._last_sample_mono = now_mono

        self.current_bpm = bpm

        if bpm > self.peak_bpm:
            self.peak_bpm = bpm
        if self.min_recorded_bpm == 0 or bpm < self.min_recorded_bpm:
            self.min_recorded_bpm = bpm

        if not self.hr_history:
            self.hr_history = [bpm] * MAX_HISTORY_POINTS
        else:
            self.hr_history.append(bpm)
            if len(self.hr_history) > MAX_HISTORY_POINTS:
                self.hr_history.pop(0)

        self.recent_window.append((now_mono, bpm))
        while self.recent_window and (now_mono - self.recent_window[0][0] > DELTA_WINDOW_S):
            self.recent_window.popleft()

        baseline_bpm = self.recent_window[0][1] if self.recent_window else bpm
        self.current_delta = bpm - baseline_bpm

        self.samples_sum += bpm
        self.samples_count += 1

        t_high = int(settings.get("thresh_high", 140))
        t_med = int(settings.get("thresh_med", 100))
        if bpm >= t_high:
            zone = "high"
            self.high_zone_seconds += dt
        elif bpm >= t_med:
            zone = "med"
        else:
            zone = "low"

        ts_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.csv_rows.append((ts_str, bpm, zone, self.current_delta))

        return {
            "type": "hr",
            "val": bpm,
            "peak": self.peak_bpm,
            "delta": self.current_delta,
            "avg": self.avg_bpm,
            "high_zone_seconds": round(self.high_zone_seconds),
            "sim": self.sim_active,
        }

    @property
    def avg_bpm(self) -> int:
        if self.samples_count == 0:
            return 0
        return round(self.samples_sum / self.samples_count)

    def snapshot(self) -> dict[str, Any]:
        return {
            "type": "session_state",
            "current_bpm": self.current_bpm,
            "peak_bpm": self.peak_bpm,
            "min_bpm": self.min_recorded_bpm,
            "avg_bpm": self.avg_bpm,
            "delta": self.current_delta,
            "history": self.hr_history,
            "high_zone_seconds": round(self.high_zone_seconds),
            "bt_status": "simulator" if self.sim_active else self.bt_status,
            "device_name": self.device_name,
            "sim_active": self.sim_active,
        }


session = SessionMemory()


def sanitize_settings(raw: dict[str, Any]) -> dict[str, Any]:
    """Фильтрует неизвестные ключи и защищает лимиты от некорректных значений."""
    cleaned: dict[str, Any] = {}
    for k in DEFAULT_SETTINGS:
        if k in raw:
            cleaned[k] = raw[k]

    if "layout" in cleaned and cleaned["layout"] not in VALID_LAYOUTS:
        cleaned["layout"] = "classic"
    if "mode_visual" in cleaned and cleaned["mode_visual"] not in VALID_VISUAL_MODES:
        cleaned["mode_visual"] = "smart"
    if "pos" in cleaned and cleaned["pos"] not in VALID_POSITIONS:
        cleaned["pos"] = "pos-center"
    if "number_anim" in cleaned and cleaned["number_anim"] not in VALID_NUMBER_ANIMS:
        cleaned["number_anim"] = "odometer"

    for b_key in BOOL_SETTING_KEYS:
        if b_key in cleaned:
            cleaned[b_key] = bool(cleaned[b_key])

    if "customTitle" in cleaned:
        val = cleaned["customTitle"]
        cleaned["customTitle"] = str(val).strip()[:40] if val is not None else ""

    for c_key in ("c_low", "c_med", "c_high"):
        if c_key in cleaned:
            c_val = str(cleaned[c_key]).strip()
            if not HEX_COLOR_RE.match(c_val):
                cleaned[c_key] = DEFAULT_SETTINGS[c_key]
            else:
                cleaned[c_key] = c_val.lower()

    cur = app_state["settings"]
    try:
        bpm_min = int(cleaned.get("bpm_min", cur["bpm_min"]))
        bpm_max = int(cleaned.get("bpm_max", cur["bpm_max"]))
    except (ValueError, TypeError):
        bpm_min, bpm_max = 50, 200

    if bpm_max <= bpm_min:
        bpm_max = bpm_min + 10
    cleaned["bpm_min"] = max(20, min(250, bpm_min))
    cleaned["bpm_max"] = max(cleaned["bpm_min"] + 10, min(300, bpm_max))

    try:
        t_med = int(cleaned.get("thresh_med", cur["thresh_med"]))
        t_high = int(cleaned.get("thresh_high", cur["thresh_high"]))
    except (ValueError, TypeError):
        t_med, t_high = 100, 140

    if t_high <= t_med:
        t_high = t_med + 10
    cleaned["thresh_med"] = max(40, min(240, t_med))
    cleaned["thresh_high"] = max(cleaned["thresh_med"] + 5, min(260, t_high))

    if "delta_threshold" in cleaned:
        try:
            cleaned["delta_threshold"] = max(3, min(80, int(cleaned["delta_threshold"])))
        except (ValueError, TypeError):
            cleaned["delta_threshold"] = 12

    if "audio_volume" in cleaned:
        try:
            cleaned["audio_volume"] = max(0.0, min(1.0, float(cleaned["audio_volume"])))
        except (ValueError, TypeError):
            cleaned["audio_volume"] = 0.35

    if "gif_scale" in cleaned:
        try:
            cleaned["gif_scale"] = max(0.3, min(4.0, float(cleaned["gif_scale"])))
        except (ValueError, TypeError):
            cleaned["gif_scale"] = 1.0

    if "bg_opacity" in cleaned:
        try:
            cleaned["bg_opacity"] = max(0.05, min(1.0, float(cleaned["bg_opacity"])))
        except (ValueError, TypeError):
            cleaned["bg_opacity"] = 0.85

    if "size" in cleaned:
        try:
            cleaned["size"] = max(30, min(300, int(cleaned["size"])))
        except (ValueError, TypeError):
            cleaned["size"] = 100

    return cleaned


def load_state() -> None:
    if not DATA_FILE.exists():
        return
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        if isinstance(data.get("gifs"), dict):
            for cat in GIF_CATEGORIES:
                if cat in data["gifs"]:
                    app_state["gifs"][cat] = data["gifs"][cat]
        if isinstance(data.get("settings"), dict):
            app_state["settings"].update(sanitize_settings(data["settings"]))
        if isinstance(data.get("last_device_address"), str):
            app_state["last_device_address"] = data["last_device_address"]
        if isinstance(data.get("last_device_name"), str):
            app_state["last_device_name"] = data["last_device_name"]
        logger.info("Конфигурация загружена из %s", DATA_FILE)
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as e:
        logger.error("Ошибка чтения конфигурации: %s", e)


def save_state() -> None:
    """Атомарное сохранение конфигурации через временный файл."""
    try:
        tmp_file = DATA_FILE.with_suffix(".json.tmp")
        tmp_file.write_text(
            json.dumps(app_state, indent=4, ensure_ascii=False),
            encoding="utf-8",
        )
        tmp_file.replace(DATA_FILE)
    except OSError as e:
        logger.error("Ошибка сохранения конфигурации: %s", e)


class ConnectionManager:
    """Реестр активных WebSocket-клиентов с параллельной рассылкой."""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)

    async def broadcast(self, message: dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._connections)
        if not targets:
            return

        results = await asyncio.gather(
            *(ws.send_json(message) for ws in targets),
            return_exceptions=True,
        )
        dead = [
            ws
            for ws, res in zip(targets, results)
            if isinstance(res, Exception)
        ]

        if dead:
            async with self._lock:
                for ws in dead:
                    self._connections.discard(ws)


manager = ConnectionManager()

tray_icon: pystray.Icon | None = None
_icon_cache: dict[str, Image.Image] = {}
_last_tray_color: str = ""
_last_tray_menu_text: str = ""
_last_tray_title: str = ""


def create_icon(fill_color: str = "#00ffcc") -> Image.Image:
    """Рисует и кэширует иконку сердца в системном трее с цветом текущей зоны/статуса."""
    cached = _icon_cache.get(fill_color)
    if cached is not None:
        return cached

    image = Image.new("RGB", (64, 64), color=(24, 28, 38))
    dc = ImageDraw.Draw(image)
    dc.rectangle([(2, 2), (61, 61)], outline=fill_color, width=3)
    dc.polygon(
        [(32, 52), (12, 30), (12, 17), (24, 13), (32, 22), (40, 13), (52, 17), (52, 30)],
        fill=fill_color,
    )
    _icon_cache[fill_color] = image
    return image


def refresh_tray() -> None:
    """Обновляет цвет иконки, всплывающую подсказку и контекстное меню только при изменениях."""
    global _last_tray_color, _last_tray_menu_text, _last_tray_title
    if tray_icon is None:
        return

    s = app_state["settings"]
    bpm = session.current_bpm

    if session.sim_active:
        color = "#a855f7"
        status_txt = f"Симулятор: {bpm or '--'} BPM"
    elif session.bt_status != "connected":
        color = "#64748b"
        status_txt = "Поиск датчика..."
    else:
        if bpm is not None and bpm >= int(s.get("thresh_high", 140)):
            color = s.get("c_high", "#ff0055")
        elif bpm is not None and bpm >= int(s.get("thresh_med", 100)):
            color = s.get("c_med", "#ffaa00")
        else:
            color = s.get("c_low", "#00ffcc")
        status_txt = f"Пульс: {bpm or '--'} BPM (Пик: {session.peak_bpm})"

    full_title = f"HR Monitor Pro — {status_txt}"

    try:
        if full_title != _last_tray_title:
            _last_tray_title = full_title
            tray_icon.title = full_title
        if color != _last_tray_color:
            _last_tray_color = color
            tray_icon.icon = create_icon(color)
        if status_txt != _last_tray_menu_text:
            _last_tray_menu_text = status_txt
            tray_icon.update_menu()
    except Exception:
        pass


_background_tasks: set[asyncio.Task[Any]] = set()
_last_hr_ts: float = 0.0
_server_loop: asyncio.AbstractEventLoop | None = None


def _spawn(coro: Any) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def process_and_broadcast_bpm(hr_value: int, from_sim: bool = False) -> None:
    if hr_value <= 0 or hr_value > 300:
        return
    if session.sim_active and not from_sim:
        return

    if not from_sim and session.bt_status != "connected":
        session.bt_status = "connected"

    payload = session.record_bpm(hr_value, app_state["settings"])
    refresh_tray()
    await manager.broadcast(payload)


def hr_handler(_sender: Any, data: bytearray) -> None:
    global _last_hr_ts
    try:
        if len(data) < 2:
            return
        _last_hr_ts = time.monotonic()
        flags = data[0]
        hr_value = int.from_bytes(data[1:3], "little") if (flags & 1) else data[1]
        _spawn(process_and_broadcast_bpm(hr_value, from_sim=False))
    except Exception as e:
        logger.error("Ошибка обработки HR-данных: %s", e)


async def set_bt_status(status: str, dev_name: str = "") -> None:
    session.bt_status = status
    if dev_name:
        session.device_name = dev_name
    refresh_tray()
    await manager.broadcast(session.snapshot())


async def connect_and_monitor(client: BleakClient, dev_label: str, dev_address: str) -> None:
    global _last_hr_ts
    try:
        await client.start_notify(HR_CHAR_UUID, hr_handler)
        _last_hr_ts = time.monotonic()

        if app_state.get("last_device_address") != dev_address:
            app_state["last_device_address"] = dev_address
            app_state["last_device_name"] = dev_label
            save_state()

        await set_bt_status("connected", dev_label)
        logger.info("Подключено к пульсометру: %s [%s]", dev_label, dev_address)

        while client.is_connected:
            await asyncio.sleep(1.0)
            if time.monotonic() - _last_hr_ts > HR_INACTIVITY_TIMEOUT_S:
                logger.warning(
                    "Нет данных от пульсометра более %.0f сек, переподключаюсь.",
                    HR_INACTIVITY_TIMEOUT_S,
                )
                break
    except BleakError as e:
        logger.error("Ошибка BLE во время мониторинга: %s", e)
    finally:
        if client.is_connected:
            try:
                await client.stop_notify(HR_CHAR_UUID)
            except Exception:
                pass
        await set_bt_status("searching")


async def bluetooth_worker() -> None:
    while True:
        try:
            saved_addr = app_state.get("last_device_address")
            saved_name = app_state.get("last_device_name") or saved_addr or "BLE HR Sensor"
            connected_directly = False

            if saved_addr:
                try:
                    async with BleakClient(saved_addr, timeout=BLE_DIRECT_TIMEOUT_S) as client:
                        if client.is_connected:
                            connected_directly = True
                            logger.info("Быстрое подключение по MAC к %s (%s)", saved_name, saved_addr)
                            await connect_and_monitor(client, str(saved_name), str(saved_addr))
                except Exception:
                    pass

            if not connected_directly:
                device = await BleakScanner.find_device_by_filter(
                    lambda d, adv: (
                        HR_SERVICE_UUID in (adv.service_uuids or [])
                        or (saved_addr is not None and d.address == saved_addr)
                    ),
                    timeout=BLE_SCAN_TIMEOUT_S,
                )
                if device:
                    dev_label = device.name or device.address
                    logger.info("Найдено устройство: %s", dev_label)
                    async with BleakClient(device, timeout=BLE_CONNECT_TIMEOUT_S) as client:
                        await connect_and_monitor(client, dev_label, device.address)

        except BleakError as e:
            logger.error("Ошибка Bluetooth: %s", e)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("Критическая ошибка в потоке Bluetooth: %s", e)

        await asyncio.sleep(2.5)


def detect_media_extension(data: bytes) -> str | None:
    if len(data) < 12:
        return None
    if data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        idat_pos = data.find(b"IDAT")
        actl_pos = data.find(b"acTL")
        if actl_pos != -1 and (idat_pos == -1 or actl_pos < idat_pos):
            return ".apng"
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return ".webm"
    if data[4:8] in (b"ftyp", b"moov", b"mdat", b"wide"):
        return ".mp4"
    return None


def validate_media_bytes(raw_bytes: bytes) -> tuple[bool, str, bytes]:
    if not raw_bytes:
        return False, "Пустой файл", b""
    if len(raw_bytes) > MAX_MEDIA_SIZE:
        return False, "Файл слишком большой (максимум 15 МБ)", b""

    ext = detect_media_extension(raw_bytes)
    if ext is None:
        return (
            False,
            "Неподдерживаемый формат (разрешены GIF, WebM, MP4, WebP, APNG/PNG)",
            b"",
        )
    return True, ext, raw_bytes


def validate_b64_media(b64_data: str) -> tuple[bool, str, bytes]:
    try:
        encoded = b64_data.split(",", 1)[1] if "," in b64_data else b64_data
        decoded = base64.b64decode(encoded, validate=True)
    except Exception as e:
        return False, f"Некорректные base64-данные: {e}", b""
    return validate_media_bytes(decoded)


def clear_category_files(category: str) -> None:
    for old_file in GIFS_DIR.glob(f"{category}.*"):
        try:
            old_file.unlink()
        except OSError as e:
            logger.error("Не удалось удалить старый файл %s: %s", old_file, e)


def save_category_media(category: str, ext: str, content: bytes) -> str:
    clear_category_files(category)
    filename = f"{category}{ext}"
    filepath = GIFS_DIR / filename
    filepath.write_bytes(content)
    rel_url = f"gifs/{filename}?v={int(time.time())}"
    app_state["gifs"][category] = rel_url
    save_state()
    return rel_url


class Utf8StaticFiles(StaticFiles):
    _TEXTUAL_SUFFIXES: Final = {".js", ".css", ".html", ".json", ".svg"}

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        suffix = Path(path).suffix.lower()
        if suffix in self._TEXTUAL_SUFFIXES:
            media_type = response.media_type or ""
            if media_type and "charset" not in media_type:
                response.headers["content-type"] = f"{media_type}; charset=utf-8"
            response.headers["cache-control"] = "no-store, no-cache, must-revalidate, max-age=0"
        return response


def _ignore_windows_connection_reset(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
    exc = context.get("exception")
    if isinstance(exc, ConnectionResetError):
        return
    loop.default_exception_handler(context)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _server_loop
    _server_loop = asyncio.get_running_loop()
    _server_loop.set_exception_handler(_ignore_windows_connection_reset)
    load_state()
    refresh_tray()
    bt_task = asyncio.create_task(bluetooth_worker())
    try:
        yield
    finally:
        bt_task.cancel()
        await asyncio.gather(bt_task, return_exceptions=True)
        save_state()


app = FastAPI(lifespan=lifespan, title="HR Monitor Pro", version="2.1")

ALLOWED_ORIGINS: Final = [
    f"http://localhost:{PORT}",
    f"http://127.0.0.1:{PORT}",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    return Response(status_code=204)


@app.post("/api/upload/{category}")
async def api_upload_media(category: str, request: Request) -> JSONResponse:
    if category not in GIF_CATEGORIES:
        return JSONResponse({"ok": False, "error": "Недопустимая категория"}, status_code=400)

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_MEDIA_SIZE:
                return JSONResponse(
                    {"ok": False, "error": "Файл слишком большой (максимум 15 МБ)"},
                    status_code=413,
                )
        except ValueError:
            pass

    chunks = bytearray()
    async for chunk in request.stream():
        chunks.extend(chunk)
        if len(chunks) > MAX_MEDIA_SIZE:
            logger.warning("Превышен лимит 15 МБ при потоковой загрузке для '%s'", category)
            return JSONResponse(
                {"ok": False, "error": "Файл слишком большой (максимум 15 МБ)"},
                status_code=413,
            )

    raw_bytes = bytes(chunks)
    is_valid, ext_or_err, content = validate_media_bytes(raw_bytes)
    if not is_valid:
        logger.warning("Отклонён файл (%s): %s", category, ext_or_err)
        return JSONResponse({"ok": False, "error": ext_or_err}, status_code=400)

    rel_url = save_category_media(category, ext_or_err, content)
    await manager.broadcast(
        {
            "type": "config_update",
            "settings": app_state["settings"],
            "gifs": app_state["gifs"],
        }
    )
    logger.info("Загружен медиафайл для '%s': %s (%d байт)", category, rel_url, len(content))
    return JSONResponse({"ok": True, "url": rel_url, "gifs": app_state["gifs"]})


@app.delete("/api/upload/{category}")
async def api_delete_media(category: str) -> JSONResponse:
    if category not in GIF_CATEGORIES:
        return JSONResponse({"ok": False, "error": "Недопустимая категория"}, status_code=400)

    clear_category_files(category)
    app_state["gifs"][category] = None
    save_state()
    await manager.broadcast(
        {
            "type": "config_update",
            "settings": app_state["settings"],
            "gifs": app_state["gifs"],
        }
    )
    return JSONResponse({"ok": True, "gifs": app_state["gifs"]})


@app.post("/api/session/reset")
async def api_reset_session() -> JSONResponse:
    session.reset()
    refresh_tray()
    await manager.broadcast(session.snapshot())
    return JSONResponse({"ok": True, "session": session.snapshot()})


@app.get("/api/session/export")
async def api_export_session_csv() -> Response:
    csv_text = build_csv_report()
    filename = f"hr_session_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    return Response(
        content=csv_text.encode("utf-8-sig"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def build_csv_report() -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(["Timestamp", "BPM", "Zone", "Delta_5s"])
    for row in session.csv_rows:
        writer.writerow(row)
    return buf.getvalue()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        await websocket.send_json(
            {
                "type": "config_update",
                "settings": app_state["settings"],
                "gifs": app_state["gifs"],
            }
        )
        await websocket.send_json(session.snapshot())

        if session.current_bpm is not None:
            await websocket.send_json(
                {
                    "type": "hr",
                    "val": session.current_bpm,
                    "peak": session.peak_bpm,
                    "delta": session.current_delta,
                    "avg": session.avg_bpm,
                    "high_zone_seconds": round(session.high_zone_seconds),
                    "sim": session.sim_active,
                }
            )

        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if not isinstance(msg, dict):
                continue

            msg_type = msg.get("type")

            if msg_type == "pong":
                continue

            elif msg_type == "settings":
                data = msg.get("data")
                if not isinstance(data, dict):
                    continue
                app_state["settings"].update(sanitize_settings(data))
                save_state()
                refresh_tray()
                await manager.broadcast(
                    {
                        "type": "config_update",
                        "settings": app_state["settings"],
                        "gifs": app_state["gifs"],
                    }
                )

            elif msg_type == "sim_toggle":
                session.sim_active = bool(msg.get("active", False))
                refresh_tray()
                await manager.broadcast(session.snapshot())
                if session.sim_active and isinstance(msg.get("val"), (int, float)):
                    await process_and_broadcast_bpm(int(msg["val"]), from_sim=True)

            elif msg_type == "sim_bpm":
                val = msg.get("val")
                if isinstance(val, (int, float)):
                    session.sim_active = True
                    await process_and_broadcast_bpm(int(val), from_sim=True)

            elif msg_type == "reset_peak":
                session.reset()
                refresh_tray()
                await manager.broadcast(session.snapshot())

            elif msg_type == "upload_gif":
                category = msg.get("category")
                if category not in GIF_CATEGORIES:
                    continue

                b64_data = msg.get("data")
                if not b64_data:
                    clear_category_files(category)
                    app_state["gifs"][category] = None
                else:
                    if not isinstance(b64_data, str):
                        continue
                    is_valid, ext_or_err, content = validate_b64_media(b64_data)
                    if not is_valid:
                        logger.warning("Отклонён медиафайл (%s): %s", category, ext_or_err)
                        continue
                    save_category_media(category, ext_or_err, content)

                save_state()
                await manager.broadcast(
                    {
                        "type": "config_update",
                        "settings": app_state["settings"],
                        "gifs": app_state["gifs"],
                    }
                )

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning("WebSocket закрыт с ошибкой: %s", e)
    finally:
        await manager.disconnect(websocket)


app.mount("/", Utf8StaticFiles(directory=STATIC_DIR, html=True), name="static")

server_instance: uvicorn.Server | None = None


def run_server() -> None:
    global server_instance
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    config = uvicorn.Config(
        app=app,
        host=HOST,
        port=PORT,
        loop="asyncio",
        log_config=None,
        ws_ping_interval=20.0,
        ws_ping_timeout=20.0,
        ws_max_size=16 * 1024 * 1024,
    )
    server_instance = uvicorn.Server(config)
    loop.run_until_complete(server_instance.serve())


def get_tray_status_label(_item: Any) -> str:
    if session.sim_active:
        return f"⚡ Симулятор: {session.current_bpm or '--'} BPM"
    if session.bt_status == "connected":
        return f"❤️ Подключено: {session.current_bpm or '--'} BPM (Пик: {session.peak_bpm})"
    return "🔍 Поиск датчика..."


def tray_reset_session() -> None:
    if _server_loop is not None:
        asyncio.run_coroutine_threadsafe(api_reset_session(), _server_loop)


def tray_save_csv() -> None:
    try:
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        filepath = REPORTS_DIR / f"hr_session_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        filepath.write_text(build_csv_report(), encoding="utf-8-sig")
        os.startfile(str(REPORTS_DIR))
    except Exception as e:
        logger.error("Не удалось сохранить CSV-отчёт: %s", e)


def stop_app(icon: pystray.Icon) -> None:
    if server_instance is not None:
        server_instance.should_exit = True
    icon.stop()


def main() -> None:
    global tray_icon
    server_thread = threading.Thread(target=run_server, daemon=False)
    server_thread.start()

    tray_icon = pystray.Icon("HR Monitor Pro", create_icon("#64748b"), "HR Monitor Pro")
    tray_icon.menu = pystray.Menu(
        pystray.MenuItem(get_tray_status_label, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "Открыть настройки в браузере",
            lambda: webbrowser.open(f"http://localhost:{PORT}"),
        ),
        pystray.MenuItem("Сбросить пик и статистику", lambda: tray_reset_session()),
        pystray.MenuItem("Сохранить CSV-отчёт в папку reports", lambda: tray_save_csv()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Выход", lambda: stop_app(tray_icon)),
    )

    try:
        tray_icon.run()
    except KeyboardInterrupt:
        stop_app(tray_icon)
    finally:
        if server_instance is not None:
            server_instance.should_exit = True
        server_thread.join(timeout=5.0)


if __name__ == "__main__":
    main()