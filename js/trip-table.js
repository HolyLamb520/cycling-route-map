/* 行程路段表格的纯逻辑：筛选、分页、批量计划、CSV 解析与导入计划。
 * 不依赖 DOM，可在浏览器（window.TripTable）与 Node（require）中使用。
 * 校验规则与 routegen/schema.py 保持一致。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TripTable = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 表格每页最多渲染的行数：无论数据多大，DOM 行数都有明确上限
  const DEFAULT_PAGE_SIZE = 50;
  const MAX_PAGE_SIZE = 100;
  // 预览里最多列出的 CSV 行数（统计仍覆盖全部行）
  const PREVIEW_LIMIT = 50;

  const MODE_LABELS = { '': '未标注', cycling: '骑行', transport: '交通/转场', inferred: '推断/近似' };
  // CSV 中可写的模式：英文枚举或中文别名；空表示「不修改 / 未标注」
  const MODE_ALIASES = {
    '': '', cycling: 'cycling', 骑行: 'cycling',
    transport: 'transport', 交通: 'transport', 转场: 'transport', '交通/转场': 'transport',
    inferred: 'inferred', 推断: 'inferred', 近似: 'inferred', '推断/近似': 'inferred',
    自动判断: '', 未标注: '',
  };

  // CSV 列名（不区分大小写）→ 字段
  const CSV_COLUMNS = {
    day: ['day', '日期编号', '天'],
    start: ['start', '起点'],
    end: ['end', '终点'],
    distance_km: ['distance_km', '里程', '里程km', '里程 km'],
    ascent_m: ['ascent_m', '爬升', '爬升m', '爬升 m'],
    date: ['date', '日期'],
    mode: ['mode', '路段模式'],
    note: ['note', '备注'],
  };

  function dayNumber(day) {
    return Number(day && day.day);
  }

  // 按日期编号升序的副本（不改变原数组）
  function sortedDays(days) {
    return days
      .map((day, index) => ({ day, index }))
      .sort((a, b) => (dayNumber(a.day) - dayNumber(b.day)) || (a.index - b.index))
      .map((item) => item.day);
  }

  // 前一天 = 按编号排序后紧邻的上一项（编号可能不连续，以排序位置为准）
  function previousDay(days, day) {
    const ordered = sortedDays(days);
    const index = ordered.indexOf(day);
    return index > 0 ? ordered[index - 1] : null;
  }

  function isValidDate(text) {
    const value = String(text || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  // 返回标准化模式；无效时返回 undefined
  function normalizeMode(text) {
    const key = String(text == null ? '' : text).trim();
    return Object.prototype.hasOwnProperty.call(MODE_ALIASES, key) ? MODE_ALIASES[key] : undefined;
  }

  // 按搜索词、模式、GPX 状态筛选。hasGpx(day) -> boolean
  function filterDays(days, options, hasGpx) {
    const query = String((options && options.query) || '').trim().toLowerCase();
    const mode = (options && options.mode) || 'all';
    const gpx = (options && options.gpx) || 'all';
    return days.filter((day) => {
      const current = day.mode || '';
      if (mode === 'none' && current !== '') return false;
      if (mode !== 'all' && mode !== 'none' && current !== mode) return false;
      if (gpx !== 'all') {
        const has = Boolean(hasGpx && hasGpx(day));
        if (gpx === 'has' && !has) return false;
        if (gpx === 'missing' && has) return false;
      }
      if (!query) return true;
      const haystack = [
        `D${day.day}`, String(day.day), day.start, day.end, day.note, day.date, MODE_LABELS[current],
      ].filter((value) => value != null).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  // 分页：页码会被钳制到有效范围；size 有上限
  function paginate(items, page, size) {
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(size) || DEFAULT_PAGE_SIZE)));
    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pages - 1);
    const from = current * pageSize;
    return {
      page: current,
      pages,
      pageSize,
      total,
      from,
      slice: items.slice(from, from + pageSize),
    };
  }

  // ------------------------------------------------------------------ 批量操作
  // 只计算，不修改。返回 {selected, changes:[{day, field, from, to}], skipped:[{day, reason}]}
  // op: {type:'mode', value} | {type:'date', value} | {type:'fillStart'}
  function planBatch(days, selected, op) {
    const plan = { selected: 0, changes: [], skipped: [] };
    const targets = days.filter((day) => selected.has(day));
    plan.selected = targets.length;
    for (const day of targets) {
      if (op.type === 'mode') {
        const from = day.mode || '';
        if (from !== op.value) plan.changes.push({ day, field: 'mode', from, to: op.value });
      } else if (op.type === 'date') {
        const from = day.date || '';
        if (from !== op.value) plan.changes.push({ day, field: 'date', from, to: op.value });
      } else if (op.type === 'fillStart') {
        const prev = previousDay(days, day);
        // schema v3：路线级地点，按地点 ID 复制（只改起点地点，其它字段不动）
        const routeMode = Object.prototype.hasOwnProperty.call(day, 'start_location_id');
        if (!prev) {
          plan.skipped.push({ day, reason: '没有前一天' });
        } else if (routeMode) {
          if (!prev.end_location_id) {
            plan.skipped.push({ day, reason: `D${prev.day} 终点未选择地点` });
          } else if (day.start_location_id !== prev.end_location_id) {
            plan.changes.push({ day, field: 'start_location_id', from: day.start_location_id || '', to: prev.end_location_id });
          }
        } else if (!String(prev.end || '').trim()) {
          plan.skipped.push({ day, reason: `D${prev.day} 终点为空` });
        } else if (day.start !== prev.end) {
          plan.changes.push({ day, field: 'start', from: day.start || '', to: prev.end });
        }
      }
    }
    return plan;
  }

  // 应用批量计划：只写入计划中的字段，其它字段保持不变。返回修改的字段数
  function applyBatch(plan) {
    for (const change of plan.changes) {
      if (change.field === 'mode') {
        if (change.to) change.day.mode = change.to;
        else delete change.day.mode;
      } else if (change.field === 'date') {
        if (change.to) change.day.date = change.to;
        else delete change.day.date;
      } else if (change.field === 'start') {
        change.day.start = change.to;
      } else if (change.field === 'start_location_id' || change.field === 'end_location_id') {
        if (change.to) change.day[change.field] = change.to;
        else delete change.day[change.field];
      }
    }
    return plan.changes.length;
  }

  // ------------------------------------------------------------------ CSV
  // 解析 CSV（支持引号、"" 转义、CRLF、BOM）。返回二维数组，忽略全空行
  function parseCsv(text) {
    const source = String(text || '').replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"') {
          if (source[i + 1] === '"') {
            cell += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          cell += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && source[i + 1] === '\n') i += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
    if (cell.length || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows
      .map((cells) => cells.map((value) => value.trim()))
      .filter((cells) => cells.some((value) => value !== ''));
  }

  // 把表头映射到字段。返回 {columns: {field: index}, unknown: [name], error?}
  function mapCsvHeader(headerCells) {
    const lookup = {};
    for (const [field, names] of Object.entries(CSV_COLUMNS)) {
      for (const name of names) lookup[name.toLowerCase()] = field;
    }
    const columns = {};
    const unknown = [];
    headerCells.forEach((name, index) => {
      const key = String(name || '').trim().toLowerCase();
      if (!key) return;
      const field = lookup[key];
      if (!field) {
        unknown.push(name);
      } else if (columns[field] === undefined) {
        columns[field] = index;
      } else {
        unknown.push(name);
      }
    });
    if (columns.day === undefined) {
      return { columns, unknown, error: '缺少「日期编号」（或 day）列' };
    }
    return { columns, unknown };
  }

  // 校验单行。返回 {values, reasons}；values 中只包含非空的合法字段
  function validateCsvValues(raw) {
    const reasons = [];
    const values = {};
    const dayText = raw.day || '';
    if (!/^\d+$/.test(dayText) || Number(dayText) < 1 || Number(dayText) > 999) {
      reasons.push(`日期编号「${dayText || '空'}」必须是 1–999 的整数`);
    } else {
      values.day = Number(dayText);
    }
    for (const field of ['start', 'end']) {
      if (raw[field]) values[field] = raw[field];
    }
    for (const field of ['distance_km', 'ascent_m']) {
      const text = raw[field];
      if (!text) continue;
      const number = Number(text);
      if (!Number.isFinite(number) || number < 0) reasons.push(`${field === 'distance_km' ? '里程' : '爬升'}「${text}」必须是非负数字`);
      else values[field] = number;
    }
    if (raw.date) {
      if (isValidDate(raw.date)) values.date = raw.date.trim();
      else reasons.push(`日期「${raw.date}」应为 YYYY-MM-DD`);
    }
    if (raw.mode) {
      const mode = normalizeMode(raw.mode);
      if (mode === undefined) reasons.push(`路段模式「${raw.mode}」无效（可用：骑行 / 交通 / 推断 或 cycling / transport / inferred）`);
      else if (mode) values.mode = mode;
    }
    if (raw.note) values.note = raw.note;
    return { values, reasons };
  }

  // schema v3：把 CSV 中的起/终点名称解析为本路线内的地点 ID。
  // 名称必须在本路线内唯一匹配；不存在或重名都会使该行无法导入（不静默新建、不猜测合并）。
  function resolveRouteLocations(values, reasons, locations) {
    const endpoints = [['start', '起点'], ['end', '终点']];
    for (const [role, label] of endpoints) {
      const name = values[role];
      delete values[role];
      values[`${role}_name`] = name; // 仅用于预览显示，不会写入数据
      if (!name) continue;
      const matches = (locations || []).filter((loc) => loc && String(loc.name || '').trim() === name);
      if (matches.length === 0) {
        reasons.push(`路线中没有名为「${name}」的${label}地点（请先在「路线地点」中新增）`);
      } else if (matches.length > 1) {
        reasons.push(`路线中有 ${matches.length} 个名为「${name}」的地点，无法判断是哪一个，请在表格中指定`);
      } else {
        values[`${role}_location_id`] = matches[0].id;
      }
    }
  }

  // 生成 CSV 导入计划（只计算，不修改 days）
  // 状态：add 新增 / overwrite 覆盖 / skip 跳过 / invalid 无法导入
  function planCsvImport(days, csvText, options) {
    const allowOverwrite = Boolean(options && options.allowOverwrite);
    const rows = parseCsv(csvText);
    const plan = {
      header: null,
      unknownColumns: [],
      rows: [],
      counts: { add: 0, overwrite: 0, skip: 0, invalid: 0 },
      error: null,
    };
    if (!rows.length) {
      plan.error = 'CSV 为空';
      return plan;
    }
    const header = mapCsvHeader(rows[0]);
    plan.unknownColumns = header.unknown;
    if (header.error) {
      plan.error = header.error;
      return plan;
    }
    plan.header = header.columns;

    const dataRows = rows.slice(1).map((cells, index) => {
      const raw = {};
      for (const field of Object.keys(header.columns)) {
        raw[field] = cells[header.columns[field]] || '';
      }
      return { line: index + 2, raw };
    });

    // CSV 内重复的日期编号：所有相关行都无法导入，避免猜测应以哪一行为准
    const seenInCsv = new Map();
    for (const item of dataRows) {
      if (!/^\d+$/.test(item.raw.day || '')) continue;
      const key = Number(item.raw.day);
      seenInCsv.set(key, (seenInCsv.get(key) || 0) + 1);
    }

    const existingByDay = new Map();
    for (const day of days) {
      const key = dayNumber(day);
      if (!existingByDay.has(key)) existingByDay.set(key, []);
      existingByDay.get(key).push(day);
    }

    const v3 = Boolean(options && Array.isArray(options.locations));
    for (const item of dataRows) {
      const { values, reasons } = validateCsvValues(item.raw);
      if (v3) resolveRouteLocations(values, reasons, options.locations);
      const entry = { line: item.line, day: values.day ?? (item.raw.day || ''), status: 'invalid', reasons, changes: [] };
      if (values.day !== undefined && seenInCsv.get(values.day) > 1) {
        reasons.push(`CSV 中日期编号 ${values.day} 重复出现 ${seenInCsv.get(values.day)} 次`);
      }
      if (reasons.length) {
        entry.status = 'invalid';
      } else {
        const matches = existingByDay.get(values.day) || [];
        if (matches.length > 1) {
          entry.status = 'invalid';
          entry.reasons.push(`现有数据中日期编号 ${values.day} 已重复，请先在表格中修正`);
        } else if (matches.length === 0) {
          const complete = v3
            ? Boolean(values.start_location_id && values.end_location_id)
            : Boolean(values.start && values.end);
          if (!complete) {
            entry.status = 'invalid';
            entry.reasons.push(v3 ? '新增路段必须同时指定起点和终点（路线内已存在的地点名称）' : '新增路段必须同时填写起点和终点');
          } else {
            entry.status = 'add';
            entry.values = values;
          }
        } else {
          const existing = matches[0];
          const endpointFields = v3 ? ['start_location_id', 'end_location_id'] : ['start', 'end'];
          for (const field of [...endpointFields, 'distance_km', 'ascent_m', 'date', 'mode', 'note']) {
            if (values[field] === undefined) continue;
            const from = existing[field] === undefined || existing[field] === null ? '' : existing[field];
            if (from !== values[field]) entry.changes.push({ field, from, to: values[field] });
          }
          entry.values = values;
          if (!entry.changes.length) {
            entry.status = 'skip';
            entry.reasons.push('与现有路段相同');
          } else if (!allowOverwrite) {
            entry.status = 'skip';
            entry.reasons.push('日期编号已存在；勾选「允许覆盖」后才会替换 CSV 中非空的字段');
          } else {
            entry.status = 'overwrite';
          }
        }
      }
      plan.counts[entry.status] += 1;
      plan.rows.push(entry);
    }
    return plan;
  }

  // 应用导入计划：只写入 add / overwrite 行的字段；其它字段保持不变。
  // 新增行会按日期编号重新排序（已有行的相对顺序不变）。返回 {added, overwritten}
  function applyCsvImport(days, plan) {
    const result = { added: 0, overwritten: 0 };
    for (const entry of plan.rows) {
      if (entry.status === 'add') {
        const day = entry.values.start_location_id !== undefined
          ? { day: entry.values.day, start_location_id: entry.values.start_location_id, end_location_id: entry.values.end_location_id }
          : { day: entry.values.day, start: entry.values.start, end: entry.values.end };
        for (const field of ['distance_km', 'ascent_m', 'date', 'mode', 'note']) {
          if (entry.values[field] !== undefined) day[field] = entry.values[field];
        }
        days.push(day);
        result.added += 1;
      } else if (entry.status === 'overwrite') {
        const target = days.find((day) => dayNumber(day) === entry.values.day);
        if (!target) continue;
        for (const change of entry.changes) target[change.field] = change.to;
        result.overwritten += 1;
      }
    }
    if (result.added) {
      const ordered = sortedDays(days);
      days.splice(0, days.length, ...ordered);
    }
    return result;
  }

  return {
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    PREVIEW_LIMIT,
    MODE_LABELS,
    CSV_COLUMNS,
    sortedDays,
    previousDay,
    isValidDate,
    normalizeMode,
    filterDays,
    paginate,
    planBatch,
    applyBatch,
    parseCsv,
    mapCsvHeader,
    planCsvImport,
    applyCsvImport,
    resolveRouteLocations,
  };
});
