export function qaLabel(flag) {
  if (flag === 'low-confidence') return '低置信度地点';
  if (flag === 'long-segment') return '超长节点段';
  if (flag === 'endpoint-offset') return '端点偏差';
  return flag;
}

export function qaColor(flags) {
  const set = new Set(flags || []);
  if (set.has('endpoint-offset')) return '#d97706';
  if (set.has('long-segment')) return '#c8901a';
  if (set.has('low-confidence')) return '#b73636';
  return null;
}

export function modeLabel(mode) {
  if (mode === 'transport') return '交通段';
  if (mode === 'inferred') return '推断段';
  return '骑行段';
}

export function providerLabel(provider) {
  if (provider === 'amap') return '高德骑行';
  if (provider === 'brouter') return 'BRouter 驾车';
  if (provider === 'ors') return 'OpenRouteService';
  if (provider === 'osrm') return 'OSRM';
  if (provider === 'fit') return 'FIT 导入';
  if (provider === 'gpx-imported') return 'GPX 导入';
  if (provider === 'gpx') return 'GPX';
  return '';
}
