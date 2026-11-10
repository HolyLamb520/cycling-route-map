/* 任务入口的纯逻辑：选项整理、摘要、启动条件与进度展示规则。
 * 不依赖 DOM，可在浏览器（window.JobView）与 Node（require）中使用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobView = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const JOB_ACTIONS = {
    geocode: '解析坐标',
    route: '生成 GPX',
    build: '重建地图',
    all: '全流程',
  };

  const STATUS_LABELS = {
    queued: '排队中',
    running: '运行中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };

  const TEXT_OPTIONS = ['provider', 'trip', 'day'];
  const FLAG_OPTIONS = ['force', 'replace_corrections', 'refresh', 'offline', 'refresh_boundaries', 'no_boundaries', 'no_svg'];

  // 从表单值整理出请求参数：空文本省略，布尔值明确保留
  function buildOptions(raw) {
    const options = {};
    for (const key of TEXT_OPTIONS) {
      const value = raw && raw[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        options[key] = String(value).trim();
      }
    }
    for (const key of FLAG_OPTIONS) {
      options[key] = Boolean(raw && raw[key]);
    }
    return options;
  }

  function summarize(options, meta) {
    const opts = options || {};
    const parts = [];
    const tripLabel = opts.trip ? ((meta && meta.tripLabel) || opts.trip) : '全部行程';
    parts.push(tripLabel);
    if (opts.day) parts.push(`仅 D${opts.day}`);
    parts.push(opts.provider ? `路线服务 ${opts.provider}` : '路线服务：全局配置');
    if (opts.force) parts.push('强制 GPX');
    if (opts.replace_corrections) parts.push('覆盖手动修正');
    if (opts.refresh) parts.push('重解析坐标');
    if (opts.offline) parts.push('仅离线地理编码');
    if (opts.refresh_boundaries) parts.push('重下行政区划');
    if (opts.no_boundaries) parts.push('不画行政区划');
    if (opts.no_svg) parts.push('不生成 SVG');
    return parts.join(' · ');
  }

  function isActive(job) {
    return Boolean(job && (job.status === 'queued' || job.status === 'running'));
  }

  // 启动 / 重试前的前端检查：未保存修改与任务互斥
  function startBlocker({ dirty, job } = {}) {
    if (isActive(job)) {
      const label = JOB_ACTIONS[job.action] || job.action;
      return {
        reason: 'busy',
        message: `已有任务正在运行：${label}（${job.id}）。请等待完成或取消。`,
      };
    }
    if (dirty) {
      return {
        reason: 'dirty',
        message: '有未保存的修改，请先点击「保存更改」再运行生成任务。',
      };
    }
    return null;
  }

  // 只有后端提供 total > 0 时才给出百分比；否则只显示阶段
  function progressView(job) {
    if (!job) return { visible: false, percent: null, text: '' };
    const stage = job.stage || '';
    const progress = job.progress;
    // null 表示后端没有提供总数；不能用 Number(null) === 0 混淆
    const rawTotal = progress ? progress.total : null;
    const total = rawTotal === null || rawTotal === undefined ? null : Number(rawTotal);
    const current = progress ? Number(progress.current) : null;
    if (!stage && !(Number.isFinite(total) && total > 0)) {
      return { visible: false, percent: null, text: '' };
    }
    if (Number.isFinite(total) && total > 0 && Number.isFinite(current)) {
      const percent = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
      return {
        visible: true,
        percent,
        text: `${stage || '处理中'} · 已处理 ${current} / ${total}（${percent}%）`,
      };
    }
    if (total === 0) {
      return {
        visible: true,
        percent: null,
        text: `${stage || '处理中'} · 总数 0，没有需要处理的项目`,
      };
    }
    return {
      visible: true,
      percent: null,
      text: stage ? `${stage} · 后端未提供可计数进度，请查看日志` : '',
    };
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || status;
  }

  return {
    JOB_ACTIONS,
    STATUS_LABELS,
    buildOptions,
    summarize,
    isActive,
    startBlocker,
    progressView,
    statusLabel,
  };
});
