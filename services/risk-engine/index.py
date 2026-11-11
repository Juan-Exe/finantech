"""Motor de riesgo en Python — servicio de scoring y generación de datos en tiempo real.

Qué aporta frente a la central de riesgo simulada:
  1. SCORING REAL: entrena una regresión logística y calcula la probabilidad de
     incumplimiento de cada solicitud a partir de sus características, con el aporte
     de cada variable (modelo explicable), en lugar de devolver un valor fijo.
  2. DATOS EN TIEMPO REAL: se suscribe a TODO el bus de eventos y mantiene métricas
     que se recalculan con cada evento (cartera, aprobación, PD promedio, serie temporal).
  3. REENTRENAMIENTO EN CALIENTE: los desenlaces observados en el bus (pagos al día
     frente a desembolsos fallidos) se incorporan al conjunto de entrenamiento.

Usa solo la librería estándar de Python + NumPy, para no romper la promesa del
proyecto de instalarse sin dependencias pesadas.

Puerto: 4009 (+ PORT_OFFSET).
"""
from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402

from bus import PORTS, BusClient, verify_jwt  # noqa: E402
from model import FEATURES, PRODUCT_RISK, RiskModel, featurize  # noqa: E402

PORT = PORTS["risk"]
STAFF_ROLES = ("analista", "admin")
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "data"
)
STATE_FILE = os.path.join(DATA_DIR, "risk-engine.json")


def log(message: str) -> None:
    print(f"[risk-engine] {message}", flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# --------------------------------------------------------------------------- #
# Estado en vivo: se alimenta del bus de eventos.
# --------------------------------------------------------------------------- #
class LiveState:
    """Métricas recalculadas en tiempo real a partir de los eventos del bus."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.scores: dict[str, dict] = {}          # creditId -> último scoring
        self.events_seen = 0
        self.by_topic: dict[str, int] = {}
        self.timeline: deque[dict] = deque(maxlen=500)
        self.observed: list[tuple[list[float], float]] = []  # (features, incumplió)
        self.pending: dict[str, dict] = {}         # creditId -> features de la solicitud
        self.last_training: dict | None = None
        self.started_at = now_iso()

    # ---------- persistencia ligera ----------
    def save(self) -> None:
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            snapshot = {
                "scores": self.scores,
                "events_seen": self.events_seen,
                "by_topic": self.by_topic,
                "observed": self.observed,
                "pending": self.pending,
                "timeline": list(self.timeline),
            }
            tmp = STATE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(snapshot, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, STATE_FILE)
        except Exception as err:  # la persistencia no debe tumbar el servicio
            log(f"no se pudo guardar el estado: {err}")

    def load(self) -> None:
        try:
            with open(STATE_FILE, encoding="utf-8") as fh:
                data = json.load(fh)
            self.scores = data.get("scores", {})
            self.events_seen = data.get("events_seen", 0)
            self.by_topic = data.get("by_topic", {})
            self.observed = [(f, t) for f, t in data.get("observed", [])]
            self.pending = data.get("pending", {})
            self.timeline = deque(data.get("timeline", []), maxlen=500)
            log(f"estado recuperado: {self.events_seen} eventos, {len(self.observed)} desenlaces")
        except FileNotFoundError:
            pass
        except Exception as err:
            log(f"no se pudo leer el estado previo: {err}")

    # ---------- consumo de eventos ----------
    def record(self, event: dict, model: RiskModel) -> None:
        topic = event.get("topic", "?")
        payload = event.get("payload") or {}
        credit_id = payload.get("creditId") or payload.get("id")

        with self.lock:
            self.events_seen += 1
            self.by_topic[topic] = self.by_topic.get(topic, 0) + 1
            self.timeline.append(
                {"at": event.get("occurredAt") or now_iso(), "topic": topic, "creditId": credit_id}
            )

        # Una solicitud nueva se puntúa en el momento.
        if topic == "credit.requested" and credit_id:
            scoring = model.score(payload)
            with self.lock:
                self.scores[credit_id] = {
                    "creditId": credit_id,
                    "scoredAt": now_iso(),
                    "amount": payload.get("amount"),
                    "product": payload.get("product"),
                    "channel": payload.get("channel"),
                    **scoring,
                }
                self.pending[credit_id] = {"features": featurize(payload).tolist()}
            log(
                f"solicitud {credit_id[:8]} → score {scoring['score']} "
                f"PD {scoring['probabilityOfDefault']:.2%} banda {scoring['band']} "
                f"({scoring['recommendation']})"
            )
            self.save()
            return

        # Desenlaces observados: alimentan el reentrenamiento.
        outcome = None
        if topic in ("payment.received", "disbursement.completed"):
            outcome = 0.0   # buen comportamiento
        elif topic in ("disbursement.failed", "credit.rejected"):
            outcome = 1.0   # desenlace adverso

        if outcome is not None and credit_id:
            with self.lock:
                entry = self.pending.get(credit_id)
                if entry:
                    self.observed.append((entry["features"], outcome))
                    if len(self.observed) > 2000:
                        del self.observed[: len(self.observed) - 2000]
            self.save()

    # ---------- métricas ----------
    def metrics(self) -> dict:
        with self.lock:
            scores = list(self.scores.values())
            by_topic = dict(self.by_topic)
            events_seen = self.events_seen
            observed = len(self.observed)
            timeline = list(self.timeline)[-60:]

        pds = [s["probabilityOfDefault"] for s in scores]
        amounts = [float(s.get("amount") or 0) for s in scores]
        bands: dict[str, int] = {}
        recs: dict[str, int] = {}
        for s in scores:
            bands[s["band"]] = bands.get(s["band"], 0) + 1
            recs[s["recommendation"]] = recs.get(s["recommendation"], 0) + 1

        # Pérdida esperada = Σ PD × exposición (simplificado, LGD=100%).
        expected_loss = sum(p * a for p, a in zip(pds, amounts))

        return {
            "generatedAt": now_iso(),
            "startedAt": self.started_at,
            "live": True,
            "events": {"total": events_seen, "byTopic": by_topic},
            "portfolio": {
                "scored": len(scores),
                "exposure": round(sum(amounts), 2),
                "avgProbabilityOfDefault": round(float(np.mean(pds)), 6) if pds else None,
                "medianProbabilityOfDefault": round(float(np.median(pds)), 6) if pds else None,
                "p95ProbabilityOfDefault": round(float(np.percentile(pds, 95)), 6) if pds else None,
                "expectedLoss": round(expected_loss, 2),
                "avgScore": round(float(np.mean([s["score"] for s in scores])), 1) if scores else None,
            },
            "distribution": {"bands": bands, "recommendations": recs},
            "observedOutcomes": observed,
            "training": self.last_training,
            "recentEvents": timeline,
        }


state = LiveState()
model = RiskModel()


def retrain(reason: str) -> dict:
    """Reentrena el modelo incorporando los desenlaces observados en el bus."""
    with state.lock:
        observed = [(np.array(f, dtype=float), t) for f, t in state.observed]
    report = model.train(observed)
    summary = {
        "at": now_iso(),
        "reason": reason,
        "samples": report.samples,
        "observedSamples": report.observed_samples,
        "logLoss": round(report.log_loss, 6),
        "accuracy": round(report.accuracy, 6),
        "auc": round(report.auc, 6) if not math.isnan(report.auc) else None,
        "weights": {k: round(v, 6) for k, v in report.weights.items()},
        "intercept": round(report.intercept, 6),
    }
    state.last_training = summary
    log(
        f"modelo entrenado ({reason}): {report.samples} muestras "
        f"({report.observed_samples} reales) · AUC {report.auc:.3f} · "
        f"precisión {report.accuracy:.1%}"
    )
    return summary


# --------------------------------------------------------------------------- #
# Generador de flujo en tiempo real (opcional).
# --------------------------------------------------------------------------- #
class StreamGenerator:
    """Emite métricas de riesgo al bus en intervalos regulares.

    Es la pieza que produce datos *en tiempo real*: cada tick recalcula el estado de
    la cartera sobre los eventos ya recibidos y publica un evento `risk.snapshot`.
    """

    def __init__(self, interval: float = 15.0) -> None:
        self.interval = interval
        self.enabled = os.environ.get("RISK_STREAM", "true") != "false"
        self._stop = threading.Event()
        self.ticks = 0

    def start(self) -> None:
        if not self.enabled:
            log("generador de flujo desactivado (RISK_STREAM=false)")
            return

        def loop() -> None:
            while not self._stop.wait(self.interval):
                try:
                    m = state.metrics()
                    if not m["portfolio"]["scored"]:
                        continue
                    self.ticks += 1
                    bus.publish(
                        "risk.snapshot",
                        {
                            "scored": m["portfolio"]["scored"],
                            "exposure": m["portfolio"]["exposure"],
                            "avgProbabilityOfDefault": m["portfolio"]["avgProbabilityOfDefault"],
                            "expectedLoss": m["portfolio"]["expectedLoss"],
                            "bands": m["distribution"]["bands"],
                            "tick": self.ticks,
                        },
                    )
                except Exception as err:
                    log(f"error en el generador de flujo: {err}")

        threading.Thread(target=loop, daemon=True).start()
        log(f"generador de flujo activo: publica risk.snapshot cada {int(self.interval)} s")

    def stop(self) -> None:
        self._stop.set()


bus = BusClient(topics=["*"], port=PORT, log=log)
stream = StreamGenerator()


# --------------------------------------------------------------------------- #
# API HTTP
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FinanTechRiskEngine/1.0"

    def log_message(self, fmt: str, *args) -> None:  # silencia el log por petición
        pass

    # ---------- utilidades ----------
    def _json(self, status: int, body: dict | list) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self) -> dict:
        length = int(self.headers.get("content-length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode() or "{}")
        except json.JSONDecodeError:
            return {}

    def _claims(self) -> dict | None:
        header = self.headers.get("authorization") or ""
        return verify_jwt(header[7:]) if header.startswith("Bearer ") else None

    def _require(self, roles: tuple[str, ...] | None) -> dict | None:
        """Confianza cero: valida el token aquí, aunque venga del gateway."""
        claims = self._claims()
        if not claims or claims.get("typ") != "access":
            self._json(401, {"error": "Token inválido o expirado"})
            return None
        if roles and claims.get("role") not in roles:
            self._json(403, {"error": "No tiene permisos para esta operación"})
            return None
        return claims

    # ---------- rutas ----------
    def do_GET(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"

        if path in ("/", "/health"):
            self._json(200, {
                "service": "risk-engine",
                "status": "UP",
                "runtime": f"Python {sys.version.split()[0]}",
                "model": "logistic_regression",
                "eventsSeen": state.events_seen,
                "streamTicks": stream.ticks,
            })
            return

        if path == "/metrics":
            if not self._require(STAFF_ROLES):
                return
            self._json(200, state.metrics())
            return

        if path == "/model":
            if not self._require(STAFF_ROLES):
                return
            self._json(200, {
                "kind": "logistic_regression",
                "trainedWith": "descenso de gradiente (NumPy)",
                "features": list(FEATURES),
                "productFactors": PRODUCT_RISK,
                "training": state.last_training,
            })
            return

        if path == "/scores":
            if not self._require(STAFF_ROLES):
                return
            with state.lock:
                scores = sorted(
                    state.scores.values(), key=lambda s: s.get("scoredAt") or "", reverse=True
                )
            self._json(200, scores)
            return

        self._json(404, {"error": "Ruta no encontrada"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        body = self._body()

        # Entrega de eventos del bus (solo rol "servicio").
        if path == "/events":
            if not self._require(("servicio",)):
                return
            event = body or {}
            event_id = event.get("id")
            if event_id and bus.already_processed(event_id):
                self._json(200, {"status": "duplicado"})
                return
            self._json(200, {"status": "procesado"})
            try:
                state.record(event, model)
            except Exception as err:
                log(f"error procesando {event.get('topic')}: {err}")
            return

        # Scoring puntual (analista/gerencia o servicio).
        if path == "/score":
            if not self._require(STAFF_ROLES + ("servicio",)):
                return
            if not body:
                self._json(400, {"error": "Cuerpo vacío: envíe los datos de la solicitud"})
                return
            try:
                self._json(200, model.score(body))
            except Exception as err:
                self._json(400, {"error": f"No se pudo calcular el score: {err}"})
            return

        if path == "/retrain":
            if not self._require(("admin", "servicio")):
                return
            self._json(200, retrain(reason=body.get("reason") or "manual"))
            return

        self._json(404, {"error": "Ruta no encontrada"})


def main() -> None:
    state.load()
    retrain(reason="arranque")
    bus.start()
    stream.start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    log(f"escuchando en http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stream.stop()
        bus.stop()
        state.save()
        server.server_close()


if __name__ == "__main__":
    main()
