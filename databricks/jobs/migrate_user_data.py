"""One-time (re-runnable) copy of the app user data from Databricks to Supabase.

    python databricks/jobs/migrate_user_data.py --dry-run     read both sides, print what would change, roll back
    python databricks/jobs/migrate_user_data.py               write it (one transaction)

Reads ops.user_profile, gold.user_job_state, ops.custom_roles and ops.custom_skills through the Databricks SQL Statement
API (DATABRICKS_HOST, DATABRICKS_TOKEN, optional DATABRICKS_WAREHOUSE_ID) and writes app.user_profile,
app.user_job_state, app.custom_roles, app.custom_skills (and seeds app.allowed_emails) with psycopg over SUPABASE_DB_URL.
Everything comes from the environment, the repo-root .env or databricks/.env; nothing secret is printed, and only
counts are printed (no emails, ids or keys).

Rules (newest wins, so it is safe to run again right before / after the switch-over):
  * profiles: only uuid ids of existing auth.users; written when Supabase has none or an older updated_at
  * job state: only for existing users and job keys present in app.jobs; the Databricks row's time is the latest of
    applied_at / hidden_at / status_updated_at (none: 1970), written as updated_at when newer than Supabase's
  * custom roles: inserted when missing; updated when the Databricks checked_at is newer; custom skills: inserted
    when missing; nothing is ever deleted
  * allow-list (unless --no-seed-allowlist), first migration only (Supabase has no profiles yet): the login emails of
    the migrated profiles are added to app.allowed_emails. Once that table has rows, only listed emails (and admins)
    can use the job data; add others with the setAllowedEmail action or leave the table empty (--no-seed-allowlist) to
    allow every signed-in user. Re-runs never seed again, so an email an admin removed is not added back.
Refuses to run while app.jobs is empty (publish the jobs first: databricks/jobs/publish_to_supabase.py).

Needs psycopg 3 (pip install "psycopg[binary]"), local only.
"""
import argparse
import datetime as dt
import json
import re
import sys
import time
from collections import Counter
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from databricks_api import api, env  # noqa: E402  (also loads the .env files)

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
JOB_KEY_RE = re.compile(r"^[0-9a-f]{64}$")
CUSTOM_ROLE_STATUSES = {"pending", "active", "mapped", "rejected"}
EPOCH = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
REQUIRED_ENV = ["DATABRICKS_HOST", "DATABRICKS_TOKEN", "SUPABASE_DB_URL"]

# --- Databricks SQL Statement API --------------------------------------------------------------------------------

_warehouse = None


def warehouse_id():
    global _warehouse
    if _warehouse is None:
        _warehouse = env("DATABRICKS_WAREHOUSE_ID")
        if not _warehouse:
            warehouses = api("GET", "/api/2.0/sql/warehouses").get("warehouses", [])
            if not warehouses:
                raise RuntimeError("No SQL warehouse found; set DATABRICKS_WAREHOUSE_ID")
            _warehouse = warehouses[0]["id"]
    return _warehouse


def _convert(value, type_name):
    if value is None:
        return None
    if type_name in ("INT", "LONG", "SHORT", "BYTE", "BIGINT", "SMALLINT", "TINYINT"):
        return int(value)
    if type_name in ("DOUBLE", "FLOAT"):
        return float(value)
    if type_name == "DECIMAL":
        return Decimal(value)
    if type_name == "BOOLEAN":
        return value is True or value == "true"
    if type_name in ("ARRAY", "MAP", "STRUCT"):
        return json.loads(value)
    return value


def run_statement(statement, parameters=None, catalog="jobseeker", timeout_seconds=900):
    """Runs one statement on the SQL warehouse and returns its rows as dicts (waits for a cold warehouse)."""
    data = api("POST", "/api/2.0/sql/statements/", json={
        "warehouse_id": warehouse_id(), "catalog": catalog, "statement": statement, "parameters": parameters or [],
        "wait_timeout": "30s", "on_wait_timeout": "CONTINUE", "disposition": "INLINE", "format": "JSON_ARRAY",
    })
    deadline = time.monotonic() + timeout_seconds
    while data.get("status", {}).get("state") in ("PENDING", "RUNNING"):
        if time.monotonic() > deadline:
            api("POST", f"/api/2.0/sql/statements/{data['statement_id']}/cancel")
            raise TimeoutError(f"Statement still running after {timeout_seconds} s")
        time.sleep(2)
        data = api("GET", f"/api/2.0/sql/statements/{data['statement_id']}")
    state = data.get("status", {}).get("state")
    if state != "SUCCEEDED":
        message = str(data.get("status", {}).get("error", {}).get("message") or "")[:400]
        raise RuntimeError(f"Statement {state}: {message}")
    columns = data.get("manifest", {}).get("schema", {}).get("columns", [])
    raw = list(data.get("result", {}).get("data_array") or [])
    link = data.get("result", {}).get("next_chunk_internal_link")
    while link:
        chunk = api("GET", link)
        raw.extend(chunk.get("data_array") or [])
        link = chunk.get("next_chunk_internal_link")
    return [{c["name"]: _convert(row[i], c.get("type_name")) for i, c in enumerate(columns)} for row in raw]


# --- reading -----------------------------------------------------------------------------------------------------


def micros_to_ts(value):
    return None if value is None else EPOCH + dt.timedelta(microseconds=int(value))


def read_databricks(catalog):
    profiles = run_statement("""
        SELECT profile_id, email, target_roles, skills, min_years, max_years, preferred_cities,
               unix_micros(updated_at) AS updated_us
        FROM ops.user_profile
        WHERE profile_id IS NOT NULL AND profile_id <> 'default'""", catalog=catalog)
    states = run_statement("""
        SELECT user_id, job_key, is_applied, unix_micros(applied_at) AS applied_us, is_hidden,
               unix_micros(hidden_at) AS hidden_us, application_status, unix_micros(status_updated_at) AS status_us
        FROM gold.user_job_state""", catalog=catalog)
    roles = run_statement("""
        SELECT role_title, status, category, description, duplicate_of, first_user, checked_by,
               unix_micros(created_at) AS created_us, unix_micros(checked_at) AS checked_us, attempts
        FROM ops.custom_roles""", catalog=catalog)
    skills = run_statement("""
        SELECT skill, first_user, unix_micros(created_at) AS created_us FROM ops.custom_skills""", catalog=catalog)
    return profiles, states, roles, skills


def text_list(value):
    return [str(v) for v in (value or []) if v is not None]


# --- planning (pure; unit-testable) ------------------------------------------------------------------------------


def plan_profiles(rows, auth_users, existing, skipped):
    """rows: Databricks profiles. auth_users: {uuid: email}. existing: {uuid: updated_at}. Returns rows to upsert."""
    newest = {}
    for row in rows:
        pid = str(row.get("profile_id") or "").strip().lower()
        if not UUID_RE.match(pid):
            skipped["profiles: id is not a uuid"] += 1
            continue
        if pid not in auth_users:
            skipped["profiles: no such Supabase user"] += 1
            continue
        updated = micros_to_ts(row.get("updated_us")) or EPOCH
        if pid in newest:
            skipped["profiles: duplicate row"] += 1
            if newest[pid]["updated_at"] >= updated:
                continue
        newest[pid] = {
            "profile_id": pid,
            "email": (row.get("email") or auth_users[pid] or None),
            "target_roles": text_list(row.get("target_roles")),
            "skills": text_list(row.get("skills")),
            "min_years": row.get("min_years"),
            "max_years": row.get("max_years"),
            "preferred_cities": text_list(row.get("preferred_cities")),
            "updated_at": updated,
        }
    upserts = []
    for pid, profile in newest.items():
        current = existing.get(pid)
        if current is not None and current >= profile["updated_at"]:
            skipped["profiles: Supabase is newer or equal"] += 1
            continue
        profile["action"] = "insert" if current is None else "update"
        upserts.append(profile)
    return list(newest), upserts


def plan_states(rows, auth_users, job_keys, existing, skipped):
    """existing: {(uuid, job_key): updated_at}. Returns rows to upsert."""
    newest = {}
    for row in rows:
        uid = str(row.get("user_id") or "").strip().lower()
        key = str(row.get("job_key") or "")
        if not UUID_RE.match(uid):
            skipped["job state: user id is not a uuid"] += 1
            continue
        if uid not in auth_users:
            skipped["job state: no such Supabase user"] += 1
            continue
        if not JOB_KEY_RE.match(key):
            skipped["job state: invalid job key"] += 1
            continue
        if key not in job_keys:
            # Applied / status rows are history the user would lose: counted apart so the owner can check it is 0
            tracked = bool(row.get("is_applied")) or (row.get("application_status") or "not_applied") != "not_applied"
            skipped["job state: APPLIED job not in app.jobs (history not migrated)" if tracked
                    else "job state: job not in app.jobs"] += 1
            continue
        applied_at, hidden_at, status_at = (micros_to_ts(row.get(k)) for k in ("applied_us", "hidden_us", "status_us"))
        stamp = max([t for t in (applied_at, hidden_at, status_at) if t is not None], default=EPOCH)
        is_applied = bool(row.get("is_applied"))
        status = row.get("application_status") or ("applied" if is_applied else "not_applied")
        state = {"user_id": uid, "job_key": key, "is_applied": is_applied, "applied_at": applied_at,
                 "is_hidden": bool(row.get("is_hidden")), "hidden_at": hidden_at, "application_status": status,
                 "status_updated_at": status_at, "updated_at": stamp}
        if (uid, key) in newest:
            skipped["job state: duplicate row"] += 1
            if newest[(uid, key)]["updated_at"] >= stamp:
                continue
        newest[(uid, key)] = state
    upserts = []
    for pair, state in newest.items():
        current = existing.get(pair)
        if current is not None and current >= state["updated_at"]:
            skipped["job state: Supabase is newer or equal"] += 1
            continue
        state["action"] = "insert" if current is None else "update"
        upserts.append(state)
    return upserts


def plan_custom_roles(rows, existing, skipped):
    """existing: {lower(role_title): checked_at}. Returns rows to insert / update."""
    seen = {}
    for row in rows:
        title = str(row.get("role_title") or "").strip()
        if not title:
            skipped["custom roles: empty title"] += 1
            continue
        status = row.get("status")
        # No status either: the export to Databricks (and 02_ingest_silver) only carries the four known ones
        if status not in CUSTOM_ROLE_STATUSES:
            skipped["custom roles: unknown status"] += 1
            continue
        role = {"role_title": title, "status": status, "category": row.get("category"),
                "description": row.get("description"), "duplicate_of": row.get("duplicate_of"),
                "first_user": row.get("first_user"), "checked_by": row.get("checked_by"),
                "created_at": micros_to_ts(row.get("created_us")), "checked_at": micros_to_ts(row.get("checked_us")),
                "attempts": row.get("attempts")}
        key = title.lower()
        previous = seen.get(key)
        if previous is not None:
            skipped["custom roles: duplicate row"] += 1
            if (previous["checked_at"] or EPOCH) >= (role["checked_at"] or EPOCH):
                continue
        seen[key] = role
    changes = []
    for key, role in seen.items():
        if key not in existing:
            role["action"] = "insert"
        elif role["checked_at"] is not None and (existing[key] is None or role["checked_at"] > existing[key]):
            role["action"] = "update"
        else:
            skipped["custom roles: Supabase is newer or equal"] += 1
            continue
        changes.append(role)
    return changes


def plan_custom_skills(rows, existing, skipped):
    """existing: set of lower(skill). Returns rows to insert."""
    inserts = {}
    for row in rows:
        skill = str(row.get("skill") or "").strip()
        if not skill:
            skipped["custom skills: empty"] += 1
            continue
        if skill.lower() in existing or skill.lower() in inserts:
            skipped["custom skills: already there"] += 1
            continue
        inserts[skill.lower()] = {"skill": skill, "first_user": row.get("first_user"),
                                  "created_at": micros_to_ts(row.get("created_us"))}
    return list(inserts.values())


# --- writing -----------------------------------------------------------------------------------------------------


PAST = {"insert": "inserted", "update": "updated"}


def write_all(conn, profiles, states, roles, skills, allow_emails):
    counts = Counter()
    with conn.cursor() as cur:
        for p in profiles:
            cur.execute("""
                INSERT INTO app.user_profile AS t (profile_id, email, target_roles, skills, min_years, max_years,
                                                   preferred_cities, updated_at)
                VALUES (%(profile_id)s, %(email)s, %(target_roles)s, %(skills)s, %(min_years)s, %(max_years)s,
                        %(preferred_cities)s, %(updated_at)s)
                ON CONFLICT (profile_id) DO UPDATE SET
                  email = EXCLUDED.email, target_roles = EXCLUDED.target_roles, skills = EXCLUDED.skills,
                  min_years = EXCLUDED.min_years, max_years = EXCLUDED.max_years,
                  preferred_cities = EXCLUDED.preferred_cities, updated_at = EXCLUDED.updated_at
                WHERE EXCLUDED.updated_at > t.updated_at""", p)
            counts[f"profiles {PAST[p['action']]}"] += cur.rowcount
        for s in states:
            cur.execute("""
                INSERT INTO app.user_job_state AS t (user_id, job_key, is_applied, applied_at, is_hidden, hidden_at,
                                                     application_status, status_updated_at, updated_at)
                VALUES (%(user_id)s, %(job_key)s, %(is_applied)s, %(applied_at)s, %(is_hidden)s, %(hidden_at)s,
                        %(application_status)s, %(status_updated_at)s, %(updated_at)s)
                ON CONFLICT (user_id, job_key) DO UPDATE SET
                  is_applied = EXCLUDED.is_applied, applied_at = EXCLUDED.applied_at, is_hidden = EXCLUDED.is_hidden,
                  hidden_at = EXCLUDED.hidden_at, application_status = EXCLUDED.application_status,
                  status_updated_at = EXCLUDED.status_updated_at, updated_at = EXCLUDED.updated_at
                WHERE EXCLUDED.updated_at > t.updated_at""", s)
            counts[f"job state {PAST[s['action']]}"] += cur.rowcount
        for r in roles:
            if r["action"] == "insert":
                cur.execute("""
                    INSERT INTO app.custom_roles (role_title, status, category, description, duplicate_of, first_user,
                                                  checked_by, created_at, checked_at, attempts)
                    VALUES (%(role_title)s, %(status)s, %(category)s, %(description)s, %(duplicate_of)s,
                            %(first_user)s, %(checked_by)s, %(created_at)s, %(checked_at)s, %(attempts)s)
                    ON CONFLICT ((lower(role_title))) DO NOTHING""", r)
            else:
                cur.execute("""
                    UPDATE app.custom_roles SET status = %(status)s, category = %(category)s,
                      description = %(description)s, duplicate_of = %(duplicate_of)s, checked_by = %(checked_by)s,
                      checked_at = %(checked_at)s, attempts = greatest(attempts, %(attempts)s),
                      first_user = coalesce(first_user, %(first_user)s), created_at = coalesce(created_at, %(created_at)s)
                    WHERE lower(role_title) = lower(%(role_title)s)
                      AND (checked_at IS NULL OR checked_at < %(checked_at)s)""", r)
            counts[f"custom roles {PAST[r['action']]}"] += cur.rowcount
        for k in skills:
            cur.execute("""INSERT INTO app.custom_skills (skill, first_user, created_at)
                           VALUES (%(skill)s, %(first_user)s, %(created_at)s)
                           ON CONFLICT ((lower(skill))) DO NOTHING""", k)
            counts["custom skills inserted"] += cur.rowcount
        for email in allow_emails:
            cur.execute("INSERT INTO app.allowed_emails (email) VALUES (%s) ON CONFLICT (email) DO NOTHING", [email])
            counts["allow-list emails added"] += cur.rowcount
    return counts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--catalog", default="jobseeker")
    parser.add_argument("--dry-run", action="store_true", help="read and plan, write nothing (the transaction is rolled back)")
    parser.add_argument("--no-seed-allowlist", action="store_true", help="do not add the migrated users to app.allowed_emails")
    args = parser.parse_args(argv)

    missing = [name for name in REQUIRED_ENV if not env(name)]
    if missing:
        print(f"[ERROR] missing environment variables: {', '.join(missing)}")
        return 2
    try:
        import psycopg
    except ImportError:
        print("[ERROR] psycopg 3 is not installed: pip install \"psycopg[binary]\"")
        return 2

    print(f"Reading Databricks ({args.catalog}) ...")
    profiles, states, roles, skills = read_databricks(args.catalog)
    print(f"  read: {len(profiles)} profiles, {len(states)} job state rows, {len(roles)} custom roles, {len(skills)} custom skills")

    skipped = Counter()
    with psycopg.connect(env("SUPABASE_DB_URL"), prepare_threshold=None, connect_timeout=20) as conn:
        conn.execute("SET statement_timeout = '120s'")
        jobs = conn.execute("SELECT count(*) FROM app.jobs").fetchone()[0]
        if jobs == 0:
            print("[ERROR] app.jobs is empty: publish the jobs first (databricks/jobs/publish_to_supabase.py), "
                  "otherwise no job state can be matched")
            return 1
        auth_users = {str(uid): (email or "").strip().lower() for uid, email in conn.execute("SELECT id, email FROM auth.users")}
        job_keys = {key for (key,) in conn.execute("SELECT job_key FROM app.jobs")}
        existing_profiles = {str(pid): ts for pid, ts in conn.execute("SELECT profile_id, updated_at FROM app.user_profile")}
        existing_states = {(str(uid), key): ts for uid, key, ts in conn.execute("SELECT user_id, job_key, updated_at FROM app.user_job_state")}
        existing_roles = {title.lower(): checked for title, checked in conn.execute("SELECT role_title, checked_at FROM app.custom_roles")}
        existing_skills = {skill.lower() for (skill,) in conn.execute("SELECT skill FROM app.custom_skills")}
        print(f"  Supabase: {len(auth_users)} users, {jobs} jobs, {len(existing_profiles)} profiles, "
              f"{len(existing_states)} job state rows, {len(existing_roles)} custom roles, {len(existing_skills)} custom skills")

        eligible, profile_rows = plan_profiles(profiles, auth_users, existing_profiles, skipped)
        state_rows = plan_states(states, auth_users, job_keys, existing_states, skipped)
        role_rows = plan_custom_roles(roles, existing_roles, skipped)
        skill_rows = plan_custom_skills(skills, existing_skills, skipped)
        # Seed only on the first migration: on a re-run the list may hold an admin's removals, which must stick
        seed = not args.no_seed_allowlist and not existing_profiles
        allow = sorted({auth_users[pid] for pid in eligible if auth_users.get(pid)}) if seed else []

        with conn.transaction(force_rollback=args.dry_run):
            counts = write_all(conn, profile_rows, state_rows, role_rows, skill_rows, allow)
            allowed_total = conn.execute("SELECT count(*) FROM app.allowed_emails").fetchone()[0]

    verb = "would be written (dry run, rolled back)" if args.dry_run else "written"
    print(f"Changes {verb}:")
    for name in sorted(set(counts) | {"profiles inserted", "profiles updated", "job state inserted", "job state updated",
                                      "custom roles inserted", "custom roles updated", "custom skills inserted"}):
        print(f"  {name}: {counts.get(name, 0)}")
    if seed:
        print(f"  allow-list emails added: {counts.get('allow-list emails added', 0)} "
              f"(app.allowed_emails now has {allowed_total}; only listed emails and admins can use the job data)")
    elif not args.no_seed_allowlist:
        print(f"  allow-list not seeded (Supabase already had profiles: not the first migration); "
              f"app.allowed_emails has {allowed_total}")
    if skipped:
        print("Skipped:")
        for reason, n in sorted(skipped.items()):
            print(f"  {reason}: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
