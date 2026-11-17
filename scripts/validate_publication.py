"""Fail the deployment build if imported values or controls no longer reconcile."""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def validate(data_path, preview_path):
    raw = data_path.read_bytes()
    data = json.loads(raw)
    preview = json.loads(preview_path.read_text())
    if not preview.get("applied") or preview.get("errors"):
        raise ValueError("Import has not passed and been applied; publication blocked")
    if hashlib.sha256(raw).hexdigest() != preview.get("candidate_sha256"):
        raise ValueError("Dataset differs from reviewed import; regenerate preview before publication")
    assets = data["assets"]
    control = data["reconciliation"]
    if len(assets) != control["asset_count"] or len({a["id"] for a in assets}) != len(assets):
        raise ValueError("Missing or duplicate holdings")
    holdings = {h["id"]:h for h in control["holdings"]}
    if set(holdings) != {a["id"] for a in assets}:
        raise ValueError("Holding control identities disagree")
    for a in assets:
        for key in ("market_value_usd", "book_cost_usd"):
            value = a.get(key)
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError(f"Invalid value for {a['id']}")
            if abs(value-holdings[a["id"]][key]) > .01:
                raise ValueError(f"Holding value differs from workbook control: {a['id']}")
        latest = next(h for h in a["valuation_history"] if h["date"] == a["valuation_as_of"])
        if abs(latest["value_usd"]-a["market_value_usd"])>.01:
            raise ValueError("Historical valuation and assigned NAV disagree")
    for key in ("market_value_usd", "book_cost_usd"):
        if abs(sum(a[key] for a in assets)-control[key])>.01:
            raise ValueError("Portfolio control total mismatch")
    workbook = ROOT / data["sources"]["latest_workbook"]
    if workbook.exists() and hashlib.sha256(workbook.read_bytes()).hexdigest() != control["workbook_sha256"]:
        raise ValueError("Workbook changed since import; refresh preview before publication")
    return {"holdings":len(assets), "assigned_nav_usd":control["market_value_usd"], "warnings":preview.get("warnings", [])}


if __name__ == "__main__":
    try:
        print(json.dumps(validate(ROOT/'data/base_assets.json', ROOT/'data/import_preview.json'), indent=2))
    except (ValueError, KeyError, StopIteration, OSError) as exc:
        raise SystemExit(f"Publication blocked: {exc}")
