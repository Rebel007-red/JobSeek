class LocationFilter:
    """Centralized location filtering for ATS scrapers.

    Keep the rules consistent across Greenhouse and Workday, while allowing
    a location target such as 'India' or 'Bengaluru' without breaking remote jobs.
    """

    def __init__(self, target_location=''):
        self.target = (target_location or '').strip()
        self.target_lower = self.target.lower()

    def _normalize(self, value):
        return (value or '').strip().lower()

    def _is_india_like(self, location):
        location_text = self._normalize(location)
        if not location_text or location_text == 'not specified':
            return True

        india_markers = [
            'india', 'indian', 'bengaluru', 'bangalore', 'hyderabad', 'gurugram', 'gurgaon',
            'delhi', 'mumbai', 'pune', 'chennai', 'kochi', 'ahmedabad', 'noida', 'kolkata',
            'jaipur', 'lucknow', 'bhubaneswar', 'visakhapatnam', 'coimbatore', 'trivandrum'
        ]

        if 'remote' in location_text:
            return True

        if self.target_lower and self.target_lower in location_text:
            return True

        return any(marker in location_text for marker in india_markers)

    def _is_non_india_location(self, location):
        location_text = self._normalize(location)
        non_india_markers = [
            'california', 'texas', 'new york', 'florida', 'washington', 'seattle', 'san francisco',
            'mountain view', 'palo alto', 'united states', 'usa', 'us,', 'us ', 'chicago', 'austin',
            'boston', 'denver', 'atlanta', 'houston', 'las vegas', 'los angeles', 'new jersey',
            'pennsylvania', 'virginia', 'illinois', 'london', 'uk', 'united kingdom', 'england',
            'ireland', 'dublin', 'manchester', 'canada', 'toronto', 'vancouver', 'montreal',
            'calgary', 'ottawa', 'germany', 'france', 'netherlands', 'belgium', 'switzerland',
            'austria', 'sweden', 'denmark', 'norway', 'finland', 'poland', 'czech', 'spain',
            'italy', 'portugal', 'greece', 'europe', 'berlin', 'paris', 'amsterdam', 'zurich',
            'brussels', 'australia', 'new zealand', 'singapore', 'malaysia', 'thailand', 'vietnam',
            'japan', 'china', 'hong kong', 'south korea', 'uae', 'dubai', 'middle east', 'mexico',
            'brazil', 'argentina', 'latin america'
        ]

        return any(marker in location_text for marker in non_india_markers)

    def filter(self, jobs):
        if not self.target:
            return jobs

        filtered = []
        for job in jobs:
            location = job.get('location', '')
            if self._is_non_india_location(location):
                continue
            if self._is_india_like(location):
                filtered.append(job)
        return filtered
