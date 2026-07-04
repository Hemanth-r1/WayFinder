export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

export function bearingBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return ((Math.atan2(lng2 - lng1, lat2 - lat1) * 180 / Math.PI) % 360 + 360) % 360;
}
