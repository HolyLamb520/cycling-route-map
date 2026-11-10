/* 实验方案：重合路径“周期变色实线”。
 *
 * 当前首页未加载此文件，默认采用平行错位方案（web/js/lanes.js）。
 * 保留此模块以便以后重新启用；使用方法见同目录 README.md。
 *
 * 纯逻辑，不依赖 DOM：浏览器使用 window.RouteOverlap，Node 测试使用 require。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RouteOverlap = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeOptions(options) {
    const source = options || {};
    return {
      cellSize: Math.max(1, numberOr(source.cellSize, 4)),
      sampleStep: Math.max(1, numberOr(source.sampleStep, 4)),
      minRunPx: Math.max(0, numberOr(source.minRunPx, 14)),
    };
  }

  function coordinateAt(coords, index) {
    const value = coords[index] || coords[coords.length - 1] || [0, 0];
    return [Number(value[0]) || 0, Number(value[1]) || 0];
  }

  function densify(points, coords, step) {
    if (!Array.isArray(points) || points.length < 2) return [];
    const out = [];
    let order = 0;
    const first = coordinateAt(coords, 0);
    out.push({ x: points[0][0], y: points[0][1], lon: first[0], lat: first[1], order: 0 });
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      if (!Array.isArray(previous) || !Array.isArray(current)) continue;
      const x0 = Number(previous[0]);
      const y0 = Number(previous[1]);
      const x1 = Number(current[0]);
      const y1 = Number(current[1]);
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const length = Math.hypot(dx, dy);
      if (!length) continue;
      const from = coordinateAt(coords, index - 1);
      const to = coordinateAt(coords, index);
      const steps = Math.max(1, Math.ceil(length / step));
      for (let part = 1; part <= steps; part += 1) {
        const t = part / steps;
        out.push({
          x: x0 + dx * t,
          y: y0 + dy * t,
          lon: from[0] + (to[0] - from[0]) * t,
          lat: from[1] + (to[1] - from[1]) * t,
          order: order + length * t,
        });
      }
      order += length;
    }
    return out;
  }

  function cellKey(cx, cy) {
    return `${cx},${cy}`;
  }

  function componentsFor(cells) {
    const visited = new Set();
    const components = [];
    for (const startKey of cells.keys()) {
      if (visited.has(startKey)) continue;
      const stack = [startKey];
      visited.add(startKey);
      const component = [];
      while (stack.length) {
        const key = stack.pop();
        const cell = cells.get(key);
        if (!cell) continue;
        component.push(cell);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const neighborKey = cellKey(cell.cx + dx, cell.cy + dy);
          if (cells.has(neighborKey) && !visited.has(neighborKey)) {
            visited.add(neighborKey);
            stack.push(neighborKey);
          }
        }
      }
      components.push(component);
    }
    return components;
  }

  function longestConsecutive(indices, maxGap) {
    if (!indices.length) return [];
    let best = [];
    let current = [indices[0]];
    for (let index = 1; index < indices.length; index += 1) {
      const value = indices[index];
      if (value - current[current.length - 1] <= maxGap) {
        current.push(value);
      } else {
        if (current.length > best.length) best = current;
        current = [value];
      }
    }
    if (current.length > best.length) best = current;
    return best;
  }

  function findOverlapRuns(routes, options) {
    const config = normalizeOptions(options);
    const routeList = Array.isArray(routes) ? routes : [];
    const samplesByRoute = new Map();
    const cellMap = new Map();

    for (const route of routeList) {
      if (!route || !route.id) continue;
      const samples = densify(route.points, route.coords, config.sampleStep);
      if (samples.length < 2) continue;
      samplesByRoute.set(route.id, samples);
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        const cx = Math.floor(sample.x / config.cellSize);
        const cy = Math.floor(sample.y / config.cellSize);
        // 自己的格子记录采样点；3×3 邻域只记录路线 ID。
        // 两条路线的采样点落在相邻格子时也算重合，避免重合段被逐格拆碎；
        // 邻域不重复保存采样点，控制内存与耗时。
        let own = cellMap.get(cellKey(cx, cy));
        if (!own) {
          own = { cx, cy, routes: new Set(), samples: new Map() };
          cellMap.set(cellKey(cx, cy), own);
        }
        own.routes.add(route.id);
        let ownIndexes = own.samples.get(route.id);
        if (!ownIndexes) {
          ownIndexes = [];
          own.samples.set(route.id, ownIndexes);
        }
        ownIndexes.push(index);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            const key = cellKey(nx, ny);
            let cell = cellMap.get(key);
            if (!cell) {
              cell = { cx: nx, cy: ny, routes: new Set(), samples: new Map() };
              cellMap.set(key, cell);
            }
            cell.routes.add(route.id);
          }
        }
      }
    }

    const groupsBySet = new Map();
    for (const [key, cell] of cellMap) {
      if (cell.routes.size < 2) continue;
      const setKey = [...cell.routes].sort().join('|');
      let group = groupsBySet.get(setKey);
      if (!group) {
        group = new Map();
        groupsBySet.set(setKey, group);
      }
      group.set(key, cell);
    }

    const runs = [];
    for (const [setKey, cells] of groupsBySet) {
      const participants = setKey.split('|');
      for (const component of componentsFor(cells)) {
        const samplesByParticipant = new Map();
        for (const cell of component) {
          for (const [routeId, indexes] of cell.samples) {
            let set = samplesByParticipant.get(routeId);
            if (!set) {
              set = new Set();
              samplesByParticipant.set(routeId, set);
            }
            for (const index of indexes) set.add(index);
          }
        }
        let backbone = null;
        let backboneCount = -1;
        for (const routeId of participants) {
          const count = (samplesByParticipant.get(routeId) || new Set()).size;
          if (count > backboneCount || (count === backboneCount && String(routeId) < String(backbone))) {
            backbone = routeId;
            backboneCount = count;
          }
        }
        if (!backbone || backboneCount < 2) continue;
        const samples = samplesByRoute.get(backbone);
        if (!samples) continue;
        const indexes = [...(samplesByParticipant.get(backbone) || new Set())].sort((a, b) => a - b);
        const consecutive = longestConsecutive(indexes, 3);
        if (consecutive.length < 2) continue;
        const first = samples[consecutive[0]];
        const last = samples[consecutive[consecutive.length - 1]];
        const lengthPx = last.order - first.order;
        if (lengthPx < config.minRunPx) continue;
        runs.push({
          id: `${setKey}#${Math.round(first.order)}-${Math.round(last.order)}`,
          participants: participants.slice(),
          backbone,
          points: consecutive.map((index) => [samples[index].x, samples[index].y]),
          coords: consecutive.map((index) => [samples[index].lon, samples[index].lat]),
          lengthPx,
        });
      }
    }

    runs.sort((a, b) => b.lengthPx - a.lengthPx);
    return runs;
  }

  function cycleDash(cycle, count, index, overlap, phase) {
    const length = Math.max(1, numberOr(cycle, 10));
    const total = Math.max(2, Math.floor(numberOr(count, 2)));
    const slot = Math.max(0, Math.min(total - 1, Math.floor(numberOr(index, 0))));
    const extra = Math.min(length * 0.4, Math.max(0, numberOr(overlap, 0)));
    const period = total * length;
    const start = slot * length;
    // phase：让不同重合区段从不同颜色开始，避免所有区段都由第一种颜色开头
    let offset = (numberOr(phase, 0) - start) % period;
    if (offset < 0) offset += period;
    return {
      dashArray: `${length + extra} ${Math.max(1, (total - 1) * length - extra)}`,
      dashOffset: offset,
      overlap: extra,
    };
  }

  function slotAtDistance(along, count, cycle, overlap, phase) {
    const total = Math.max(2, Math.floor(numberOr(count, 2)));
    const length = Math.max(1, numberOr(cycle, 10));
    const extra = Math.min(length * 0.4, Math.max(0, numberOr(overlap, 0)));
    const period = total * length;
    const shifted = numberOr(along, 0) + numberOr(phase, 0);
    let phaseInCycle = ((shifted % period) + period) % period;
    let index = Math.min(total - 1, Math.floor(phaseInCycle / length));
    if (shifted >= period && phaseInCycle < extra) index = total - 1;
    return index;
  }

  // 视觉覆盖检测：按绘制顺序，为“最表层”的路线生成彩带区段。
  // 只要另一条路线在 radius 像素内，就认为会被覆盖；这样不会因为中心线
  // 只差几像素、或参与者集合局部变化而把重合段拆碎。
  function findCoverageRuns(routes, options) {
    const config = normalizeOptions(options);
    const radius = Math.max(1, numberOr((options || {}).radius, 4));
    const list = (Array.isArray(routes) ? routes : []).filter((route) => route && route.id);
    const samplesByRoute = new Map();
    const grid = new Map();
    const drawIndex = new Map();
    const cellSize = Math.max(4, Math.ceil(radius));

    list.forEach((route, index) => {
      drawIndex.set(route.id, index);
      const samples = densify(route.points, route.coords, config.sampleStep);
      if (samples.length < 2) return;
      samplesByRoute.set(route.id, samples);
      for (const sample of samples) {
        const key = cellKey(Math.floor(sample.x / cellSize), Math.floor(sample.y / cellSize));
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push({ x: sample.x, y: sample.y, id: route.id });
      }
    });

    const maxGapSamples = 2;
    const runs = [];
    for (const route of list) {
      const samples = samplesByRoute.get(route.id);
      if (!samples) continue;
      const nearbySets = samples.map((sample) => {
        const nearby = new Set();
        const cx = Math.floor(sample.x / cellSize);
        const cy = Math.floor(sample.y / cellSize);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (const other of grid.get(cellKey(cx + dx, cy + dy)) || []) {
              if (other.id === route.id) continue;
              if (Math.hypot(sample.x - other.x, sample.y - other.y) <= radius) {
                nearby.add(other.id);
              }
            }
          }
        }
        return nearby;
      });
      // 每个采样点单独判断“谁在最表层”。不能对整个区段取参与者并集：
      // 某条后画的路线只在很短一段靠近，也会让整段被跳过。
      const topIds = nearbySets.map((nearby) => {
        let top = route.id;
        for (const id of nearby) {
          if ((drawIndex.get(id) ?? -1) > (drawIndex.get(top) ?? -1)) top = id;
        }
        return top;
      });
      // 后画路线只在很短一段靠近时，不要让它“抢走”整段；
      // 短于最小可见长度的支配段仍由当前路线绘制，避免留下空隙。
      const minDominance = Math.max(2, Math.ceil(config.minRunPx / config.sampleStep));
      for (let start = 0; start < topIds.length;) {
        let end = start;
        while (end + 1 < topIds.length && topIds[end + 1] === topIds[start]) end += 1;
        if (end - start + 1 < minDominance && topIds[start] !== route.id) {
          for (let index = start; index <= end; index += 1) topIds[index] = route.id;
        }
        start = end + 1;
      }

      let current = null;
      let lastIndex = -1;
      const flush = () => {
        if (!current || current.samples.length < 2) {
          current = null;
          return;
        }
        const first = current.samples[0];
        const last = current.samples[current.samples.length - 1];
        const lengthPx = last.order - first.order;
        if (lengthPx >= config.minRunPx) {
          runs.push({
            id: `${route.id}#${Math.round(first.order)}-${Math.round(last.order)}`,
            participants: [...current.participants].sort(),
            backbone: route.id,
            points: current.samples.map((sample) => [sample.x, sample.y]),
            coords: current.samples.map((sample) => [sample.lon, sample.lat]),
            lengthPx,
          });
        }
        current = null;
      };

      for (let index = 0; index < samples.length; index += 1) {
        const nearby = nearbySets[index];
        // 只画当前路线是最表层的位置；其它位置交给真正最表层的路线
        const drawable = nearby.size > 0 && topIds[index] === route.id;
        if (!drawable) {
          if (current && index - lastIndex > maxGapSamples) flush();
          continue;
        }
        if (current && index - lastIndex > maxGapSamples) flush();
        if (!current) current = { samples: [], participants: new Set([route.id]) };
        current.samples.push(samples[index]);
        lastIndex = index;
        for (const id of nearby) current.participants.add(id);
      }
      flush();
    }

    runs.sort((a, b) => b.lengthPx - a.lengthPx);
    return runs;
  }

  function closestOnPolyline(points, target) {
    let best = { distance: Infinity, along: 0 };
    let cumulative = 0;
    for (let index = 1; index < points.length; index += 1) {
      const [x0, y0] = points[index - 1];
      const [x1, y1] = points[index];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const length = Math.hypot(dx, dy);
      const length2 = dx * dx + dy * dy;
      let t = length2 ? ((target.x - x0) * dx + (target.y - y0) * dy) / length2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = x0 + dx * t;
      const py = y0 + dy * t;
      const distance = Math.hypot(target.x - px, target.y - py);
      if (distance < best.distance) {
        best = { distance, along: cumulative + length * t };
      }
      cumulative += length;
    }
    return best;
  }

  return {
    findOverlapRuns,
    findCoverageRuns,
    densify,
    normalizeOptions,
    cycleDash,
    slotAtDistance,
    closestOnPolyline,
  };
});
