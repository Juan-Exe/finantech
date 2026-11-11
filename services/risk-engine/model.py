"""Modelo de riesgo de crédito (regresión logística entrenada en memoria).

A diferencia de la central de riesgo simulada (que devuelve un score fijo según el
último dígito del documento), este módulo *entrena* un modelo real y calcula la
probabilidad de incumplimiento a partir de las características de cada solicitud.

Se entrena con descenso de gradiente sobre NumPy para no depender de scikit-learn.
El conjunto de entrenamiento se genera de forma reproducible (semilla fija) a partir
de una relación causal explícita entre las variables y el incumplimiento; al
reentrenar en caliente se incorporan además los casos reales observados en el bus.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

# Nombres de las características, en el orden en que entran al modelo.
FEATURES = (
    "ratio_cuota_ingreso",   # cuota mensual / ingreso mensual
    "ratio_gasto_ingreso",   # gastos / ingresos
    "log_monto",             # logaritmo del monto solicitado
    "plazo_norm",            # plazo en meses / 60
    "ingreso_norm",          # ingreso mensual / 10M COP
    "reportes_negativos",    # cantidad de reportes en central
)

PRODUCT_RISK = {
    "libre_inversion": 1.0,
    "educativo": 0.75,
    "vehiculo": 0.85,
    "vivienda": 0.6,
}


@dataclass
class TrainingReport:
    """Métricas del entrenamiento, expuestas por la API para poder auditar el modelo."""

    samples: int
    epochs: int
    log_loss: float
    accuracy: float
    auc: float
    weights: dict[str, float]
    intercept: float
    observed_samples: int = 0
    feature_means: dict[str, float] = field(default_factory=dict)


def _sigmoid(z: np.ndarray) -> np.ndarray:
    # Estable para valores grandes: evita overflow en exp.
    return np.where(z >= 0, 1.0 / (1.0 + np.exp(-z)), np.exp(z) / (1.0 + np.exp(z)))


def _auc(y: np.ndarray, p: np.ndarray) -> float:
    """Área bajo la curva ROC vía el estadístico de Mann-Whitney (con empates)."""
    pos, neg = p[y == 1], p[y == 0]
    if pos.size == 0 or neg.size == 0:
        return float("nan")
    order = np.argsort(p)
    ranks = np.empty(p.size, dtype=float)
    ranks[order] = np.arange(1, p.size + 1, dtype=float)
    # Promedia los rangos de los valores empatados.
    sorted_p = p[order]
    i = 0
    while i < sorted_p.size:
        j = i
        while j + 1 < sorted_p.size and sorted_p[j + 1] == sorted_p[i]:
            j += 1
        if j > i:
            ranks[order[i : j + 1]] = ranks[order[i : j + 1]].mean()
        i = j + 1
    rank_sum = ranks[y == 1].sum()
    return float((rank_sum - pos.size * (pos.size + 1) / 2) / (pos.size * neg.size))


def featurize(app: dict) -> np.ndarray:
    """Convierte una solicitud en el vector de características del modelo."""
    income = max(float(app.get("monthlyIncome") or 0.0), 1.0)
    expenses = max(float(app.get("monthlyExpenses") or 0.0), 0.0)
    amount = max(float(app.get("amount") or 0.0), 1.0)
    term = max(int(app.get("termMonths") or 12), 1)
    installment = float(app.get("installment") or 0.0)
    if installment <= 0:
        # Si no viene la cuota, se aproxima con una tasa de referencia del 1.9% mensual.
        rate = 0.019
        installment = amount * rate / (1 - (1 + rate) ** -term)
    negatives = float(app.get("negativeReports") or 0.0)

    return np.array(
        [
            min(installment / income, 3.0),
            min(expenses / income, 3.0),
            math.log10(amount),
            term / 60.0,
            min(income / 10_000_000.0, 5.0),
            negatives,
        ],
        dtype=float,
    )


def _synthetic_dataset(n: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Genera solicitudes sintéticas y su desenlace según una relación causal explícita.

    El modelo no "conoce" esta fórmula: la aprende de los datos, igual que ocurriría
    con un histórico real de cartera.
    """
    rng = np.random.default_rng(seed)

    income = rng.lognormal(mean=math.log(4_000_000), sigma=0.55, size=n)
    expense_ratio = np.clip(rng.beta(2.5, 5.0, size=n), 0.03, 0.95)
    expenses = income * expense_ratio
    term = rng.choice([12, 18, 24, 36, 48, 60], size=n, p=[0.16, 0.14, 0.24, 0.22, 0.14, 0.10])
    # El monto guarda relación con el ingreso, con dispersión.
    amount = np.clip(income * rng.lognormal(mean=math.log(2.2), sigma=0.7, size=n), 500_000, 120_000_000)
    negatives = rng.choice([0, 1, 2, 3], size=n, p=[0.80, 0.12, 0.06, 0.02])

    rate = 0.019
    installment = amount * rate / (1 - (1 + rate) ** -term)
    burden = installment / income  # capacidad de pago: el factor dominante

    # Probabilidad latente de incumplimiento.
    logit = (
        -3.9
        + 4.2 * np.minimum(burden, 3.0)
        + 1.5 * expense_ratio
        + 0.85 * negatives
        + 0.35 * (term / 60.0)
        - 0.30 * np.minimum(income / 10_000_000.0, 5.0)
        + 0.22 * (np.log10(amount) - 6.5)
    )
    default = (rng.random(n) < _sigmoid(logit)).astype(float)

    X = np.column_stack(
        [
            np.minimum(burden, 3.0),
            np.minimum(expense_ratio, 3.0),
            np.log10(amount),
            term / 60.0,
            np.minimum(income / 10_000_000.0, 5.0),
            negatives.astype(float),
        ]
    )
    return X, default


class RiskModel:
    """Regresión logística con estandarización de características."""

    def __init__(self, seed: int = 20260101, samples: int = 6000, epochs: int = 600) -> None:
        self.seed = seed
        self.samples = samples
        self.epochs = epochs
        self.mu = np.zeros(len(FEATURES))
        self.sigma = np.ones(len(FEATURES))
        self.w = np.zeros(len(FEATURES))
        self.b = 0.0
        self.report: TrainingReport | None = None

    # ---------- entrenamiento ----------
    def train(self, observed: list[tuple[np.ndarray, float]] | None = None) -> TrainingReport:
        X, y = _synthetic_dataset(self.samples, self.seed)
        observed = observed or []
        if observed:
            # Los casos reales del bus se repiten para que pesen frente al histórico sintético.
            obs_X = np.array([f for f, _ in observed], dtype=float)
            obs_y = np.array([t for _, t in observed], dtype=float)
            weight = max(1, int(0.25 * len(X) / max(len(obs_X), 1)))
            X = np.vstack([X, np.tile(obs_X, (weight, 1))])
            y = np.concatenate([y, np.tile(obs_y, weight)])

        self.mu = X.mean(axis=0)
        self.sigma = X.std(axis=0)
        self.sigma[self.sigma < 1e-9] = 1.0
        Z = (X - self.mu) / self.sigma

        w = np.zeros(Z.shape[1])
        b = 0.0
        lr, l2, n = 0.5, 1e-4, Z.shape[0]
        for _ in range(self.epochs):
            p = _sigmoid(Z @ w + b)
            err = p - y
            w -= lr * ((Z.T @ err) / n + l2 * w)
            b -= lr * err.mean()
        self.w, self.b = w, b

        p = _sigmoid(Z @ w + b)
        eps = 1e-12
        self.report = TrainingReport(
            samples=int(n),
            epochs=self.epochs,
            log_loss=float(-np.mean(y * np.log(p + eps) + (1 - y) * np.log(1 - p + eps))),
            accuracy=float(np.mean((p >= 0.5) == (y == 1))),
            auc=_auc(y, p),
            weights={name: float(v) for name, v in zip(FEATURES, w)},
            intercept=float(b),
            observed_samples=len(observed),
            feature_means={name: float(v) for name, v in zip(FEATURES, self.mu)},
        )
        return self.report

    # ---------- inferencia ----------
    def probability(self, x: np.ndarray) -> float:
        z = float(((x - self.mu) / self.sigma) @ self.w + self.b)
        return float(_sigmoid(np.array([z]))[0])

    def contributions(self, x: np.ndarray) -> dict[str, float]:
        """Aporte de cada característica al logit: permite explicar la decisión."""
        z = ((x - self.mu) / self.sigma) * self.w
        return {name: float(v) for name, v in zip(FEATURES, z)}

    def score(self, app: dict) -> dict:
        """Calcula el score de riesgo de una solicitud y explica el resultado."""
        x = featurize(app)
        pd_raw = self.probability(x)
        product = str(app.get("product") or "libre_inversion")
        factor = PRODUCT_RISK.get(product, 1.0)
        # El ajuste por producto refleja la garantía asociada (vivienda y educativo son menos riesgosos).
        pd_adj = min(max(pd_raw * factor, 0.0005), 0.9995)

        # Score tipo central de riesgo (300-950): mayor score = menor riesgo.
        score = int(round(300 + (1.0 - pd_adj) * 650))
        if pd_adj < 0.05:
            band, decision = "A", "aprobar"
        elif pd_adj < 0.12:
            band, decision = "B", "aprobar"
        elif pd_adj < 0.25:
            band, decision = "C", "revision_manual"
        elif pd_adj < 0.45:
            band, decision = "D", "revision_manual"
        else:
            band, decision = "E", "rechazar"

        contributions = self.contributions(x)
        drivers = sorted(contributions.items(), key=lambda kv: abs(kv[1]), reverse=True)[:3]

        return {
            "score": score,
            "probabilityOfDefault": round(pd_adj, 6),
            "probabilityRaw": round(pd_raw, 6),
            "band": band,
            "recommendation": decision,
            "productFactor": factor,
            "features": {name: round(float(v), 6) for name, v in zip(FEATURES, x)},
            "contributions": {k: round(v, 6) for k, v in contributions.items()},
            "topDrivers": [{"feature": k, "effect": round(v, 6)} for k, v in drivers],
            "model": {
                "kind": "logistic_regression",
                "trainedOn": self.report.samples if self.report else 0,
                "auc": round(self.report.auc, 4) if self.report else None,
                "observedSamples": self.report.observed_samples if self.report else 0,
            },
            "source": "Motor de riesgo Python (modelo entrenado)",
        }
