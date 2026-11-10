/* 校验问题定位：把 schema 校验的 path 解析为“可跳转目标”。
 *
 * 后端实际产生的 path 有三类（见 routegen/schema.py）：
 *   1. 索引式：trips[0]、trips[0].name、trips[0].days[1].start、places.地点名.lon
 *   2. 交叉校验：trips.<行程名>.D3.start（用行程名/ID，不是索引）
 *   3. 文件级：schema_version、meta.revision、未知顶层字段
 * 行程名和地点名都可能包含 "."，所以这里始终对照当前 docs 解析，
 * 不按模板切分字符串。
 *
 * 纯逻辑，不依赖 DOM：浏览器使用 window.IssueLocator，Node 测试使用 require。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IssueLocator = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SEVERITY_LABELS = { error: '错误', warning: '警告', info: '提示' };

  // 编辑页里确实存在控件的字段
  const TRIP_EDITABLE = ['id', 'name', 'color', 'region', 'tags', 'year', 'team_type', 'start_date', 'end_date', 'verification', 'source_url', 'note'];
  const DAY_EDITABLE = ['day', 'start', 'end', 'distance_km', 'ascent_m', 'mode', 'date', 'note'];
  const DAY_ADVANCED = ['start_coord', 'end_coord', 'source_url', 'route.fallback'];
  const DAY_ROUTE_EDITABLE = ['route.provider', 'route.profile'];
  const PLACE_EDITABLE = ['lon', 'lat', 'note', 'locked'];
  const PLACE_UNSUPPORTED = ['source', 'confidence', 'display_name', 'query', 'fetched_at'];

  const NONE_REASONS = {
    file: (path) => `文件级问题（${path}），编辑页没有对应字段，请在 YAML 中手工修正`,
    top: (path) => `路径「${path}」不属于行程、日期或地点，无法在编辑页定位`,
  };

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function none(path, reason) {
    return { path, kind: 'none', field: null, fieldSupport: null, reason };
  }

  function supportFor(kind, field) {
    if (!field) return null;
    if (kind === 'trip') {
      if (TRIP_EDITABLE.includes(field)) return 'editable';
      if (field === 'days') return 'container';
      if (field === 'route' || field.startsWith('route.')) return 'unsupported';
      return 'unknown';
    }
    if (kind === 'day') {
      if (DAY_EDITABLE.includes(field)) return 'editable';
      if (DAY_ADVANCED.includes(field)) return 'advanced';
      if (DAY_ROUTE_EDITABLE.includes(field)) return 'editable';
      if (field === 'route' || field.startsWith('route.')) return 'unsupported';
      return 'unknown';
    }
    if (kind === 'place') {
      if (PLACE_EDITABLE.includes(field)) return 'editable';
      if (PLACE_UNSUPPORTED.includes(field)) return 'unsupported';
      return 'unknown';
    }
    return null;
  }

  function unsupportedReason(kind, field) {
    if (kind === 'day') return `字段「${field}」在表格/卡片中没有控件`;
    if (kind === 'trip') return `行程级字段「${field}」没有编辑控件`;
    return `地点字段「${field}」没有编辑控件`;
  }

  function withField(locator, field, kind) {
    locator.field = field || null;
    locator.fieldSupport = field ? supportFor(kind, field) : null;
    if (locator.fieldSupport === 'unsupported' || locator.fieldSupport === 'unknown') {
      locator.reason = unsupportedReason(kind, field);
    } else if (locator.fieldSupport === 'container') {
      locator.reason = '该问题针对日期列表整体，已定位到日期区域';
    }
    return locator;
  }

  function locateTripIndex(trips, index, rest) {
    const trip = trips[index];
    if (!isObject(trip)) {
      return none(`trips[${index}]`, `行程序号 ${index} 超出当前数据（共 ${trips.length} 条），可能数据已变化`);
    }
    const locator = { path: `trips[${index}]`, kind: 'trip', tripIndex: index, tripId: trip.id ?? null, field: null, fieldSupport: null, reason: null };
    if (!rest) return locator;

    const daysMatch = /^days\[(\d+)\](?:\.([\s\S]+))?$/.exec(rest);
    if (daysMatch) {
      const dayIndex = Number(daysMatch[1]);
      const days = Array.isArray(trip.days) ? trip.days : [];
      const day = days[dayIndex];
      if (!isObject(day)) {
        return none(`trips[${index}].${rest}`, `日期序号 ${dayIndex} 超出行程「${trip.name || trip.id || index}」的日期数量（共 ${days.length} 天）`);
      }
      locator.kind = 'day';
      locator.dayIndex = dayIndex;
      locator.dayNumber = day.day;
      return withField(locator, daysMatch[2] || null, 'day');
    }
    if (rest === 'days') {
      return withField(locator, 'days', 'trip');
    }
    return withField(locator, rest, 'trip');
  }

  // 交叉校验：trips.<行程名>.D<编号>.<字段>
  function locateCross(trips, rest) {
    const candidates = [];
    trips.forEach((trip, index) => {
      if (!isObject(trip)) return;
      const name = typeof trip.name === 'string' && trip.name.trim() ? trip.name.trim() : '';
      const id = typeof trip.id === 'string' && trip.id.trim() ? trip.id.trim() : '';
      if (name) candidates.push({ key: name, trip, index, kind: 'name' });
      if (id) candidates.push({ key: id, trip, index, kind: 'id' });
    });
    // 名称可能互为前缀，按长度降序匹配，避免 "2026" 抢走 "2026骑行团"
    candidates.sort((a, b) => b.key.length - a.key.length);

    const numbered = /^trips\[(\d+)\]/;
    const fallback = numbered.exec(rest);
    if (fallback) {
      const index = Number(fallback[1]);
      const tail = rest.slice(fallback[0].length).replace(/^\./, '');
      return crossDay(trips, index, tail, rest);
    }

    for (const candidate of candidates) {
      if (rest !== candidate.key && !rest.startsWith(candidate.key + '.')) continue;
      const tail = rest === candidate.key ? '' : rest.slice(candidate.key.length + 1);
      return crossDay(trips, candidate.index, tail, rest, candidate.key);
    }
    return none(`trips.${rest}`, `当前数据源中没有匹配的行程「${rest.split('.D')[0] || rest}」；问题可能来自已删除的行程或另一份数据`);
  }

  function crossDay(trips, index, tail, rest, key) {
    const trip = trips[index];
    if (!isObject(trip)) return none(`trips.${rest}`, `问题指向的行程（第 ${index + 1} 条）在当前数据中不存在`);
    const locator = { path: `trips.${rest}`, kind: 'trip', tripIndex: index, tripId: trip.id ?? null, field: null, fieldSupport: null, reason: null };
    if (!tail) return locator;
    const dayMatch = /^D(\d+)(?:\.([\s\S]+))?$/.exec(tail);
    if (!dayMatch) {
      return withField(locator, tail, 'trip');
    }
    const number = Number(dayMatch[1]);
    const days = Array.isArray(trip.days) ? trip.days : [];
    const dayIndex = days.findIndex((day) => isObject(day) && Number(day.day) === number);
    if (dayIndex < 0) {
      return none(`trips.${rest}`, `行程「${key || trip.name || trip.id || index}」中没有 D${number}`);
    }
    locator.kind = 'day';
    locator.dayIndex = dayIndex;
    locator.dayNumber = number;
    return withField(locator, dayMatch[2] || null, 'day');
  }

  // 地点：地点名可能含 "."，用实际存在的键做最长匹配
  function locatePlace(places, rest) {
    const names = Object.keys(places).sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (rest !== name && !rest.startsWith(name + '.')) continue;
      const field = rest === name ? null : rest.slice(name.length + 1);
      const locator = { path: `places.${rest}`, kind: 'place', placeName: name, field: null, fieldSupport: null, reason: null };
      return withField(locator, field, 'place');
    }
    return none(`places.${rest}`, `当前数据源中没有地点「${rest.split('.')[0] || rest}」；可能已被删除或来自另一份数据`);
  }

  function locateIssue(path, docs) {
    const trips = Array.isArray(docs && docs.trips) ? docs.trips : [];
    const places = docs && isObject(docs.places) ? docs.places : {};
    const text = typeof path === 'string' ? path : '';
    if (!text) return none(text, '问题缺少路径，无法定位');

    let match = /^trips\[(\d+)\](?:\.([\s\S]+))?$/.exec(text);
    if (match) return locateTripIndex(trips, Number(match[1]), match[2] || '');

    match = /^trips\.([\s\S]+)$/.exec(text);
    if (match) return locateCross(trips, match[1]);

    match = /^places\.([\s\S]+)$/.exec(text);
    if (match) return locatePlace(places, match[1]);

    if (['schema_version', 'meta', 'trips', 'places'].includes(text) || text.startsWith('meta.')) {
      return none(text, NONE_REASONS.file(text));
    }
    // 顶层未知字段（如 bogus）也是文件级问题
    if (/^[A-Za-z0-9_-]+$/.test(text)) return none(text, NONE_REASONS.file(text));
    return none(text, NONE_REASONS.top(text));
  }

  // 展示用标签（同时参与搜索）
  function locatorLabel(locator, docs) {
    if (!locator || locator.kind === 'none') return '';
    if (locator.kind === 'place') return locator.placeName;
    const trips = Array.isArray(docs && docs.trips) ? docs.trips : [];
    const trip = trips[locator.tripIndex];
    const name = (trip && (trip.name || trip.id)) || `第 ${locator.tripIndex + 1} 条行程`;
    return locator.kind === 'day' ? `${name} · D${locator.dayNumber ?? locator.dayIndex + 1}` : name;
  }

  function decorateIssues(issues, docs) {
    return (issues || []).map((issue) => {
      const locator = locateIssue(issue.path, docs);
      return { issue, locator, label: locatorLabel(locator, docs) };
    });
  }

  function filterIssues(entries, options) {
    const severity = (options && options.severity) || 'all';
    const query = String((options && options.query) || '').trim().toLowerCase();
    return (entries || []).filter((entry) => {
      const issue = entry.issue;
      if (severity !== 'all' && issue.severity !== severity) return false;
      if (!query) return true;
      const haystack = [
        SEVERITY_LABELS[issue.severity], issue.severity, issue.path, issue.message, entry.label,
        entry.locator && entry.locator.reason, // 无法定位时也能按原因搜到
      ].filter((value) => value != null).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  /* 执行跳转。adapter 由页面实现：
   *   switchTab(tab), selectTrip(index), revealTripField(index, field, support),
   *   revealDay(index, dayIndex, field, support), revealPlace(name, field, support),
   *   unlocatable(locator), notify(message)
   * 返回 {ok, reason}。任何分支都不会重新加载数据，因此不会丢弃未保存的修改。
   */
  function performJump(locator, adapter) {
    if (!locator || locator.kind === 'none') {
      const reason = (locator && locator.reason) || '无法定位该问题';
      if (adapter.unlocatable) adapter.unlocatable(locator);
      return { ok: false, reason };
    }
    let focused = false;
    if (locator.kind === 'place') {
      adapter.switchTab('places');
      focused = Boolean(adapter.revealPlace(locator.placeName, locator.field, locator.fieldSupport));
    } else {
      adapter.switchTab('trips');
      adapter.selectTrip(locator.tripIndex);
      focused = locator.kind === 'day'
        ? Boolean(adapter.revealDay(locator.tripIndex, locator.dayIndex, locator.field, locator.fieldSupport))
        : Boolean(adapter.revealTripField(locator.tripIndex, locator.field, locator.fieldSupport));
    }
    const reason = !focused
      ? (locator.reason || '已定位到所属位置，但该字段没有可聚焦的控件')
      : (locator.reason || null);
    if (reason && adapter.notify) adapter.notify(reason);
    return { ok: focused, reason };
  }

  return {
    SEVERITY_LABELS,
    TRIP_EDITABLE,
    DAY_EDITABLE,
    DAY_ADVANCED,
    PLACE_EDITABLE,
    locateIssue,
    locatorLabel,
    decorateIssues,
    filterIssues,
    performJump,
  };
});
