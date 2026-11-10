/* 首页数据源选择：从 sources.json 清单中挑出要加载的源。
 * 纯逻辑，不依赖 DOM；浏览器用 window.SourcePicker，Node 测试用 require。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SourcePicker = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function usable(manifest) {
    if (!manifest || !Array.isArray(manifest.sources)) return [];
    return manifest.sources.filter((source) => source && source.id && !source.error);
  }

  // search 传 window.location.search；?source=<id> 优先，其次 manifest.default，最后第一个可用源
  function pickSource(manifest, search) {
    const list = usable(manifest);
    if (!list.length) return null;
    let requested = '';
    try {
      requested = new URLSearchParams(search || '').get('source') || '';
    } catch (error) {
      requested = '';
    }
    if (requested) {
      const match = list.find((source) => source.id === requested);
      if (match) return match;
    }
    return list.find((source) => source.id === manifest.default) || list[0];
  }

  function displayName(source) {
    return String(source.display || source.id || '').replace(/_demo$/, '');
  }

  function options(manifest) {
    if (!manifest || !Array.isArray(manifest.sources)) return [];
    return manifest.sources.map((source) => {
      const name = displayName(source);
      return {
        id: source.id,
        label: `${name}${source.label && source.label !== source.id ? ` · ${source.label}` : ''}${source.error ? '（不可用）' : ''}`,
        disabled: Boolean(source.error),
      };
    });
  }

  return { pickSource, options, displayName };
});
