/* 论坛发布页：优先加载构建时生成的 .gz 数据，失败时回退到未压缩文件。 */
(() => {
  if (typeof DecompressionStream === 'undefined' || !window.fetch) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : (input && typeof input.url === 'string' ? input.url : '');
    // 源清单没有压缩版，直接走原文件
    if (/(?:^|\/)data\/sources\.json$/.test(url)) {
      return originalFetch(input, init);
    }
    if (/(?:^|\/)data\/[^?#]+\.(?:geojson|json)$/.test(url)) {
      try {
        const response = await originalFetch(`${url}.gz`, init);
        if (response.ok && response.body) {
          const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      } catch (error) {
        // 没有 .gz 或浏览器不支持时使用原文件
      }
    }
    return originalFetch(input, init);
  };
})();
