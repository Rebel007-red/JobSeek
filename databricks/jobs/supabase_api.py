"""Minimal Supabase PostgREST client for the service-only pipeline RPCs (sync_user_data.py, publish_to_supabase.py).

Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment, databricks/.env or the repo-root .env.
The service key is sent as apikey + Bearer token, so auth.jwt()->>'role' = 'service_role' inside the RPC.
It is never logged, and never written anywhere: Databricks does not get it (files move through the volume).
"""
import os
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")
load_dotenv(HERE.parents[1] / ".env")

ATTEMPTS = 4
RETRY_STATUSES = {408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524}


class SupabaseError(RuntimeError):
    """An RPC refused with an HTTP error; .status and .code (SQLSTATE / PostgREST code) are set."""

    def __init__(self, message, status=None, code=None):
        super().__init__(message)
        self.status = status
        self.code = code


def _env(name):
    return (os.getenv(name) or "").strip().strip('"')


def _config():
    url = _env("SUPABASE_URL").rstrip("/")
    key = _env("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise EnvironmentError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return url, key


def _error_message(response):
    try:
        body = response.json()
    except ValueError:
        return None, response.text[:500]
    if isinstance(body, dict):
        message = body.get("message") or body.get("error") or body.get("msg") or str(body)
        details = body.get("details") or body.get("hint")
        return body.get("code"), (f"{message} ({details})" if details else str(message))[:1000]
    return None, str(body)[:500]


def rpc(name, payload, timeout=60):
    """POST /rest/v1/rpc/<name> with the service key and return the parsed JSON (None for an empty body).
    Retries network errors, timeouts, 429 and 5xx (the pipeline RPCs are idempotent); raises SupabaseError with the
    server's error.message on any other HTTP error (pipeline_publish_finish refusals arrive as 400)."""
    url, key = _config()
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    last = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            response = requests.post(f"{url}/rest/v1/rpc/{name}", json=payload, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            last = SupabaseError(f"{name}: {type(exc).__name__}")
        else:
            if response.status_code < 400:
                return response.json() if response.content else None
            code, message = _error_message(response)
            last = SupabaseError(f"{name} failed with {response.status_code}: {message}", response.status_code, code)
            if response.status_code not in RETRY_STATUSES:
                raise last
        if attempt < ATTEMPTS:
            time.sleep(min(30, 2 ** attempt))
    raise last
