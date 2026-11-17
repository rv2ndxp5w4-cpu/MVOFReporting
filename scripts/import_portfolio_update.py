#!/usr/bin/env python3
"""Import a reconciled Portfolio Report without rebuilding or discarding history."""
import argparse
import copy
import datetime as dt
import hashlib
import json
import math
from pathlib import Path

import openpyxl
from build_dataset import infer_instrument

# Workbook holding number -> persistent dashboard identity; legal name check prevents drift.
MATCHES = {
    1: ("1984-ventures-ii-l-p", "1984"),
    2: ("3-0-fund-lp", "3.0 Fund"),
    3: ("backend-capital-ii-lp", "Backend"),
    4: ("onevc-fund-ii-lp", "ONEVC"),
    5: ("shrug-fund-ii-l-p", "Shrug"),
    6: ("iseed-fund-ii-a-series-of-utsav-somani-investments-lp", "iSeed"),
    7: ("atlas-kitchen-pte-ltd-safe", "Atlas Kitchen"),
    8: ("atom-finance-inc-series-a-preferred-stock", "Atom Finance"),
    9: ("coda-project-inc", "Birdly"),
    10: ("calii-inc-series-seed-1-preferred-stock", "Calii"),
    11: ("codesignal-inc", "CodeSignal"),
    12: ("creoate-limited-advance-subscription", "Creoate"),
    13: ("market-kurly", "Fuse Venture"),
    14: ("houm-group-inc-converted-safe", "Houm"),
    15: ("krisp-technologies-inc-series-a-preferred-stock", "Krisp"),
    16: ("mighty-angel-vehicle-pte-ltd", "Mighty Angel"),
    17: ("teachmint", "Teachmint"),
    18: ("pagarbook", "Gyankaar"),
    19: ("rain-technologies-inc", "Rain"),
    20: ("snark-ai-inc-series-a-3-preferred", "Snark"),
    21: ("speechify-inc-safe", "Speechify"),
    22: ("cure-group-gmbh", "Cure"),
    23: ("byrd-technologies", "Byrd"),
    24: ("supersapiens", "TT1"),
    25: ("helbiz-wheels-labs-inc-series-a-1-1-5-pref", "Helbiz"),
    26: ("mighty-buildings-inc-common-stock", "Mighty Buildings"),
    27: ("byuk-inc", "Byuk"),
    28: ("productify-inc-series-a1-preferred-stock", "Productify"),
}


def import_update(base, workbook, research):
    result = copy.deepcopy(base)
    ws = openpyxl.load_workbook(workbook, data_only=True)["Portfolio Report"]
    valuation_date = ws["D5"].value.date().isoformat()
    if ws["P1"].value.date().isoformat() != valuation_date:
        raise ValueError("Workbook valuation dates disagree")
    source = f"{workbook.name} / Portfolio Report"
    groups = {}
    for r in range(8, ws.max_row + 1):
        n = ws.cell(r, 2).value
        if isinstance(n, int):
            groups.setdefault(n, []).append(r)
    if set(groups) != set(MATCHES):
        raise ValueError("Unreconciled or missing holding numbers")
    assets = {a["id"]: a for a in result["assets"]}
    if set(assets) != {v[0] for v in MATCHES.values()}:
        raise ValueError("Holdings differ from the existing portfolio; manual reconciliation required")
    audit = []
    for n, rows in groups.items():
        asset_id, expected = MATCHES[n]
        if any(expected.lower() not in str(ws.cell(r, 3).value).lower() for r in rows):
            raise ValueError(f"Holding {n}: legal name changed; review mapping")
        a = assets[asset_id]
        subtotal = [r for r in rows if ws.cell(r, 7).value is None]
        details = [r for r in rows if r not in subtotal]
        if len(subtotal) > 1:
            raise ValueError(f"Multiple subtotal rows for {asset_id}")
        valuation_rows = subtotal or details
        value = sum(float(ws.cell(r, 11).value) for r in valuation_rows)
        book = sum(float(ws.cell(r, 9).value) for r in valuation_rows)
        if not math.isfinite(value) or not math.isfinite(book):
            raise ValueError(f"Non-finite value in holding {n}")
        tranches = []
        for r in details or subtotal:
            name = ws.cell(r, 3).value
            terms = infer_instrument(name, str(ws.cell(r, 6).value or ""))
            tranches.append(dict(security_name=name, **terms,
                nominal_holding=ws.cell(r, 7).value, average_cost=ws.cell(r, 8).value,
                book_cost_usd=ws.cell(r, 9).value, market_value_usd=ws.cell(r, 11).value,
                pnl_usd=ws.cell(r, 13).value, source=f"{source}, row {r}", as_of=valuation_date))
        prior_date = a.get("valuation_as_of", "2025-12-31")
        if prior_date > valuation_date:
            raise ValueError("Refusing to replace a newer valuation with an older report")
        history = a.setdefault("valuation_history", [])
        if not history:
            history.extend([
                {"date": "2023-03-31", "value_usd": a.get("value_2023_usd"), "source": "Original Sheet2 / 1Q 2023"},
                {"date": prior_date, "value_usd": a["market_value_usd"],
                 "book_cost_usd": a.get("book_cost_usd"), "source": "Original Sheet2 / December 2025",
                 "investments": copy.deepcopy(a.get("investments", []))}])
        previous = max((h for h in history if h["date"] < valuation_date), key=lambda h: h["date"])
        history[:] = [h for h in history if h["date"] != valuation_date]
        history.append({"date": valuation_date, "value_usd": value, "book_cost_usd": book,
                        "source": source, "source_rows": valuation_rows, "investments": tranches})
        history.sort(key=lambda h: h["date"])
        a.update(valuation_as_of=valuation_date, previous_valuation_date=previous["date"],
                 previous_market_value_usd=previous["value_usd"],
                 change_since_previous_usd=value-previous["value_usd"],
                 market_value_usd=value, book_cost_usd=book, pnl_usd=value-book,
                 investments=tranches, latest_valuation_source=source,
                 diff_current_vs_2023_usd=value-a["value_2023_usd"])
        change = a["change_since_previous_usd"]
        a["trend"] = "stable" if abs(change) < 1 else "growth" if change > 0 else "decline"
        a["value_grower"] = value > 0 and change > 100000
        a["major_slider"] = value > 0 and change <= -500000
        if value == 0:
            a["section"] = "writeoffs"
        review = copy.deepcopy(research[asset_id])
        review["reviewed_at"] = "2026-11-17"
        a["nav_review"] = review
        a["latest_market_info_external"] = review["traction"]
        a["clarification_status"] = "OK" if value == 0 else "Clarification needed"
        a["decline_reason"] = review["assessment"]
        current_event = {"date": valuation_date, "label": "H1 2026 reported valuation",
                         "event_type": "valuation", "reporting_style": "half-year",
                         "value_usd": value, "source": source,
                         "summary": f"Change vs {previous['date']}: USD {change:,.2f}. Value movement is not cash-flow-adjusted return."}
        a["timeline"] = [e for e in a.get("timeline", []) if e.get("import_key") != "nov26-update"]
        current_event["import_key"] = "nov26-update"
        a["timeline"].append(current_event)
        for evidence in review.get("sources", []):
            if evidence.get("event_date"):
                a["timeline"].append({"date":evidence["event_date"], "label":evidence["title"],
                    "event_type":"external_market_info", "reporting_style":"ad-hoc",
                    "source":evidence["url"], "summary":review["traction"], "import_key":"nov26-update"})
        a["timeline"].append({"date": "2026-11-17", "label": "Traction and NAV evidence review",
                              "event_type": "research", "reporting_style": "ad-hoc", "source": "External sources linked in NAV review",
                              "summary": review["traction"] + " Assessment: " + review["assessment"], "import_key": "nov26-update"})
        a["timeline"].sort(key=lambda e:e.get("date", ""), reverse=True)
        a["reporting_styles_available"] = sorted(set(a.get("reporting_styles_available", []) + ["half-year"]))
        gap = book-sum(float(t["book_cost_usd"] or 0) for t in tranches)
        value_gap = value-sum(float(t["market_value_usd"] or 0) for t in tranches)
        if abs(value_gap) > .01:
            raise ValueError(f"Tranche market values do not reconcile for {asset_id}")
        a["latest_reconciliation"] = {"holding_number":n, "source_rows":rows, "valuation_rows":valuation_rows,
            "tranche_book_gap_usd":gap, "tranche_value_gap_usd":value_gap,
            "note":"Subtotal used once; tranche book cost does not reconcile. Confirm cost basis." if abs(gap)>0.01 else "Tranches reconcile to reported book cost and value."}
        audit.append({"id":asset_id, "name":a["name"], "rows":rows, "book_cost_usd":book,
                      "market_value_usd":value, "change_usd":change, "tranche_book_gap_usd":gap})
    total = sum(a["market_value_usd"] for a in assets.values())
    total_book = sum(a["book_cost_usd"] for a in assets.values())
    if abs(total - ws["K56"].value)>0.01 or abs(total_book-ws["I56"].value)>0.01:
        raise ValueError("Portfolio totals do not reconcile")
    result["valuation_as_of"] = valuation_date
    result["research_as_of"] = "2026-11-17"
    result["sources"]["latest_workbook"] = workbook.name
    result["generated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    result["reconciliation"] = {"asset_count":len(assets), "market_value_usd":total, "book_cost_usd":total_book,
        "workbook_market_value_cell":"Portfolio Report!K56", "workbook_book_cost_cell":"Portfolio Report!I56",
        "workbook_sha256":hashlib.sha256(workbook.read_bytes()).hexdigest(), "holdings":audit}
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--workbook", type=Path, required=True)
    p.add_argument("--base", type=Path, required=True)
    p.add_argument("--research", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--preview-report", type=Path, required=True)
    p.add_argument("--apply", action="store_true", help="Apply reconciled values; without this flag only the preview is written")
    args = p.parse_args()
    preview = {"applied":False, "errors":[], "warnings":[], "rows":[], "source":args.workbook.name}
    try:
        baseline = json.loads(args.base.read_text())
        data = import_update(baseline, args.workbook, json.loads(args.research.read_text()))
        previous = {a["id"]:a for a in baseline["assets"]}
        for a in data["assets"]:
            preview["rows"].append({"id":a["id"], "name":a["name"], "matched":True,
                "source_rows":a["latest_reconciliation"]["source_rows"],
                "old_value_usd":previous[a["id"]]["market_value_usd"], "new_value_usd":a["market_value_usd"],
                "change_usd":a["market_value_usd"]-previous[a["id"]]["market_value_usd"],
                "old_book_cost_usd":previous[a["id"]]["book_cost_usd"], "new_book_cost_usd":a["book_cost_usd"]})
            if abs(a["latest_reconciliation"]["tranche_book_gap_usd"])>.01:
                preview["warnings"].append(f"{a['name']}: tranche book-cost gap USD {a['latest_reconciliation']['tranche_book_gap_usd']:,.2f}; reported subtotal retained")
        preview.update(valuation_as_of=data["valuation_as_of"], matched_count=len(data["assets"]), unmatched_names=[],
            market_value_usd=data["reconciliation"]["market_value_usd"], book_cost_usd=data["reconciliation"]["book_cost_usd"])
        content = json.dumps(data, indent=2, ensure_ascii=True) + "\n"
        preview["candidate_sha256"] = hashlib.sha256(content.encode()).hexdigest()
        if args.apply:
            temporary = args.output.with_suffix('.tmp')
            temporary.write_text(content)
            temporary.replace(args.output)
            preview["applied"] = True
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as exc:
        preview["errors"].append(str(exc))
        # Identify workbook names not covered by the explicit identity map.
        if args.workbook.exists():
            failed_wb = openpyxl.load_workbook(args.workbook, data_only=True)
            ws = failed_wb['Portfolio Report'] if 'Portfolio Report' in failed_wb.sheetnames else None
        else:
            ws = None
        if ws is not None:
            preview["unmatched_names"] = [str(ws.cell(r,3).value) for r in range(8,ws.max_row+1)
                if isinstance(ws.cell(r,2).value,int) and (ws.cell(r,2).value not in MATCHES or
                    MATCHES[ws.cell(r,2).value][1].lower() not in str(ws.cell(r,3).value).lower())]
    args.preview_report.write_text(json.dumps(preview, indent=2)+"\n")
    print(json.dumps({k:v for k,v in preview.items() if k != "rows"}, indent=2))
    if preview["errors"]:
        raise SystemExit(1)
