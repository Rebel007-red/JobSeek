"""Python reference of the per-user fit score (app.user_jobs / the former Spark USER_JOBS_CTE).

Spark types are reproduced: Python float = DOUBLE (IEEE 754, same operation order), Decimal = DECIMAL literals, and
round() = HALF_UP on the decimal form of the double (Decimal(repr(x))). The tests compare app.user_jobs against this.
"""
from decimal import ROUND_HALF_UP, Decimal

FIT_WEIGHT_ROLE = 0.4
FIT_WEIGHT_SKILLS = 0.45
FIT_WEIGHT_EXPERIENCE = Decimal("0.15")
MATCH_MIN_FIT = 60
STRONG_FIT = 70
ROLE_SIM_FLOOR = 0.75
ROLE_SIM_MATCH = 0.86
ROLE_SIM_SPAN = 0.11
ROLE_SIM_SCORE = Decimal("0.85")
NEUTRAL_SKILLS = 0.3
UNSEEN_SKILL_IDF = 3.0
EXPERIENCE_HIDE_GAP = 2
ALSO_SKILL_WEIGHT = 0.5
APPLIED_STATUSES = ("applied", "interviewing", "offer", "rejected", "withdrawn")

LEVEL_YEARS = {
    "Intern": 0, "Entry": 0, "Junior": 1, "Mid": 3, "Mid-Senior": 3,
    "Senior": 5, "Lead/Manager": 7, "Principal/Staff": 8, "Director+": 10,
}


def half_up(x):
    return int(Decimal(repr(x)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def fit_score_of(fit_role, fit_skills, fit_experience):
    """The double before rounding and the rounded score"""
    raw = 100.0 * ((FIT_WEIGHT_ROLE * fit_role + FIT_WEIGHT_SKILLS * fit_skills) + float(FIT_WEIGHT_EXPERIENCE * fit_experience))
    return raw, half_up(raw)


def _greatest(*values):
    present = [v for v in values if v is not None]
    return max(present) if present else None


def _least(*values):
    present = [v for v in values if v is not None]
    return min(present) if present else None


def user_jobs(jobs, profile, *, custom_roles=(), skill_stats=(), role_similarity=(), ref_roles=(), state=None):
    """Scores every job for one user.

    jobs: dicts with the app.jobs columns. profile: dict (target_roles, skills, also_skills, min_years, max_years) or None.
    custom_roles: dicts (role_title, status, category, duplicate_of). skill_stats: (skill, idf) pairs.
    role_similarity: (role_a, role_b, sim). ref_roles: (role_title, category). state: {job_key: dict} for this user.
    Returns {job_key: dict} with the score columns.
    """
    state = state or {}
    role_map = {c["role_title"].lower(): c["duplicate_of"] for c in custom_roles
                if c.get("status") == "mapped" and c.get("duplicate_of") is not None}
    skill_idf = {}
    for skill, idf in skill_stats:
        if skill is None:
            continue
        key = skill.lower()
        skill_idf[key] = idf if key not in skill_idf else max(skill_idf[key], idf)

    if profile is not None:
        roles = [role_map.get(r.lower(), r) for r in profile.get("target_roles") or []]
        core = profile.get("skills") or []
        core_lower = {s.lower() for s in core}
        # (skill, idf, tier weight, is core): core skills first, then the also-know skills that are not core skills
        weights = [(s, skill_idf.get(s.lower(), UNSEEN_SKILL_IDF), 1.0, True) for s in core]
        weights += [(s, skill_idf.get(s.lower(), UNSEEN_SKILL_IDF), ALSO_SKILL_WEIGHT, False)
                    for s in profile.get("also_skills") or [] if s.lower() not in core_lower]
        min_years, max_years = profile.get("min_years"), profile.get("max_years")
    else:
        roles, weights, min_years, max_years = [], [], None, None
    n = sum(1 for w in weights if w[3])
    idf_sum = 0.0
    for _, idf, _, is_core in weights:
        if is_core:
            idf_sum = idf_sum + idf
    skill_idf_total = (idf_sum * float(max(3, n))) / float(max(1, n))

    related = {}
    if profile is not None:
        for role_a, role_b, sim in role_similarity:
            if role_b is None or role_a not in roles:
                continue
            factor = float((Decimal("1.0") if roles.index(role_a) == 0 else Decimal("0.95")) * ROLE_SIM_SCORE)
            ramp = None if sim is None else (sim - ROLE_SIM_FLOOR) / ROLE_SIM_SPAN
            score = factor * _least(1.0, _greatest(0.0, ramp))
            best = related.get(role_b)
            related[role_b] = (score if best is None else max(best[0], score),
                               sim if best is None else _greatest(best[1], sim))
    related_ready = len(related) > 0

    categories = set()
    for role_title, category in list(ref_roles) + [(c["role_title"], c.get("category")) for c in custom_roles
                                                    if c.get("status") == "active"]:
        if category is not None and role_title in roles:
            categories.add(category)

    out = {}
    for j in jobs:
        st = state.get(j["job_key"], {})
        role_title = j.get("role_title")
        role_rank = 0 if role_title is None or role_title not in roles else roles.index(role_title) + 1
        title = j.get("title")
        title_has_role = title is not None and any(r.lower() in title.lower() for r in roles)
        rel = related.get(role_title) if role_title is not None else None
        alternative_is_role = j.get("role_alternative") is not None and j.get("role_alternative") in roles
        category_is_role = j.get("category") is not None and j.get("category") in categories
        skill_keys = {s.lower() for s in (j.get("skills") or []) + (j.get("skill_groups") or []) if s is not None}
        matched = [w for w in weights if w[0].lower() in skill_keys]
        matched_sum = 0.0
        for _, idf, tier, _ in matched:
            matched_sum = matched_sum + idf * tier
        no_job_skills = len(j.get("skills") or []) + len(j.get("skill_groups") or []) == 0
        level = LEVEL_YEARS.get(j.get("experience_level"))
        emin, emax = j.get("experience_min_years"), j.get("experience_max_years")
        exp_min = emin if emin is not None else level
        exp_top = emax if emax is not None else (emin + 3 if emin is not None else (level + 3 if level is not None else None))
        # the stated minimum, else the level's typical years (the calibration gate's rule)
        above = exp_min is not None and max_years is not None and exp_min > max_years + EXPERIENCE_HIDE_GAP

        if role_rank == 1:
            fit_role = 1.0
        elif role_rank > 1:
            fit_role = 0.95
        elif title_has_role:
            fit_role = 0.9
        elif related_ready:
            fit_role = rel[0] if rel is not None and rel[0] is not None else 0.0
        elif alternative_is_role:
            fit_role = 0.5
        elif category_is_role:
            fit_role = 0.3
        else:
            fit_role = 0.0
        if related_ready:
            related_match = rel is not None and rel[1] is not None and rel[1] >= ROLE_SIM_MATCH
        else:
            related_match = alternative_is_role or category_is_role
        role_match = role_rank > 0 or title_has_role or related_match

        if n == 0:
            fit_skills = 0.0
        elif no_job_skills:
            fit_skills = NEUTRAL_SKILLS
        else:
            fit_skills = min(1.0, matched_sum / skill_idf_total)

        if exp_min is None:
            fit_experience = Decimal("0.7")
        elif max_years is not None and exp_min > max_years:
            fit_experience = max(Decimal("0.0"), Decimal("1.0") - Decimal("0.3") * (exp_min - max_years))
        elif min_years is not None and exp_top < min_years:
            fit_experience = max(Decimal("0.5"), Decimal("1.0") - Decimal("0.15") * (min_years - exp_top))
        else:
            fit_experience = Decimal("1.0")

        raw, fit_score = fit_score_of(fit_role, fit_skills, fit_experience)
        is_applied = bool(st.get("is_applied"))
        status = st.get("application_status") or "not_applied"
        is_tracked = is_applied or status != "not_applied"
        if role_rank == 1:
            reason = "first_role"
        elif role_rank > 1:
            reason = "second_role"
        elif title_has_role:
            reason = "title"
        elif related_ready:
            reason = "related" if rel is not None and rel[0] is not None and rel[0] > 0 else "none"
        elif alternative_is_role:
            reason = "alternative"
        elif category_is_role:
            reason = "category"
        else:
            reason = "none"
        out[j["job_key"]] = {
            "fit_role": fit_role,
            "fit_skills": fit_skills,
            "fit_experience": fit_experience,
            "fit_score": fit_score,
            "raw_score": raw,
            "role_match": role_match,
            "above_experience": above,
            "fit_matched_skills": [w[0] for w in matched],
            "fit_core_matched": sum(1 for w in matched if w[3]),
            "fit_role_reason": reason,
            "fit_role_sim": rel[1] if rel is not None else None,
            "fit_exp_years": exp_min,
            "job_skills_known": not no_job_skills,
            "is_applied": is_applied,
            "is_tracked": is_tracked,
            "application_status": status,
            "is_hidden": bool(st.get("is_hidden")),
            "is_match": is_tracked or (role_match and fit_score >= MATCH_MIN_FIT and not above),
            "branch": ("rank1" if role_rank == 1 else "rank2" if role_rank > 1 else "title" if title_has_role
                       else "related" if related_ready else "alternative" if alternative_is_role
                       else "category" if category_is_role else "none"),
        }
    return out
