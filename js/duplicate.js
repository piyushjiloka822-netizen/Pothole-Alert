/**
 * Duplicate Detection Module — Pothole Reporting Application
 * Uses the Haversine formula to find nearby reports within a radius.
 */

const Duplicate = {
  RADIUS_METERS: 60, // reports within 60m are considered potential duplicates

  /**
   * Haversine formula — calculates distance between two lat/lng points in meters.
   */
  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const toRad = (deg) => deg * (Math.PI / 180);
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  },

  /**
   * Find all non-resolved reports within RADIUS_METERS of the given coordinates.
   * @param {number} lat
   * @param {number} lng
   * @param {Array} reports — full list of existing reports
   * @returns {Array} nearby reports sorted by distance
   */
  findNearby(lat, lng, reports) {
    return reports
      .filter(r => r.status !== 'resolved') // skip resolved ones
      .map(r => ({
        report: r,
        distance: Math.round(this.haversineDistance(lat, lng, r.lat, r.lng))
      }))
      .filter(item => item.distance <= this.RADIUS_METERS)
      .sort((a, b) => a.distance - b.distance);
  },

  /**
   * Check if a new submission is a duplicate of an existing report.
   * Returns the closest match or null.
   */
  checkDuplicate(lat, lng, reports) {
    const nearby = this.findNearby(lat, lng, reports);
    return nearby.length > 0 ? nearby[0] : null;
  },

  /**
   * Format distance for human display (e.g., "23 m away" or "0.1 km away")
   */
  formatDistance(meters) {
    if (meters < 1000) return `${meters} m away`;
    return `${(meters / 1000).toFixed(1)} km away`;
  }
};
