"""Review metadata and cash-flow attribution; never modifies assigned NAV."""
import datetime as dt
import json
import math
from pathlib import Path
from urllib.parse import urlparse

STATES = {"open", "evidence-requested", "in-review", "resolved"}
BRIDGE_KEYS = ("contributions_usd", "distributions_usd", "fx_usd", "fees_usd")


def read_optional(path):
    return json.loads(path.read_text()) if path.exists() else {"assets": {}}


def source_type(url):
    host = urlparse(url).hostname or ""
    if host == "find-and-update.company-information.service.gov.uk":
        return "Official filing"
    if any(host == h or host.endswith('.' + h) for h in (
        "speechify.com", "activeloop.ai", "rainapp.com", "krisp.ai", "superhuman.com",
        "kurlycorp.com", "getcure.app", "mightybuildings.com")):
        return "Company claim / disclosure"
    if host == "www.prnewswire.com" or host.endswith("linkedin.com"):
        return "Company announcement"
    if any(h in host for h in ("entrackr.com", "chocale.cl", "brutkasten.com", "sportsbusinessjournal.com", "axios.com")):
        return "Independent reporting"
    return "Secondary source / directory"


def decorate(base, data_dir, today=None):
    today = today or dt.date.today()
    workflows = read_optional(data_dir / "review_workflow.json").get("assets", {})
    bridges = read_optional(data_dir / "performance_inputs.json").get("assets", {})
    for asset in base.get("assets", []):
        review = asset.get("nav_review", {})
        status = review.get("status", "")
        written_off = asset.get("section") == "writeoffs" or asset.get("market_value_usd") == 0
        level = "written-off" if written_off else (
            "urgent" if status == "Urgent impairment review" else
            "review" if any(word in status.lower() for word in ("review required", "reconciliation required", "markdown review")) else "evidence")
        asset["nav_risk"] = {
            "level": level, "assigned_nav_unchanged": True,
            "label": {"urgent": "Assigned NAV at risk", "review": "Assigned NAV needs reconciliation",
                      "evidence": "Assigned NAV not independently substantiated", "written-off": "Written off"}[level],
        }
        workflow = workflows.get(asset["id"], {})
        asset["review_workflow"] = {"owner": "", "state": "open", "due_date": "",
            "evidence_requested": review.get("required_evidence", ""), "resolution": "", "last_reviewed_at": "", **workflow}
        published = []
        for source in review.get("sources", []):
            source["source_type"] = source_type(source.get("url", ""))
            date = source.get("event_date")
            try:
                age = (today-dt.date.fromisoformat(date)).days
                source["age_days"] = age
                source["freshness"] = "Future-dated; verify" if age < 0 else "Older than 180 days" if age > 180 else "Within 180 days"
                published.append(age)
            except (ValueError, TypeError):
                source["freshness"] = "Undated; freshness unknown"
        try:
            review_age = (today-dt.date.fromisoformat(review.get("reviewed_at", ""))).days
        except ValueError:
            review_age = None
        asset["evidence_health"] = {
            "review_age_days": review_age,
            "label": "No sources" if not review.get("sources") else "No dated evidence" if not published else
                     "Dated evidence older than 180 days" if min(published) > 180 else "Recent dated evidence available",
            "review_stale": review_age is None or review_age > 90,
        }
        inputs = bridges.get(asset["id"], {})
        matched = inputs.get("from_date") == asset.get("previous_valuation_date") and inputs.get("to_date") == asset.get("valuation_as_of")
        valid = matched and bool(inputs.get("source")) and all(
            type(inputs.get(k)) in (int, float) and math.isfinite(inputs[k]) for k in BRIDGE_KEYS)
        if valid and any(inputs[k] < 0 for k in ("contributions_usd", "distributions_usd", "fees_usd")):
            valid = False
        bridge = {k: inputs.get(k) if valid else None for k in BRIDGE_KEYS}
        movement = asset.get("change_since_previous_usd")
        bridge.update(complete=valid, source=inputs.get("source", ""),
            warning="" if valid else "Cash-flow attribution unavailable: provide all four components, period dates and a source. Missing amounts are not zero.",
            unexplained_change_usd=(movement-inputs["contributions_usd"]+inputs["distributions_usd"]-inputs["fx_usd"]+inputs["fees_usd"]) if valid and movement is not None else None)
        asset["performance_bridge"] = bridge
    base["import_preview"] = read_optional(data_dir / "import_preview.json") if (data_dir / "import_preview.json").exists() else None
    return base


def save_review(data_dir, asset_id, payload, base):
    if asset_id not in {a["id"] for a in base["assets"]}:
        raise ValueError("Unknown asset")
    allowed = {"owner", "state", "due_date", "evidence_requested", "resolution"}
    if not isinstance(payload, dict) or set(payload)-allowed:
        raise ValueError("Only review workflow fields may be changed; assigned NAV is read-only")
    if payload.get("state") not in STATES:
        raise ValueError("Invalid review state")
    if any(not isinstance(v, str) or len(v)>5000 for v in payload.values()):
        raise ValueError("Review fields must be text, at most 5000 characters")
    if payload.get("due_date"):
        dt.date.fromisoformat(payload["due_date"])
    if payload["state"] == "resolved" and not payload.get("resolution", "").strip():
        raise ValueError("Provide a resolution rationale. The evidence risk flag remains visible.")
    path = data_dir / "review_workflow.json"
    data = read_optional(path)
    old = data.setdefault("assets", {}).get(asset_id, {})
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    event = {"saved_at":now, **payload}
    data["assets"][asset_id] = {**old, **payload, "last_reviewed_at":now[:10], "history":[*old.get("history", []), event]}
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2)+"\n")
    temporary.replace(path)
