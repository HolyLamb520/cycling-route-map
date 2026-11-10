/* 骑行路线图 · 交互预览与 SVG/PNG 导出 */
import {
  daySummary, escapeHtml, fmt, formatNumber, shortPlace, slugify, splitPlaceName,
} from './js/format.js';
import { lodBucket, sampleRoute } from './js/lod.js';
import { modeLabel, providerLabel, qaColor, qaLabel } from './js/qa.js';
import { drawProfile as drawProfileChart } from './js/profile.js';
import { renderMapSVG, renderMinimalMapSVG } from './js/export.js';

(() => {
  'use strict';

  // ------------------------------------------------------------------ 常量
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const DATE = new Date();
  const TODAY = `${DATE.getFullYear()}-${String(DATE.getMonth() + 1).padStart(2, '0')}-${String(DATE.getDate()).padStart(2, '0')}`;
  const STORAGE_PREFIX = 'svg-routegen:selection:v2:';
  const DISPLAY_PREFIX = 'svg-routegen:display:v1:';
  // 兼容旧页面缓存：即使 palette.js 未加载，基础地图也不应因此中断
  const Overlap = window.RouteOverlap || {
    findOverlapRuns: () => [],
    cycleDash: () => ({ dashArray: '', dashOffset: 0 }),
    slotAtDistance: () => 0,
    closestOnPolyline: () => ({ along: 0 }),
  };
  const Palette = window.RoutePalette || {
    OTHER: '未标注',
    COLOR_BY: ['default', 'year', 'team'],
    SCHEMES: ['contrast', 'family'],
    yearOf(trip) {
      if (trip && trip.year !== null && trip.year !== undefined && trip.year !== '') {
        const year = Number(trip.year);
        if (Number.isInteger(year)) return year;
      }
      const match = /^(\d{4})/.exec(String((trip && trip.name) || ''));
      return match ? Number(match[1]) : null;
    },
    tripGroupKey() { return 'default'; },
    buildTripColors() { return null; },
  };

  const state = {
    meta: null,
    style: null,
    routes: null,
    boundaries: null,
    routeById: new Map(),
    tripById: new Map(),
    // 地图显示设置：线宽、模式线型、配色、重合路径彩带
    display: {
      lineWidth: null,
      showModeStyles: true,
      colorBy: 'default',
      scheme: 'contrast',
      overlapBands: true,
      overlapCycle: 10,
    },
    palette: null,
    overlapRenderer: null,
    overlapLayer: null,
    overlapLayers: [],
    overlapHitRenderer: null,
    overlapHitLayer: null,
    overlapTipTimer: null,
    loadedYears: new Set(),
    yearPromises: new Map(),
    selection: new Set(),
    map: null,
    tileLayer: null,
    boundaryLayer: null,
    routeLayer: null,
    routeLineLayers: new Map(),
    basemapKey: null,
    hoveredId: null,
    fitted: false,
    showDayNumbers: true,
    collapsedTrips: new Set(),
    boundaryMode: 'local',
    boundariesNation: null,
    boundariesNationCities: null,
    boundaryPromises: {},
    filters: { year: '', team: '', query: '', qa: '' },
    qaMode: false,
    lodCache: new Map(),
    viewCache: new Map(),
    viewCacheBucket: null,
    viewCacheCrs: null,
    lodBucket: null,
    routeRenderer: null,
    hoverRenderer: null,
    hoverLayer: null,
    profiles: null,
    profilePromise: null,
    activeRouteId: null,
    years: [],
    dataBase: 'data',
    sourceManifest: null,
    sourceEntry: null,
  };

  // ------------------------------------------------------------------ 启动
  // 首页可构建多个数据源：web/data/sources.json 由 `run.py build --all-sources` 生成。
  // 每个源的数据在 web/data/<id>/；没有清单时退回旧的单源 web/data/。
  async function loadSourceManifest() {
    try {
      const response = await fetch('data/sources.json', { cache: 'no-store' });
      if (!response.ok) return null;
      const manifest = await response.json();
      return Array.isArray(manifest.sources) ? manifest : null;
    } catch (error) {
      return null;
    }
  }

  function pickSource(manifest) {
    return window.SourcePicker.pickSource(manifest, window.location.search);
  }

  function renderSourceSwitcher() {
    const wrap = $('#source-switch-wrap');
    const select = $('#source-switch');
    const mapWrap = $('#map-source-setting');
    const mapSelect = $('#map-source-switch');
    const manifest = state.sourceManifest;
    const current = state.sourceEntry;
    const multiple = Boolean(manifest && manifest.sources.length >= 2);
    if (wrap) wrap.hidden = !multiple;
    if (mapWrap) mapWrap.hidden = !multiple;
    if (!multiple) return;

    const options = window.SourcePicker.options(manifest);
    for (const node of [select, mapSelect]) {
      if (!node) continue;
      node.innerHTML = '';
      for (const item of options) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label;
        option.disabled = item.disabled;
        node.appendChild(option);
      }
      node.value = current ? current.id : (manifest.default || '');
      if (!node.dataset.bound) {
        node.dataset.bound = '1';
        node.addEventListener('change', () => {
          // 整页重载，避免上一个源已加载的年份、边界与选择状态残留
          const url = new URL(window.location.href);
          url.searchParams.set('source', node.value);
          window.location.href = url.toString();
        });
      }
    }
  }

  function loadRoutesData() {
    const base = state.dataBase || 'data';
    if (!window.Worker) return fetchJSON(`${base}/routes.geojson`);
    return new Promise((resolve, reject) => {
      const worker = new Worker('routes-worker.js');
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error('route worker timeout'));
      }, 60000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        worker.terminate();
        if (event.data?.ok) resolve(event.data.data);
        else reject(new Error(event.data?.error || 'route worker failed'));
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message || 'route worker failed'));
      };
      worker.postMessage({ path: `${base}/routes.geojson` });
    }).catch(() => fetchJSON(`${base}/routes.geojson`));
  }

  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    try {
      state.showDayNumbers = readShowDayNumbers();
      state.collapsedTrips = readCollapsedTrips();
      if (typeof L === 'undefined') {
        throw new Error('Leaflet 未加载，请确认 web/vendor/leaflet/leaflet.js 存在。');
      }
      state.sourceManifest = await loadSourceManifest();
      state.sourceEntry = pickSource(state.sourceManifest);
      state.dataBase = state.sourceEntry?.dir || 'data';
      const dataBase = state.dataBase;
      const [meta, boundaries, style] = await Promise.all([
        fetchJSON(`${dataBase}/meta.json`),
        fetchJSON(`${dataBase}/boundaries.geojson`),
        fetchJSON(`${dataBase}/style.json`),
      ]);
      state.meta = meta;
      state.boundaries = boundaries;
      state.style = style;
      state.tripById = new Map((meta.trips || []).map((trip) => [trip.id, trip]));
      readDisplaySettings();
      rebuildTripColors();
      try {
        if (localStorage.getItem('svg-routegen:collapsed-trips:v2') === null) {
          state.collapsedTrips = new Set((meta.trips || []).map((trip) => trip.id));
        }
      } catch (error) {
        state.collapsedTrips = new Set((meta.trips || []).map((trip) => trip.id));
      }
      restoreSelection();
      if (meta.files?.routes_by_year) {
        // 新构建：只加载当前选中年份的路线文件；其余按需加载。
        await ensureSelectionLoaded();
      } else {
        // 兼容旧构建：退回一次性加载完整 routes.geojson。
        const routes = await loadRoutesData();
        for (const feature of routes.features || []) state.routeById.set(feature.properties.id, feature);
      }
      prepareRouteBounds([...state.routeById.values()]);

      const files = meta.files || {};
      const nationOption = document.querySelector('#boundary-mode option[value="nation"]');
      const nationCitiesOption = document.querySelector('#boundary-mode option[value="nation_cities"]');
      if (!files.boundaries_nation && nationOption) {
        nationOption.disabled = true;
        nationOption.textContent = '全国（省界，未生成）';
      }
      if (!files.boundaries_nation_cities && nationCitiesOption) {
        nationCitiesOption.disabled = true;
        nationCitiesOption.textContent = '全国（市界，未生成）';
      }
      state.boundaryMode = readBoundaryMode();
      if (!boundaryModeAvailable(state.boundaryMode, files)) {
        state.boundaryMode = 'local';
      } else if (state.boundaryMode !== 'local' && state.boundaryMode !== 'none') {
        if (!(await ensureNationBoundaries(state.boundaryMode))) {
          state.boundaryMode = 'local';
          toast('全国行政区划暂不可用，已使用“仅经过市”');
        }
      }
      const boundarySelect = $('#boundary-mode');
      if (boundarySelect) boundarySelect.value = state.boundaryMode;

      applyStaticText();
      renderSourceSwitcher();
      renderTripList();
      initMap();
      bindControls();
      refreshAll({ first: true });
      hideMapMessage();
    } catch (error) {
      console.error(error);
      showMapMessage(`加载失败：${error.message}`, true);
    }
  }

  async function fetchJSON(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path}（HTTP ${response.status}）`);
    return response.json();
  }

  // ------------------------------------------------------------------ 文本
  function applyStaticText() {
    const { meta } = state;
    document.title = meta.project.title || '骑行路线图';
    $('#project-title').textContent = meta.project.title || '骑行路线图';
    $('#project-subtitle').textContent = meta.project.subtitle || '';
    $('#attribution').textContent = meta.project.attribution || '';
    $('#source-note').textContent = meta.source ? `数据源：${meta.source.id} · ${meta.source.path}` : '';
    const totalDays = (meta.trips || []).reduce((sum, trip) => sum + (trip.days?.length || 0), 0);
    const summary = $('#route-summary');
    if (summary) summary.textContent = `${(meta.trips || []).length} 组 · ${totalDays} 天`;
    const selectable = availableIds();
    $('#project-note').textContent = `${meta.trips.length} 条行程 · ${selectable.length} 个可显示日子 · 点击日期可定位`;
    renderWarnings();
    renderBasemapOptions();
    populateYearFilter();
    populateTimeline();
    renderYearLegend();
    renderTeamLegend();
  }

  function renderBasemapOptions() {
    const select = $('#basemap');
    const providers = state.meta.basemap?.providers || {};
    select.innerHTML = '';
    for (const [key, provider] of Object.entries(providers)) {
      const option = document.createElement('option');
      option.value = key;
      const unavailable = provider.available === false;
      option.disabled = unavailable;
      option.textContent = `${provider.name || key}${unavailable ? '（未配置 key）' : ''}`;
      select.appendChild(option);
    }
    const fallback = state.meta.basemap?.default;
    select.value = providers[fallback] ? fallback : Object.keys(providers)[0] || '';
  }

  function renderWarnings() {
    const warnings = [...(state.meta.warnings || []), ...(state.meta.missing || [])];
    const unique = [...new Set(warnings)];
    const box = $('#warnings');
    if (!unique.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = '<strong>提示</strong><ul></ul>';
    const list = box.querySelector('ul');
    for (const warning of unique) {
      const item = document.createElement('li');
      item.textContent = warning;
      list.appendChild(item);
    }
  }

  function showMapMessage(text, isError = false) {
    const element = $('#map-message');
    element.textContent = text;
    element.classList.remove('hidden');
    element.classList.toggle('error', isError);
  }

  function hideMapMessage() {
    $('#map-message').classList.add('hidden');
  }

  let toastTimer = null;
  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 2600);
  }

  // ------------------------------------------------------------------ 选择
  function dayId(trip, day) {
    return `${trip.id}/day-${String(day.day).padStart(2, '0')}`;
  }

  function availableIds() {
    return (state.meta?.trips || []).flatMap((trip) =>
      (trip.days || [])
        .filter((day) => day.has_gpx)
        .map((day) => dayId(trip, day))
    );
  }

  function tripForRouteId(id) {
    const cut = String(id).indexOf('/day-');
    return state.tripById.get(cut >= 0 ? String(id).slice(0, cut) : String(id)) || null;
  }

  function routeYearKey(id) {
    const trip = tripForRouteId(id);
    const year = trip ? tripYear(trip) : null;
    return year ? String(year) : 'other';
  }

  async function ensureYearsLoaded(years) {
    const files = state.meta?.files?.routes_by_year;
    if (!files) return;
    const pending = [];
    for (const year of new Set(years)) {
      if (!year || state.loadedYears.has(year) || !files[year]) continue;
      if (state.yearPromises.has(year)) {
        pending.push(state.yearPromises.get(year));
        continue;
      }
      const promise = fetchJSON(files[year])
        .then((collection) => {
          const features = collection?.features || [];
          for (const feature of features) state.routeById.set(feature.properties.id, feature);
          prepareRouteBounds(features);
          state.loadedYears.add(year);
        })
        .finally(() => state.yearPromises.delete(year));
      state.yearPromises.set(year, promise);
      pending.push(promise);
    }
    await Promise.all(pending);
  }

  async function ensureSelectionLoaded() {
    if (!state.meta?.files?.routes_by_year) return;
    await ensureYearsLoaded([...state.selection].map(routeYearKey));
  }

  function storageKey() {
    const title = state.meta?.project?.title || 'default';
    const source = state.meta?.source?.id || '';
    return `${STORAGE_PREFIX}${title}:${source}`;
  }

  function tripYear(tripOrName) {
    if (tripOrName && typeof tripOrName === 'object') {
      if (Number.isInteger(tripOrName.year)) return tripOrName.year;
      return tripYear(tripOrName.name);
    }
    const year = String(tripOrName || '').slice(0, 4);
    return /^\d{4}$/.test(year) ? Number(year) : null;
  }

  function latestYear() {
    const years = (state.meta?.trips || []).map((trip) => tripYear(trip)).filter(Boolean);
    return years.length ? Math.max(...years) : null;
  }

  function defaultSelection() {
    const latest = latestYear();
    if (!latest) return new Set();
    return new Set(
      (state.meta?.trips || [])
        .filter((trip) => tripYear(trip) === latest)
        .flatMap((trip) =>
          (trip.days || [])
            .filter((day) => day.has_gpx)
            .map((day) => dayId(trip, day))
        )
    );
  }

  function restoreSelection() {
    const available = new Set(availableIds());
    let stored = null;
    try {
      stored = localStorage.getItem(storageKey());
    } catch (error) {
      stored = null;
    }
    if (stored === null) {
      state.selection = defaultSelection();
      return;
    }
    try {
      const parsed = JSON.parse(stored);
      state.selection = new Set(Array.isArray(parsed) ? parsed.filter((id) => available.has(id)) : [...defaultSelection()]);
    } catch (error) {
      state.selection = defaultSelection();
    }
  }

  function saveSelection() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify([...state.selection]));
    } catch (error) {
      /* 忽略隐私模式下的存储错误 */
    }
  }

  function selectedFeatures() {
    return [...state.selection]
      .map((id) => state.routeById.get(id))
      .filter(Boolean);
  }

  // ------------------------------------------------------------------ 显示设置
  function displayStorageKey() {
    const title = state.meta?.project?.title || 'default';
    const source = state.meta?.source?.id || '';
    return `${DISPLAY_PREFIX}${title}:${source}`;
  }

  function readDisplaySettings() {
    const fallbackWidth = Number(state.style?.route_width) || 3;
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(displayStorageKey()) || 'null');
    } catch (error) {
      stored = null;
    }
    const data = stored && typeof stored === 'object' ? stored : {};
    const width = Number(data.lineWidth);
    state.display.lineWidth = Number.isFinite(width) ? Math.min(20, Math.max(1, width)) : fallbackWidth;
    state.display.showModeStyles = data.showModeStyles !== false;
    state.display.colorBy = Palette.COLOR_BY.includes(data.colorBy) ? data.colorBy : 'default';
    state.display.scheme = Palette.SCHEMES.includes(data.scheme) ? data.scheme : 'contrast';
    state.display.overlapBands = data.overlapBands !== false;
    const cycle = Number(data.overlapCycle);
    state.display.overlapCycle = Number.isFinite(cycle) ? Math.min(30, Math.max(4, cycle)) : 10;
  }

  function saveDisplaySettings() {
    try {
      localStorage.setItem(displayStorageKey(), JSON.stringify(state.display));
    } catch (error) {
      /* 忽略隐私模式存储错误 */
    }
  }

  function lineWidth() {
    const stored = state.display.lineWidth;
    if (stored === null || stored === undefined || stored === '') {
      return Number(state.style?.route_width) || 3;
    }
    const width = Number(stored);
    return Number.isFinite(width) ? width : (Number(state.style?.route_width) || 3);
  }

  function weightFor(props, base = lineWidth()) {
    if (state.qaMode) return base + 1.8;
    if (state.display.showModeStyles && props && props.mode === 'inferred') return Math.max(2, base - 0.5);
    return base;
  }

  function visibleDash(entry) {
    return state.display.showModeStyles ? ((entry && entry.dash) || null) : null;
  }

  function widthLabel(value) {
    const number = Number(value);
    return Number.isInteger(number) ? String(number) : number.toFixed(1);
  }

  function rebuildTripColors() {
    const trips = state.meta?.trips || [];
    if (!trips.length || state.display.colorBy === 'default') {
      state.palette = null;
      return;
    }
    state.palette = Palette.buildTripColors(trips, state.display.colorBy, state.display.scheme);
  }

  function tripDisplayColor(trip) {
    if (!trip) return '#2a78d6';
    if (state.display.colorBy === 'default' || !state.palette) return trip.color || '#2a78d6';
    return state.palette.tripColors.get(trip.id) || trip.color || '#2a78d6';
  }

  function dayDisplayColor(trip, day) {
    if (state.display.colorBy !== 'default') return tripDisplayColor(trip);
    return (day && day.color) || tripDisplayColor(trip);
  }

  function featureDisplayColor(feature) {
    const props = (feature && feature.properties) || feature || {};
    const trip = state.tripById.get(props.trip_id);
    if (state.display.colorBy !== 'default' && trip) return tripDisplayColor(trip);
    return props.color || (trip && trip.color) || '#2a78d6';
  }

  function yearDisplayColor(year) {
    if (state.display.colorBy === 'year' && state.palette) {
      return state.palette.groupColors.get(String(year)) || '#77705f';
    }
    // 按团别配色时，年份筛选按钮不再暗示某一年的颜色
    if (state.display.colorBy === 'team') return '#77705f';
    const trip = (state.meta?.trips || []).find((item) => String(Palette.yearOf(item)) === String(year));
    return trip ? tripDisplayColor(trip) : '#77705f';
  }

  // 预计算每条路线的 WGS-84 包围盒：缩放/平移时只绘制视口内的路线。
  function prepareRouteBounds(features) {
    for (const feature of features) {
      const coords = feature.geometry?.coordinates || [];
      let minLon = Infinity;
      let minLat = Infinity;
      let maxLon = -Infinity;
      let maxLat = -Infinity;
      for (let i = 0; i < coords.length; i += 1) {
        const lon = coords[i][0];
        const lat = coords[i][1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      if (Number.isFinite(minLon)) {
        feature.properties.bbox = [minLon, minLat, maxLon, maxLat];
      }
    }
  }

  function viewportWgsBounds(pad = 0.12) {
    if (!state.map) return null;
    const bounds = state.map.getBounds().pad(pad);
    if (activeProvider().crs !== 'gcj02') {
      return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    }
    // GCJ-02 底图：把视口四角反算回 WGS-84，避免近似变换造成边缘漏画。
    const corners = [
      [bounds.getWest(), bounds.getSouth()],
      [bounds.getEast(), bounds.getSouth()],
      [bounds.getEast(), bounds.getNorth()],
      [bounds.getWest(), bounds.getNorth()],
    ].map(([lon, lat]) => gcjToWgs(lon, lat));
    return [
      Math.min(...corners.map((point) => point[0])),
      Math.min(...corners.map((point) => point[1])),
      Math.max(...corners.map((point) => point[0])),
      Math.max(...corners.map((point) => point[1])),
    ];
  }

  function featureInBounds(feature, view) {
    const bbox = feature.properties.bbox;
    if (!bbox || !view) return true;
    return !(bbox[2] < view[0] || view[2] < bbox[0] || bbox[3] < view[1] || view[3] < bbox[1]);
  }

  // ------------------------------------------------------------------ 侧栏
  function filteredTrips() {
    const trips = state.meta?.trips || [];
    const year = state.filters.year;
    const team = state.filters.team;
    const query = state.filters.query.trim().toLowerCase();
    return trips.filter((trip) => {
      if (year && String(tripYear(trip)) !== String(year)) return false;
      if (team && teamCategory(trip) !== team) return false;
      if (state.filters.qa) {
        const hasFlag = (trip.days || []).some((day) => {
          if (state.filters.qa === 'imported') return Boolean(day.imported);
          return (day.qa_flags || []).includes(state.filters.qa);
        });
        if (!hasFlag) return false;
      }
      if (!query) return true;
      const haystack = [
        trip.name,
        trip.note,
        ...(trip.days || []).flatMap((day) => [day.start, day.end, day.note]),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    }).sort((a, b) => {
      const yearDelta = (tripYear(b) || 0) - (tripYear(a) || 0);
      if (yearDelta) return yearDelta;
      return String(b.name).localeCompare(String(a.name), 'zh');
    });
  }

  function populateYearFilter() {
    const select = $('#year-filter');
    const mapSelect = $('#map-year-filter');
    const mapSetting = $('#map-year-setting');
    const years = [...new Set((state.meta?.trips || []).map((trip) => tripYear(trip)).filter(Boolean))].map(String).sort().reverse();
    state.years = years;
    for (const node of [select, mapSelect]) {
      if (!node) continue;
      node.innerHTML = '<option value="">全部年份</option>';
      for (const year of years) {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = year;
        node.appendChild(option);
      }
    }
    if (mapSetting) mapSetting.hidden = years.length < 2;
    if (mapSelect && !mapSelect.value) {
      // 默认选中最新一年，与 defaultSelection() 实际显示的路线保持一致
      const latest = latestYear();
      if (latest) mapSelect.value = String(latest);
    }
  }

  function populateTimeline() {
    const slider = $('#year-slider');
    const label = $('#timeline-label');
    if (!slider) return;
    slider.min = '0';
    slider.max = String(state.years.length || 0);
    slider.step = '1';
    slider.value = '0';
    if (label) label.textContent = '全部';
  }

  function renderYearLegend() {
    const box = $('#year-legend');
    if (!box) return;
    box.innerHTML = '';
    const trips = state.meta?.trips || [];
    const byYear = new Map();
    for (const trip of trips) {
      const year = tripYear(trip);
      if (year && !byYear.has(year)) byYear.set(year, trip);
    }
    for (const year of state.years) {
      const trip = byYear.get(Number(year));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'year-chip';
      button.style.setProperty('--chip-color', yearDisplayColor(year));
      button.textContent = year;
      button.title = `只看 ${year} 年`;
      button.addEventListener('click', () => applyYearFilter(year, true));
      box.appendChild(button);
    }
  }

  const INDEPENDENT_TEAM_HINTS = ['独立', '私约', '远征'];

  // 把 72 组历史行程粗分成“常规暑期”和“独立团”两类。
  // 独立团：名称/团别里明确带“独立”“私约”“远征”的行程；其余归常规暑期。
  function teamCategory(item) {
    const value = item && item.properties ? item.properties : (item || {});
    if (!value.team_type && value.trip_id) {
      const trip = (state.meta?.trips || []).find((candidate) => candidate.id === value.trip_id);
      if (trip) return teamCategory(trip);
    }
    const text = [value.team_type, value.name, value.trip_name].filter(Boolean).join(' ');
    return INDEPENDENT_TEAM_HINTS.some((hint) => text.includes(hint)) ? 'independent' : 'regular';
  }

  function teamCategoryLabel(category) {
    return category === 'independent' ? '独立团' : '常规暑期';
  }

  function renderTeamLegend() {
    const box = $('#team-legend');
    if (!box) return;
    const trips = state.meta?.trips || [];
    let regular = 0;
    let independent = 0;
    for (const trip of trips) {
      if (teamCategory(trip) === 'independent') independent += 1;
      else regular += 1;
    }
    const options = [
      { value: '', label: '全部', count: trips.length },
      { value: 'regular', label: '常规暑期', count: regular },
      { value: 'independent', label: '独立团', count: independent },
    ];
    box.innerHTML = '';
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'team-chip' + (state.filters.team === option.value ? ' active' : '');
      button.textContent = `${option.label} ${option.count}`;
      button.setAttribute('aria-pressed', String(state.filters.team === option.value));
      button.addEventListener('click', () => applyTeamFilter(option.value));
      box.appendChild(button);
    }
  }

  function applyTeamFilter(team) {
    // 团别标签只过滤左侧列表；不自动选中全部年份，避免点一下标签就加载 30MB 路线。
    state.filters.team = state.filters.team === team ? '' : team;
    renderTeamLegend();
    renderTripList();
  }

  function applyYearFilter(year, selectRoutes = false) {
    state.filters.year = year || '';
    const select = $('#year-filter');
    if (select && select.value !== state.filters.year) select.value = state.filters.year;
    const mapSelect = $('#map-year-filter');
    if (mapSelect && mapSelect.value !== state.filters.year) mapSelect.value = state.filters.year;
    const slider = $('#year-slider');
    if (slider) {
      const index = state.filters.year ? state.years.indexOf(state.filters.year) + 1 : 0;
      slider.value = String(index);
    }
    const label = $('#timeline-label');
    if (label) label.textContent = state.filters.year || '全部';
    renderTripList();
    if (selectRoutes) {
      const trips = (state.meta?.trips || []).filter((trip) => {
        if (state.filters.team && teamCategory(trip) !== state.filters.team) return false;
        return !state.filters.year || String(tripYear(trip)) === String(state.filters.year);
      });
      state.selection = new Set(
        trips.flatMap((trip) =>
          (trip.days || []).filter((day) => day.has_gpx).map((day) => dayId(trip, day))
        )
      );
      afterSelectionChange().then(() => fitSelected(true));
    }
  }

  function renderTripList() {
    const list = $('#trip-list');
    list.innerHTML = '';
    const trips = filteredTrips();
    const totalDays = trips.reduce((sum, trip) => sum + trip.days.length, 0);
    const summary = $('#route-summary');
    if (summary) {
      const allTrips = state.meta?.trips || [];
      summary.textContent = state.filters.year || state.filters.team || state.filters.query || state.filters.qa
        ? `${trips.length}/${allTrips.length} 组 · ${totalDays} 天`
        : `${allTrips.length} 组 · ${totalDays} 天`;
    }
    if (!trips.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-row';
      empty.textContent = '没有匹配的路线';
      list.appendChild(empty);
      updateCollapseAllButton();
      return;
    }
    trips.forEach((trip) => {
      const section = document.createElement('section');
      section.className = 'trip';
      section.dataset.tripId = trip.id;
      section.style.setProperty('--trip-color', tripDisplayColor(trip));

      const head = document.createElement('div');
      head.className = 'trip-head';

      const tripCheckbox = document.createElement('input');
      tripCheckbox.type = 'checkbox';
      tripCheckbox.dataset.tripCheckbox = trip.id;
      tripCheckbox.setAttribute('aria-label', `选择 ${trip.name} 的全部日期`);
      const available = trip.days.filter((day) => day.has_gpx).map((day) => dayId(trip, day));
      tripCheckbox.disabled = available.length === 0;
      tripCheckbox.addEventListener('change', () => {
        for (const id of available) {
          if (tripCheckbox.checked) state.selection.add(id);
          else state.selection.delete(id);
        }
        afterSelectionChange();
      });
      head.appendChild(tripCheckbox);

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.innerHTML = swatchSVG(tripDisplayColor(trip), null, 28, 11);
      head.appendChild(swatch);

      const name = document.createElement('span');
      name.className = 'trip-name';
      name.textContent = trip.name;
      name.title = trip.name;
      head.appendChild(name);

      const meta = document.createElement('span');
      meta.className = 'trip-meta';
      const days = trip.days.filter((day) => day.has_gpx);
      const km = days.reduce((sum, day) => sum + (Number(day.distance_km) || 0), 0);
      meta.textContent = `${days.length} 天 · ${formatNumber(Math.round(km))} km`;
      head.appendChild(meta);
      section.appendChild(head);

      if (trip.note) {
        const note = document.createElement('p');
        note.className = 'trip-note';
        note.textContent = trip.note;
        section.appendChild(note);
      }

      const daysWrap = document.createElement('div');
      daysWrap.className = 'trip-days';
      daysWrap.id = `trip-days-${trip.id}`;
      if (state.collapsedTrips.has(trip.id)) daysWrap.hidden = true;
      section.appendChild(daysWrap);
      const collapsed = state.collapsedTrips.has(trip.id);

      if (!collapsed) trip.days.forEach((day) => {
        const id = dayId(trip, day);
        const row = document.createElement('div');
        row.className = 'day' + (day.has_gpx ? '' : ' is-missing');
        row.dataset.routeId = id;
        row.title = `${day.start} → ${day.end}${day.note ? `\n${day.note}` : ''}`;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.disabled = !day.has_gpx;
        checkbox.dataset.dayCheckbox = id;
        checkbox.setAttribute('aria-label', `${trip.name} 第 ${day.day} 天`);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.selection.add(id);
          else state.selection.delete(id);
          afterSelectionChange();
        });
        row.appendChild(checkbox);

        const line = document.createElement('span');
        line.className = 'swatch';
        line.innerHTML = swatchSVG(dayDisplayColor(trip, day), visibleDash(day), 28, 11);
        row.appendChild(line);

        const main = document.createElement('div');
        main.className = 'day-main';

        const title = document.createElement('div');
        title.className = 'day-title';
        title.textContent = `${day.label} ${shortPlace(day.start)} → ${shortPlace(day.end)}`;
        main.appendChild(title);

        const sub = document.createElement('div');
        sub.className = 'day-sub';
        const numbers = document.createElement('span');
        numbers.className = 'numbers';
        if (day.has_gpx) {
          const pieces = [];
          if (day.distance_km !== null && day.distance_km !== undefined) pieces.push(`${formatNumber(Math.round(day.distance_km))} km`);
          if (day.ascent_m !== null && day.ascent_m !== undefined) pieces.push(`爬升 ${formatNumber(Math.round(day.ascent_m))} m`);
          numbers.textContent = pieces.join(' · ');
        } else {
          numbers.textContent = 'GPX 未生成';
        }
        sub.appendChild(numbers);
        const places = document.createElement('span');
        places.className = 'places';
        places.textContent = day.note || providerLabel(day.provider);
        places.title = day.note || '';
        sub.appendChild(places);
        if (day.imported) {
          const badge = document.createElement('span');
          badge.className = 'import-badge';
          badge.textContent = day.import_kind === 'fit' ? 'FIT 导入' : 'GPX 导入';
          badge.title = `用户导入${day.import_source ? `：${day.import_source}` : ''}`;
          sub.appendChild(badge);
        }
        if (day.edited) {
          const badge = document.createElement('span');
          badge.className = 'import-badge edit-badge';
          badge.textContent = '已修正';
          badge.title = `GPX 几何已手动修正${day.edit_source ? `：${day.edit_source}` : ''}`;
          sub.appendChild(badge);
        }
        if ((day.qa_flags || []).length) {
          const badge = document.createElement('span');
          badge.className = 'qa-badge';
          badge.textContent = 'QA';
          badge.title = (day.qa_flags || []).map(qaLabel).join(' / ');
          sub.appendChild(badge);
        }
        main.appendChild(sub);
        row.appendChild(main);

        if (day.has_gpx) {
          row.addEventListener('click', async (event) => {
            if (event.target === checkbox) return;
            try {
              await ensureYearsLoaded([routeYearKey(id)]);
            } catch (error) {
              console.error(error);
            }
            showRouteCard(id);
            focusRoute(id);
          });
          row.addEventListener('mouseenter', () => highlightRoute(id, true));
          row.addEventListener('mouseleave', () => highlightRoute(id, false));
        }
        daysWrap.appendChild(row);
      });

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'trip-toggle';
      toggle.title = collapsed ? '展开每天行程' : '折叠每天行程';
      toggle.setAttribute('aria-label', collapsed ? '展开每天行程' : '折叠每天行程');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-controls', daysWrap.id);
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const isCollapsed = !state.collapsedTrips.has(trip.id);
        if (isCollapsed) state.collapsedTrips.add(trip.id);
        else state.collapsedTrips.delete(trip.id);
        saveCollapsedTrips();
        const sidebar = $('#sidebar');
        const scroll = sidebar ? sidebar.scrollTop : 0;
        renderTripList();
        if (sidebar) sidebar.scrollTop = scroll;
      });
      head.appendChild(toggle);

      list.appendChild(section);
    });
    syncCheckboxUI();
    updateCollapseAllButton();
  }

  function updateCollapseAllButton() {
    const trips = filteredTrips();
    const allCollapsed = trips.length > 0 && trips.every((trip) => state.collapsedTrips.has(trip.id));
    const button = $('#collapse-all');
    if (!button) return;
    button.disabled = trips.length === 0;
    button.textContent = allCollapsed ? '全部展开' : '全部折叠';
    button.setAttribute('aria-pressed', String(allCollapsed));
  }


  function swatchSVG(color, dash, width, height) {
    const dashAttr = dash ? ` stroke-dasharray="${escapeHtml(dash)}"` : '';
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <line x1="1.5" y1="${height / 2}" x2="${width - 1.5}" y2="${height / 2}" stroke="${escapeHtml(color)}" stroke-width="3" stroke-linecap="round"${dashAttr}/>
    </svg>`;
  }

  function syncCheckboxUI() {
    $$('[data-day-checkbox]').forEach((checkbox) => {
      checkbox.checked = state.selection.has(checkbox.dataset.dayCheckbox);
      const row = checkbox.closest('.day');
      if (row) row.classList.toggle('is-selected', checkbox.checked);
    });
    $$('[data-trip-checkbox]').forEach((checkbox) => {
      const trip = state.meta.trips.find((item) => item.id === checkbox.dataset.tripCheckbox);
      const available = trip ? trip.days.filter((day) => day.has_gpx).map((day) => dayId(trip, day)) : [];
      const checked = available.filter((id) => state.selection.has(id)).length;
      checkbox.checked = available.length > 0 && checked === available.length;
      checkbox.indeterminate = checked > 0 && checked < available.length;
    });
  }

  async function afterSelectionChange() {
    saveSelection();
    syncCheckboxUI();
    try {
      await ensureSelectionLoaded();
    } catch (error) {
      console.error(error);
      toast(`路线数据加载失败：${error.message}`);
      return;
    }
    // 当前查看的路线已被取消选择时，关闭路线卡并恢复其它路线的透明度
    if (state.activeRouteId && !state.selection.has(state.activeRouteId)) hideRouteCard();
    rebuildRouteLayers();
    updateStats();
    updateDataTable();
    updateExportState();
    updateProjectNote();
    renderMapLegend();
  }

  function refreshAll({ first = false } = {}) {
    syncCheckboxUI();
    rebuildBoundaryLayer();
    rebuildRouteLayers();
    updateStats();
    updateDataTable();
    updateExportState();
    updateProjectNote();
    renderMapLegend();
    if (first) fitSelected(false);
  }

  function updateProjectNote() {
    const total = availableIds().length;
    const selected = selectedFeatures().length;
    $('#project-note').textContent = `已选 ${selected} / ${total} 天 · 点击日期可定位`;
  }

  function updateStats() {
    const features = selectedFeatures();
    const km = features.reduce((sum, feature) => sum + (Number(feature.properties.distance_km) || 0), 0);
    const up = features.reduce((sum, feature) => sum + (Number(feature.properties.ascent_m) || 0), 0);
    $('#stat-km').textContent = features.length ? formatNumber(Math.round(km)) : '–';
    $('#stat-up').textContent = features.length ? formatNumber(Math.round(up)) : '–';
    $('#stat-days').textContent = features.length ? String(features.length) : '–';
  }

  function updateDataTable() {
    const details = $('#data-table');
    // 数据表默认折叠：上千天时不必在每次选择/缩放后重建几千个单元格。
    if (details && !details.open) return;
    const body = $('#data-table-body');
    body.innerHTML = '';
    const features = selectedFeatures();
    if (!features.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.className = 'empty-row';
      cell.textContent = '尚未选择路线';
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }
    for (const feature of features) {
      const p = feature.properties;
      const row = document.createElement('tr');
      const values = [
        p.label || `D${p.day}`,
        `${shortPlace(p.start)}→${shortPlace(p.end)}`,
        `${formatNumber(Math.round(p.distance_km || 0))} km`,
        `${formatNumber(Math.round(p.ascent_m || 0))} m`,
      ];
      values.forEach((value, index) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (index === 1) cell.title = `${p.start} → ${p.end}`;
        row.appendChild(cell);
      });
      body.appendChild(row);
    }
  }

  function updateExportState() {
    const disabled = state.selection.size === 0;
    const exportSvg = $('#export-svg');
    const exportPng = $('#export-png');
    if (exportSvg) exportSvg.disabled = disabled;
    if (exportPng) exportPng.disabled = disabled;
  }

  // ------------------------------------------------------------------ 地图
  function initMap() {
    const bounds = state.meta.bounds;
    let center = [30.0, 120.3];
    if (bounds && bounds.length === 4) {
      center = [(bounds[1] + bounds[3]) / 2, (bounds[0] + bounds[2]) / 2];
    }
    state.map = L.map('map', {
      zoomControl: true,
      preferCanvas: false,
      minZoom: 4,
      maxZoom: 18,
      zoomSnap: 0,
      zoomDelta: 0.25,
      attributionControl: true,
    }).setView(center, 8);

    state.routeRenderer = L.canvas({ padding: 0.5 });
    if (!state.map.getPane('route-hover')) {
      const pane = state.map.createPane('route-hover');
      pane.style.zIndex = '450';
      // 高亮 canvas 只负责画线，绝不能挡住下层路线的鼠标事件（否则 tooltip 失效）。
      pane.style.pointerEvents = 'none';
    }
    state.hoverRenderer = L.canvas({ padding: 0.5, pane: 'route-hover' });
    // 重合彩带：视觉层用 SVG（支持 dashOffset），命中层负责悬停/点击
    if (!state.map.getPane('route-overlap')) {
      const pane = state.map.createPane('route-overlap');
      pane.style.zIndex = '440';
      pane.style.pointerEvents = 'none';
    }
    state.overlapRenderer = L.svg({ padding: 0.5, pane: 'route-overlap' });
    if (!state.map.getPane('route-overlap-hit')) {
      const pane = state.map.createPane('route-overlap-hit');
      pane.style.zIndex = '446';
    }
    state.overlapHitRenderer = L.svg({ padding: 0.5, pane: 'route-overlap-hit' });
    window.__routeMap = state.map;
    window.__routeState = state;
    setupSmoothWheelZoom(state.map);

    state.map.on('zoomend', () => {
      updateBoundaryLabelVisibility();
      updateDayMarkerScale();
      scheduleRouteRebuild(80);
    });
    state.map.on('moveend', () => scheduleRouteRebuild(180));
    state.map.on('tileerror', () => {
      if (state.tileErrorShown) return;
      state.tileErrorShown = true;
      toast('底图瓦片加载失败，可切换到其他底图或“无底图”');
    });

    setBasemap(state.meta.basemap?.default || 'none', { rebuild: false, keepView: false });
    // 初次图层由 boot 末尾的 refreshAll({ first: true }) 统一构建，避免重复。

    updateDayMarkerScale();
    applyDayVisibility(false);
    window.addEventListener('resize', () => state.map && state.map.invalidateSize());
    setTimeout(() => state.map.invalidateSize(), 80);
  }

  let routeRebuildTimer = null;

  function scheduleRouteRebuild(delay = 120) {
    clearTimeout(routeRebuildTimer);
    routeRebuildTimer = setTimeout(() => {
      routeRebuildTimer = null;
      rebuildRouteLayers();
    }, delay);
  }

  function activeProvider() {
    const providers = state.meta.basemap?.providers || {};
    return providers[state.basemapKey] || { crs: 'wgs84', url: '', max_zoom: 18, attribution: '' };
  }

  function activeTransform() {
    return activeProvider().crs === 'gcj02' ? wgsToGcj : (lon, lat) => [lon, lat];
  }

  function setBasemap(key, { rebuild = true, keepView = true } = {}) {
    const providers = state.meta.basemap?.providers || {};
    const next = providers[key] || providers.none || { crs: 'wgs84', url: '' };
    const previous = activeProvider();
    let center = null;
    let zoom = null;
    if (keepView && state.map) {
      center = state.map.getCenter();
      zoom = state.map.getZoom();
      if (previous.crs === 'wgs84' && next.crs === 'gcj02') {
        const [lon, lat] = wgsToGcj(center.lng, center.lat);
        center = { lat, lng: lon };
      } else if (previous.crs === 'gcj02' && next.crs === 'wgs84') {
        const [lon, lat] = gcjToWgs(center.lng, center.lat);
        center = { lat, lng: lon };
      }
    }

    if (state.tileLayer) {
      state.map.removeLayer(state.tileLayer);
      state.tileLayer = null;
    }
    // 底图 CRS 变了，缓存的显示坐标和悬停/剖面标记都要失效。
    state.viewCache.clear();
    state.viewCacheBucket = null;
    state.viewCacheCrs = null;
    removeHoverLayer();
    removeProfileMarker();
    state.basemapKey = key;
    if (next.url) {
      const subdomains = Array.isArray(next.subdomains) && next.subdomains.length ? next.subdomains : 'abc';
      state.tileLayer = L.tileLayer(next.url, {
        subdomains,
        maxZoom: Number(next.max_zoom) || 18,
        attribution: next.attribution || '',
        fadeAnimation: false,
        keepBuffer: 4,
      }).addTo(state.map);
    }
    if (center && zoom !== null) {
      state.map.setView(center, zoom, { animate: false });
    }
    if (rebuild) {
      rebuildBoundaryLayer();
      rebuildRouteLayers();
    }
    updateBoundaryLabelVisibility();
    updateDayMarkerScale();
  }

  function wgsToGcj(lon, lat) {
    if (outOfChina(lon, lat)) return [lon, lat];
    const a = 6378245.0;
    const ee = 0.00669342162296594323;
    let dLat = transformLat(lon - 105.0, lat - 35.0);
    let dLon = transformLon(lon - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
    dLon = (dLon * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
    return [lon + dLon, lat + dLat];
  }

  function gcjToWgs(lon, lat) {
    if (outOfChina(lon, lat)) return [lon, lat];
    let wLon = lon;
    let wLat = lat;
    for (let i = 0; i < 6; i += 1) {
      const [gLon, gLat] = wgsToGcj(wLon, wLat);
      wLon -= gLon - lon;
      wLat -= gLat - lat;
    }
    return [wLon, wLat];
  }

  function outOfChina(lon, lat) {
    return !(lon >= 72.004 && lon <= 137.8347 && lat >= 0.8293 && lat <= 55.8271);
  }

  function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320.0 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
    return ret;
  }

  function transformLon(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
    return ret;
  }

  function transformCoords(coords, fn) {
    if (!Array.isArray(coords)) return coords;
    if (typeof coords[0] === 'number') {
      const [lon, lat] = fn(coords[0], coords[1]);
      return coords.length > 2 ? [lon, lat, ...coords.slice(2)] : [lon, lat];
    }
    return coords.map((item) => transformCoords(item, fn));
  }

  function transformFeature(feature, fn) {
    const props = { ...feature.properties };
    if (typeof props.label_lon === 'number' && typeof props.label_lat === 'number') {
      const [lon, lat] = fn(props.label_lon, props.label_lat);
      props.label_lon = lon;
      props.label_lat = lat;
    }
    return {
      ...feature,
      properties: props,
      geometry: { ...feature.geometry, coordinates: transformCoords(feature.geometry.coordinates, fn) },
    };
  }

  function boundaryStyle(feature) {
    const style = state.style;
    const props = feature.properties || {};
    const major = ['province', 'city', 'country'].includes(props.level);
    return {
      className: 'boundary-path',
      color: major ? style.boundary_stroke_major : style.boundary_stroke,
      weight: major ? 1.25 : 0.9,
      opacity: 0.95,
      fillColor: 'transparent',
      fillOpacity: 0,
    };
  }

  function readBoundaryMode() {
    try {
      const stored = localStorage.getItem('svg-routegen:boundary-mode');
      return ['local', 'nation_cities', 'nation', 'none'].includes(stored) ? stored : 'local';
    } catch (error) {
      return 'local';
    }
  }

  function boundaryModeAvailable(mode, files = state.meta?.files || {}) {
    if (mode === 'nation') return Boolean(files.boundaries_nation);
    if (mode === 'nation_cities') return Boolean(files.boundaries_nation_cities);
    return true;
  }

  async function ensureNationBoundaries(mode) {
    if (mode === 'nation') {
      if (state.boundariesNation && state.boundariesNation.length) return true;
    } else if (mode === 'nation_cities') {
      if (state.boundariesNationCities && state.boundariesNationCities.length) return true;
    } else {
      return false;
    }
    const fileKey = mode === 'nation' ? 'boundaries_nation' : 'boundaries_nation_cities';
    const url = state.meta?.files?.[fileKey];
    if (!url) return false;
    if (state.boundaryPromises[mode]) return state.boundaryPromises[mode];
    state.boundaryPromises[mode] = fetchJSON(url)
      .then((collection) => {
        const features = collection.features || [];
        if (mode === 'nation') state.boundariesNation = features;
        else state.boundariesNationCities = features;
        return features.length > 0;
      })
      .catch((error) => {
        console.warn('全国行政区划加载失败', error);
        return false;
      })
      .finally(() => {
        state.boundaryPromises[mode] = null;
      });
    return state.boundaryPromises[mode];
  }

  async function setBoundaryMode(mode, { persist = true } = {}) {
    if (!['local', 'nation_cities', 'nation', 'none'].includes(mode)) mode = 'local';
    if ((mode === 'nation' || mode === 'nation_cities') && !(await ensureNationBoundaries(mode))) {
      toast('该行政区划数据暂不可用，已切回“仅经过市”');
      mode = 'local';
    }
    state.boundaryMode = mode;
    const select = $('#boundary-mode');
    if (select) select.value = mode;
    if (persist) {
      try {
        localStorage.setItem('svg-routegen:boundary-mode', mode);
      } catch (error) {
        /* 忽略隐私模式存储错误 */
      }
    }
    rebuildBoundaryLayer();
  }

  function setupSmoothWheelZoom(map) {
    // 手势期间只对现有地图做 CSS 缩放（不触发 Leaflet 重新切瓦片），
    // 停止滚轮后再一次性提交缩放，避免整屏变灰和反复重载。
    map.scrollWheelZoom.disable();
    const container = map.getContainer();
    let previewing = false;
    let baseZoom = map.getZoom();
    let basePos = null;
    let target = baseZoom;
    let anchor = null;
    let timer = null;
    let snapshotEl = null;

    function clearSnapshot() {
      if (snapshotEl) {
        snapshotEl.remove();
        snapshotEl = null;
      }
    }

    function cloneMapPaneWithCanvas() {
      const clone = map._mapPane.cloneNode(true);
      const sourceCanvases = map._mapPane.querySelectorAll('canvas');
      const cloneCanvases = clone.querySelectorAll('canvas');
      sourceCanvases.forEach((source, index) => {
        const target = cloneCanvases[index];
        if (!target || !source.width || !source.height) return;
        try {
          const image = document.createElement('img');
          image.src = source.toDataURL('image/png');
          image.width = source.width;
          image.height = source.height;
          image.style.cssText = source.style.cssText;
          image.style.width = `${source.clientWidth}px`;
          image.style.height = `${source.clientHeight}px`;
          target.replaceWith(image);
        } catch (error) {
          /* 跨域污染等情况下退回透明 canvas */
        }
      });
      return clone;
    }

    function createSnapshot() {
      clearSnapshot();
      const wrapper = document.createElement('div');
      wrapper.className = 'zoom-snapshot';
      wrapper.appendChild(cloneMapPaneWithCanvas());
      map.getContainer().appendChild(wrapper);
      snapshotEl = wrapper;
      return wrapper;
    }

    function fadeSnapshot(snapshot) {
      if (!snapshot || snapshot !== snapshotEl) return;
      const layer = state.tileLayer;
      let finished = false;
      const finish = () => {
        if (finished || snapshot !== snapshotEl) return;
        finished = true;
        snapshot.style.transition = 'opacity 220ms ease';
        requestAnimationFrame(() => {
          snapshot.style.opacity = '0';
        });
        setTimeout(() => {
          if (snapshot === snapshotEl) {
            snapshot.remove();
            snapshotEl = null;
          }
        }, 260);
      };
      if (layer) {
        if (!layer.isLoading()) {
          // 目标级别瓦片可能已从缓存同步就绪，快速淡出。
          setTimeout(finish, 120);
        } else {
          layer.once('load', finish);
          setTimeout(finish, 900);
        }
      } else {
        setTimeout(finish, 120);
      }
    }

    function applyPreview() {
      if (!previewing || !basePos) return;
      const scale = Math.pow(2, target - baseZoom);
      const x = anchor.x - (anchor.x - basePos.x) * scale;
      const y = anchor.y - (anchor.y - basePos.y) * scale;
      L.DomUtil.setTransform(map._mapPane, L.point(x, y), scale);
    }

    function cancelPreview() {
      if (!previewing) return;
      clearTimeout(timer);
      timer = null;
      if (basePos) L.DomUtil.setPosition(map._mapPane, basePos);
      previewing = false;
      basePos = null;
      baseZoom = map.getZoom();
      target = baseZoom;
      clearSnapshot();
    }

    function commit() {
      if (!previewing) return;
      previewing = false;
      const zoom = target;
      const point = anchor;
      timer = null;
      if (Math.abs(zoom - map.getZoom()) < 1e-4) {
        if (basePos) L.DomUtil.setPosition(map._mapPane, basePos);
        baseZoom = map.getZoom();
        target = baseZoom;
        basePos = null;
        return;
      }
      // 先把当前（已按目标缩放预览）的画面克隆到上层，
      // 再让 Leaflet 切到新级别；新瓦片加载完成后淡出快照。
      const snapshot = createSnapshot();
      map.setZoomAround(point, zoom, { animate: false });
      fadeSnapshot(snapshot);
      baseZoom = map.getZoom();
      target = baseZoom;
      basePos = null;
    }

    container.addEventListener('wheel', (event) => {
      event.preventDefault();
      const modeFactor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const delta = event.deltaY * modeFactor;
      if (!delta) return;
      if (!previewing) {
        clearSnapshot();
        previewing = true;
        baseZoom = map.getZoom();
        target = baseZoom;
        basePos = map._getMapPanePos();
      }
      anchor = map.mouseEventToContainerPoint(event);
      target = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), target - delta * 0.0022));
      applyPreview();
      clearTimeout(timer);
      timer = setTimeout(commit, 180);
    }, { passive: false });

    // 外部缩放（按钮/定位）或拖拽开始时取消尚未提交的预览。
    map.on('zoomstart', cancelPreview);
    map.on('dragstart', cancelPreview);
  }

  function rebuildBoundaryLayer() {
    if (!state.map) return;
    if (state.boundaryLayer) {
      state.map.removeLayer(state.boundaryLayer);
      state.boundaryLayer = null;
    }
    if (state.boundaryMode === 'none') return;
    let sourceFeatures;
    if (state.boundaryMode === 'nation') sourceFeatures = state.boundariesNation;
    else if (state.boundaryMode === 'nation_cities') sourceFeatures = state.boundariesNationCities;
    else sourceFeatures = state.boundaries && state.boundaries.features;
    if (!sourceFeatures || !sourceFeatures.length) return;
    const fn = activeTransform();
    const features = sourceFeatures.map((feature) => transformFeature(feature, fn));
    const group = L.layerGroup();
    const geo = L.geoJSON({ type: 'FeatureCollection', features }, {
      style: boundaryStyle,
      onEachFeature(feature, layer) {
        const props = feature.properties || {};
        const baseStyle = boundaryStyle(feature);
        layer.bindTooltip(escapeHtml(props.name || ''), {
          sticky: true,
          direction: 'top',
          className: 'boundary-tooltip',
        });
        layer.on('mouseover', () => layer.setStyle({
          ...baseStyle,
          weight: baseStyle.weight + 0.8,
          color: '#6f6756',
          fillColor: '#8c8472',
          fillOpacity: 0.08,
        }));
        layer.on('mouseout', () => layer.setStyle(baseStyle));
      },
    });
    group.addLayer(geo);

    const labelLevels = new Set(['province', 'city', 'state', 'country', 'district']);
    const hideLabels = Boolean(activeProvider().hide_boundary_labels);
    if (!hideLabels) {
      for (const feature of features) {
        const props = feature.properties || {};
        if (!labelLevels.has(props.level)) continue;
        if (typeof props.label_lon !== 'number' || typeof props.label_lat !== 'number') continue;
        const icon = L.divIcon({
          className: 'boundary-label',
          html: `<span class="boundary-label-inner level-${escapeHtml(props.level)}">${escapeHtml(props.name || '')}</span>`,
          iconSize: null,
          iconAnchor: [0, 0],
        });
        const marker = L.marker([props.label_lat, props.label_lon], {
          icon,
          interactive: false,
          keyboard: false,
          zIndexOffset: 120,
        });
        marker._isBoundaryLabel = true;
        marker._labelLevel = props.level;
        group.addLayer(marker);
      }
    }

    group.addTo(state.map);
    state.boundaryLayer = group;
    updateBoundaryLabelVisibility();
  }

  function updateBoundaryLabelVisibility() {
    if (!state.map || !state.boundaryLayer) return;
    const zoom = state.map.getZoom();
    const thresholds = state.style?.label_min_zoom || {};
    state.boundaryLayer.eachLayer((layer) => {
      if (!layer._isBoundaryLabel) return;
      const element = layer.getElement && layer.getElement();
      if (!element) return;
      const level = layer._labelLevel || '';
      const defaultMin = level === 'district' ? 8 : level === 'city' ? 7 : 4;
      const minZoom = Number(thresholds[level] ?? defaultMin);
      element.style.display = zoom >= minZoom ? '' : 'none';
    });
  }

  function readCollapsedTrips() {
    try {
      const raw = localStorage.getItem('svg-routegen:collapsed-trips:v2');
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
    } catch (error) {
      return new Set();
    }
  }

  function saveCollapsedTrips() {
    try {
      localStorage.setItem('svg-routegen:collapsed-trips:v2', JSON.stringify([...state.collapsedTrips]));
    } catch (error) {
      /* 忽略隐私模式存储错误 */
    }
  }

  function readShowDayNumbers() {
    try {
      const stored = localStorage.getItem('svg-routegen:show-days');
      return stored === null ? true : stored === '1';
    } catch (error) {
      return true;
    }
  }

  function applyDayVisibility(persist = true) {
    if (state.map) {
      state.map.getContainer().classList.toggle('day-numbers-hidden', !state.showDayNumbers);
      updateDayMarkerScale();
    }
    const button = $('#toggle-days');
    if (button) {
      button.setAttribute('aria-pressed', String(state.showDayNumbers));
      button.textContent = state.showDayNumbers ? '隐藏天数' : '显示天数';
    }
    if (persist) {
      try {
        localStorage.setItem('svg-routegen:show-days', state.showDayNumbers ? '1' : '0');
      } catch (error) {
        /* 忽略隐私模式存储错误 */
      }
    }
  }

  function updateDayMarkerScale() {
    if (!state.map) return;
    const minZoom = Number(state.style?.day_number_min_zoom) || 8;
    const baseSize = Number(state.style?.day_number_size) || 24;
    const zoom = state.map.getZoom();
    const container = state.map.getContainer();
    container.classList.toggle('day-numbers-off', zoom < minZoom);
    const size = Math.round(Math.min(30, Math.max(18, baseSize + (zoom - minZoom) * 1.5)));
    container.style.setProperty('--day-marker-size', `${size}px`);
  }


  function removeHoverLayer() {
    if (state.hoverLayer && state.map) {
      state.map.removeLayer(state.hoverLayer);
    }
    state.hoverLayer = null;
  }

  function rebuildRouteLayers() {
    if (!state.map) return;
    removeHoverLayer();
    if (state.routeLayer) {
      state.map.removeLayer(state.routeLayer);
      state.routeLayer = null;
    }
    state.routeLineLayers.clear();
    if (state.overlapLayer) {
      state.map.removeLayer(state.overlapLayer);
      state.overlapLayer = null;
    }
    if (state.overlapHitLayer) {
      state.map.removeLayer(state.overlapHitLayer);
      state.overlapHitLayer = null;
    }
    clearOverlapTooltip();
    state.overlapLayers = [];
    const zoom = state.map.getZoom();
    state.lodBucket = lodBucket(zoom);
    const crs = activeProvider().crs;
    if (state.viewCacheBucket !== state.lodBucket || state.viewCacheCrs !== crs) {
      state.viewCache.clear();
      state.viewCacheBucket = state.lodBucket;
      state.viewCacheCrs = crs;
    }
    const group = L.layerGroup();
    const fn = activeTransform();
    const view = viewportWgsBounds();
    const features = selectedFeatures().filter((feature) => featureInBounds(feature, view));
    const lineWeight = lineWidth();

    // 先为所有可见路线取出显示坐标，供基础图层与重合彩带共用。
    const latlngById = new Map();
    for (const feature of features) {
      const props = feature.properties;
      const displayCoords = sampleRoute(feature.geometry.coordinates, feature, zoom, {
        selectedCount: state.selection.size,
        cache: state.lodCache,
      });
      const sampleMode = state.selection.size > 300 && zoom < 9 ? 'overview' : String(state.lodBucket);
      const cacheKey = `${props.id}:${sampleMode}`;
      let latlngs = state.viewCache.get(cacheKey);
      if (!latlngs) {
        latlngs = transformCoords(displayCoords, fn).map(([lon, lat]) => [lat, lon]);
        state.viewCache.set(cacheKey, latlngs);
      }
      if (latlngs.length >= 2) latlngById.set(props.id, latlngs);
    }
    const routePaths = [];
    for (const feature of features) {
      const latlngs = latlngById.get(feature.properties.id);
      if (latlngs) routePaths.push({ id: feature.properties.id, latlngs });
    }

    const lines = [];
    for (const feature of features) {
      const props = feature.properties;
      const latlngs = latlngById.get(props.id);
      if (!latlngs) continue;
      const dash = visibleDash(props);
      // 关闭“路段模式线型”后，虚线和透明度差异一并取消，全部按实线绘制
      const mode = state.display.showModeStyles ? (props.mode || 'cycling') : 'cycling';
      const lineOpacity = mode === 'transport' ? 0.62 : mode === 'inferred' ? 0.82 : 1;
      const qa = state.qaMode ? qaColor(props.qa_flags) : null;
      const color = qa || featureDisplayColor(feature);

      const line = L.polyline(latlngs, {
        color,
        weight: weightFor(props, lineWeight),
        opacity: qa ? 1 : lineOpacity,
        lineCap: 'round',
        lineJoin: 'round',
        dashArray: qa ? null : dash,
        renderer: state.routeRenderer,
      });
      line.bindTooltip(routeTooltip(props), {
        sticky: true,
        direction: 'top',
        className: 'route-tooltip',
        opacity: 1,
      });
      line.on('click', () => {
        showRouteCard(props.id);
        focusRoute(props.id);
      });
      line.on('mouseover', () => highlightRoute(props.id, true));
      line.on('mouseout', () => highlightRoute(props.id, false));
      state.routeLineLayers.set(props.id, line);
      lines.push(line);

      if (features.length > 300) continue;
      const startIcon = L.divIcon({
        className: 'route-marker',
        html: `<div class="route-start" style="background:${escapeHtml(color)}">${escapeHtml(String(props.day))}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const startMarker = L.marker(latlngs[0], {
        icon: startIcon,
        interactive: false,
        keyboard: false,
        zIndexOffset: 200,
      });
      group.addLayer(startMarker);

      const endMarker = L.circleMarker(latlngs[latlngs.length - 1], {
        radius: 4,
        color: '#fffdf8',
        weight: 1.8,
        fillColor: color,
        fillOpacity: 1,
        interactive: false,
        renderer: state.routeRenderer,
      });
      group.addLayer(endMarker);

      const labelPoint = midpointLatLng(latlngs);
      if (labelPoint && features.length <= 14) {
        const labelIcon = L.divIcon({
          className: 'route-label',
          html: routeLabelHTML(props, color),
          iconSize: null,
          iconAnchor: [0, 0],
        });
        const labelMarker = L.marker(labelPoint, {
          icon: labelIcon,
          interactive: false,
          keyboard: false,
          zIndexOffset: 180,
        });
        group.addLayer(labelMarker);
      }
    }

    for (const line of lines) group.addLayer(line);
    group.addTo(state.map);
    state.routeLayer = group;
    renderOverlapBands(routePaths);
    refreshRouteEmphasis();
  }

  // 用重合区段的 id 生成稳定的起始相位（0..period），避免每段都从第一种颜色开头
  function stablePhase(text, period) {
    let hash = 2166136261;
    const value = String(text || '');
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const fraction = (hash >>> 0) / 4294967296;
    return fraction * Math.max(0, Number(period) || 0);
  }

  // 重合彩带：只对当前视口内、屏幕空间重合的路线绘制。
  function renderOverlapBands(routePaths) {
    if (!state.display.overlapBands || state.qaMode || !state.map
        || !state.overlapRenderer || !state.overlapHitRenderer) return;
    if (routePaths.length > 300) return;
    const routes = [];
    for (const entry of routePaths) {
      if (!entry.latlngs || entry.latlngs.length < 2) continue;
      const points = entry.latlngs.map(([lat, lon]) => {
        const point = state.map.latLngToLayerPoint([lat, lon]);
        return [point.x, point.y];
      });
      routes.push({
        id: entry.id,
        points,
        coords: entry.latlngs.map(([lat, lon]) => [lon, lat]),
      });
    }
    if (routes.length < 2) return;
    // 视觉覆盖检测：按线宽判断“会互相盖住”的距离，并只让最表层的路线出彩带
    const runs = Overlap.findCoverageRuns(routes, {
      sampleStep: 8,
      minRunPx: 16,
      radius: Math.max(3, lineWidth() + 1),
    });
    if (!runs.length) return;
    const cycle = Number(state.display.overlapCycle) || 10;
    const overlapPx = Math.max(1.2, lineWidth() * 0.5);
    const group = L.layerGroup();
    const hitGroup = L.layerGroup();
    for (const run of runs.slice(0, 200)) {
      const latlngs = run.coords.map(([lon, lat]) => [lat, lon]);
      if (latlngs.length < 2) continue;
      const participants = run.participants
        .map((id) => state.routeById.get(id))
        .filter(Boolean);
      if (participants.length < 2) continue;
      const period = participants.length * cycle;
      const phase = stablePhase(run.id, period);
      participants.forEach((feature, index) => {
        const pattern = Overlap.cycleDash(cycle, participants.length, index, overlapPx, phase);
        const band = L.polyline(latlngs, {
          color: featureDisplayColor(feature),
          // 比基础线略宽，完全盖住下层实线；不再使用白色 casing
          weight: lineWidth() + 1.2,
          opacity: 1,
          lineCap: 'butt',
          lineJoin: 'round',
          dashArray: pattern.dashArray,
          dashOffset: pattern.dashOffset,
          interactive: false,
          renderer: state.overlapRenderer,
          pane: 'route-overlap',
        });
        group.addLayer(band);
        state.overlapLayers.push({ layer: band, kind: 'band' });
      });
      const hit = L.polyline(latlngs, {
        color: '#000000',
        opacity: 0.01,
        weight: Math.max(12, lineWidth() + 9),
        lineCap: 'round',
        lineJoin: 'round',
        interactive: true,
        renderer: state.overlapHitRenderer,
        pane: 'route-overlap-hit',
      });
      hit.on('mousemove', (event) => showOverlapHover(event, run, participants, cycle, overlapPx, phase));
      hit.on('mouseout', scheduleOverlapHoverClear);
      hit.on('click', (event) => {
        const info = overlapRouteAt(event, run, participants, cycle, overlapPx, phase);
        if (!info) return;
        showRouteCard(info.feature.properties.id);
        focusRoute(info.feature.properties.id);
      });
      hitGroup.addLayer(hit);
      state.overlapLayers.push({ layer: hit, kind: 'hit' });
    }
    if (!group.getLayers().length) return;
    group.addTo(state.map);
    state.overlapLayer = group;
    if (hitGroup.getLayers().length) {
      hitGroup.addTo(state.map);
      state.overlapHitLayer = hitGroup;
    }
  }

  function overlapRouteAt(event, run, participants, cycle, overlapPx, phase) {
    if (!state.map || !run.coords || run.coords.length < 2 || !event.latlng) return null;
    const target = state.map.latLngToLayerPoint(event.latlng);
    const points = run.coords.map(([lon, lat]) => {
      const point = state.map.latLngToLayerPoint([lat, lon]);
      return [point.x, point.y];
    });
    const hit = Overlap.closestOnPolyline(points, target);
    if (!Number.isFinite(hit.along)) return null;
    const index = Overlap.slotAtDistance(hit.along, participants.length, cycle, overlapPx, phase);
    const feature = participants[index];
    return feature ? { feature, index, along: hit.along } : null;
  }

  function overlapHoverElement() {
    let element = document.getElementById('overlap-hover-tip');
    if (!element) {
      element = document.createElement('div');
      element.id = 'overlap-hover-tip';
      element.className = 'route-tooltip';
      element.hidden = true;
      document.body.appendChild(element);
    }
    return element;
  }

  function showOverlapHover(event, run, participants, cycle, overlapPx, phase) {
    const info = overlapRouteAt(event, run, participants, cycle, overlapPx, phase);
    if (!info) return;
    clearTimeout(state.overlapTipTimer);
    state.overlapTipTimer = null;
    const element = overlapHoverElement();
    const color = featureDisplayColor(info.feature);
    element.innerHTML = `<div class="overlap-tip-color" style="background:${escapeHtml(color)}"></div>${routeTooltip(info.feature.properties)}`;
    element.hidden = false;
    const original = event.originalEvent || {};
    const x = Number(original.clientX);
    const y = Number(original.clientY);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      element.style.left = '0px';
      element.style.top = '0px';
      const rect = element.getBoundingClientRect();
      let left = x + 14;
      let top = y + 14;
      if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 14;
      if (top + rect.height > window.innerHeight - 8) top = y - rect.height - 14;
      element.style.left = `${Math.max(8, left)}px`;
      element.style.top = `${Math.max(8, top)}px`;
    }
  }

  function scheduleOverlapHoverClear() {
    clearTimeout(state.overlapTipTimer);
    state.overlapTipTimer = setTimeout(() => {
      state.overlapTipTimer = null;
      const element = document.getElementById('overlap-hover-tip');
      if (element) element.hidden = true;
    }, 40);
  }

  function clearOverlapTooltip() {
    clearTimeout(state.overlapTipTimer);
    state.overlapTipTimer = null;
    const element = document.getElementById('overlap-hover-tip');
    if (element) {
      element.hidden = true;
      element.innerHTML = '';
    }
  }

  // 拖动线宽滑块时只改现有图层的样式，不重建几何
  function applyLiveWidth() {
    const base = lineWidth();
    for (const [id, layer] of state.routeLineLayers) {
      const feature = state.routeById.get(id);
      const props = feature ? feature.properties : null;
      if (props) layer.setStyle({ weight: weightFor(props, base) });
    }
    for (const item of state.overlapLayers) {
      if (item.kind === 'hit') item.layer.setStyle({ weight: Math.max(12, base + 9) });
      else item.layer.setStyle({ weight: base + 1.2 });
    }
    const label = $('#line-width-value');
    if (label) label.textContent = widthLabel(base);
  }

  function displayedTrips() {
    const trips = state.meta?.trips || [];
    return trips.filter((trip) =>
      (trip.days || []).some((day) => state.selection.has(dayId(trip, day)))
    );
  }

  // 图例只列当前真正画在地图上的路线（有选中日期的行程）
  function renderMapLegend() {
    const host = $('#map-legend');
    if (!host) return;
    const count = $('#map-legend-count');
    const trips = displayedTrips().sort((a, b) => {
      const yearDelta = (Palette.yearOf(b) || 0) - (Palette.yearOf(a) || 0);
      if (yearDelta) return yearDelta;
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
    if (count) count.textContent = `${trips.length} 条 · ${state.selection.size} 天`;
    host.innerHTML = '';
    if (!trips.length) {
      const empty = document.createElement('p');
      empty.className = 'map-legend-empty';
      empty.textContent = '尚未选择路线';
      host.appendChild(empty);
      return;
    }
    for (const trip of trips) {
      const days = (trip.days || []).filter((day) => state.selection.has(dayId(trip, day)));
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'map-legend-row';
      row.title = `定位到「${trip.name}」`;
      const swatch = document.createElement('span');
      swatch.className = 'map-legend-swatch';
      swatch.style.background = tripDisplayColor(trip);
      const name = document.createElement('span');
      name.className = 'map-legend-name';
      name.textContent = trip.name;
      const meta = document.createElement('span');
      meta.className = 'map-legend-meta';
      const group = state.display.colorBy === 'team'
        ? Palette.tripGroupKey(trip, 'team')
        : (Palette.yearOf(trip) || '—');
      meta.textContent = `${group} · ${days.length} 天`;
      row.append(swatch, name, meta);
      row.addEventListener('click', () => focusTripRoutes(trip.id));
      host.appendChild(row);
    }
    if (state.qaMode) {
      const note = document.createElement('p');
      note.className = 'map-legend-note';
      note.textContent = '质量检查开启：地图按问题类别着色，图例颜色仅表示路线归属。';
      host.appendChild(note);
    }
  }

  function focusTripRoutes(tripId) {
    if (!state.map) return;
    const features = selectedFeatures().filter((feature) => feature.properties.trip_id === tripId);
    if (!features.length) return;
    const bounds = L.latLngBounds([]);
    for (const feature of features) {
      for (const coordinate of feature.geometry.coordinates) bounds.extend([coordinate[1], coordinate[0]]);
    }
    if (bounds.isValid()) {
      state.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 12, animate: true });
    }
    const section = $$('.trip').find((node) => node.dataset.tripId === tripId);
    if (section) section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function syncDisplayControls() {
    const slider = $('#line-width');
    if (slider) slider.value = String(lineWidth());
    const label = $('#line-width-value');
    if (label) label.textContent = widthLabel(lineWidth());
    const modeStyles = $('#show-mode-styles');
    if (modeStyles) modeStyles.checked = state.display.showModeStyles;
    const colorBy = $('#color-by');
    if (colorBy) colorBy.value = state.display.colorBy;
    const scheme = $('#color-scheme');
    if (scheme) {
      scheme.value = state.display.scheme;
      scheme.disabled = state.display.colorBy === 'default';
    }
    const overlapBands = $('#overlap-bands');
    if (overlapBands) overlapBands.checked = state.display.overlapBands;
    const overlapCycle = $('#overlap-cycle');
    if (overlapCycle) {
      overlapCycle.value = String(state.display.overlapCycle);
      overlapCycle.disabled = !state.display.overlapBands;
    }
    const overlapCycleValue = $('#overlap-cycle-value');
    if (overlapCycleValue) overlapCycleValue.textContent = `${state.display.overlapCycle} px`;
    const panel = $('#map-panel');
    if (panel && !panel.dataset.initialized) {
      panel.dataset.initialized = '1';
      // 窄屏默认折叠，避免遮住大部分地图
      if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) {
        setMapPanelCollapsed(true);
      }
    }
  }

  function setMapPanelCollapsed(collapsed) {
    const panel = $('#map-panel');
    const button = $('#map-panel-toggle');
    if (!panel || !button) return;
    panel.classList.toggle('collapsed', collapsed);
    button.setAttribute('aria-expanded', String(!collapsed));
  }

  function routeTooltip(props) {
    const parts = [];
    if (props.distance_km !== null && props.distance_km !== undefined) {
      parts.push(`${formatNumber(Math.round(props.distance_km))} km`);
    }
    if (props.ascent_m !== null && props.ascent_m !== undefined) {
      parts.push(`爬升 ${formatNumber(Math.round(props.ascent_m))} m`);
    }
    const note = props.note
      ? `<div class="tt-note">${escapeHtml(props.note)}</div>`
      : '';
    return `<div class="tt-title">${escapeHtml(props.trip_name)} · ${escapeHtml(props.label || `D${props.day}`)}</div>
      <div class="tt-sub">${escapeHtml(props.start)} → ${escapeHtml(props.end)}</div>
      <div>${parts.join(' · ')}</div>${note}`;
  }


  function providerText(props) {
    if (props.imported) return props.import_kind === 'fit' ? 'FIT 导入' : 'GPX 导入';
    const base = providerLabel(props.provider) || '自动生成';
    const edited = props.edited ? `${base}（已修正）` : base;
    // 端点坐标为行政中心/估算/旧共享坐标时，提示需要核查（与地点精度一致）
    return props.needs_review ? `${edited} · 端点坐标待核查` : edited;
  }

  async function ensureProfiles() {
    if (state.profiles) return state.profiles;
    if (!state.profilePromise) {
      state.profilePromise = fetchJSON(state.meta?.files?.profiles || `${state.dataBase}/profiles.json`)
        .then((data) => { state.profiles = data || {}; return state.profiles; })
        .catch(() => { state.profiles = {}; return state.profiles; });
    }
    return state.profilePromise;
  }

  function showRouteCard(id) {
    const feature = state.routeById.get(id);
    if (!feature) return;
    const props = feature.properties;
    state.activeRouteId = id;
    refreshRouteEmphasis();
    const card = $('#route-card');
    card.hidden = false;
    $('#route-card-kicker').textContent = `${props.trip_name} · ${props.label || `D${props.day}`}`;
    $('#route-card-title').textContent = `${props.start} → ${props.end}`;
    const qaText = (props.qa_flags || []).map(qaLabel).join(' / ');
    $('#route-card-sub').textContent = [modeLabel(props.mode), providerText(props), qaText, props.note].filter(Boolean).join(' · ');
    const stats = [];
    if (props.distance_km !== null && props.distance_km !== undefined) stats.push(`<span><b>${formatNumber(Math.round(props.distance_km))}</b> km</span>`);
    if (props.ascent_m !== null && props.ascent_m !== undefined) stats.push(`<span><b>${formatNumber(Math.round(props.ascent_m))}</b> m 爬升</span>`);
    if (props.point_count) stats.push(`<span>${formatNumber(props.point_count)} 点</span>`);
    $('#route-card-stats').innerHTML = stats.join('');
    $('#route-card-note').textContent = props.note || '';
    const prev = adjacentRouteId(id, -1);
    const next = adjacentRouteId(id, 1);
    $('#route-prev').disabled = !prev;
    $('#route-next').disabled = !next;
    const sourceId = state.meta?.source?.id || '';
    const gpxLink = $('#route-gpx');
    if (gpxLink) {
      gpxLink.href = `/api/gpx?source=${encodeURIComponent(sourceId)}&trip=${encodeURIComponent(props.trip_id)}&day=${props.day}`;
    }
    drawProfile(null);
    ensureProfiles().then((profiles) => {
      if (state.activeRouteId === id) drawProfile(profiles[id]);
    });
  }

  function adjacentRouteId(id, delta) {
    const feature = state.routeById.get(id);
    if (!feature) return null;
    const days = [...state.routeById.values()]
      .filter((item) => item.properties.trip_id === feature.properties.trip_id)
      .sort((a, b) => a.properties.day - b.properties.day);
    const index = days.findIndex((item) => item.properties.id === id);
    return index >= 0 ? days[index + delta]?.properties.id || null : null;
  }

  function goAdjacentRoute(delta) {
    const next = adjacentRouteId(state.activeRouteId, delta);
    if (!next) return;
    showRouteCard(next);
    focusRoute(next);
  }

  async function copyActiveCoords() {
    const feature = state.routeById.get(state.activeRouteId);
    if (!feature) return;
    const coords = feature.geometry.coordinates || [];
    if (!coords.length) return;
    const text = `${coords[0][0].toFixed(6)},${coords[0][1].toFixed(6)} → ${coords[coords.length - 1][0].toFixed(6)},${coords[coords.length - 1][1].toFixed(6)}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('坐标已复制');
    } catch (error) {
      toast(text);
    }
  }

  function hideRouteCard() {
    state.activeRouteId = null;
    removeProfileMarker();
    const card = $('#route-card');
    if (card) card.hidden = true;
    refreshRouteEmphasis();
  }

  function drawProfile(profile) {
    drawProfileChart(profile, {
      svg: $('#profile-chart'),
      range: $('#profile-range'),
      onHover: showProfileMarker,
      onLeave: removeProfileMarker,
    });
  }

  function showProfileMarker(lon, lat) {
    if (!state.map || lon === undefined || lat === undefined) return;
    // profiles.json 是 WGS-84；高德底图需要转换成 GCJ-02 才能和路线重合。
    const [glon, glat] = activeTransform()(lon, lat);
    if (!state.profileMarker) {
      state.profileMarker = L.circleMarker([glat, glon], {
        radius: 5,
        color: '#fffdf8',
        weight: 2,
        fillColor: '#2a78d6',
        fillOpacity: 1,
        interactive: false,
      }).addTo(state.map);
    } else {
      state.profileMarker.setLatLng([glat, glon]);
    }
  }

  function removeProfileMarker() {
    if (state.profileMarker) {
      state.profileMarker.remove();
      state.profileMarker = null;
    }
  }


  function routeLabelHTML(props, color) {
    const pieces = [props.label || `D${props.day}`];
    if (props.distance_km !== null && props.distance_km !== undefined) pieces.push(`${Math.round(props.distance_km)} km`);
    return `<span style="border-color:${escapeHtml(color || props.color || '#2a78d6')}">${escapeHtml(pieces.join(' · '))}</span>`;
  }

  function midpointLatLng(latlngs) {
    if (!latlngs.length) return null;
    let total = 0;
    const distances = [0];
    for (let i = 1; i < latlngs.length; i += 1) {
      total += haversine(latlngs[i - 1], latlngs[i]);
      distances.push(total);
    }
    const target = total / 2;
    for (let i = 1; i < distances.length; i += 1) {
      if (distances[i] >= target) {
        const segment = distances[i] - distances[i - 1] || 1;
        const t = (target - distances[i - 1]) / segment;
        const a = latlngs[i - 1];
        const b = latlngs[i];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
    }
    return latlngs[latlngs.length - 1];
  }

  function haversine(a, b) {
    const radius = 6371008.8;
    const p1 = (a[0] * Math.PI) / 180;
    const p2 = (b[0] * Math.PI) / 180;
    const dp = p2 - p1;
    const dl = ((b[1] - a[1]) * Math.PI) / 180;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * radius * Math.asin(Math.min(1, Math.sqrt(Math.max(0, h))));
  }

  let emphasisTimer = null;

  function highlightRoute(id, on) {
    state.hoveredId = on ? id : null;
    if (on) {
      refreshRouteEmphasis();
      return;
    }
    // 鼠标从一条路线移到另一条时会先触发 mouseout：稍等再恢复，
    // 避免透明度在两条路线之间闪烁。
    clearTimeout(emphasisTimer);
    emphasisTimer = setTimeout(() => {
      emphasisTimer = null;
      refreshRouteEmphasis();
    }, 60);
  }

  // 悬停或正在查看的路线画在最上层，其余路线整体降低透明度。
  // 重合路径下，当前这条仍然清晰可见，同时底图、行政区划不受影响。
  function refreshRouteEmphasis() {
    clearTimeout(emphasisTimer);
    emphasisTimer = null;
    let id = state.hoveredId;
    if (id && !state.routeLineLayers.get(id)) id = null;
    if (!id) id = state.activeRouteId;
    const layer = id ? state.routeLineLayers.get(id) : null;
    const feature = id ? state.routeById.get(id) : null;

    const renderer = state.routeRenderer && state.routeRenderer.getContainer && state.routeRenderer.getContainer();
    if (renderer) {
      renderer.style.transition = 'opacity 140ms ease';
      renderer.style.opacity = layer ? '0.26' : '1';
    }
    const overlapRenderer = state.overlapRenderer && state.overlapRenderer.getContainer && state.overlapRenderer.getContainer();
    if (overlapRenderer) {
      overlapRenderer.style.transition = 'opacity 140ms ease';
      overlapRenderer.style.opacity = layer ? '0.26' : '1';
    }

    removeHoverLayer();
    if (!layer || !feature || !state.map || !state.hoverRenderer) return;
    // 只在独立的高亮 canvas 上画一条线；不要 setStyle 基础图层，
    // 否则 Leaflet 会重绘包含上千条路线的整块 canvas。
    const color = state.qaMode
      ? (qaColor(feature.properties.qa_flags) || featureDisplayColor(feature))
      : featureDisplayColor(feature);
    const width = lineWidth() + 2.4;
    state.hoverLayer = L.polyline(layer.getLatLngs(), {
      color,
      weight: width,
      opacity: 0.98,
      lineCap: 'round',
      lineJoin: 'round',
      dashArray: visibleDash(feature.properties),
      interactive: false,
      renderer: state.hoverRenderer,
    }).addTo(state.map);
    const hoverContainer = state.hoverRenderer.getContainer && state.hoverRenderer.getContainer();
    if (hoverContainer) hoverContainer.style.pointerEvents = 'none';
  }

  function focusRoute(id) {
    const feature = state.routeById.get(id);
    if (!feature) return;
    const fn = activeTransform();
    const latlngs = transformCoords(feature.geometry.coordinates, fn).map(([lon, lat]) => [lat, lon]);
    if (!latlngs.length) return;
    const bounds = L.latLngBounds(latlngs);
    state.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 12, animate: true });
  }

  function fitSelected(animate = true) {
    if (!state.map) return;
    const fn = activeTransform();
    const bounds = L.latLngBounds([]);
    for (const feature of selectedFeatures()) {
      const bbox = feature.properties.bbox;
      if (!bbox) continue;
      const [west, south] = fn(bbox[0], bbox[1]);
      const [east, north] = fn(bbox[2], bbox[3]);
      bounds.extend([[south, west], [north, east]]);
    }
    if (bounds.isValid()) {
      state.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11, animate: Boolean(animate) });
      setTimeout(updateDayMarkerScale, 0);
      return;
    }
    if (state.boundaryLayer) {
      const boundaryBounds = state.boundaryLayer.getBounds ? state.boundaryLayer.getBounds() : null;
      if (boundaryBounds && boundaryBounds.isValid()) {
        state.map.fitBounds(boundaryBounds, { padding: [30, 30], maxZoom: 9, animate: Boolean(animate) });
        setTimeout(updateDayMarkerScale, 0);
      }
    }
  }

  // ------------------------------------------------------------------ 控件
  function bindControls() {
    let searchTimer = null;
    let sliderTimer = null;
    $('#collapse-all').addEventListener('click', () => {
      const trips = filteredTrips();
      const allCollapsed = trips.length > 0 && trips.every((trip) => state.collapsedTrips.has(trip.id));
      for (const trip of trips) {
        if (allCollapsed) state.collapsedTrips.delete(trip.id);
        else state.collapsedTrips.add(trip.id);
      }
      saveCollapsedTrips();
      renderTripList();
    });
    $('#select-all').addEventListener('click', () => {
      state.selection = new Set(availableIds());
      afterSelectionChange();
    });
    $('#select-none').addEventListener('click', () => {
      state.selection.clear();
      afterSelectionChange();
      fitSelected(true);
    });
    $('#zoom-selected').addEventListener('click', () => fitSelected(true));

    // 地图显示设置：线宽、模式线型、配色与图例
    const lineWidthInput = $('#line-width');
    if (lineWidthInput) {
      lineWidthInput.addEventListener('input', () => {
        state.display.lineWidth = Number(lineWidthInput.value) || 3;
        applyLiveWidth();
      });
      lineWidthInput.addEventListener('change', saveDisplaySettings);
    }
    const modeStyles = $('#show-mode-styles');
    if (modeStyles) {
      modeStyles.addEventListener('change', () => {
        state.display.showModeStyles = modeStyles.checked;
        saveDisplaySettings();
        rebuildRouteLayers();
        renderTripList();
        renderMapLegend();
      });
    }
    const overlapBands = $('#overlap-bands');
    if (overlapBands) {
      overlapBands.addEventListener('change', () => {
        state.display.overlapBands = overlapBands.checked;
        saveDisplaySettings();
        syncDisplayControls();
        rebuildRouteLayers();
      });
    }
    const overlapCycle = $('#overlap-cycle');
    if (overlapCycle) {
      overlapCycle.addEventListener('input', () => {
        state.display.overlapCycle = Number(overlapCycle.value) || 10;
        const label = $('#overlap-cycle-value');
        if (label) label.textContent = `${state.display.overlapCycle} px`;
      });
      overlapCycle.addEventListener('change', () => {
        saveDisplaySettings();
        rebuildRouteLayers();
      });
    }
    const colorBy = $('#color-by');
    if (colorBy) {
      colorBy.addEventListener('change', () => {
        state.display.colorBy = colorBy.value;
        syncDisplayControls();
        rebuildTripColors();
        saveDisplaySettings();
        renderTripList();
        renderYearLegend();
        renderMapLegend();
        rebuildRouteLayers();
      });
    }
    const colorScheme = $('#color-scheme');
    if (colorScheme) {
      colorScheme.addEventListener('change', () => {
        state.display.scheme = colorScheme.value;
        rebuildTripColors();
        saveDisplaySettings();
        renderTripList();
        renderYearLegend();
        renderMapLegend();
        rebuildRouteLayers();
      });
    }
    const mapSelectAll = $('#map-select-all');
    if (mapSelectAll) {
      mapSelectAll.addEventListener('click', () => {
        state.selection = new Set(availableIds());
        afterSelectionChange().then(() => fitSelected(true));
      });
    }
    const mapSelectNone = $('#map-select-none');
    if (mapSelectNone) {
      mapSelectNone.addEventListener('click', () => {
        state.selection.clear();
        afterSelectionChange();
        fitSelected(true);
      });
    }
    const panelToggle = $('#map-panel-toggle');
    if (panelToggle) {
      panelToggle.addEventListener('click', () => {
        const collapsed = !$('#map-panel').classList.contains('collapsed');
        setMapPanelCollapsed(collapsed);
      });
    }
    syncDisplayControls();
    $('#year-filter').addEventListener('change', (event) => {
      applyYearFilter(event.target.value, false);
    });
    const mapYearFilter = $('#map-year-filter');
    if (mapYearFilter) {
      mapYearFilter.addEventListener('change', (event) => {
        applyYearFilter(event.target.value, true);
      });
    }
    $('#year-slider').addEventListener('input', (event) => {
      const index = Number(event.target.value);
      const year = index > 0 ? state.years[index - 1] : '';
      const label = $('#timeline-label');
      if (label) label.textContent = year || '全部';
      // 拖动过程只更新标签，停手后再真正切换选择，避免每格都重建图层。
      clearTimeout(sliderTimer);
      sliderTimer = setTimeout(() => applyYearFilter(year, Boolean(year)), 180);
    });
    $('#route-search').addEventListener('input', (event) => {
      state.filters.query = event.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderTripList, 180);
    });
    $('#toggle-days').addEventListener('click', () => {
      state.showDayNumbers = !state.showDayNumbers;
      applyDayVisibility(true);
    });
    $('#toggle-qa')?.addEventListener('click', () => {
      state.qaMode = !state.qaMode;
      $('#toggle-qa').setAttribute('aria-pressed', String(state.qaMode));
      const legend = $('#qa-legend');
      if (legend) legend.hidden = !state.qaMode;
      rebuildRouteLayers();
      renderMapLegend();
    });
    $('#qa-filter')?.addEventListener('change', (event) => {
      state.filters.qa = event.target.value;
      renderTripList();
    });
    $('#basemap').addEventListener('change', (event) => {
      setBasemap(event.target.value);
      updateBoundaryLabelVisibility();
    });
    $('#boundary-mode').addEventListener('change', (event) => {
      setBoundaryMode(event.target.value);
    });
    $('#route-card-close').addEventListener('click', hideRouteCard);
    $('#route-prev').addEventListener('click', () => goAdjacentRoute(-1));
    $('#route-next').addEventListener('click', () => goAdjacentRoute(1));
    $('#route-only').addEventListener('click', () => {
      if (!state.activeRouteId) return;
      state.selection = new Set([state.activeRouteId]);
      afterSelectionChange();
    });
    $('#route-copy')?.addEventListener('click', copyActiveCoords);
    const dataTable = $('#data-table');
    if (dataTable) {
      dataTable.addEventListener('toggle', () => {
        if (dataTable.open) updateDataTable();
      });
    }
    $('#export-svg')?.addEventListener('click', exportSVG);
    $('#export-png')?.addEventListener('click', exportPNG);
    setupFullscreen();
  }

  function setupFullscreen() {
    const shell = $('#map-shell');
    const button = $('#map-fullscreen');
    if (!shell || !button) return;
    const icon = button.querySelector('span');
    const update = () => {
      const active = document.fullscreenElement === shell || shell.classList.contains('pseudo-fullscreen');
      button.setAttribute('aria-pressed', String(active));
      button.title = active ? '退出全屏' : '全屏显示地图';
      button.setAttribute('aria-label', button.title);
      if (icon) icon.textContent = active ? '⤢' : '⛶';
      setTimeout(() => state.map?.invalidateSize(), 120);
    };
    const exitPseudo = () => {
      shell.classList.remove('pseudo-fullscreen');
      document.body.classList.remove('map-pseudo-fullscreen');
      update();
    };
    button.addEventListener('click', async () => {
      if (document.fullscreenElement === shell) {
        try {
          await document.exitFullscreen();
        } catch (error) {
          /* 浏览器拒绝时保持当前状态 */
        }
        return;
      }
      if (shell.classList.contains('pseudo-fullscreen')) {
        exitPseudo();
        return;
      }
      if (shell.requestFullscreen) {
        try {
          await shell.requestFullscreen();
          update();
          return;
        } catch (error) {
          /* 论坛沙箱或浏览器不允许时退回页面内全屏 */
        }
      }
      shell.classList.add('pseudo-fullscreen');
      document.body.classList.add('map-pseudo-fullscreen');
      update();
    });
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && shell.classList.contains('pseudo-fullscreen')) {
        exitPseudo();
      }
    });
  }

  // ------------------------------------------------------------------ 导出
  async function exportSVG() {
    try {
      await ensureSelectionLoaded();
      const svg = buildExportSVG();
      const filename = `${slugify(state.meta.project.title)}-${TODAY}.svg`;
      downloadBlob(filename, new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      toast(`已导出 ${filename}`);
    } catch (error) {
      console.error(error);
      toast(`导出失败：${error.message}`);
    }
  }

  async function exportPNG() {
    try {
      await ensureSelectionLoaded();
      const svg = buildExportSVG();
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const root = parsed.documentElement;
      const svgWidth = Number(root.getAttribute('width')) || Number(state.style.width) || 1600;
      const svgHeight = Number(root.getAttribute('height')) || 900;
      const scale = Math.min(2, 4096 / Math.max(svgWidth, svgHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(svgWidth * scale);
      canvas.height = Math.round(svgHeight * scale);
      const context = canvas.getContext('2d');
      context.fillStyle = state.style.background || '#f8f5ee';
      context.fillRect(0, 0, canvas.width, canvas.height);

      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('SVG 渲染失败'));
        image.src = url;
      });
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 生成失败');
      const filename = `${slugify(state.meta.project.title)}-${TODAY}.png`;
      downloadBlob(filename, blob);
      toast(`已导出 ${filename}`);
    } catch (error) {
      console.error(error);
      toast(`导出失败：${error.message}`);
    }
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportBoundaries() {
    if (state.boundaryMode === 'none') return [];
    if (state.boundaryMode === 'nation') return state.boundariesNation || [];
    if (state.boundaryMode === 'nation_cities') return state.boundariesNationCities || [];
    return state.boundaries?.features || [];
  }

  function buildExportSVG() {
    // 导出至少按 12 级采样；缩得很远时也不会把整条路线压成几十个点。
    const exportZoom = Math.max(12, state.map ? state.map.getZoom() : 0);
    const routes = selectedFeatures().map((feature) => ({
      ...feature.properties,
      color: featureDisplayColor(feature),
      dash: visibleDash(feature.properties),
      // 关闭模式线型时，导出也不使用交通/推断的透明度差异
      mode: state.display.showModeStyles ? feature.properties.mode : 'cycling',
      // 与屏幕使用同一套 LOD，避免全选时把 128 万个点同步拼成数 MB 字符串。
      points: sampleRoute(feature.geometry.coordinates, feature, exportZoom, {
        selectedCount: state.selection.size,
        cache: state.lodCache,
      }),
    }));
    // 浏览器导出只保留地图（行政区划描边）和路线，不包含标题、图例、
    // 比例尺、指北针、地名、天数标记等额外元素。
    return renderMinimalMapSVG({
      routes,
      boundaries: exportBoundaries(),
      style: {
        ...state.style,
        route_width: lineWidth(),
      },
    });
  }


})();
