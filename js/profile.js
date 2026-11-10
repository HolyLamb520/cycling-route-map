export function drawProfile(profile, { svg, range, onHover, onLeave } = {}) {
  if (!svg) return;
  svg.innerHTML = '';
  svg.onmousemove = null;
  svg.onmouseleave = null;
  const points = profile?.points || [];
  if (points.length < 2) {
    if (range) range.textContent = '无海拔数据';
    return;
  }
  const width = 300;
  const height = 86;
  const minEle = Math.min(...points.map((point) => point[1]));
  const maxEle = Math.max(...points.map((point) => point[1]));
  const span = Math.max(1, maxEle - minEle);
  const maxKm = Math.max(0.1, points[points.length - 1][0]);
  const path = points.map(([km, ele], index) => {
    const x = (km / maxKm) * width;
    const y = height - 8 - ((ele - minEle) / span) * (height - 20);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const area = `${path} L${width},${height - 8} L0,${height - 8} Z`;
  const ns = 'http://www.w3.org/2000/svg';
  const areaEl = document.createElementNS(ns, 'path');
  areaEl.setAttribute('d', area);
  areaEl.setAttribute('class', 'profile-area');
  const lineEl = document.createElementNS(ns, 'path');
  lineEl.setAttribute('d', path);
  lineEl.setAttribute('class', 'profile-line');
  const cursor = document.createElementNS(ns, 'line');
  cursor.setAttribute('class', 'profile-cursor');
  cursor.setAttribute('y1', '4');
  cursor.setAttribute('y2', String(height - 8));
  cursor.style.display = 'none';
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('class', 'profile-dot');
  dot.setAttribute('r', '2.6');
  dot.style.display = 'none';
  svg.append(areaEl, lineEl, cursor, dot);
  if (range) range.textContent = `${maxKm.toFixed(1)} km · ${Math.round(minEle)}–${Math.round(maxEle)} m`;

  svg.onmousemove = (event) => {
    const rect = svg.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const km = ratio * maxKm;
    let best = points[0];
    for (const point of points) {
      if (Math.abs(point[0] - km) < Math.abs(best[0] - km)) best = point;
    }
    const x = (best[0] / maxKm) * width;
    const y = height - 8 - ((best[1] - minEle) / span) * (height - 20);
    cursor.setAttribute('x1', x.toFixed(1));
    cursor.setAttribute('x2', x.toFixed(1));
    cursor.style.display = '';
    dot.setAttribute('cx', x.toFixed(1));
    dot.setAttribute('cy', y.toFixed(1));
    dot.style.display = '';
    if (onHover) onHover(best[2], best[3]);
    if (range) range.textContent = `${best[0].toFixed(1)} km · ${Math.round(best[1])} m`;
  };

  svg.onmouseleave = () => {
    cursor.style.display = 'none';
    dot.style.display = 'none';
    if (onLeave) onLeave();
    if (range) range.textContent = `${maxKm.toFixed(1)} km · ${Math.round(minEle)}–${Math.round(maxEle)} m`;
  };
}
