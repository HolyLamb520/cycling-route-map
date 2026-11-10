/* 首页地图配色：先按年份/团别确定组的基准色，再决定同组内各条路线如何变化。
 *
 * - 同色系：同一组（同一年/同一团别）的路线使用相近的深浅/邻近色；
 *   不同组之间用较大的色相间隔，便于观察年份或团别的变化。
 * - 高对比：同一组内的多条路线用较大的色相间隔，便于区分同一年份的不同团。
 *
 * 纯逻辑，不依赖 DOM：浏览器使用 window.RoutePalette，Node 测试使用 require。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoutePalette = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OTHER = '未标注';
  const COLOR_BY = ['default', 'year', 'team'];
  const SCHEMES = ['contrast', 'family'];
  const GOLDEN_ANGLE = 137.508;

  function yearOf(trip) {
    if (trip && trip.year !== null && trip.year !== undefined && trip.year !== '') {
      const year = Number(trip.year);
      if (Number.isInteger(year)) return year;
    }
    const match = /^(\d{4})/.exec(String((trip && trip.name) || ''));
    return match ? Number(match[1]) : null;
  }

  function tripGroupKey(trip, colorBy) {
    if (colorBy === 'year') {
      const year = yearOf(trip);
      return year ? String(year) : OTHER;
    }
    if (colorBy === 'team') {
      const team = String((trip && trip.team_type) || '').trim();
      return team || OTHER;
    }
    return 'default';
  }

  // 年份按时间升序；团别按中文名称排序。顺序稳定，颜色分配才可复现。
  function orderedGroups(trips, colorBy) {
    const seen = new Set();
    for (const trip of trips || []) seen.add(tripGroupKey(trip, colorBy));
    const keys = [...seen];
    if (colorBy === 'year') {
      keys.sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        const fa = Number.isFinite(na);
        const fb = Number.isFinite(nb);
        if (fa && fb) return na - nb;
        if (fa !== fb) return fa ? -1 : 1;
        return a.localeCompare(b, 'zh');
      });
    } else {
      keys.sort((a, b) => a.localeCompare(b, 'zh'));
    }
    return keys;
  }

  function hslToHex(hue, saturation, lightness) {
    const h = ((Number(hue) % 360) + 360) % 360 / 360;
    const s = Math.min(1, Math.max(0, Number(saturation)));
    const l = Math.min(1, Math.max(0, Number(lightness)));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t) => {
      let value = t;
      if (value < 0) value += 1;
      if (value > 1) value -= 1;
      if (value < 1 / 6) return p + (q - p) * 6 * value;
      if (value < 1 / 2) return q;
      if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
      return p;
    };
    const toHex = (value) => Math.round(value * 255).toString(16).padStart(2, '0');
    return `#${toHex(channel(h + 1 / 3))}${toHex(channel(h))}${toHex(channel(h - 1 / 3))}`;
  }

  function hexToHsl(hex) {
    const value = String(hex || '').replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(value)) return [205, 0.6, 0.44];
    const r = parseInt(value.slice(0, 2), 16) / 255;
    const g = parseInt(value.slice(2, 4), 16) / 255;
    const b = parseInt(value.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta !== 0) {
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    const lightness = (max + min) / 2;
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
    return [hue, saturation, lightness];
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // 组的基准色：在色相环上均匀分开，并用明度错开相邻组；
  // 这样不同年份/团别之间差异明显，同组内的变体仍围绕各自基准色。
  function groupBaseColors(groups) {
    const colors = new Map();
    const count = Math.max(1, groups.length);
    const step = 360 / count;
    groups.forEach((key, index) => {
      const hue = index * step + 18;
      const lightness = 0.38 + (index % 3) * 0.06;
      colors.set(key, hslToHex(hue, 0.62, lightness));
    });
    return colors;
  }

  // 同组内的路线：
  // family  —— 围绕组基准色做邻近色相 + 轻微深浅变化；
  // contrast —— 以黄金角继续拉开色相，保证同组路线彼此对比明显。
  function variantColor(baseHex, index, count, scheme) {
    if (count <= 1) return baseHex;
    const [hue, saturation, lightness] = hexToHsl(baseHex);
    if (scheme === 'family') {
      const offset = index - (count - 1) / 2;
      return hslToHex(
        hue + offset * 5,
        clamp(saturation, 0.52, 0.68),
        clamp(lightness + offset * 0.045, 0.32, 0.62),
      );
    }
    if (index === 0) return baseHex;
    return hslToHex(
      hue + index * GOLDEN_ANGLE,
      0.63,
      index % 2 === 1 ? 0.47 : 0.40,
    );
  }

  function buildTripColors(trips, colorBy, scheme) {
    const list = Array.isArray(trips) ? trips : [];
    const mode = SCHEMES.includes(scheme) ? scheme : 'contrast';
    const groups = orderedGroups(list, colorBy);
    const groupColors = groupBaseColors(groups);
    const byGroup = new Map();
    for (const trip of list) {
      if (!trip || !trip.id) continue;
      const key = tripGroupKey(trip, colorBy);
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(trip);
    }
    const tripColors = new Map();
    const tripGroup = new Map();
    for (const [key, members] of byGroup) {
      members.sort((a, b) => {
        const yearDelta = (yearOf(a) || 0) - (yearOf(b) || 0);
        if (yearDelta) return yearDelta;
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
          || String(a.id).localeCompare(String(b.id));
      });
      const base = groupColors.get(key);
      members.forEach((trip, index) => {
        tripGroup.set(trip.id, key);
        tripColors.set(trip.id, variantColor(base, index, members.length, mode));
      });
    }
    return { groups, groupColors, tripColors, tripGroup };
  }

  return {
    OTHER,
    COLOR_BY,
    SCHEMES,
    yearOf,
    tripGroupKey,
    orderedGroups,
    hslToHex,
    hexToHsl,
    groupBaseColors,
    buildTripColors,
  };
});
