#!/usr/bin/env python3
"""HU-26 -- analisis estadistico OFFLINE de las semillas candidatas.

Lee las muestras que genera `tools/hu-26/generate-samples.ts` con el codigo
PRODUCTIVO de Combat (`createNormalSequence(seed).nextNormal()`) y calcula, para
cada semilla y con exactamente el mismo procedimiento:

  media, desviacion tipica, asimetria, exceso de curtosis,
  Kolmogorov-Smirnov contra N(0,1), Ljung-Box (lags 10,20,30,40,50), Q-Q.

El diseno (semillas, N, alfa, lags y REGLA DE SELECCION) se lee de
`study-config.json`, que se commitea ANTES de ejecutar el estudio: aqui no se
ajusta ningun criterio ni umbral. Nada de esto es un requisito de RF-26: son
decisiones experimentales del estudio.

Este script es tooling de evidencia. No se ejecuta en el servicio ni en la CI
normal, y no forma parte de la imagen de Combat.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import platform
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import scipy  # noqa: E402
import statsmodels  # noqa: E402
from scipy import stats  # noqa: E402
from statsmodels.stats.diagnostic import acorr_ljungbox  # noqa: E402


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_text(path: Path, text: str) -> None:
    """Escribe con saltos de linea LF en cualquier plataforma (en Windows, write_text
    produciria CRLF y los artefactos cambiarian de bytes segun el sistema)."""
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def write_json(path: Path, payload: dict) -> None:
    write_text(path, json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def fmt(value: float) -> str:
    """Representacion exacta y determinista (repr de float, hasta 17 cifras)."""
    return repr(float(value))


# --------------------------------------------------------------------------- #
# Ljung-Box independiente (contraste de la implementacion de statsmodels)
# --------------------------------------------------------------------------- #
def ljung_box_independent(z: np.ndarray, lags: list[int]) -> dict[int, float]:
    """Ljung-Box O(n log n) con ACF por FFT, sin statsmodels.

    Q(k) = n (n + 2) * sum_{j=1..k} rho_j^2 / (n - j),  Q ~ chi2(k) bajo H0.
    """
    n = z.size
    centered = z - z.mean()
    spectrum = np.fft.rfft(centered, 2 * n)
    autocovariance = np.fft.irfft(spectrum * np.conj(spectrum))[:n]
    rho = autocovariance / autocovariance[0]

    p_values: dict[int, float] = {}
    for lag in lags:
        j = np.arange(1, lag + 1)
        q = n * (n + 2) * np.sum(rho[1 : lag + 1] ** 2 / (n - j))
        p_values[lag] = float(stats.chi2.sf(q, df=lag))
    return p_values


# --------------------------------------------------------------------------- #
# Metricas por semilla
# --------------------------------------------------------------------------- #
def qq_summary(z: np.ndarray) -> tuple[float, float]:
    """Resumen numerico del Q-Q (DESCRIPTIVO; no participa en la seleccion).

    - r: correlacion de Pearson entre cuantiles observados y teoricos.
    - max |desviacion| de los cuantiles en las probabilidades [0.005, 0.995].
    """
    n = z.size
    ordered = np.sort(z)
    positions = (np.arange(1, n + 1) - 0.5) / n
    theoretical = stats.norm.ppf(positions)

    r = float(np.corrcoef(theoretical, ordered)[0, 1])
    central = (positions >= 0.005) & (positions <= 0.995)
    max_dev = float(np.max(np.abs(ordered[central] - theoretical[central])))
    return r, max_dev


def analyse_seed(z: np.ndarray, lags: list[int], alpha: float) -> dict:
    ks = stats.kstest(z, "norm")
    lb = acorr_ljungbox(z, lags=lags, return_df=True)
    lb_p = {lag: float(lb.loc[lag, "lb_pvalue"]) for lag in lags}
    lb_min_p = min(lb_p.values())
    qq_r, qq_max_dev = qq_summary(z)

    return {
        "n": int(z.size),
        "mean": float(np.mean(z)),
        "std": float(np.std(z, ddof=1)),
        "skewness": float(stats.skew(z, bias=True)),
        "excess_kurtosis": float(stats.kurtosis(z, fisher=True, bias=True)),
        "min": float(np.min(z)),
        "max": float(np.max(z)),
        "ks_d": float(ks.statistic),
        "ks_p": float(ks.pvalue),
        "lb_p": lb_p,
        "lb_min_p": float(lb_min_p),
        "ks_ok": bool(ks.pvalue > alpha),
        "lb_ok": bool(lb_min_p > alpha),
        "qq_r": qq_r,
        "qq_max_abs_dev": qq_max_dev,
    }


def select_seed(results: dict[int, dict]) -> dict:
    """Aplica la regla PRE-REGISTRADA: filtros KS y LB; menor KS D entre aceptadas."""
    accepted = {seed: r for seed, r in results.items() if r["ks_ok"] and r["lb_ok"]}
    ranking = sorted(accepted, key=lambda seed: (accepted[seed]["ks_d"], seed))

    return {
        "status": "SELECTED" if ranking else "NO_ACCEPTED_CANDIDATE",
        "selected_seed": ranking[0] if ranking else None,
        "accepted_seeds_ranked_by_ks_d": ranking,
        "rejected": {
            seed: [
                reason
                for reason, failed in (
                    ("KS p <= alpha", not r["ks_ok"]),
                    ("Ljung-Box min p <= alpha", not r["lb_ok"]),
                )
                if failed
            ]
            for seed, r in results.items()
            if seed not in accepted
        },
    }


# --------------------------------------------------------------------------- #
# Q-Q
# --------------------------------------------------------------------------- #
def qq_plot(z: np.ndarray, seed: int, path: Path) -> None:
    n = z.size
    ordered = np.sort(z)
    theoretical = stats.norm.ppf((np.arange(1, n + 1) - 0.5) / n)
    limit = float(np.ceil(max(np.abs(theoretical).max(), np.abs(ordered).max())))

    fig, axis = plt.subplots(figsize=(5.2, 5.2))
    axis.plot(theoretical, ordered, ".", markersize=1.2, rasterized=True, label="cuantiles observados")
    axis.plot([-limit, limit], [-limit, limit], "r-", linewidth=1.0, label="referencia y = x")
    axis.set_xlim(-limit, limit)
    axis.set_ylim(-limit, limit)
    axis.set_aspect("equal", adjustable="box")
    axis.set_xlabel("Cuantiles teoricos N(0,1)")
    axis.set_ylabel("Cuantiles observados de Z")
    axis.set_title(f"Q-Q de Z (createNormalSequence)\nsemilla {seed}, n = {n}")
    axis.grid(True, alpha=0.3)
    axis.legend(loc="upper left", fontsize=8)
    fig.tight_layout()
    # `Software: None` evita que la version de matplotlib cambie los bytes del PNG.
    fig.savefig(path, dpi=110, metadata={"Software": None})
    plt.close(fig)


# --------------------------------------------------------------------------- #
# Validacion secundaria del indice (NO participa en la seleccion)
# --------------------------------------------------------------------------- #
def index_uniformity(index_sample: np.ndarray, bins: int, alpha: float) -> dict:
    n = int(index_sample.size)
    width = 8000 // bins
    counts = np.bincount((index_sample.astype(np.int64) - 1) // width, minlength=bins)[:bins]
    expected = n / bins
    chi2 = float(np.sum((counts - expected) ** 2 / expected))
    p = float(stats.chi2.sf(chi2, df=bins - 1))

    return {
        "n": n,
        "min": int(index_sample.min()),
        "max": int(index_sample.max()),
        "in_range_1_8000": bool(index_sample.min() >= 1 and index_sample.max() <= 8000),
        "chi2": chi2,
        "chi2_p": p,
        "share_rows_1_4800": float(np.mean(index_sample <= 4800)),
        "consistent_with_uniform": bool(p > alpha),
    }


# --------------------------------------------------------------------------- #
# Autocomprobacion del propio analisis (controles conocidos, sin datos de Combat)
# --------------------------------------------------------------------------- #
def self_check(alpha: float, lags: list[int]) -> dict:
    """Verifica que el analisis detecta lo que debe detectar.

    Usa el generador de NumPy SOLO como control del codigo de analisis; nunca
    para elegir una semilla de Combat.
    """
    rng = np.random.default_rng(20260920)
    n = 100_000
    checks: list[dict] = []

    def record(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "passed": bool(passed), "detail": detail})

    # 1) Ljung-Box de statsmodels == implementacion independiente.
    white = rng.standard_normal(n)
    reference = acorr_ljungbox(white, lags=lags, return_df=True)["lb_pvalue"]
    independent = ljung_box_independent(white, lags)
    worst = max(abs(float(reference.loc[lag]) - independent[lag]) for lag in lags)
    record("Ljung-Box statsmodels vs implementacion independiente", worst < 1e-9, f"max |dif p| = {worst:.3e}")

    # 2) Control negativo de KS: media desplazada 0.05 -> se debe rechazar.
    shifted = analyse_seed(rng.standard_normal(n) + 0.05, lags, alpha)
    record("KS rechaza N(0.05, 1)", not shifted["ks_ok"], f"KS p = {shifted['ks_p']:.3e}")

    # 3) Control negativo de KS: uniforme -> se debe rechazar.
    uniform = analyse_seed(rng.uniform(-1.7, 1.7, n), lags, alpha)
    record("KS rechaza una uniforme", not uniform["ks_ok"], f"KS p = {uniform['ks_p']:.3e}")

    # 4) Control negativo de Ljung-Box: AR(1) con phi = 0.05 -> se debe rechazar.
    innovations = rng.standard_normal(n)
    ar1 = np.empty(n)
    ar1[0] = innovations[0]
    for t in range(1, n):
        ar1[t] = 0.05 * ar1[t - 1] + innovations[t]
    autocorrelated = analyse_seed(ar1 / ar1.std(), lags, alpha)
    record("Ljung-Box rechaza AR(1) phi=0.05", not autocorrelated["lb_ok"], f"LB min p = {autocorrelated['lb_min_p']:.3e}")

    # 5) Control positivo: una muestra N(0,1) independiente tiene metricas ~teoricas.
    control = analyse_seed(white, lags, alpha)
    close = (
        abs(control["mean"]) < 0.02
        and abs(control["std"] - 1) < 0.02
        and abs(control["skewness"]) < 0.05
        and abs(control["excess_kurtosis"]) < 0.1
        and control["qq_r"] > 0.9999
    )
    record(
        "Muestra N(0,1) independiente: metricas ~ teoricas",
        close,
        f"mean={control['mean']:.4f} std={control['std']:.4f} skew={control['skewness']:.4f} "
        f"exkurt={control['excess_kurtosis']:.4f} qq_r={control['qq_r']:.6f}",
    )

    # 6) La regla de seleccion elige la menor KS D entre las aceptadas y no elige nada si no hay.
    fake = {
        1: {"ks_ok": True, "lb_ok": True, "ks_d": 0.003},
        2: {"ks_ok": True, "lb_ok": True, "ks_d": 0.001},
        3: {"ks_ok": True, "lb_ok": False, "ks_d": 0.0001},
        4: {"ks_ok": False, "lb_ok": True, "ks_d": 0.0001},
    }
    chosen = select_seed(fake)
    none = select_seed({1: {"ks_ok": False, "lb_ok": True, "ks_d": 0.1}})
    record(
        "Regla de seleccion: menor KS D entre aceptadas; sin aceptadas no se elige",
        chosen["selected_seed"] == 2 and none["status"] == "NO_ACCEPTED_CANDIDATE" and none["selected_seed"] is None,
        f"elegida={chosen['selected_seed']} sin_aceptadas={none['status']}",
    )

    return {"all_passed": all(c["passed"] for c in checks), "checks": checks}


# --------------------------------------------------------------------------- #
# Salidas
# --------------------------------------------------------------------------- #
CSV_COLUMNS = [
    "seed",
    "n",
    "mean",
    "std",
    "skewness",
    "excess_kurtosis",
    "min",
    "max",
    "ks_d",
    "ks_p",
    "lb_p_10",
    "lb_p_20",
    "lb_p_30",
    "lb_p_40",
    "lb_p_50",
    "lb_min_p",
    "ks_ok",
    "lb_ok",
    "accepted",
    "qq_r",
    "qq_max_abs_dev",
    "rank_among_accepted",
    "selected",
]


def build_rows(results: dict[int, dict], decision: dict, lags: list[int]) -> list[dict]:
    ranking = decision["accepted_seeds_ranked_by_ks_d"]
    rows = []
    for seed, r in results.items():
        row = {
            "seed": seed,
            "n": r["n"],
            "mean": fmt(r["mean"]),
            "std": fmt(r["std"]),
            "skewness": fmt(r["skewness"]),
            "excess_kurtosis": fmt(r["excess_kurtosis"]),
            "min": fmt(r["min"]),
            "max": fmt(r["max"]),
            "ks_d": fmt(r["ks_d"]),
            "ks_p": fmt(r["ks_p"]),
            "lb_min_p": fmt(r["lb_min_p"]),
            "ks_ok": str(r["ks_ok"]).lower(),
            "lb_ok": str(r["lb_ok"]).lower(),
            "accepted": str(r["ks_ok"] and r["lb_ok"]).lower(),
            "qq_r": fmt(r["qq_r"]),
            "qq_max_abs_dev": fmt(r["qq_max_abs_dev"]),
            "rank_among_accepted": (ranking.index(seed) + 1) if seed in ranking else "",
            "selected": str(decision["selected_seed"] == seed).lower(),
        }
        for lag in lags:
            row[f"lb_p_{lag}"] = fmt(r["lb_p"][lag])
        rows.append(row)
    return rows


def write_csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_markdown(path: Path, results: dict[int, dict], decision: dict, cfg: dict, lags: list[int]) -> None:
    ranking = decision["accepted_seeds_ranked_by_ks_d"]
    lines = [
        "# HU-26 -- comparacion de semillas (generado automaticamente)",
        "",
        "Variable analizada: Z = `createNormalSequence(seed).nextNormal()` del codigo productivo de Combat.",
        f"N = {cfg['sampleSize']} por semilla - alfa = {cfg['alpha']} - referencia N(0,1).",
        "Regla PRE-REGISTRADA: aceptar si KS p > alfa y minimo Ljung-Box p > alfa; entre las aceptadas, menor KS D.",
        "",
        "| Semilla | Media | Std (ddof=1) | Asimetria | Exceso curtosis | KS D | KS p | "
        + " | ".join(f"LB p({lag})" for lag in lags)
        + " | LB min p | KS OK | LB OK | Aceptada | Orden |",
        "|" + "---|" * (12 + len(lags)),
    ]
    for seed, r in results.items():
        order = str(ranking.index(seed) + 1) if seed in ranking else "-"
        lines.append(
            f"| {seed} | {r['mean']:.6f} | {r['std']:.6f} | {r['skewness']:.6f} | {r['excess_kurtosis']:.6f} | "
            f"{r['ks_d']:.6f} | {r['ks_p']:.6f} | "
            + " | ".join(f"{r['lb_p'][lag]:.6f}" for lag in lags)
            + f" | {r['lb_min_p']:.6f} | {'si' if r['ks_ok'] else 'no'} | {'si' if r['lb_ok'] else 'no'} | "
            f"{'si' if (r['ks_ok'] and r['lb_ok']) else 'no'} | {order} |"
        )
    lines += ["", f"Estado de la seleccion: **{decision['status']}**"]
    if decision["selected_seed"] is not None:
        lines.append(f"Semilla seleccionada segun la regla: **{decision['selected_seed']}**")
    for seed, reasons in decision["rejected"].items():
        lines.append(f"- Semilla {seed} descartada: {', '.join(reasons)}")
    lines += [
        "",
        "KS p > alfa significa NO RECHAZAR H0 (la muestra proviene de N(0,1)), no que se haya demostrado la normalidad.",
        "",
    ]
    write_text(path, "\n".join(lines))


# --------------------------------------------------------------------------- #
# Programa principal
# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(description="Analisis estadistico de HU-26")
    parser.add_argument("--config", default="tools/hu-26/study-config.json")
    parser.add_argument("--samples-dir", default="tools/hu-26/.samples")
    parser.add_argument("--evidence-dir", default="docs/evidence/hu-26")
    args = parser.parse_args()

    config = read_json(Path(args.config))
    samples_dir = Path(args.samples_dir)
    evidence_dir = Path(args.evidence_dir)
    qq_dir = evidence_dir / "qq"
    qq_dir.mkdir(parents=True, exist_ok=True)

    alpha = float(config["alpha"])
    lags = [int(lag) for lag in config["ljungBoxLags"]]
    seeds = [int(seed) for seed in config["candidateSeeds"]]
    sample_size = int(config["sampleSize"])
    bins = int(config["secondaryChecks"]["indexUniformity"]["bins"])

    # 0) Autocomprobacion del analisis. Si falla, no se analiza nada.
    check = self_check(alpha, lags)
    write_json(evidence_dir / "analysis-self-check.json", check)
    for item in check["checks"]:
        print(("OK   " if item["passed"] else "FAIL ") + item["name"] + " -- " + item["detail"])
    if not check["all_passed"]:
        print("La autocomprobacion del analisis fallo: se aborta.", file=sys.stderr)
        return 2

    # 1) Integridad: las muestras deben coincidir con las huellas del harness TypeScript.
    fingerprints = read_json(evidence_dir / "sample-fingerprints.json")
    normal_fp = {int(f["seed"]): f for f in fingerprints["normal"]}
    index_fp = {int(f["seed"]): f for f in fingerprints["index"]}

    results: dict[int, dict] = {}
    index_results: dict[int, dict] = {}

    for seed in seeds:
        normal_path = samples_dir / f"normal-{seed}.f64"
        index_path = samples_dir / f"index-{seed}.u16"

        if sha256_file(normal_path) != normal_fp[seed]["sha256"]:
            print(f"La muestra normal de la semilla {seed} no coincide con su huella.", file=sys.stderr)
            return 3
        if sha256_file(index_path) != index_fp[seed]["sha256"]:
            print(f"La muestra de indices de la semilla {seed} no coincide con su huella.", file=sys.stderr)
            return 3

        z = np.fromfile(normal_path, dtype="<f8")
        if z.size != sample_size or not np.all(np.isfinite(z)):
            print(f"La muestra de la semilla {seed} no tiene {sample_size} valores finitos.", file=sys.stderr)
            return 3

        results[seed] = analyse_seed(z, lags, alpha)
        qq_plot(z, seed, qq_dir / f"seed-{seed}.png")

        # Contraste independiente de Ljung-Box para CADA semilla (no solo en los controles).
        independent = ljung_box_independent(z, lags)
        worst = max(abs(independent[lag] - results[seed]["lb_p"][lag]) for lag in lags)
        if worst > 1e-9:
            print(f"Ljung-Box: statsmodels difiere de la implementacion independiente ({worst:.3e}).", file=sys.stderr)
            return 4

        index_results[seed] = index_uniformity(np.fromfile(index_path, dtype="<u2"), bins, alpha)
        print(f"semilla {seed}: KS p={results[seed]['ks_p']:.4f} LB min p={results[seed]['lb_min_p']:.4f}")

    # 2) Seleccion segun la regla PRE-REGISTRADA (sin ajustar nada tras ver resultados).
    decision = select_seed(results)

    rows = build_rows(results, decision, lags)
    write_csv(evidence_dir / "seed-comparison.csv", CSV_COLUMNS, rows)
    write_markdown(evidence_dir / "seed-comparison.md", results, decision, config, lags)

    index_columns = [
        "seed",
        "n",
        "min",
        "max",
        "in_range_1_8000",
        "chi2",
        "chi2_p",
        "share_rows_1_4800",
        "consistent_with_uniform",
    ]
    index_rows = [
        {
            "seed": seed,
            "n": r["n"],
            "min": r["min"],
            "max": r["max"],
            "in_range_1_8000": str(r["in_range_1_8000"]).lower(),
            "chi2": fmt(r["chi2"]),
            "chi2_p": fmt(r["chi2_p"]),
            "share_rows_1_4800": fmt(r["share_rows_1_4800"]),
            "consistent_with_uniform": str(r["consistent_with_uniform"]).lower(),
        }
        for seed, r in index_results.items()
    ]
    write_csv(evidence_dir / "index-uniformity.csv", index_columns, index_rows)

    write_json(
        evidence_dir / "selected-seed.json",
        {
            "status": decision["status"],
            "seed": decision["selected_seed"],
            "sampleSize": sample_size,
            "alpha": alpha,
            "ljungBoxLags": lags,
            "referenceDistribution": config["referenceDistribution"],
            "selectionRule": config["selectionRule"],
            "acceptedSeedsRankedByKsD": decision["accepted_seeds_ranked_by_ks_d"],
            "rejected": {str(seed): reasons for seed, reasons in decision["rejected"].items()},
            "candidateSeeds": seeds,
            "historicalInvalidSeeds": config["historicalInvalidSeeds"],
            "interpretation": (
                "Mejor ajuste DENTRO del conjunto de candidatas, la muestra finita y el criterio experimental "
                "definidos. No significa que la semilla sea matematicamente superior ni 'mas aleatoria' en general."
            ),
            "notASecurityProperty": "Seleccionar una semilla no vuelve criptograficamente seguro a MT19937.",
            "runtimeSeedPolicy": "NO DEFINIDA: esta seleccion no implica usar esta semilla para todas las batallas.",
            "environment": {
                "python": platform.python_version(),
                "numpy": np.__version__,
                "scipy": scipy.__version__,
                "statsmodels": statsmodels.__version__,
                "matplotlib": matplotlib.__version__,
            },
        },
    )

    print(f"Estado de la seleccion: {decision['status']} -> semilla {decision['selected_seed']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
