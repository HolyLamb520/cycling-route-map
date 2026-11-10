import { daySummary, escapeHtml, fmt, shortPlace } from './format.js';

export function renderMinimalMapSVG({ routes, boundaries, style }) {
    const width = Number(style.width) || 1600;
    const maxHeight = Number(style.max_height) || 2000;
    const padding = Number(style.padding) || 0.06;
    const background = style.background || '#f8f5ee';
    const edge = Math.max(16, Math.round(width * 0.02));

    let dataBBox = null;
    for (const route of routes) {
      dataBBox = mergeBBox(dataBBox, pointsBBox(route.points));
    }
    if (!dataBBox) {
      for (const feature of boundaries) {
        dataBBox = mergeBBox(dataBBox, geometryBBox(feature.geometry));
      }
    }
    if (!dataBBox) dataBBox = [119.5, 29.5, 120.5, 30.5];

    const minSpan = 0.02;
    let spanLon = Math.max(dataBBox[2] - dataBBox[0], minSpan);
    const spanLat = Math.max(dataBBox[3] - dataBBox[1], minSpan);
    const centerLon = (dataBBox[0] + dataBBox[2]) / 2;
    const centerLat = (dataBBox[1] + dataBBox[3]) / 2;
    const latStretch = 1 / Math.max(Math.cos((centerLat * Math.PI) / 180), 0.1);
    if (spanLon < spanLat * latStretch * 1.12) spanLon = spanLat * latStretch * 1.12;
    dataBBox = [
      centerLon - spanLon * (0.5 + padding),
      centerLat - spanLat * (0.5 + padding),
      centerLon + spanLon * (0.5 + padding),
      centerLat + spanLat * (0.5 + padding),
    ];

    const merc = mercatorBBox(dataBBox);
    const spanX = Math.max(merc[2] - merc[0], 1e-12);
    const spanY = Math.max(merc[3] - merc[1], 1e-12);
    const scale = Math.min((width - edge * 2) / spanX, (maxHeight - edge * 2) / spanY);
    const height = Math.max(320, Math.min(maxHeight, Math.round(spanY * scale + edge * 2)));
    const xOffset = (width - spanX * scale) / 2;
    const yOffset = (height - spanY * scale) / 2;

    const project = (lon, lat) => {
      const [mx, my] = mercator(lon, lat);
      return [xOffset + (mx - merc[0]) * scale, yOffset + (my - merc[1]) * scale];
    };

    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeHtml(background)}"/>`);
    parts.push('<g>');

    const stroke = style.boundary_stroke || '#b9ae94';
    const strokeMajor = style.boundary_stroke_major || '#8f8572';
    for (const feature of boundaries) {
      const pathData = geometryPath(feature.geometry, project);
      if (!pathData) continue;
      const props = feature.properties || {};
      const major = ['province', 'city', 'country'].includes(props.level);
      parts.push(`<path d="${pathData}" fill="none" stroke="${escapeHtml(major ? strokeMajor : stroke)}" stroke-width="${major ? '1.25' : '0.9'}" stroke-linejoin="round"/>`);
    }

    const routeWidth = Number(style.route_width) || 3;
    const paths = routes
      .filter((route) => route.points && route.points.length >= 2)
      .map((route) => ({ route, pathData: linePath(route.points, project) }))
      .filter((item) => item.pathData);
    for (const { route, pathData } of paths) {
      const mode = route.mode || 'cycling';
      const dash = route.dash ? ` stroke-dasharray="${escapeHtml(route.dash)}"` : '';
      const opacity = mode === 'transport' ? '0.62' : mode === 'inferred' ? '0.82' : '1';
      parts.push(`<path d="${pathData}" fill="none" stroke="${escapeHtml(route.color || '#2a78d6')}" stroke-opacity="${opacity}" stroke-width="${fmt(routeWidth)}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`);
    }

    parts.push('</g>');
    parts.push('</svg>');
    return parts.join('\n');
  }

  // ------------------------------------------------------------------ SVG 渲染
export function renderMapSVG({ routes, boundaries, meta, style, showDayNumbers = true }) {
    const width = Number(style.width) || 1600;
    const maxHeight = Number(style.max_height) || 2000;
    const minHeight = Number(style.min_height) || 640;
    const padding = Number(style.padding) || 0.09;
    const background = style.background || '#f8f5ee';
    const font = style.font_family || 'sans-serif';
    const title = meta.project.title || '骑行路线图';
    const subtitle = meta.project.subtitle || '';
    const attribution = meta.project.attribution || '';
    const titleSize = Number(style.title_size) || 34;
    const subtitleSize = Number(style.subtitle_size) || 17;
    const margin = Math.max(36, Math.round(width * 0.028));
    const headerH = Math.round(titleSize + (subtitle ? subtitleSize + 10 : 0) + 38);

    let dataBBox = null;
    for (const route of routes) {
      dataBBox = mergeBBox(dataBBox, pointsBBox(route.points));
    }
    if (!dataBBox) {
      for (const feature of boundaries) {
        dataBBox = mergeBBox(dataBBox, geometryBBox(feature.geometry));
      }
    }
    if (!dataBBox) dataBBox = [119.5, 29.5, 120.5, 30.5];

    const minSpan = 0.02;
    let spanLon = Math.max(dataBBox[2] - dataBBox[0], minSpan);
    const spanLat = Math.max(dataBBox[3] - dataBBox[1], minSpan);
    const centerLon = (dataBBox[0] + dataBBox[2]) / 2;
    const centerLat = (dataBBox[1] + dataBBox[3]) / 2;
    // 纵向路线扩展东西向视野（按墨卡托纬度拉伸换算），避免画布被压成极窄竖条
    const latStretch = 1 / Math.max(Math.cos((centerLat * Math.PI) / 180), 0.1);
    const minLonSpan = spanLat * latStretch * 1.12;
    if (spanLon < minLonSpan) spanLon = minLonSpan;
    dataBBox = [
      centerLon - spanLon * (0.5 + padding),
      centerLat - spanLat * (0.5 + padding),
      centerLon + spanLon * (0.5 + padding),
      centerLat + spanLat * (0.5 + padding),
    ];

    const merc = mercatorBBox(dataBBox);
    const spanX = Math.max(merc[2] - merc[0], 1e-12);
    const spanY = Math.max(merc[3] - merc[1], 1e-12);
    const legend = legendMetrics(routes, style, width);
    const footerH = legend.entries.length ? legend.panelH + 34 : 34;
    const minMapH = Math.max(260, minHeight - headerH - footerH);
    const availH = Math.max(240, maxHeight - headerH - footerH - margin * 2);
    const scale = Math.min((width - margin * 2) / spanX, availH / spanY);
    const mapH = spanY * scale + margin * 2;
    const mapAreaH = Math.max(mapH, minMapH);
    let totalH = Math.round(headerH + mapAreaH + footerH);
    totalH = Math.min(totalH, Math.max(maxHeight, headerH + minMapH + footerH));
    const height = totalH;
    const xOffset = (width - spanX * scale) / 2;
    const yOffset = headerH + (mapAreaH - spanY * scale) / 2;
    const footerTop = headerH + mapAreaH;

    const project = (lon, lat) => {
      const [mx, my] = mercator(lon, lat);
      return [xOffset + (mx - merc[0]) * scale, yOffset + (my - merc[1]) * scale];
    };

    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" font-family="${escapeHtml(font)}">`);
    parts.push(`<title>${escapeHtml(title)}</title>`);
    parts.push(`<desc>${escapeHtml(subtitle || title)}</desc>`);
    parts.push('<defs>');
    parts.push(`<clipPath id="map-clip"><rect x="0" y="${headerH}" width="${width}" height="${Math.max(0, mapAreaH)}"/></clipPath>`);
    parts.push('<filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.4" flood-color="#3a3428" flood-opacity="0.22"/></filter>');
    parts.push('</defs>');
    parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeHtml(background)}"/>`);
    parts.push('<g clip-path="url(#map-clip)">');

    const stroke = style.boundary_stroke || '#d6d0c2';
    const strokeMajor = style.boundary_stroke_major || '#bdb5a3';
    for (const feature of boundaries) {
      const props = feature.properties || {};
      const pathData = geometryPath(feature.geometry, project);
      if (!pathData) continue;
      const level = props.level || 'district';
      const major = ['province', 'city', 'country'].includes(level);
      parts.push(`<path d="${pathData}" fill="none" stroke="${escapeHtml(major ? strokeMajor : stroke)}" stroke-width="${major ? '1.25' : '0.9'}" stroke-linejoin="round"/>`);
    }

    const placedBoxes = [];
    const labelLevels = new Set(style.label_levels || ['city', 'district']);
    if (style.show_boundary_labels !== false && boundaries.length) {
      const baseSize = Number(style.label_size) || 12;
      const candidates = [];
      for (const feature of boundaries) {
        const props = feature.properties || {};
        const level = props.level || 'district';
        if (labelLevels.size && !labelLevels.has(level)) continue;
        if (typeof props.label_lon !== 'number' || typeof props.label_lat !== 'number') continue;
        const [x, y] = project(props.label_lon, props.label_lat);
        if (!(x >= 12 && x <= width - 12 && y >= headerH + 12 && y <= height - 12)) continue;
        const name = props.name || '';
        if (!name) continue;
        const size = baseSize + (['province', 'city'].includes(level) ? 2.5 : 0);
        candidates.push({ level, name, x, y, size, adcode: Number(props.adcode) || 0 });
      }
      candidates.sort((a, b) => {
        const rankA = ['province', 'city'].includes(a.level) ? 0 : 1;
        const rankB = ['province', 'city'].includes(b.level) ? 0 : 1;
        return rankA - rankB || a.adcode - b.adcode;
      });
      for (const item of candidates) {
        const w = textWidth(item.name, item.size);
        const box = [item.x - w / 2 - 2, item.y - item.size, item.x + w / 2 + 2, item.y + item.size * 0.3];
        if (placedBoxes.some((other) => boxesOverlap(box, other))) continue;
        placedBoxes.push(box);
        const major = ['province', 'city'].includes(item.level);
        const color = major ? (style.label_color_major || '#5d5647') : (style.label_color || '#77705f');
        const weight = item.level === 'province' ? '600' : item.level === 'city' ? '500' : '400';
        parts.push(`<text x="${fmt(item.x)}" y="${fmt(item.y)}" font-size="${fmt(item.size)}" fill="${escapeHtml(color)}" font-weight="${weight}" text-anchor="middle" letter-spacing="0.4" paint-order="stroke" stroke="${escapeHtml(background)}" stroke-width="2.6" stroke-opacity="0.75">${escapeHtml(item.name)}</text>`);
      }
    }

    const routing = routes
      .filter((route) => route.points && route.points.length >= 2)
      .map((route) => ({ route, pathData: linePath(route.points, project) }))
      .filter((item) => item.pathData);
    const routeWidth = Number(style.route_width) || 3;
    for (const { route, pathData } of routing) {
      const dash = route.dash ? ` stroke-dasharray="${escapeHtml(route.dash)}"` : '';
      parts.push(`<path d="${pathData}" fill="none" stroke="${escapeHtml(route.color || '#2a78d6')}" stroke-width="${fmt(routeWidth)}" stroke-linecap="round" stroke-linejoin="round"${dash} filter="url(#soft-shadow)"/>`);
    }

    const markerRadius = Number(style.marker_radius) || 10;
    const routeLabelSize = Number(style.label_size) || 12;
    for (const { route } of routing) {
      const points = route.points;
      const [sx, sy] = project(points[0][0], points[0][1]);
      const [ex, ey] = project(points[points.length - 1][0], points[points.length - 1][1]);
      if (showDayNumbers) {
        parts.push(`<circle cx="${fmt(sx)}" cy="${fmt(sy)}" r="${fmt(markerRadius)}" fill="${escapeHtml(route.color || '#2a78d6')}" stroke="#ffffff" stroke-width="2.6"/>`);
        parts.push(`<text x="${fmt(sx)}" y="${fmt(sy + markerRadius * 0.34)}" font-size="${fmt(markerRadius * 0.95)}" fill="#ffffff" font-weight="700" text-anchor="middle">${escapeHtml(String(route.day || ''))}</text>`);
        placedBoxes.push([sx - markerRadius, sy - markerRadius, sx + markerRadius, sy + markerRadius]);
      }
      const isLoop = haversine([points[0][1], points[0][0]], [points[points.length - 1][1], points[points.length - 1][0]]) <= 30;
      if (showDayNumbers) {
        if (!isLoop) {
          parts.push(`<circle cx="${fmt(ex)}" cy="${fmt(ey)}" r="5.5" fill="#fffdf8" stroke="${escapeHtml(route.color || '#2a78d6')}" stroke-width="2.6"/>`);
          placedBoxes.push([ex - 7, ey - 7, ex + 7, ey + 7]);
        }
      } else {
        parts.push(`<circle cx="${fmt(ex)}" cy="${fmt(ey)}" r="4" fill="${escapeHtml(route.color || '#2a78d6')}" stroke="#fffdf8" stroke-width="1.8"/>`);
        placedBoxes.push([ex - 6, ey - 6, ex + 6, ey + 6]);
      }
      if (style.route_labels === false || !showDayNumbers) continue;
      const label = `${route.label || `D${route.day}`} · ${daySummary(route)}`.replace(/^ · | · $/g, '');
      const labelWidth = textWidth(label, routeLabelSize);
      for (const fraction of [0.5, 0.38, 0.62, 0.28, 0.72]) {
        const [lon, lat, bearing] = pointAtFraction(points, fraction);
        const [px, py] = project(lon, lat);
        const rad = (bearing * Math.PI) / 180;
        const lx = px + Math.sin(rad) * 16;
        const ly = py - Math.cos(rad) * 16;
        const box = [lx - labelWidth / 2 - 6, ly - routeLabelSize - 4, lx + labelWidth / 2 + 6, ly + 5];
        if (!(box[0] >= 12 && box[2] <= width - 12 && box[1] >= headerH + 12 && box[3] <= height - 12)) continue;
        if (placedBoxes.some((other) => boxesOverlap(box, other))) continue;
        placedBoxes.push(box);
        parts.push(`<rect x="${fmt(box[0])}" y="${fmt(box[1])}" width="${fmt(labelWidth + 12)}" height="${fmt(routeLabelSize + 9)}" rx="5" fill="#fffdf8" fill-opacity="0.92" stroke="${escapeHtml(route.color || '#2a78d6')}" stroke-opacity="0.42"/>`);
        parts.push(`<text x="${fmt(lx)}" y="${fmt(ly)}" font-size="${fmt(routeLabelSize)}" fill="#3f3a2f" text-anchor="middle">${escapeHtml(label)}</text>`);
        break;
      }
    }

    parts.push('</g>');

    const titleX = margin * 0.9;
    const titleY = margin * 0.55 + titleSize * 0.86;
    parts.push(`<text x="${fmt(titleX)}" y="${fmt(titleY)}" font-size="${fmt(titleSize)}" font-weight="700" fill="#2f2b23" letter-spacing="1">${escapeHtml(title)}</text>`);
    if (subtitle) {
      parts.push(`<text x="${fmt(titleX)}" y="${fmt(titleY + subtitleSize + 9)}" font-size="${fmt(subtitleSize)}" fill="#736b59" letter-spacing="2">${escapeHtml(subtitle)}</text>`);
    }
    parts.push(`<line x1="${fmt(titleX)}" y1="${fmt(headerH - 14)}" x2="${fmt(titleX + 56)}" y2="${fmt(headerH - 14)}" stroke="#b9ae94" stroke-width="2.4" stroke-linecap="round"/>`);
    if (routes.length) {
      const totalKm = routes.reduce((sum, route) => sum + (Number(route.distance_km) || 0), 0);
      const totalUp = routes.reduce((sum, route) => sum + (Number(route.ascent_m) || 0), 0);
      const statsText = `${routes.length} 天 · ${Math.round(totalKm)} km · 爬升 ${Math.round(totalUp)} m`;
      parts.push(`<text x="${fmt(width - margin)}" y="${fmt(titleY)}" font-size="14.5" fill="#6f6756" text-anchor="end" letter-spacing="0.8">${escapeHtml(statsText)}</text>`);
    }

    parts.push(`<line x1="${fmt(margin)}" y1="${fmt(footerTop + 1)}" x2="${fmt(width - margin)}" y2="${fmt(footerTop + 1)}" stroke="#ddd6c6" stroke-width="0.8"/>`);
    if (legend.entries.length) appendLegend(parts, legend, margin * 0.85, footerTop + 16);
    if (routing.length) appendScaleBar(parts, width, margin, scale, centerLat, footerTop + 42);
    appendCompass(parts, width, margin, headerH);
    const footerText = `${TODAY ? `生成于 ${TODAY}` : ''}${attribution ? ` · ${attribution}` : ''}`;
    parts.push(`<text x="${fmt(width - margin)}" y="${fmt(height - 12)}" font-size="10.5" fill="#8c8472" text-anchor="end">${escapeHtml(footerText)}</text>`);
    parts.push('</svg>');
    return parts.join('\n');
  }

  function legendMetrics(routes, style, width) {
    const byTrip = new Map();
    const order = [];
    for (const route of routes) {
      const tripId = route.trip_id || '';
      if (!byTrip.has(tripId)) {
        byTrip.set(tripId, []);
        order.push(tripId);
      }
      byTrip.get(tripId).push(route);
    }
    const size = 13;
    const lineH = 22;
    const headingH = 26;
    const pad = 15;
    let colW = 0;
    let headings = 0;
    const entries = [];
    for (const tripId of order) {
      const tripRoutes = byTrip.get(tripId);
      const tripName = tripRoutes[0].trip_name || tripId;
      const totalKm = tripRoutes.reduce((sum, route) => sum + (Number(route.distance_km) || 0), 0);
      const totalUp = tripRoutes.reduce((sum, route) => sum + (Number(route.ascent_m) || 0), 0);
      const heading = `${tripName}  ${Math.round(totalKm)} km · 爬升 ${Math.round(totalUp)} m`;
      entries.push({ heading, route: null });
      headings += 1;
      for (const route of tripRoutes) {
        entries.push({ heading: '', route });
        colW = Math.max(
          colW,
          textWidth(heading, size + 2),
          textWidth(`${route.label || ''} ${shortPlace(route.start)}→${shortPlace(route.end)}   ${daySummary(route)}`, size),
        );
      }
    }
    const panelW = Math.min(width * 0.52, colW + 86);
    const panelH = pad * 2 + headings * headingH + Math.max(0, entries.length - headings) * lineH + 4;
    return { entries, panelW, panelH, size, lineH, headingH, pad };
  }

  function appendLegend(parts, legend, x, y) {
    const { size, lineH, headingH, pad } = legend;
    parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(legend.panelW)}" height="${fmt(legend.panelH)}" rx="9" fill="#fffdf8" fill-opacity="0.96" stroke="#ddd6c6" stroke-width="0.8"/>`);
    let cursor = y + pad + size;
    for (const entry of legend.entries) {
      if (!entry.route) {
        parts.push(`<text x="${fmt(x + pad)}" y="${fmt(cursor)}" font-size="${fmt(size + 1.5)}" font-weight="700" fill="#3f3a2f">${escapeHtml(entry.heading)}</text>`);
        cursor += headingH;
        continue;
      }
      const route = entry.route;
      const color = route.color || '#2a78d6';
      const dash = route.dash ? ` stroke-dasharray="${escapeHtml(route.dash)}"` : '';
      const sx = x + pad + 3;
      const sy = cursor - size * 0.32;
      parts.push(`<line x1="${fmt(sx)}" y1="${fmt(sy)}" x2="${fmt(sx + 26)}" y2="${fmt(sy)}" stroke="#ffffff" stroke-width="5.5" stroke-linecap="round"${dash}/>`);
      parts.push(`<line x1="${fmt(sx)}" y1="${fmt(sy)}" x2="${fmt(sx + 26)}" y2="${fmt(sy)}" stroke="${escapeHtml(color)}" stroke-width="2.8" stroke-linecap="round"${dash}/>`);
      const label = `${route.label || ''} ${shortPlace(route.start)}→${shortPlace(route.end)}`;
      parts.push(`<text x="${fmt(sx + 36)}" y="${fmt(cursor)}" font-size="${fmt(size)}" fill="#4a4438">${escapeHtml(label)}</text>`);
      parts.push(`<text x="${fmt(x + legend.panelW - pad)}" y="${fmt(cursor)}" font-size="${fmt(size - 0.5)}" fill="#7c7462" text-anchor="end">${escapeHtml(daySummary(route))}</text>`);
      cursor += lineH;
    }
  }

  function appendScaleBar(parts, width, margin, scale, centerLat, y) {
    const metersPerPixel = (40075016.686 * Math.cos((centerLat * Math.PI) / 180)) / scale;
    const candidates = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    let distanceKm = candidates[0];
    let best = Infinity;
    for (const km of candidates) {
      const diff = Math.abs((km * 1000) / metersPerPixel - 130);
      if (diff < best) {
        best = diff;
        distanceKm = km;
      }
    }
    const pixels = (distanceKm * 1000) / metersPerPixel;
    const x2 = width - margin;
    const x1 = x2 - pixels;
    const color = '#4f4a3e';
    parts.push(`<line x1="${fmt(x1)}" y1="${fmt(y)}" x2="${fmt(x2)}" y2="${fmt(y)}" stroke="${color}" stroke-width="2"/>`);
    parts.push(`<line x1="${fmt(x1)}" y1="${fmt(y - 5)}" x2="${fmt(x1)}" y2="${fmt(y + 5)}" stroke="${color}" stroke-width="2"/>`);
    parts.push(`<line x1="${fmt(x2)}" y1="${fmt(y - 5)}" x2="${fmt(x2)}" y2="${fmt(y + 5)}" stroke="${color}" stroke-width="2"/>`);
    parts.push(`<text x="${fmt((x1 + x2) / 2)}" y="${fmt(y - 9)}" font-size="11.5" fill="${color}" text-anchor="middle" font-weight="600">${escapeHtml(`${distanceKm} km`)}</text>`);
  }

  function appendCompass(parts, width, margin, top) {
    const x = width - margin - 8;
    const y = top + 12;
    parts.push(`<g transform="translate(${fmt(x)} ${fmt(y)})" stroke="#5d5647" fill="#5d5647"><path d="M0 -15 L5.5 7 L0 3 L-5.5 7 Z" fill="#5d5647" stroke="none"/><text x="0" y="22" font-size="11" text-anchor="middle" stroke="none" font-weight="700">N</text></g>`);
  }

  // ------------------------------------------------------------------ 几何 / 文本
  function mercator(lon, lat) {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const x = (lon + 180) / 360;
    const sinLat = Math.sin((clamped * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    return [x, y];
  }

  function mercatorBBox(bbox) {
    const [x1, y1] = mercator(bbox[0], bbox[1]);
    const [x2, y2] = mercator(bbox[2], bbox[3]);
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  }

  function pointsBBox(points) {
    let bbox = null;
    for (const point of points || []) {
      const lon = Number(point[0]);
      const lat = Number(point[1]);
      bbox = bbox
        ? [Math.min(bbox[0], lon), Math.min(bbox[1], lat), Math.max(bbox[2], lon), Math.max(bbox[3], lat)]
        : [lon, lat, lon, lat];
    }
    return bbox;
  }

  function mergeBBox(a, b) {
    if (!a) return b;
    if (!b) return a;
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  }

  function geometryBBox(geometry) {
    if (!geometry) return null;
    let bbox = null;
    const walk = (coords) => {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === 'number') {
        bbox = bbox
          ? [Math.min(bbox[0], coords[0]), Math.min(bbox[1], coords[1]), Math.max(bbox[2], coords[0]), Math.max(bbox[3], coords[1])]
          : [coords[0], coords[1], coords[0], coords[1]];
        return;
      }
      coords.forEach(walk);
    };
    walk(geometry.coordinates);
    return bbox;
  }

  function geometryPath(geometry, project) {
    const type = geometry.type;
    const coords = geometry.coordinates;
    if (type === 'Polygon') return polygonPath([coords], project);
    if (type === 'MultiPolygon') return polygonPath(coords, project);
    return '';
  }

  function polygonPath(polygons, project) {
    const commands = [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        const command = ringPath(ring, project);
        if (command) commands.push(command);
      }
    }
    return commands.join(' ');
  }

  function ringPath(ring, project) {
    if (!ring || ring.length < 3) return '';
    const coords = ring.map(([lon, lat]) => {
      const [x, y] = project(lon, lat);
      return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
    });
    const cleaned = [coords[0]];
    for (const point of coords.slice(1)) {
      if (point[0] !== cleaned[cleaned.length - 1][0] || point[1] !== cleaned[cleaned.length - 1][1]) {
        cleaned.push(point);
      }
    }
    if (cleaned[0][0] !== cleaned[cleaned.length - 1][0] || cleaned[0][1] !== cleaned[cleaned.length - 1][1]) {
      cleaned.push(cleaned[0]);
    }
    if (cleaned.length < 4) return '';
    return `M${fmt(cleaned[0][0])} ${fmt(cleaned[0][1])} ` + cleaned.slice(1).map(([x, y]) => `L${fmt(x)} ${fmt(y)}`).join(' ') + ' Z';
  }

  function linePath(points, project) {
    const commands = [];
    let last = null;
    for (const [lon, lat] of points) {
      const [x, y] = project(lon, lat);
      const rounded = [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
      if (last && rounded[0] === last[0] && rounded[1] === last[1]) continue;
      last = rounded;
      commands.push(`${commands.length ? 'L' : 'M'}${fmt(rounded[0])} ${fmt(rounded[1])}`);
    }
    return commands.join(' ');
  }

  function pointAtFraction(points, fraction) {
    if (!points.length) return [0, 0, 0];
    if (points.length === 1) return [points[0][0], points[0][1], 0];
    const distances = [0];
    for (let i = 1; i < points.length; i += 1) {
      distances.push(distances[i - 1] + haversine([points[i - 1][1], points[i - 1][0]], [points[i][1], points[i][0]]));
    }
    const target = distances[distances.length - 1] * Math.max(0, Math.min(1, fraction));
    for (let i = 1; i < distances.length; i += 1) {
      if (distances[i] >= target) {
        const segment = distances[i] - distances[i - 1] || 1;
        const t = (target - distances[i - 1]) / segment;
        const a = points[i - 1];
        const b = points[i];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, bearing(a, b)];
      }
    }
    const a = points[points.length - 2];
    const b = points[points.length - 1];
    return [b[0], b[1], bearing(a, b)];
  }

  function bearing(a, b) {
    const lat1 = (a[1] * Math.PI) / 180;
    const lat2 = (b[1] * Math.PI) / 180;
    const dlon = ((b[0] - a[0]) * Math.PI) / 180;
    const x = Math.sin(dlon) * Math.cos(lat2);
    const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon);
    return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
  }

  function textWidth(text, size) {
    let width = 0;
    for (const char of String(text)) {
      width += char.codePointAt(0) > 0x2e80 ? size : size * 0.56;
    }
    return width;
  }

  function boxesOverlap(a, b) {
    return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
  }


