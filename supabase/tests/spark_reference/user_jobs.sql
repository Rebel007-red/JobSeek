-- Frozen from netlify/functions/api/sql.mjs at 7cb4909: USER_JOBS_CTE + the score columns of every gold.jobs row for :user_id
WITH role_map AS (
  SELECT map_from_entries(collect_list(struct(lower(role_title), duplicate_of))) AS m
  FROM ops.custom_roles
  WHERE status = 'mapped' AND duplicate_of IS NOT NULL
),
skill_idf AS (
  SELECT map_from_entries(collect_list(struct(skill, idf))) AS m
  FROM (SELECT lower(skill) AS skill, max(idf) AS idf FROM ops.skill_stats WHERE skill IS NOT NULL GROUP BY lower(skill))
),
profile_row AS (
  SELECT
    transform(target_roles, r -> coalesce(try_element_at(rm.m, lower(r)), r)) AS roles,
    transform(skills, s -> named_struct('skill', s, 'idf', coalesce(try_element_at(si.m, lower(s)), 3))) AS skill_weights,
    min_years, max_years
  FROM ops.user_profile
  CROSS JOIN role_map rm
  CROSS JOIN skill_idf si
  WHERE profile_id = :user_id
  LIMIT 1
),
profile AS (
  SELECT *,
    aggregate(skill_weights, 0D, (total, s) -> total + s.idf) * greatest(3, size(skill_weights)) / greatest(1, size(skill_weights))
      AS skill_idf_total
  FROM profile_row
),
related_roles AS (
  SELECT count(*) > 0 AS ready, map_from_entries(collect_list(struct(role_b, struct(score, sim)))) AS m
  FROM (
    SELECT s.role_b,
      max(CASE WHEN array_position(p.roles, s.role_a) = 1 THEN 1.0 ELSE 0.95 END
        * 0.85 * least(1.0, greatest(0.0, (s.sim - 0.75) / 0.11))) AS score,
      max(s.sim) AS sim
    FROM ops.role_similarity s
    JOIN profile p ON array_contains(p.roles, s.role_a)
    WHERE s.role_b IS NOT NULL
    GROUP BY s.role_b
  )
),
role_categories AS (
  SELECT collect_set(r.category) AS categories
  FROM (
    SELECT role_title, category FROM ops.ref_roles
    UNION ALL SELECT role_title, category FROM ops.custom_roles WHERE status = 'active'
  ) r
  JOIN profile p ON array_contains(p.roles, r.role_title)
),
state AS (
  SELECT job_key, is_applied, applied_at, is_hidden, hidden_at
  FROM gold.user_job_state
  WHERE user_id = :user_id
),
scored AS (
  SELECT
    j.job_key, j.source, j.company_name, j.title, j.location, j.posted_date, j.job_url,
    j.seniority_level, j.employment_type, j.experience_min_years, j.experience_max_years, j.experience_level,
    j.skills, j.category, j.role_title, j.role_score, j.role_alternative,
    j.first_seen_at, j.last_seen_at, j.times_seen, j.is_active,
    coalesce(st.is_applied, false) AS is_applied, st.applied_at,
    coalesce(st.is_hidden, false) AS is_hidden, st.hidden_at,
    coalesce(array_position(p.roles, j.role_title), 0) AS role_rank,
    coalesce(exists(p.roles, r -> contains(lower(j.title), lower(r))), false) AS title_has_role,
    rr.ready AS related_ready,
    try_element_at(rr.m, j.role_title) AS related,
    coalesce(array_contains(p.roles, j.role_alternative), false) AS alternative_is_role,
    coalesce(array_contains(c.categories, j.category), false) AS category_is_role,
    filter(p.skill_weights, ps -> exists(j.skills, js -> lower(js) = lower(ps.skill)) OR exists(j.skill_groups, g -> lower(g) = lower(ps.skill)))
      AS matched_weights,
    coalesce(size(p.skill_weights), 0) > 0 AS has_profile_skills,
    p.skill_idf_total,
    size(coalesce(j.skills, CAST(array() AS ARRAY<STRING>))) + size(coalesce(j.skill_groups, CAST(array() AS ARRAY<STRING>))) = 0 AS no_job_skills,
    coalesce(j.experience_min_years, CASE j.experience_level
      WHEN 'Intern' THEN 0 WHEN 'Entry' THEN 0 WHEN 'Junior' THEN 1 WHEN 'Mid' THEN 3 WHEN 'Mid-Senior' THEN 3
      WHEN 'Senior' THEN 5 WHEN 'Lead/Manager' THEN 7 WHEN 'Principal/Staff' THEN 8 WHEN 'Director+' THEN 10
    END) AS exp_min,
    coalesce(j.experience_max_years, j.experience_min_years + 3, CASE j.experience_level
      WHEN 'Intern' THEN 0 WHEN 'Entry' THEN 0 WHEN 'Junior' THEN 1 WHEN 'Mid' THEN 3 WHEN 'Mid-Senior' THEN 3
      WHEN 'Senior' THEN 5 WHEN 'Lead/Manager' THEN 7 WHEN 'Principal/Staff' THEN 8 WHEN 'Director+' THEN 10
    END + 3) AS exp_top,
    p.min_years AS profile_min_years, p.max_years AS profile_max_years,
    coalesce(j.experience_min_years > p.max_years + 2, false) AS above_experience
  FROM gold.jobs j
  LEFT JOIN state st ON st.job_key = j.job_key
  LEFT JOIN profile p ON true
  CROSS JOIN role_categories c
  CROSS JOIN related_roles rr
),
parts AS (
  SELECT *,
    CASE
      WHEN role_rank = 1 THEN 1.0
      WHEN role_rank > 1 THEN 0.95
      WHEN title_has_role THEN 0.9
      WHEN related_ready THEN coalesce(related.score, 0.0)
      WHEN alternative_is_role THEN 0.5
      WHEN category_is_role THEN 0.3
      ELSE 0.0
    END AS fit_role,
    role_rank > 0 OR title_has_role OR CASE
      WHEN related_ready THEN coalesce(related.sim >= 0.86, false)
      ELSE alternative_is_role OR category_is_role
    END AS role_match,
    coalesce(transform(matched_weights, ps -> ps.skill), CAST(array() AS ARRAY<STRING>)) AS fit_matched_skills,
    CASE
      WHEN NOT has_profile_skills THEN 0.0
      WHEN no_job_skills THEN 0.3
      ELSE least(1.0, aggregate(matched_weights, 0D, (total, ps) -> total + ps.idf) / skill_idf_total)
    END AS fit_skills,
    CASE
      WHEN exp_min IS NULL THEN 0.7
      WHEN exp_min > profile_max_years THEN greatest(0.0, 1.0 - 0.3 * (exp_min - profile_max_years))
      WHEN exp_top < profile_min_years THEN greatest(0.5, 1.0 - 0.15 * (profile_min_years - exp_top))
      ELSE 1.0
    END AS fit_experience
  FROM scored
),
user_jobs AS (
  SELECT *,
    CAST(round(100 * (0.4 * fit_role + 0.45 * fit_skills + 0.15 * fit_experience)) AS INT) AS fit_score
  FROM parts
)
SELECT job_key, fit_score, fit_role, fit_skills, fit_experience, role_match, above_experience, fit_matched_skills, is_applied
FROM user_jobs
