"""Apply the app schema and RPC API to the Supabase database.

    python supabase/apply.py            apply app_schema.sql then app_api.sql in one transaction
    python supabase/apply.py --check    only report whether SUPABASE_DB_URL is set

SUPABASE_DB_URL (Supabase dashboard -> Connect -> connection string, session pooler or direct) comes from the
environment, the repo-root .env or databricks/.env. It is never printed. Both files are idempotent, so re-running is
safe; afterwards the size of every app table is printed.

For a plain local PostgreSQL (tests): --url-env TEST_DATABASE_URL --local-stub also applies tests/local_stub.sql first
(Supabase roles, auth.users, auth.uid()). Never use --local-stub against the Supabase project.

Needs psycopg 3 (pip install "psycopg[binary]"), local only.
"""
import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "databricks" / ".env")

FILES = ["app_schema.sql", "app_api.sql"]


def env(name):
    return (os.getenv(name) or "").strip().strip('"')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="only report whether the database URL is set")
    parser.add_argument("--url-env", default="SUPABASE_DB_URL", help="environment variable with the database URL")
    parser.add_argument("--local-stub", action="store_true", help="apply tests/local_stub.sql first (local PostgreSQL only)")
    args = parser.parse_args(argv)

    url = env(args.url_env)
    if args.check:
        print(f"{args.url_env}: {'set' if url else 'missing'}")
        return 0 if url else 1
    if not url:
        print(f"[ERROR] {args.url_env} is not set (environment, .env or databricks/.env)")
        return 1

    import psycopg

    files = (["tests/local_stub.sql"] if args.local_stub else []) + FILES
    with psycopg.connect(url, prepare_threshold=None, connect_timeout=20) as conn:
        server = conn.execute("SELECT current_setting('server_version')").fetchone()[0]
        print(f"Connected (PostgreSQL {server})")
        if args.local_stub and conn.execute(
                "SELECT count(*) FROM pg_roles WHERE rolname IN ('supabase_admin', 'supabase_auth_admin')").fetchone()[0]:
            print("[ERROR] --local-stub is for a plain local PostgreSQL; this database is a Supabase project")
            return 1
        with conn.transaction():
            # Large statements (the API file) must not hit a short role-level timeout
            conn.execute("SET LOCAL statement_timeout = '120s'")
            for name in files:
                conn.execute((HERE / name).read_text(encoding="utf-8"))
                print(f"[OK] {name}")
        rows = conn.execute("""
            SELECT c.relname, pg_total_relation_size(c.oid), coalesce(s.n_live_tup, 0)
            FROM pg_class c
            LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
            WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'r'
            ORDER BY pg_total_relation_size(c.oid) DESC, c.relname
        """).fetchall()
        total = sum(size for _, size, _ in rows)
        print(f"app tables ({total / 1024 / 1024:.1f} MB in total):")
        for name, size, live in rows:
            print(f"  {name:<18} {size / 1024:>10.0f} KB  ~{live} rows")
        db_size = conn.execute("SELECT pg_database_size(current_database())").fetchone()[0]
        print(f"database size: {db_size / 1024 / 1024:.1f} MB (free tier limit 500 MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
