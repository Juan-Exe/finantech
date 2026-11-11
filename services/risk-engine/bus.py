"""Cliente del bus de eventos para el servicio Python.

Reproduce el contrato de shared/bus.js y shared/auth.js:
  - JWT HS256 firmado con el mismo secreto (rol "servicio") para hablar entre servicios.
  - POST /subscriptions para suscribirse (idempotente, se repite cada 4 s).
  - POST /publish para emitir eventos, con patrón outbox y reintentos.
  - El bus entrega los eventos por HTTP a POST /events de este servicio.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

JWT_SECRET = os.environ.get("JWT_SECRET", "finantech-dev-secret-cambiar-en-produccion")
PORT_OFFSET = int(os.environ.get("PORT_OFFSET", "0"))

BASE_PORTS = {"bus": 4100, "risk": 4009}
PORTS = {name: port + PORT_OFFSET for name, port in BASE_PORTS.items()}
BUS_URL = f"http://127.0.0.1:{PORTS['bus']}"

SERVICE = "risk-engine"


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def sign_jwt(payload: dict, ttl_seconds: int = 600) -> str:
    """JWT HS256 compatible con shared/jwt.js."""
    now = int(time.time())
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body_obj = {"iss": "finantech-identity", "iat": now, "exp": now + ttl_seconds, **payload}
    body = _b64url(json.dumps(body_obj, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}".encode()
    sig = _b64url(hmac.new(JWT_SECRET.encode(), signing_input, hashlib.sha256).digest())
    return f"{header}.{body}.{sig}"


def verify_jwt(token: str | None) -> dict | None:
    """Valida un JWT HS256 (confianza cero: este servicio también verifica por sí mismo)."""
    parts = str(token or "").split(".")
    if len(parts) != 3:
        return None
    header, body, sig = parts
    try:
        if json.loads(_b64url_decode(header)).get("alg") != "HS256":
            return None
        expected = hmac.new(JWT_SECRET.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(_b64url_decode(sig), expected):
            return None
        payload = json.loads(_b64url_decode(body))
        if not payload.get("exp") or float(payload["exp"]) < time.time():
            return None
        return payload
    except Exception:
        return None


_token_cache: dict[str, tuple[str, float]] = {}


def service_token() -> str:
    cached = _token_cache.get(SERVICE)
    if cached and cached[1] > time.time() + 60:
        return cached[0]
    ttl = 600
    token = sign_jwt({"sub": f"svc:{SERVICE}", "role": "servicio", "typ": "access"}, ttl)
    _token_cache[SERVICE] = (token, time.time() + ttl)
    return token


def _request(url: str, method: str, body: dict | None, timeout: float = 5.0) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    req.add_header("authorization", f"Bearer {service_token()}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode() or "{}"
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as err:
        raw = err.read().decode() or "{}"
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, {"error": raw}


class BusClient:
    """Suscripción al bus + publicación con outbox y reintentos."""

    def __init__(self, topics: list[str], port: int, log=print) -> None:
        self.topics = topics
        self.port = port
        self.log = log
        self.outbox: list[dict] = []
        self.processed: set[str] = set()
        self.processed_order: list[str] = []
        self.registered = False
        self._lock = threading.Lock()
        self._stop = threading.Event()

    # ---------- consumo ----------
    def already_processed(self, event_id: str) -> bool:
        """Idempotencia por id de evento, igual que el cliente de Node."""
        with self._lock:
            if event_id in self.processed:
                return True
            self.processed.add(event_id)
            self.processed_order.append(event_id)
            if len(self.processed_order) > 5000:
                for old in self.processed_order[:1000]:
                    self.processed.discard(old)
                del self.processed_order[:1000]
            return False

    # ---------- publicación ----------
    def publish(self, topic: str, payload: dict, correlation_id: str | None = None) -> dict:
        event = {
            "id": str(uuid.uuid4()),
            "topic": topic,
            "source": SERVICE,
            "occurredAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "correlationId": correlation_id or payload.get("creditId"),
            "payload": payload,
        }
        with self._lock:
            self.outbox.append(event)
        self._flush()
        return event

    def _flush(self) -> None:
        while True:
            with self._lock:
                if not self.outbox:
                    return
                event = self.outbox[0]
            try:
                status, _ = _request(f"{BUS_URL}/publish", "POST", event)
                if status >= 400:
                    return  # el bus rechazó: queda en el outbox para reintentar
            except Exception:
                return  # bus no disponible: se reintenta luego
            with self._lock:
                if self.outbox and self.outbox[0] is event:
                    self.outbox.pop(0)

    # ---------- suscripción ----------
    def register(self) -> None:
        try:
            status, _ = _request(
                f"{BUS_URL}/subscriptions",
                "POST",
                {
                    "service": SERVICE,
                    "url": f"http://127.0.0.1:{self.port}/events",
                    "topics": self.topics,
                },
            )
            ok = status < 400
            if ok and not self.registered:
                self.log(f"suscrito al bus: {', '.join(self.topics)}")
            self.registered = ok
        except Exception:
            self.registered = False

    def start(self) -> None:
        """Re-suscripción periódica idempotente, para recuperarse si el bus se reinicia."""

        def loop() -> None:
            while not self._stop.is_set():
                self._flush()
                if self.topics:
                    self.register()
                self._stop.wait(4.0)

        self.register()
        threading.Thread(target=loop, daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
