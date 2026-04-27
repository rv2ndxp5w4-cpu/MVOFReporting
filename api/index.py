from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import date
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
WEB_DIR = ROOT / "web"
BASE_FILE = DATA_DIR / "base_assets.json"
MANUAL_FILE = DATA_DIR / "manual_updates.json"
AUTH_FILE = DATA_DIR / "auth.json"

LEGACY_PASSWORD = os.getenv("MVOF_DASHBOARD_PASSWORD", "mvof2026")
COOKIE_SECRET = os.getenv("MVOF_COOKIE_SECRET", os.getenv("MVOF_DASHBOARD_PASSWORD", "mvof-cookie-secret"))
COOKIE_NAME = "mvof_session"
COOKIE_TTL_SECONDS = 60 * 60 * 12


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


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

    expected = hashlib.sha256(LEGACY_PASSWORD.encode("utf-8")).hexdigest()
    computed = hashlib.sha256(candidate.encode("utf-8")).hexdigest()
    return secrets.compare_digest(computed, expected)


def _sign(data: str) -> str:
    return hmac.new(COOKIE_SECRET.encode("utf-8"), data.encode("utf-8"), hashlib.sha256).hexdigest()


def issue_session_cookie() -> str:
    expiry = int(time.time()) + COOKIE_TTL_SECONDS
    nonce = secrets.token_urlsafe(12)
    payload = f"{expiry}:{nonce}"
    sig = _sign(payload)
    return f"{payload}:{sig}"


def verify_session_cookie(token: str | None) -> bool:
    if not token:
        return False
    try:
        expiry_str, nonce, sig = token.split(":", 2)
        payload = f"{expiry_str}:{nonce}"
        if not secrets.compare_digest(_sign(payload), sig):
            return False
        if int(expiry_str) < int(time.time()):
            return False
        return True
    except Exception:
        return False


def merge_assets() -> dict[str, Any]:
    base = load_json(BASE_FILE)
    manual = load_json(MANUAL_FILE) if MANUAL_FILE.exists() else {"assets": {}}
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


class handler(BaseHTTPRequestHandler):
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
        value = cookie.get(COOKIE_NAME)
        return value.value if value else None

    def _is_authenticated(self) -> bool:
        return verify_session_cookie(self._cookie_token())

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
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Set-Cookie", f"{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
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
                self._send_text("<h3>Incorrect password</h3><p><a href='/login'>Try again</a></p>", status=401)
                return
            token = issue_session_cookie()
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Set-Cookie", f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={COOKIE_TTL_SECONDS}")
            self.send_header("Location", "/")
            self.end_headers()
            return

        if not self._is_authenticated():
            self._send_json({"error": "Unauthorized"}, status=401)
            return

        if path.startswith("/api/assets/") and (path.endswith("/update") or path.endswith("/event")):
            self._send_json(
                {
                    "error": "Write endpoints are disabled in Vercel serverless mode. Use local runtime for manual edits.",
                    "mode": "read-only",
                },
                status=501,
            )
            return

        if path == "/api/import-path":
            self._send_json(
                {
                    "error": "Import endpoint is disabled in Vercel serverless mode. Use local runtime for imports.",
                    "mode": "read-only",
                },
                status=501,
            )
            return

        self._send_json({"error": "Not found"}, status=404)
