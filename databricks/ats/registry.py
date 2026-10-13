"""ats_type name -> adapter class, imported lazily so one missing or broken adapter never stops the others.

The name is the value of public.companies.ats_type, the CSV prefix (<name>_<YYYYmmdd_HHMMSS>.csv), the scrape report
source (output/<name>_report.json) and app.jobs.source. Names are lower case with no '_' (02_ingest_silver takes the
source system from the file name up to the first '_').
"""
from importlib import import_module

from scraper_common import ScrapeFailed

# API / HTML adapters run by databricks/ats_scrape.py, in run order (--all-api)
ADAPTERS = {
    "lever": "ats.lever:LeverAdapter",
    "ashby": "ats.ashby:AshbyAdapter",
    "smartrecruiters": "ats.smartrecruiters:SmartRecruitersAdapter",
    "workable": "ats.workable:WorkableAdapter",
    "oracle": "ats.oracle:OracleAdapter",
    "successfactors": "ats.successfactors:SuccessFactorsAdapter",
    "darwinbox": "ats.darwinbox:DarwinboxAdapter",
    "keka": "ats.keka:KekaAdapter",
}

LABELS = {
    "workday": "Workday",
    "greenhouse": "Greenhouse",
    "linkedin": "LinkedIn",
    "lever": "Lever",
    "ashby": "Ashby",
    "smartrecruiters": "SmartRecruiters",
    "workable": "Workable",
    "oracle": "Oracle Recruiting",
    "successfactors": "SAP SuccessFactors",
    "darwinbox": "Darwinbox",
    "keka": "Keka",
}

# Sources with their own scraper script (not adapters)
SCRIPT_SOURCES = ("workday", "greenhouse", "linkedin")
# Every scrape source, i.e. every valid app.scrape_runs.source / pipeline_record_scrape source
ALL_SOURCES = (*SCRIPT_SOURCES, *ADAPTERS)


class AdapterNotAvailable(ScrapeFailed):
    """The adapter module is missing or fails to import; str() is the reason the scrape report records."""


def get(name):
    """An adapter instance for name; raises AdapterNotAvailable (unknown name, module not built yet, import error)."""
    key = str(name or "").strip().lower()
    spec = ADAPTERS.get(key)
    if not spec:
        raise AdapterNotAvailable(f"no adapter for ats_type {key!r}")
    module_name, class_name = spec.split(":")
    try:
        module = import_module(module_name)
    except ModuleNotFoundError as exc:
        if exc.name == module_name:
            raise AdapterNotAvailable(f"{LABELS.get(key, key)} scraper not built yet") from exc
        raise AdapterNotAvailable(f"{LABELS.get(key, key)} scraper failed to import: {exc}") from exc
    except Exception as exc:
        raise AdapterNotAvailable(f"{LABELS.get(key, key)} scraper failed to import: {type(exc).__name__}: {exc}") from exc
    adapter_class = getattr(module, class_name, None)
    if adapter_class is None:
        raise AdapterNotAvailable(f"{module_name} has no {class_name}")
    adapter = adapter_class()
    if adapter.name != key:
        raise AdapterNotAvailable(f"{class_name}.name is {adapter.name!r}, expected {key!r}")
    return adapter


def available():
    """Names whose adapter imports."""
    names = []
    for name in ADAPTERS:
        try:
            get(name)
        except AdapterNotAvailable:
            continue
        names.append(name)
    return names


def parse_names(value):
    """'lever, Ashby' -> ['lever', 'ashby'] (order kept, duplicates dropped); raises ValueError for an unknown name."""
    names = []
    for part in str(value or "").split(","):
        name = part.strip().lower()
        if not name or name in names:
            continue
        if name not in ADAPTERS:
            known = ", ".join(ADAPTERS)
            raise ValueError(f"unknown ATS {name!r} (known: {known}; workday / greenhouse / linkedin have own scripts)")
        names.append(name)
    return names
