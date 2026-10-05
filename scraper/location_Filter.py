INDIA_MARKERS = [
    'india', 'indian', 'bengaluru', 'bangalore', 'hyderabad', 'gurugram', 'gurgaon',
    'delhi', 'mumbai', 'pune', 'chennai', 'kochi', 'ahmedabad', 'noida', 'kolkata',
    'jaipur', 'lucknow', 'bhubaneswar', 'visakhapatnam', 'coimbatore', 'trivandrum',
]


def filter_india_jobs(jobs):
    """Only keep roles tied to India or Indian cities; India remote is allowed, bare 'Remote' is not."""
    filtered = []
    for job in jobs:
        location = (job.get('location') or '').lower()
        if any(marker in location for marker in INDIA_MARKERS):
            filtered.append(job)
    return filtered
