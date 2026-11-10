const UNITS = [
  '特别行政区', '自治区', '自治州', '自治县', '自治旗',
  '地区', '街道', '苏木', '省', '市', '区', '县', '旗', '镇', '乡', '盟',
];
const PLACE_RE = new RegExp(`([\\u4e00-\\u9fff·]{1,20}?(?:${UNITS.join('|')}))`, 'g');

export function splitPlaceName(name) {
  const text = String(name || '').trim();
  const parts = text.match(PLACE_RE) || [];
  const remainder = text.replace(PLACE_RE, '').trim();
  if (remainder) parts.push(remainder);
  return parts.length ? parts : [text];
}

export function shortPlace(name) {
  const parts = splitPlaceName(name);
  const last = parts[parts.length - 1];
  return parts.length > 1 && last.length >= 2 ? last : String(name || '');
}

export function daySummary(route) {
  const parts = [];
  if (route.distance_km !== null && route.distance_km !== undefined) parts.push(`${Math.round(route.distance_km)} km`);
  if (route.ascent_m !== null && route.ascent_m !== undefined) parts.push(`爬升 ${Math.round(route.ascent_m)} m`);
  return parts.join(' · ');
}

export function formatNumber(value) {
  try {
    return new Intl.NumberFormat('zh-CN').format(value);
  } catch (error) {
    return String(value);
  }
}

export function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return '0';
  let text = value.toFixed(digits);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

export function slugify(value) {
  const cleaned = String(value || 'route-map')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'route-map';
}
