# -*- coding: utf-8 -*-
"""
run_daily.py — 离线数据管道入口
--------------------------------
用法:
    python3 run_daily.py                 # auto: 东财qfq → 新浪 → demo 三级回退
    python3 run_daily.py --mode demo     # 强制演示数据（无网络可跑）
    python3 run_daily.py --mode akshare  # 强制真实源（拉不到即报错）

产出（全部为静态 JSON，直接落在 site/data/）:
    universe.json          # ETF 全集清单（含区间统计，供清单页与组内对比表）
    groups.json            # 分组预聚合
    etfs/{code}.json       # 单只 ETF 全量（meta + series + disclosures）

设计要点（对应技术方案 §3）: 所有聚合（排名/分组/区间统计）都在此算好，
前端只做渲染；披露数据与日度数据在字段上分离，口径诚实。
"""
import argparse
import json
import os
import sys
from datetime import date, datetime

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sources as S

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "site", "data")
ETFS_DIR = os.path.join(OUT_DIR, "etfs")
HOLDINGS_CSV = os.path.join(HERE, "holdings.csv")
HOLDINGS_EXAMPLE = os.path.join(HERE, "holdings.example.csv")

START_DATE = "20240101"           # 序列起点（约 650 个交易日）
WINDOWS = {"week": 5, "month": 21, "quarter": 63}   # 交易日窗口


# ---------------------------------------------------------------------------
# 计算：区间统计（管道算好，前端零计算）
# ---------------------------------------------------------------------------
def compute_stats(df: pd.DataFrame) -> dict:
    stats = {}
    n = len(df)
    for key, w in WINDOWS.items():
        if n < 2:
            stats[key] = None
            continue
        w = min(w, n - 1)
        tail = df.tail(w)
        base_close = float(df["qfq_close"].iloc[-(w + 1)])
        last_close = float(df["qfq_close"].iloc[-1])
        item = {
            "days": w,
            "price_pct": round((last_close / base_close - 1) * 100, 2),
            "turnover_yi": round(float(tail["turnover_yi"].sum()), 2),
        }
        if tail["delta_units_yi"].notna().any():
            du = float(tail["delta_units_yi"].sum())
            item["delta_units_yi"] = round(du, 2)
            est = (tail["delta_units_yi"] * tail["qfq_close"]).sum()
            item["net_amount_est_yi"] = round(float(est), 2)
        else:
            item["delta_units_yi"] = None
            item["net_amount_est_yi"] = None
        stats[key] = item
    return stats


# ---------------------------------------------------------------------------
# 采集：三级回退
# ---------------------------------------------------------------------------
def fetch_one(etf: dict, mode: str):
    """返回 (df, source_label, notes)；df 列: date/qfq_close/turnover_yi/total_units_yi/delta_units_yi"""
    code, ex = etf["code"], etf["exchange"]
    notes = []
    if mode in ("auto", "akshare"):
        try:
            df = S.fetch_etf_series_akshare(code, START_DATE, date.today().strftime("%Y%m%d"))
            if df is not None:
                notes.append("行情:东方财富·前复权")
                return attach_units(df, code, notes), "eastmoney(qfq)", notes
        except Exception as e:
            notes.append(f"东财接口失败({type(e).__name__})")
        try:
            df = S.fetch_etf_series_sina(code, ex, START_DATE)
            if df is not None:
                notes.append("行情:新浪财经·未复权(如有分红需自行调整)")
                return attach_units(df, code, notes), "sina(raw)", notes
        except Exception as e:
            notes.append(f"新浪接口失败({type(e).__name__})")
            if mode == "akshare":
                raise
    notes.append("行情:本地演示数据(随机游走,固定seed)")
    return S.demo_series(code, date.fromisoformat("2024-01-01"), date.today()), "demo", notes


def attach_units(df: pd.DataFrame, code: str, notes: list) -> pd.DataFrame:
    """真实源无日度份额序列——仅尝试最新份额快照；demo 序列自带份额。"""
    if "total_units_yi" in df.columns:
        return df
    df = df.copy()
    df["total_units_yi"] = None
    df["delta_units_yi"] = None
    units, udate = S.probe_units_akshare(code)
    if units:
        df.loc[df.index[-1], "total_units_yi"] = round(units, 2)
        notes.append(f"份额:仅最新快照({udate or '未知日期'})")
    return df


# ---------------------------------------------------------------------------
# 组装与落盘
# ---------------------------------------------------------------------------
def build(mode: str) -> None:
    os.makedirs(ETFS_DIR, exist_ok=True)
    holdings = S.load_holdings_csv(HOLDINGS_CSV)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    universe, used_modes = [], set()

    for etf in S.SEED_ETFS:
        code = etf["code"]
        df, src, notes = fetch_one(etf, mode)
        used_modes.add(src)

        # 披露数据：holdings.csv（人工核实）优先，否则演示值
        if code in holdings:
            disc, disc_note = holdings[code], "披露:holdings.csv(人工维护)"
        else:
            disc, disc_note = S.demo_disclosures(code), "披露:演示值,请以基金定期报告为准"
        notes.append(disc_note)

        stats = compute_stats(df)
        last = df.iloc[-1]
        last_disc = disc[-1] if disc else None

        meta = {
            "code": code,
            "name": etf["name"],
            "exchange": etf["exchange"],
            "display_group": etf["display_group"],
            "manager": etf["manager"],
            "data_source": src,
            "data_refreshed_at": now,
            "latest_series_date": str(last["date"]),
            "latest_qfq_price": float(last["qfq_close"]),
            "latest_qfq_turnover_est_yi": round(float(last["turnover_yi"]), 2),
            "latest_units_yi": (None if pd.isna(last.get("total_units_yi")) else float(last["total_units_yi"])),
            "latest_disclosure_report_date": last_disc["report_date"] if last_disc else None,
            "latest_disclosure_ratio_pct": last_disc["combined_ratio_pct"] if last_disc else None,
            "latest_disclosure_value_yi": last_disc["combined_value_yi"] if last_disc else None,
            "disclosure_is_demo": bool(disc and disc[-1].get("est", False)),
            "stats": stats,
            "data_notes": "；".join(notes),
        }
        payload = {
            "meta": meta,
            "series": df.where(pd.notna(df), None).to_dict(orient="records"),
            "disclosures": disc,
        }
        with open(os.path.join(ETFS_DIR, f"{code}.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

        entry = {k: meta[k] for k in
                 ("code", "name", "exchange", "display_group", "manager",
                  "latest_disclosure_report_date", "latest_disclosure_ratio_pct",
                  "latest_disclosure_value_yi", "disclosure_is_demo", "stats")}
        entry["data_notes"] = "；".join(n for n in notes if not n.startswith("行情") or "演示" in n)
        universe.append(entry)
        print(f"  ✓ {code} {etf['name']:<14} {src:<16} {len(df)}条 "
              f"披露{meta['latest_disclosure_ratio_pct']}%")

    # 全局排名（按最新披露比例）
    ranked = sorted([u for u in universe if u["latest_disclosure_ratio_pct"] is not None],
                    key=lambda x: -x["latest_disclosure_ratio_pct"])
    for i, u in enumerate(ranked, 1):
        u["rank_by_ratio"] = i
    for u in universe:
        u.setdefault("rank_by_ratio", None)

    with open(os.path.join(OUT_DIR, "universe.json"), "w", encoding="utf-8") as f:
        json.dump(universe, f, ensure_ascii=False, separators=(",", ":"))

    groups = {}
    for u in universe:
        groups.setdefault(u["display_group"], []).append(u)
    groups_out = [{"group": g, "order": i, "etf_count": len(v), "etfs": v}
                  for i, (g, v) in enumerate(sorted(groups.items()), 1)]
    with open(os.path.join(OUT_DIR, "groups.json"), "w", encoding="utf-8") as f:
        json.dump(groups_out, f, ensure_ascii=False, separators=(",", ":"))

    if not os.path.exists(HOLDINGS_CSV):
        with open(HOLDINGS_EXAMPLE, "w", newline="", encoding="utf-8") as f:
            w = __import__("csv").writer(f)
            w.writerow(["code", "report_date", "combined_ratio_pct", "combined_value_yi"])
            w.writerow(["# 把本文件改名 holdings.csv 后填入真实披露值（基金定期报告·前十大持有人汇总）", "", "", ""])
            w.writerow(["510310", "2025-12-31", 85.27, 2556.98])
            w.writerow(["510300", "2025-12-31", 82.76, 3494.08])

    print(f"\n完成: {len(universe)} 只 ETF, 数据源={sorted(used_modes)}, "
          f"输出目录={os.path.abspath(OUT_DIR)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["auto", "akshare", "demo"], default="auto")
    args = ap.parse_args()
    build(args.mode)
