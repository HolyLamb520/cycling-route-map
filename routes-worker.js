self.onmessage = async (event) => {
  try {
    const path = (event.data && event.data.path) || 'data/routes.geojson';
    const response = await fetch(path);
    if (!response.ok) throw new Error(`routes.geojson HTTP ${response.status}`);
    const data = await response.json();
    self.postMessage({ ok: true, data });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error && error.message ? error.message : error) });
  }
};
