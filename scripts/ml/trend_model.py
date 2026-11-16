"""
Trains models that judge whether BTC is entering a real down- or up-trend, the way FreqAI does it:
indicator features from several timeframes, labels from what the price did next, and walk-forward
retraining every month on past data only. Writes out-of-sample probabilities for every 15-minute
candle, which scripts/ml-exit-research.ts feeds into the backtest as an early-exit signal.

    pip install numpy pandas scikit-learn lightgbm
    python3 scripts/ml/trend_model.py BTCUSDT.csv out_dir

Labels use barriers rather than a fixed-horizon return: a candle is "down" if, within the horizon,
price falls k x volatility before it rises k x volatility ("up" is the mirror; neither is "flat").
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.metrics import roc_auc_score
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

BAR = 900  # 15 minutes
src, out_dir = sys.argv[1], Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)

m = pd.read_csv(src)
m["bar"] = (m["timestamp"] // BAR) * BAR
b = m.groupby("bar").agg(open=("open", "first"), high=("high", "max"), low=("low", "min"), close=("close", "last"), volume=("volume", "sum"))
b = b.reindex(np.arange(b.index[0], b.index[-1] + BAR, BAR)).ffill()
c, h, l, v = b["close"], b["high"], b["low"], b["volume"]
lr = np.log(c).diff()


def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


def rsi(s, n=14):
    d = s.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn)


# Volatility of a 4-hour move, from 15-minute returns over the last day.
vol4h = lr.rolling(96).std() * np.sqrt(16)

f = pd.DataFrame(index=b.index)
for n, name in [(1, "15m"), (4, "1h"), (16, "4h"), (48, "12h"), (96, "1d"), (288, "3d")]:
    f[f"ret_{name}"] = np.log(c / c.shift(n)) / vol4h  # move in units of typical 4h volatility
for n, name in [(8, "2h"), (32, "8h"), (96, "1d"), (288, "3d"), (800, "8d")]:
    e = ema(c, n)
    f[f"px_ema_{name}"] = (c / e - 1) / vol4h
    f[f"slope_ema_{name}"] = (e / e.shift(4) - 1) / vol4h
for mult, name in [(1, "15m"), (4, "1h"), (16, "4h")]:
    f[f"rsi_{name}"] = (rsi(c, 14 * mult) - 50) / 50
    macd = ema(c, 12 * mult) - ema(c, 26 * mult)
    f[f"macdh_{name}"] = (macd - ema(macd, 9 * mult)) / c / vol4h
f["vol_ratio"] = vol4h / vol4h.rolling(96 * 14).mean()
f["volu_ratio"] = np.log((v.rolling(4).mean() + 1e-9) / (v.rolling(96 * 3).mean() + 1e-9))
for n, name in [(96, "1d"), (288, "3d")]:
    f[f"from_high_{name}"] = (c / h.rolling(n).max() - 1) / vol4h
    f[f"from_low_{name}"] = (c / l.rolling(n).min() - 1) / vol4h
f = f.replace([np.inf, -np.inf], np.nan)
FEATURES = list(f.columns)


def barrier_labels(k, horizon):
    """1 = up barrier first, -1 = down barrier first, 0 = neither within the horizon."""
    cl, hi, lo, vv = c.to_numpy(), h.to_numpy(), l.to_numpy(), vol4h.to_numpy()
    lab = np.zeros(len(cl), dtype=np.int8)
    for i in range(len(cl) - 1):
        if np.isnan(vv[i]):
            continue
        upb, dnb = cl[i] * (1 + k * vv[i]), cl[i] * (1 - k * vv[i])
        j_end = min(len(cl), i + 1 + horizon)
        hu = np.nonzero(hi[i + 1 : j_end] >= upb)[0]
        hd = np.nonzero(lo[i + 1 : j_end] <= dnb)[0]
        fu = hu[0] if len(hu) else 10**9
        fd = hd[0] if len(hd) else 10**9
        if fu < fd:
            lab[i] = 1
        elif fd < fu:
            lab[i] = -1
        elif fu != 10**9:  # both inside the same 15-minute candle: call it noise
            lab[i] = 0
    return pd.Series(lab, index=b.index)


def models():
    return {
        "mlp": make_pipeline(
            StandardScaler(),
            MLPClassifier(hidden_layer_sizes=(32, 16), alpha=1e-3, early_stopping=True, validation_fraction=0.15, max_iter=200, random_state=7),
        ),
        "lgbm": LGBMClassifier(n_estimators=300, learning_rate=0.03, num_leaves=15, min_child_samples=200, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1, random_state=7),
    }


utc = lambda s: int(pd.Timestamp(s, tz="UTC").timestamp())
first_month = pd.Timestamp("2025-05-01", tz="UTC")
last_time = int(b.index[-1])
months = pd.date_range(first_month, pd.Timestamp(last_time, unit="s", tz="UTC"), freq="MS")
TRAIN_FROM = utc("2025-01-10")  # after feature warm-up
PERIODS = {"dev": (utc("2025-05-01"), utc("2026-04-01")), "val": (utc("2026-04-01"), utc("2026-10-07")), "test": (utc("2026-10-07"), utc("2026-10-27T02:28"))}

summary = {}
for k, hours in [(1.0, 8), (1.5, 24), (2.0, 24)]:
    horizon = hours * 4
    y = barrier_labels(k, horizon)
    for name in ["mlp", "lgbm"]:
        key = f"{name}_k{k}_h{hours}"
        probs = pd.DataFrame(index=b.index, columns=["p_down", "p_up"], dtype=float)
        for ms in months:
            t0 = int(ms.timestamp())
            t1 = int((ms + pd.offsets.MonthBegin(1)).timestamp())
            # Train only on candles whose label was fully known before this month (purge the horizon).
            tr = (f.index >= TRAIN_FROM) & (f.index < t0 - horizon * BAR) & f.notna().all(axis=1)
            te = (f.index >= t0) & (f.index < t1) & f.notna().all(axis=1)
            if te.sum() == 0:
                continue
            model = models()[name]
            model.fit(f.loc[tr, FEATURES].to_numpy(), y[tr].to_numpy())
            p = model.predict_proba(f.loc[te, FEATURES].to_numpy())
            cls = list(model.classes_)
            probs.loc[te, "p_down"] = p[:, cls.index(-1)]
            probs.loc[te, "p_up"] = p[:, cls.index(1)]
        # How well it predicts, out of sample, per period.
        stats = {}
        for pname, (a, z) in PERIODS.items():
            sel = (probs.index >= a) & (probs.index < z - horizon * BAR) & probs["p_down"].notna()
            yy = y[sel]
            stats[pname] = {
                "auc_down": round(roc_auc_score(yy == -1, probs.loc[sel, "p_down"]), 3),
                "auc_up": round(roc_auc_score(yy == 1, probs.loc[sel, "p_up"]), 3),
                "share_down": round(float((yy == -1).mean()), 3),
                "share_up": round(float((yy == 1).mean()), 3),
            }
        summary[key] = stats
        print(key, json.dumps(stats), flush=True)
        probs.index.name = "time"
        out = probs.dropna().reset_index()
        out["time"] = out["time"].astype(int)
        out.to_csv(out_dir / f"{key}.csv", index=False, float_format="%.4f")

(out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
