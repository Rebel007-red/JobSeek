"""Scores in Supabase (app.user_jobs / app_read) against the frozen Databricks statements (spark_reference/).

    python supabase/tests/parity.py [--catalog jobseeker] [--max-profiles 10] [--verbose]

Run it right after a publish (Supabase holds the snapshot of the current gold.jobs, no pipeline run in between) and
after migrate_user_data.py. It compares, for every profile whose updated_at is the same on both sides:
  * every job's fit_score, role_match, fit_matched_skills, is_applied (exact) and fit_role, fit_skills,
    fit_experience (|difference| < 1e-9), and which job keys exist on each side
  * each case of spark_reference/statements.json through app_read: the job lists (same keys in the same order, same
    total_count), summary, facets and trend
Time-relative cases (postedWithin, new_48h, trend) can differ by rows crossing a cutoff between the two queries.

The reference predates the feature wave. Its intended differences are applied to the reference before comparing, and
printed with counts (contract section 9):
  D1  above_experience counts the level's typical years when no minimum is stated: the expected value is recomputed
      here from experience_min_years / experience_level and the profile's max_years; jobs that flip leave "For you",
      so they are dropped from the expected "For you" lists, summaries and facets
  D2  Best fit breaks ties by freshness before role_score: expected fit lists are re-sorted by the new key (rows that
      tie with the page boundary are compared by fit only)
  D3  on the All / To apply tabs a tracked job no longer passes postedWithin: such rows are dropped from the expected
      lists and summaries
  D4  lists are collapsed by default: every list and summary is requested with collapse: false
  D5  hidden-only jobs exist only in Supabase (sync-in exports tracked rows): they are un-hidden in a rolled-back
      transaction before each profile is compared
  Profiles with also-know skills score differently by design: their scores are not compared ("intended (also-know)").
Only the new rules (tracked jobs in VISIBLE / MATCH, "-word" search) could cause other differences, and the reference
data has neither saved jobs nor "-" words, so anything left is a real mismatch. Prints mismatches (job keys and values;
no emails) and exits 1 when there are any.

Needs DATABRICKS_HOST / DATABRICKS_TOKEN (optional DATABRICKS_WAREHOUSE_ID) and SUPABASE_DB_URL (environment, the
repo-root .env or databricks/.env), and psycopg 3.
"""
import argparse
import datetime as dt
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "databricks" / "jobs"))
from migrate_user_data import env, run_statement  # noqa: E402  (loads the .env files)
from scoring_reference import EXPERIENCE_HIDE_GAP, LEVEL_YEARS, MATCH_MIN_FIT, STRONG_FIT  # noqa: E402

TOLERANCE = 1e-9
EXACT = ["fit_score", "role_match", "fit_matched_skills", "is_applied"]
CLOSE = ["fit_role", "fit_skills", "fit_experience"]
TIME_RELATIVE = ("postedWithin", "trend", "summary")
OLD_FACETS = ("role", "category", "source", "company")
OLD_SUMMARY = ("total", "new_48h", "strong_fit", "applied", "pending")


def normalized(column, value):
    if column == "fit_matched_skills":
        return list(value or [])
    if column in ("role_match", "above_experience", "is_applied"):
        return bool(value)
    return value


def close(a, b):
    if a is None or b is None:
        return a is b
    return abs(float(a) - float(b)) < TOLERANCE


def supabase_rows(conn, uid, claims, action, params):
    """app_read as the user (admin claims: the allow-list does not apply), in a rolled-back transaction"""
    from psycopg.types.json import Jsonb
    with conn.transaction(force_rollback=True):
        conn.execute("SET LOCAL ROLE authenticated")
        conn.execute("SELECT set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])
        return conn.execute("SELECT public.app_read(%s, %s)", [action, Jsonb(params)]).fetchone()[0]["rows"]


def filtered(conn, uid, params):
    """{job_key: row} of app.filtered_jobs in summary mode (visible, scope, filters; fresh flag; no tab / time rule)"""
    from psycopg.types.json import Jsonb
    rows = conn.execute("""SELECT job_key, is_applied, is_tracked, fresh, first_seen_at, fit_score
                           FROM app.filtered_jobs(%s, %s, 'summary')""", [uid, Jsonb(params)]).fetchall()
    return {r[0]: dict(zip(["job_key", "is_applied", "is_tracked", "fresh", "first_seen_at", "fit_score"], r)) for r in rows}


def substitute(value, values):
    if isinstance(value, str) and value in values:
        return values[value]
    if isinstance(value, dict):
        return {k: substitute(v, values) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, values) for v in value]
    return value


def placeholder_values(facets, jobs):
    """Real filter values for the placeholders: the most common value of each facet among the user's jobs"""
    top = {}
    for row in facets:  # ordered by kind, n DESC
        top.setdefault(row["kind"], row["value"])
    title = next((j["title"] for j in jobs if j.get("title")), "engineer")
    location = next((j["location"] for j in jobs if j.get("location")), "india")
    return {
        "__q__": " ".join(str(title).lower().split()[:2]),
        "__role__": top.get("role", "Data Engineer"),
        "__category__": top.get("category", "Data Engineering"),
        "__source__": top.get("source", "linkedin"),
        "__company__": top.get("company", "x"),
        "__location__": str(location).split(",")[0].strip().lower(),
    }


def new_above(job, max_years):
    """D1: the stated minimum years, else the level's typical years, more than EXPERIENCE_HIDE_GAP above the maximum"""
    years = job["experience_min_years"] if job["experience_min_years"] is not None else LEVEL_YEARS.get(job["experience_level"])
    return years is not None and max_years is not None and years > max_years + EXPERIENCE_HIDE_GAP


def fit_sort_key(row, jobs):
    """D2: fit, job date, first seen, role_score (all descending, NULLs last), job_key"""
    job = jobs[row["job_key"]]
    date = job["posted_date"] or (job["first_seen_at"].astimezone(dt.timezone.utc).date() if job["first_seen_at"] else None)
    return (-(int(row["fit_score"]) if row["fit_score"] is not None else -1),
            -(date.toordinal() if date else 0), -(job["first_seen_at"].timestamp() if job["first_seen_at"] else 0),
            -(job["role_score"] if job["role_score"] is not None else float("-inf")), row["job_key"].encode())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--catalog", default="jobseeker")
    parser.add_argument("--max-profiles", type=int, default=10)
    parser.add_argument("--verbose", action="store_true", help="print every mismatching job, not only the first 10 per profile")
    args = parser.parse_args(argv)
    missing = [n for n in ("DATABRICKS_HOST", "DATABRICKS_TOKEN", "SUPABASE_DB_URL") if not env(n)]
    if missing:
        print(f"[ERROR] missing environment variables: {', '.join(missing)}")
        return 2
    import psycopg

    reference = json.loads((HERE / "spark_reference" / "statements.json").read_text(encoding="utf-8"))
    user_jobs_sql = (HERE / "spark_reference" / "user_jobs.sql").read_text(encoding="utf-8")
    user_jobs_sql = "\n".join(line for line in user_jobs_sql.splitlines() if not line.startswith("--"))
    print(f"Reference: {reference['generated_from']}, {len(reference['cases'])} cases")

    dbx_profiles = {str(r["profile_id"]).lower(): r["updated_us"] for r in run_statement(
        "SELECT profile_id, unix_micros(updated_at) AS updated_us FROM ops.user_profile WHERE profile_id <> 'default'",
        catalog=args.catalog)}
    mismatches = Counter()
    intended = Counter()
    with psycopg.connect(env("SUPABASE_DB_URL"), prepare_threshold=None, connect_timeout=20) as conn:
        # writes happen only inside rolled-back transactions (D5)
        conn.execute("SET extra_float_digits = 3")  # Supabase's default is 0 (15 digits)
        conn.execute("SET TIME ZONE 'UTC'")  # as app_read runs (current_date in the postedWithin rule)
        status = conn.execute("SELECT run_id, snapshot_at FROM app.pipeline_status WHERE id = 1").fetchone()
        print(f"Supabase snapshot: run {status[0]} at {status[1]}")
        sb_profiles = {str(pid): (int(us), max_years, list(also or [])) for pid, us, max_years, also in conn.execute(
            """SELECT profile_id, (extract(epoch FROM updated_at) * 1000000)::bigint, max_years, also_skills
               FROM app.user_profile""")}
        jobs = {r[0]: dict(zip(["job_key", "experience_min_years", "experience_level", "posted_date", "first_seen_at",
                                "role_score", "role_title", "category", "source", "company_name"], r))
                for r in conn.execute("""SELECT job_key, experience_min_years, experience_level, posted_date, first_seen_at,
                                                role_score, role_title, category, source, company_name FROM app.jobs""")}
        same = sorted(pid for pid, (us, _, _) in sb_profiles.items() if dbx_profiles.get(pid) == us)
        print(f"Profiles: {len(sb_profiles)} in Supabase, {len(dbx_profiles)} in Databricks, {len(same)} identical "
              f"(compared: {min(len(same), args.max_profiles)})")
        for n, uid in enumerate(same[:args.max_profiles], 1):
            # D5: hidden-only state lives in Supabase alone (the export carries tracked rows), so within a rolled-back
            # transaction those jobs are un-hidden here to give both sides the same state
            with conn.transaction(force_rollback=True):
                dbx_hidden = [r["job_key"] for r in run_statement(
                    "SELECT job_key FROM gold.user_job_state WHERE user_id = :user_id AND is_hidden",
                    [{"name": "user_id", "value": uid, "type": "STRING"}], catalog=args.catalog)]
                unhidden = conn.execute("""UPDATE app.user_job_state SET is_hidden = false, hidden_at = NULL
                                           WHERE user_id = %s AND is_hidden AND NOT job_key = ANY(%s)""",
                                        [uid, dbx_hidden]).rowcount
                if unhidden:
                    intended["D5 hidden-only jobs un-hidden for the comparison"] += unhidden
                label = f"profile {n}"
                max_years, also = sb_profiles[uid][1], sb_profiles[uid][2]
                if also:
                    intended["also-know profiles skipped"] += 1
                    print(f"[INTENDED] {label}: {len(also)} also-know skills, scores differ by design (not compared)")
                    continue
                claims = {"sub": uid, "role": "authenticated", "app_metadata": {"role": "admin"}}
                user_param = [{"name": "user_id", "value": uid, "type": "STRING"}]

                spark = {r["job_key"]: r for r in run_statement(user_jobs_sql, user_param, catalog=args.catalog)}
                cols = ["job_key", "above_experience"] + EXACT + CLOSE
                pg = {r[0]: dict(zip(cols, r)) for r in conn.execute(f"SELECT {', '.join(cols)} FROM app.user_jobs(%s)", [uid])}
                only_spark, only_pg = set(spark) - set(pg), set(pg) - set(spark)
                if only_spark or only_pg:
                    mismatches["job keys"] += 1
                    print(f"[DIFF] {label}: {len(only_spark)} jobs only in Databricks, {len(only_pg)} only in Supabase "
                          f"(e.g. {sorted(only_spark)[:2]} / {sorted(only_pg)[:2]})")
                shown = 0
                flipped = set()  # D1: jobs whose above_experience changes with the new rule
                left_for_you = set()  # D1: ... and that were "For you" before
                for key in sorted(set(spark) & set(pg)):
                    s, p = spark[key], pg[key]
                    expected_above = new_above(jobs[key], max_years)
                    if bool(s["above_experience"]) != expected_above:
                        flipped.add(key)
                        if (not s["is_applied"] and s["role_match"] and (s["fit_score"] or 0) >= MATCH_MIN_FIT
                                and not s["above_experience"]):
                            left_for_you.add(key)
                    bad = [c for c in EXACT if normalized(c, s[c]) != normalized(c, p[c])]
                    bad += [c for c in CLOSE if not close(s[c], p[c])]
                    if bool(p["above_experience"]) != expected_above:
                        bad.append("above_experience")
                    if bad:
                        mismatches["job scores"] += 1
                        if args.verbose or shown < 10:
                            shown += 1
                            print(f"[DIFF] {label} job {key}: " + ", ".join(
                                f"{c} spark={s.get(c)!r} supabase={p[c]!r}" for c in bad))
                print(f"[{'OK' if not shown and not (only_spark or only_pg) else 'DIFF'}] {label}: {len(set(spark) & set(pg))} jobs scored")
                if flipped:
                    intended["D1 above_experience flips"] += len(flipped)
                    intended["D1 jobs leaving For you"] += len(left_for_you)
                    print(f"[INTENDED] {label} D1: above_experience flips for {len(flipped)} jobs ({len(left_for_you)} leave "
                          f"For you), e.g. {sorted(flipped)[:3]}")

                facets = supabase_rows(conn, uid, claims, "facets", {"scope": "all"})
                values = placeholder_values(facets, supabase_rows(conn, uid, claims, "jobs", {"scope": "all", "limit": 5}))
                for case in reference["cases"]:
                    params = substitute(case["params"], values)
                    parameters = [p if p["name"] != "user_id" else {**p, "value": uid} for p in substitute(case["parameters"], values)]
                    expected = run_statement(case["statement"], parameters, catalog=args.catalog)
                    request = {**params, "collapse": False} if case["action"] in ("jobs", "summary") else params  # D4
                    actual = supabase_rows(conn, uid, claims, case["action"], request)
                    expected, notes = intended_reference(conn, uid, case["action"], params, expected, jobs, left_for_you)
                    for note, count in notes.items():
                        intended[note] += count
                    problem = compare(case["action"], params, expected, actual, jobs)
                    if problem:
                        soft = any(t in json.dumps(case["params"]) or case["action"] == t for t in TIME_RELATIVE)
                        mismatches["time-relative cases" if soft else "cases"] += 1
                        print(f"[{'WARN' if soft else 'DIFF'}] {label} {case['name']}: {problem}")
    if intended:
        print("Intended differences: " + ", ".join(f"{k} {v}" for k, v in sorted(intended.items())))
    if mismatches:
        print("Mismatches: " + ", ".join(f"{k} {v}" for k, v in sorted(mismatches.items())))
    hard = sum(v for k, v in mismatches.items() if k != "time-relative cases")
    print("[OK] parity" if not hard else "[FAIL] parity")
    return 1 if hard else 0


def intended_reference(conn, uid, action, params, expected, jobs, left_for_you):
    """The reference with the intended differences D1 and D3 applied: {"rows" ...} for jobs, the summary row, facets"""
    notes = Counter()
    tab = params.get("tab") if isinstance(params.get("tab"), str) else None
    scope_all = params.get("scope") == "all"
    drop = set() if scope_all else set(left_for_you)  # D1
    stale = set()
    if action in ("jobs", "summary") and "postedWithin" in params and tab not in ("applied", "saved"):
        stale = {k for k, r in filtered(conn, uid, params).items() if r["is_tracked"] and not r["fresh"]}  # D3
    drop |= stale
    if action == "trend" or not drop:
        return expected, notes
    # which of the dropped jobs the old query counted: visible, passing the case's filters (and the tab)
    old_set = filtered(conn, uid, {**params, "scope": "all"})
    if action == "jobs" and tab == "applied":
        old_set = {k: r for k, r in old_set.items() if r["is_applied"]}
    elif action == "jobs" and tab == "pending":
        old_set = {k: r for k, r in old_set.items() if not r["is_applied"]}
    counted = {k: old_set[k] for k in drop if k in old_set}
    if not counted:
        return expected, notes
    notes["D1 rows dropped from the reference" if not stale else "D1/D3 rows dropped from the reference"] += len(counted)
    if action == "jobs":
        rows = [dict(r) for r in expected if r["job_key"] not in drop]
        total = (int(expected[0]["total_count"]) - len(counted)) if expected else 0
        for r in rows:
            r["total_count"] = total
        return {"rows": rows, "total": total, "truncated": len(expected) < int(expected[0]["total_count"]) if expected else False}, notes
    if action == "summary":
        row = {k: int(v) for k, v in expected[0].items()}
        now = dt.datetime.now(dt.timezone.utc)
        for r in counted.values():
            row["total"] -= 1
            if not r["is_applied"]:
                row["pending"] -= 1
            if r["first_seen_at"] and r["first_seen_at"] >= now - dt.timedelta(hours=48):
                row["new_48h"] -= 1
            if (r["fit_score"] or 0) >= STRONG_FIT:
                row["strong_fit"] -= 1
        return [row], notes
    if action == "facets":
        counts = {(r["kind"], r["value"]): int(r["n"]) for r in expected}
        for key in counted:
            job = jobs[key]
            for kind, column in (("role", "role_title"), ("category", "category"), ("source", "source"), ("company", "company_name")):
                if job[column] is not None and (kind, job[column]) in counts:
                    counts[(kind, job[column])] -= 1
        rows = [{"kind": k, "value": v, "n": c} for (k, v), c in counts.items() if c > 0]
        rows.sort(key=lambda r: (r["kind"].encode(), -r["n"], r["value"].encode()))
        return rows, notes
    return expected, notes


def compare(action, params, expected, actual, jobs):
    if action == "jobs":
        adjusted = isinstance(expected, dict)
        rows = expected["rows"] if adjusted else expected
        total = expected["total"] if adjusted else (int(rows[0]["total_count"]) if rows else 0)
        truncated = expected["truncated"] if adjusted else (bool(rows) and len(rows) < int(rows[0]["total_count"]))
        offset = int(params.get("offset") or 0)
        if params.get("sort", "fit") == "fit" and rows:  # D2
            rows = sorted(rows, key=lambda r: fit_sort_key(r, jobs))
            # rows that tie with a page boundary may be other rows of the same fit: compare those by fit only
            low = rows[-1]["fit_score"] if truncated else None
            high = rows[0]["fit_score"] if offset else None
            inner = [r for r in rows if r["fit_score"] != low and r["fit_score"] != high]
            got = [r for r in actual[:len(rows)] if r["fit_score"] != low and r["fit_score"] != high]
            if [r["job_key"] for r in inner] != [r["job_key"] for r in got]:
                return f"fit order differs ({len(inner)} vs {len(got)} rows away from the page boundaries)"
            if sorted(r["fit_score"] for r in rows) != sorted(r["fit_score"] for r in actual[:len(rows)]):
                return "fit scores of the page differ"
        else:
            ek, ak = [r["job_key"] for r in rows], [r["job_key"] for r in actual[:len(rows)]]
            if ek != ak:
                first = next((i for i, (a, b) in enumerate(zip(ek, ak)) if a != b), min(len(ek), len(ak)))
                return f"job order differs at position {first} ({len(ek)} vs {len(ak)} rows)"
        if not truncated and len(actual) != len(rows):
            return f"{len(rows)} vs {len(actual)} rows"
        if (actual[0]["total_count"] if actual else 0) != total and (rows or actual):
            return f"total_count {total} vs {actual[0]['total_count'] if actual else 0}"
        by_key = {r["job_key"]: r for r in actual}
        for e in rows:
            a = by_key.get(e["job_key"])
            if a is not None and (e["fit_score"] != a["fit_score"] or bool(e["role_match"]) != bool(a["role_match"])):
                return f"job {e['job_key']} fit {e['fit_score']} vs {a['fit_score']}"
        return ""
    if action == "summary":
        e = {k: int(v) for k, v in expected[0].items() if k in OLD_SUMMARY}
        a = {k: int(v) for k, v in actual[0].items() if k in OLD_SUMMARY}
        return "" if e == a else f"{e} vs {a}"
    if action == "facets":
        e = [(r["kind"], r["value"], int(r["n"])) for r in expected if r["kind"] in OLD_FACETS]
        a = [(r["kind"], r["value"], int(r["n"])) for r in actual if r["kind"] in OLD_FACETS]
        if e == a:
            return ""
        return f"{len(e)} vs {len(a)} rows; first difference {next((x for x in zip(e, a) if x[0] != x[1]), None)}"
    if action == "trend":
        e = [(str(r["day"])[:10], int(r["added"]), int(r["applied"])) for r in expected]
        a = [(str(r["day"])[:10], int(r["added"]), int(r["applied"])) for r in actual]
        return "" if e == a else f"{e} vs {a}"
    return ""


if __name__ == "__main__":
    sys.exit(main())
