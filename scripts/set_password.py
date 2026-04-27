#!/usr/bin/env python3
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTH_FILE = ROOT / "data" / "auth.json"


def build_record(password: str, iterations: int = 390000) -> dict[str, object]:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return {
        "algo": "pbkdf2_sha256",
        "iterations": iterations,
        "salt": salt.hex(),
        "hash": digest.hex(),
    }


def prompt_password() -> str:
    first = getpass.getpass("New dashboard password: ")
    second = getpass.getpass("Confirm password: ")
    if not first:
        raise SystemExit("Password cannot be empty.")
    if first != second:
        raise SystemExit("Passwords do not match.")
    return first


def main() -> None:
    parser = argparse.ArgumentParser(description="Set/rotate hashed password for MVOF dashboard")
    parser.add_argument("--password", help="Password value (omit to enter securely in terminal)")
    parser.add_argument("--iterations", type=int, default=390000)
    args = parser.parse_args()

    password = args.password if args.password is not None else prompt_password()
    if not password:
        raise SystemExit("Password cannot be empty.")

    record = build_record(password, iterations=args.iterations)
    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    AUTH_FILE.write_text(json.dumps(record, indent=2), encoding="utf-8")
    os.chmod(AUTH_FILE, 0o600)

    print(f"Updated hashed password file: {AUTH_FILE}")
    print("Restart server.py to apply the new password.")


if __name__ == "__main__":
    main()
