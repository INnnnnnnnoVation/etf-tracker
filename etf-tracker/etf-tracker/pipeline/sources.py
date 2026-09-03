# -*- coding: utf-8 -*-
"""
sources.py — 数据源层
---------------------
统一的数据获取接口，双模式：
  1) akshare 真实源（东方财富公开行情）—— 行情/成交额真实
  2) demo 演示源 —— 无网络/接口失效时回退，随机游走合成（固定 seed 可复现）

"汇金/证金披露数据"来自手工维护的 holdings.csv（前十大持有人解析无法完全
自动化，需人工从基金定期报告核实），不存在时按演示值生成并明确标注。
"""
import csv
import math
import os
import random
from datetime import date, datetime, timedelta

import pandas as pd

# ---------------------------------------------------------------------------
# 种子清单：人工策划的 ETF 池（与原站一致的策划思路：覆盖主流宽基 + 少量行业）
# ---------------------------------------------------------------------------
SEED_ETFS = [
    {"code": "510300", "name": "沪深300ETF华泰柏瑞", "exchange": "SH", "display_group": "宽基/沪深300", "manager": "华泰柏瑞"},
    {"code": "510310", "name": "沪深300ETF易方达",   "exchange": "SH", "display_group": "宽基/沪深300", "manager": "易方达"},
    {"code": "510330", "name": "沪深300ETF华夏",     "exchange": "SH", "display_group": "宽基/沪深300", "manager": "华夏"},
    {"code": "159919", "name": "沪深300ETF嘉实",     "exchange": "SZ", "display_group": "宽基/沪深300", "manager": "嘉实"},
    {"code": "510050", "name": "上证50ETF华夏",      "exchange": "SH", "display_group": "宽基/上证50",  "manager": "华夏"},
    {"code": "510500", "name": "中证500ETF南方",     "exchange": "SH", "display_group": "宽基/中证500", "manager": "南方"},
    {"code": "512100", "name": "中证1000ETF南方",    "exchange": "SH", "display_group": "宽基/中证1000", "manager": "南方"},
    {"code": "159915", "name": "创业板ETF易方达",    "exchange": "SZ", "display_group": "宽基/创业板",  "manager": "易方达"},
    {"code": "588080", "name": "科创50ETF易方达",    "exchange": "SH", "display_group": "宽基/科创50",  "manager": "易方达"},
    {"code": "512690", "name": "中证酒ETF鹏华",      "exchange": "SH", "display_group": "消费/医药",    "manager": "鹏华"},
]

DEFAULT_CODE = "510310"  # 首屏默认标的（与原站一致）

# 每只 ETF 的 demo 基准参数（初始价、规模基数）
DEMO_BASE = {
    "510300": (3.9, 900), "510310": (4.4, 1100), "510330": (3.8, 800), "159919": (3.7, 600),
    "510050": (2.6, 550), "510500": (6.0, 450), "512100": (0.65, 300), "159915": (2.2, 400),
    "588080": (0.95, 200), "512690": (0.75, 90),
}

REPORT_DATES = ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31",
                "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"]


# ---------------------------------------------------------------------------
# akshare 真实源
# ---------------------------------------------------------------------------
def fetch_etf_series_akshare(code: str, start: str, end: str):
    """东方财富日度行情（前复权收盘价 + 成交额），单位对齐：元 / 亿元。"""
    import akshare as ak  # 延迟导入，demo 模式无需安装
    df = ak.fund_etf_hist_em(symbol=code, period="daily",
                             start_date=start, end_date=end, adjust="qfq")
    if df is None or df.empty:
        return None
    df = df.rename(columns={"日期": "date", "收盘": "qfq_close", "成交额": "amount"})
    out = pd.DataFrame({
        "date": pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d"),
        "qfq_close": pd.to_numeric(df["qfq_close"], errors="coerce").round(4),
        "turnover_yi": (pd.to_numeric(df["amount"], errors="coerce") / 1e8).round(4),
    }).dropna(subset=["date"])
    return out if len(out) else None


def fetch_etf_series_sina(code: str, exchange: str, start: str):
    """新浪财经日度行情（回退源，未复权收盘价）。start: 'YYYYMMDD'"""
    import akshare as ak
    sym = ("sh" if exchange == "SH" else "sz") + code
    df = ak.fund_etf_hist_sina(symbol=sym)
    if df is None or df.empty:
        return None
    df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
    df = df[df["date"] >= f"{start[:4]}-{start[4:6]}-{start[6:]}"]
    out = pd.DataFrame({
        "date": df["date"],
        "qfq_close": pd.to_numeric(df["close"], errors="coerce").round(4),
        "turnover_yi": (pd.to_numeric(df["amount"], errors="coerce") / 1e8).round(4),
    }).dropna(subset=["date"])
    return out if len(out) else None


def probe_units_akshare(code: str):
    """尝试获取基金份额（亿份）。东财接口不保证提供日度份额，拿不到返回 None。"""
    try:
        import akshare as ak
        df = ak.fund_etf_fund_daily_em()
        row = df[df["基金代码"].astype(str).str.zfill(6) == str(code)]
        if row.empty:
            return None, None
        r = row.iloc[0]
        for col in ("最新份额", "份额", "基金份额"):
            if col in df.columns:
                v = pd.to_numeric(pd.Series([r[col]]), errors="coerce").iloc[0]
                if pd.notna(v) and v > 0:
                    latest_date = None
                    if "净值日期" in df.columns:
                        latest_date = str(r["净值日期"])
                    return float(v), latest_date
    except Exception:
        pass
    return None, None


# ---------------------------------------------------------------------------
# demo 演示源（固定 seed，可复现；形态模拟"2024 初增持 → 份额增长"）
# ---------------------------------------------------------------------------
def _workdays(start: date, end: date):
    d, out = start, []
    while d <= end:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def demo_series(code: str, start: date, end: date):
    base_price, base_units = DEMO_BASE.get(code, (1.0, 200))
    rng = random.Random(f"demo-{code}")
    days = _workdays(start, end)
    rows, price = [], base_price
    units = base_units
    n = len(days)
    for i, d in enumerate(days):
        # 价格：随机游走 + 2024 年初一波"救市"反弹形态
        drift = 0.0006 if d < date(2024, 3, 1) else (0.0004 if d < date(2025, 1, 1) else 0.0001)
        price *= math.exp(rng.gauss(drift, 0.012))
        if d == date(2024, 2, 6):   # 单日跳涨，模拟行情剧变
            price *= 1.035
        # 份额：整体缓慢增长 + 季末申赎脉冲（指数型资金行为）
        if i > 0:
            if d.month in (1, 4) and d.day <= 10:      # 季度脉冲申赎
                units *= 1 + rng.gauss(0.02, 0.05)
            else:
                units *= 1 + rng.gauss(0.0004, 0.002)
        turnover = base_units * rng.uniform(0.02, 0.12) * (0.6 + 0.8 * rng.random())
        prev_units = rows[-1]["total_units_yi"] if rows else None
        rows.append({
            "date": d.isoformat(),
            "qfq_close": round(price, 4),
            "turnover_yi": round(turnover, 4),
            "total_units_yi": round(units, 4),
            "delta_units_yi": round(units - prev_units, 4) if prev_units is not None else None,
        })
    return pd.DataFrame(rows)


def demo_disclosures(code: str):
    """演示披露序列：比例逐季抬升（模拟国家队持续增持），并给出金额估计。"""
    base_price, base_units = DEMO_BASE.get(code, (1.0, 200))
    rng = random.Random(f"disc-{code}")
    ratios = [round(min(0.86, 0.18 + 0.09 * i + rng.uniform(-0.03, 0.03)), 4)
              for i in range(len(REPORT_DATES))]
    out = []
    for dt, r in zip(REPORT_DATES, ratios):
        price = base_price * (0.9 + 0.12 * REPORT_DATES.index(dt))
        out.append({
            "report_date": dt,
            "combined_ratio_pct": round(r * 100, 2),
            "combined_value_yi": round(r * base_units * price, 2),
            "est": True,
        })
    return out


# ---------------------------------------------------------------------------
# holdings.csv — 手工维护的真实披露数据（替换演示值即可接入真实口径）
# 列: code, report_date, combined_ratio_pct, combined_value_yi(可空)
# ---------------------------------------------------------------------------
def load_holdings_csv(path: str):
    if not os.path.exists(path):
        return {}
    by_code = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            code = (row.get("code") or "").strip()
            if not code:
                continue
            try:
                item = {
                    "report_date": row["report_date"].strip(),
                    "combined_ratio_pct": float(row["combined_ratio_pct"]),
                    "combined_value_yi": float(row["combined_value_yi"]) if (row.get("combined_value_yi") or "").strip() else None,
                    "est": False,
                }
            except (KeyError, ValueError):
                continue
            by_code.setdefault(code, []).append(item)
    for code in by_code:
        by_code[code].sort(key=lambda x: x["report_date"])
    return by_code
