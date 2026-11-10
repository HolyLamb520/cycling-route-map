function haversineLonLat(a, b) {
  const radius = 6371008.8;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(Math.max(0, h))));
}

// 抽稀容差按 Web Mercator 的像素尺度取值（约 1.5 倍屏幕像素），
// 而不是固定米数：低缩放不再保留几十米级的无用细节。
export function lodBucket(zoom) {
  return Math.max(4, Math.min(16, Math.floor(zoom)));
}

export function lodTolerance(zoom) {
  if (zoom >= 16) return 3;
  if (zoom >= 15) return 6;
  if (zoom >= 14) return 12;
  if (zoom >= 13) return 25;
  if (zoom >= 12) return 50;
  if (zoom >= 11) return 100;
  if (zoom >= 10) return 200;
  if (zoom >= 9) return 400;
  if (zoom >= 8) return 800;
  if (zoom >= 7) return 1500;
  if (zoom >= 6) return 3000;
  return 5000;
}

export function sampleRoute(coords, feature, zoom, { selectedCount = 0, cache = new Map() } = {}) {
  if (!coords.length) return coords;
  // 全选上千天时，低缩放直接用构建期生成的概览几何，避免首次抽稀开销。
  if (selectedCount > 300 && zoom < 9 && feature.properties.overview?.length) {
    return feature.properties.overview;
  }
  const tolerance = lodTolerance(zoom);
  const bucket = lodBucket(zoom);
  const key = `${feature.properties.id}:${bucket}`;
  if (cache.has(key)) return cache.get(key);
  if (tolerance <= 0) {
    cache.set(key, coords);
    return coords;
  }
  const sampled = [coords[0]];
  let last = coords[0];
  for (let i = 1; i < coords.length - 1; i += 1) {
    const point = coords[i];
    if (haversineLonLat(last, point) >= tolerance) {
      sampled.push(point);
      last = point;
    }
  }
  if (coords.length > 1) sampled.push(coords[coords.length - 1]);
  cache.set(key, sampled);
  return sampled;
}
