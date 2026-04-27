#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import secrets
from datetime import date
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
WEB_DIR = ROOT / "web"
BASE_FILE = DATA_DIR / "base_assets.json"
MANUAL_FILE = DATA_DIR / "manual_updates.json"
AUTH_FILE = DATA_DIR / "auth.json"

LEGACY_PASSWORD = os.getenv("MVOF_DASHBOARD_PASSWORD", "mvof2026")
SESSIONS: set[str] = set()


def ensure_manual_file() -> None:
    if MANUAL_FILE.exists():
        return
    MANUAL_FILE.write_text(json.dumps({"assets": {}, "aliases": {}}, indent=2), encoding="utf-8")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _pbkdf2_sha256(password: str, salt_hex: str, iterations: int) -> str:
    salt = bytes.fromhex(salt_hex)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return digest.hex()


def _read_auth_record() -> dict[str, Any] | None:
    if not AUTH_FILE.exists():
        return None
    try:
        data = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    required = {"algo", "iterations", "salt", "hash"}
    if not required.issubset(set(data.keys())):
        return None
    return data


def verify_password(candidate: str) -> bool:
    record = _read_auth_record()
    if record and str(record.get("algo")) == "pbkdf2_sha256":
        try:
            expected = str(record["hash"])
            computed = _pbkdf2_sha256(candidate, str(record["salt"]), int(record["iterations"]))
            return secrets.compare_digest(computed, expected)
        except (ValueError, TypeError):
            return False

    # Backward-compatible fallback if hashed password file is not configured yet.
    expected = hashlib.sha256(LEGACY_PASSWORD.encode("utf-8")).hexdigest()
    computed = hashlib.sha256(candidate.encode("utf-8")).hexdigest()
    return secrets.compare_digest(computed, expected)


def fmt_report_date(value: str | None) -> str:
    if value:
        return value
    return date.today().isoformat()


def merge_assets() -> dict[str, Any]:
    base = load_json(BASE_FILE)
    ensure_manual_file()
    manual = load_json(MANUAL_FILE)
    manual_assets = manual.get("assets", {})

    for asset in base.get("assets", []):
        overrides = manual_assets.get(asset["id"], {})
        if overrides.get("canonical_name"):
            asset["canonical_name"] = overrides["canonical_name"]
        if overrides.get("underlying_asset"):
            asset["underlying_asset"] = overrides["underlying_asset"]
        if overrides.get("resolved") is True:
            asset["resolved"] = True
            if asset.get("clarification_status") == "Clarification needed":
                asset["clarification_status"] = "resolved"
        if overrides.get("aliases"):
            asset["aliases"] = sorted({*(asset.get("aliases") or []), *overrides["aliases"]})
        if overrides.get("timeline"):
            asset["timeline"] = sorted(
                [*(asset.get("timeline") or []), *overrides["timeline"]],
                key=lambda ev: ev.get("date", ""),
                reverse=True,
            )

    return {
        "generated_at": base.get("generated_at"),
        "sources": base.get("sources", {}),
        "assets": base.get("assets", []),
    }


def parse_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    content_len = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(content_len) if content_len else b""
    if not raw:
        return {}
    ctype = handler.headers.get("Content-Type", "")
    if "application/json" in ctype:
        return json.loads(raw.decode("utf-8"))
    return {k: v[0] for k, v in parse_qs(raw.decode("utf-8")).items()}


def read_source_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".json", ".csv"}:
        return path.read_text(encoding="utf-8", errors="ignore")[:20000]
    return f"File imported: {path.name} (binary or unsupported preview format)"


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text: str, status: int = 200, content_type: str = "text/html; charset=utf-8") -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cookie_token(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        cookie = SimpleCookie()
        cookie.load(raw)
        value = cookie.get("mvof_session")
        return value.value if value else None

    def _is_authenticated(self) -> bool:
        token = self._cookie_token()
        return bool(token and token in SESSIONS)

    def _require_auth(self) -> bool:
        if self._is_authenticated():
            return True
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", "/login")
        self.end_headers()
        return False

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/login":
            self._send_text((WEB_DIR / "login.html").read_text(encoding="utf-8"))
            return

        if path == "/logout":
            token = self._cookie_token()
            if token and token in SESSIONS:
                SESSIONS.remove(token)
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Set-Cookie", "mvof_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
            self.send_header("Location", "/login")
            self.end_headers()
            return

        if path == "/api/assets":
            if not self._is_authenticated():
                self._send_json({"error": "Unauthorized"}, status=401)
                return
            data = merge_assets()
            qs = parse_qs(parsed.query)
            section = (qs.get("section") or [""])[0]
            trend = (qs.get("trend") or [""])[0]
            reporting = (qs.get("reporting") or [""])[0]
            search = ((qs.get("search") or [""])[0]).strip().lower()

            assets = data["assets"]
            if section:
                assets = [a for a in assets if a.get("section") == section]
            if trend:
                assets = [a for a in assets if a.get("trend") == trend]
            if reporting:
                assets = [a for a in assets if reporting in (a.get("reporting_styles_available") or [])]
            if search:
                assets = [
                    a
                    for a in assets
                    if search in a.get("name", "").lower()
                    or search in a.get("canonical_name", "").lower()
                    or search in a.get("underlying_asset", "").lower()
                    or any(search in alias.lower() for alias in (a.get("aliases") or []))
                ]

            self._send_json({**data, "assets": assets})
            return

        if path.startswith("/api/assets/"):
            if not self._is_authenticated():
                self._send_json({"error": "Unauthorized"}, status=401)
                return
            asset_id = path.split("/")[-1]
            data = merge_assets()
            asset = next((a for a in data["assets"] if a["id"] == asset_id), None)
            if not asset:
                self._send_json({"error": "Asset not found"}, status=404)
                return
            self._send_json({"asset": asset})
            return

        if path == "/":
            if not self._require_auth():
                return
            self._send_text((WEB_DIR / "index.html").read_text(encoding="utf-8"))
            return

        if path == "/app.js":
            if not self._require_auth():
                return
            self._send_text((WEB_DIR / "app.js").read_text(encoding="utf-8"), content_type="application/javascript; charset=utf-8")
            return

        if path == "/styles.css":
            if not self._require_auth():
                return
            self._send_text((WEB_DIR / "styles.css").read_text(encoding="utf-8"), content_type="text/css; charset=utf-8")
            return

        self._send_text("Not found", status=404, content_type="text/plain; charset=utf-8")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/login":
            payload = parse_body(self)
            candidate = str(payload.get("password", ""))
            if not verify_password(candidate):
                self.send_response(HTTPStatus.FOUND)
                self.send_header("Location", "/login?error=1")
                self.end_headers()
                return
            token = secrets.token_urlsafe(24)
            SESSIONS.add(token)
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Set-Cookie", f"mvof_session={token}; Path=/; HttpOnly; SameSite=Lax")
            self.send_header("Location", "/")
            self.end_headers()
            return

        if not self._is_authenticated():
            self._send_json({"error": "Unauthorized"}, status=401)
            return

        if path.startswith("/api/assets/") and path.endswith("/update"):
            asset_id = path.split("/")[3]
            payload = parse_body(self)

            ensure_manual_file()
            manual = load_json(MANUAL_FILE)
            assets = manual.setdefault("assets", {})
            asset_data = assets.setdefault(asset_id, {"aliases": [], "timeline": []})

            if payload.get("canonical_name"):
                asset_data["canonical_name"] = str(payload["canonical_name"]).strip()
            if payload.get("underlying_asset"):
                asset_data["underlying_asset"] = str(payload["underlying_asset"]).strip()
            if payload.get("resolved") is True:
                asset_data["resolved"] = True
            if payload.get("alias"):
                alias = str(payload["alias"]).strip()
                if alias and alias not in asset_data["aliases"]:
                    asset_data["aliases"].append(alias)

            save_json(MANUAL_FILE, manual)
            self._send_json({"ok": True})
            return

        if path.startswith("/api/assets/") and path.endswith("/event"):
            asset_id = path.split("/")[3]
            payload = parse_body(self)
            ensure_manual_file()
            manual = load_json(MANUAL_FILE)
            assets = manual.setdefault("assets", {})
            asset_data = assets.setdefault(asset_id, {"aliases": [], "timeline": []})
            event = {
                "date": fmt_report_date(payload.get("date")),
                "label": str(payload.get("label", "Manual update")).strip(),
                "event_type": str(payload.get("event_type", "note")).strip() or "note",
                "reporting_style": str(payload.get("reporting_style", "full-year")).strip() or "full-year",
                "source": str(payload.get("source", "Manual input")).strip() or "Manual input",
            }
            if payload.get("value_usd") not in (None, ""):
                try:
                    event["value_usd"] = float(payload["value_usd"])
                except (TypeError, ValueError):
                    pass
            asset_data["timeline"].append(event)
            save_json(MANUAL_FILE, manual)
            self._send_json({"ok": True, "event": event})
            return

        if path == "/api/import-path":
            payload = parse_body(self)
            asset_id = str(payload.get("asset_id", "")).strip()
            source_path = Path(str(payload.get("source_path", "")).strip())
            if not asset_id:
                self._send_json({"error": "asset_id is required"}, status=400)
                return
            if not source_path.exists():
                self._send_json({"error": "Source path does not exist"}, status=400)
                return

            text = read_source_text(source_path)
            summary = text.strip().replace("\n", " ")[:300]

            ensure_manual_file()
            manual = load_json(MANUAL_FILE)
            assets = manual.setdefault("assets", {})
            asset_data = assets.setdefault(asset_id, {"aliases": [], "timeline": []})
            asset_data["timeline"].append(
                {
                    "date": fmt_report_date(payload.get("date")),
                    "label": str(payload.get("label") or f"Imported from {source_path.name}"),
                    "event_type": str(payload.get("event_type") or "import"),
                    "reporting_style": str(payload.get("reporting_style") or "full-year"),
                    "source": str(source_path),
                    "summary": summary,
                }
            )
            save_json(MANUAL_FILE, manual)
            self._send_json({"ok": True, "summary": summary})
            return

        self._send_json({"error": "Not found"}, status=404)


def run() -> None:
    ensure_manual_file()
    host = "127.0.0.1"
    port = int(os.getenv("PORT", "8787"))
    print(f"MVOF dashboard running on http://{host}:{port}")
    print("Use scripts/set_password.py to configure a hashed password in data/auth.json.")
    server = ThreadingHTTPServer((host, port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    run()
