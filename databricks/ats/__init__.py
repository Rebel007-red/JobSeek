"""API / HTML job-board scrapers (one adapter per ATS) run by databricks/ats_scrape.py.

base.py      the adapter interface (AtsAdapter, Posting), polite HTTP (Http), dates, India filter, run_company()
registry.py  ats_type name -> adapter class (lazy imports, so an adapter that is not built yet is reported, not fatal)
<name>.py    one adapter per ATS (lever.py is the reference example)

Workday (browser) and Greenhouse keep their own scripts (databricks/workday.py, greenhouse.py).
"""
