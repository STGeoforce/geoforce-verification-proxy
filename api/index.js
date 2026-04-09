/**
 * Geoforce API Proxy — Vercel Serverless Function
 *
 * Endpoints:
 *   GET  /api?route=readings&esn=...&from=...&to=...
 *   GET  /api?route=asset&id=UNIT-14
 *   POST /api?route=assets          (body: Asset API query object)
 *   GET  /api?route=locations
 *   GET  /api?route=health
 *
 * Environment variables (set in Vercel dashboard, never in code):
 *   GEOFORCE_READINGS_TOKEN   — JWT for the Readings API
 *   GEOFORCE_ASSET_KEY        — Key for Asset API auth
 *   GEOFORCE_ASSET_SECRET     — Secret for Asset API auth
 *   GEOFORCE_ENV              — "prod" or "dev" (defaults to "dev")
 */

const URLS = {
  dev: {
    readings: 'https://readings.dev.geoforce.net/readings',
    asset:    'https://asset.api.geoforce.com/api/v1',
    location: 'https://location.api.geoforce.com/api/v1',
    auth:     'https://asset.api.geoforce.com/api/v1/auth/token',
  },
  prod: {
    readings: 'https://readings.geoforce.com/readings',
    asset:    'https://asset.api.geoforce.com/api/v1',
    location: 'https://location.api.geoforce.com/api/v1',
    auth:     'https://asset.api.geoforce.com/api/v1/auth/token',
  }
};

// Simple in-memory JWT cache (lives for the duration of the function instance)
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAssetJWT(env, baseUrl) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry - 60000) return cachedToken;

  const credentials = Buffer.from(`${env.GEOFORCE_ASSET_KEY}:${env.GEOFORCE_ASSET_SECRET}`).toString('base64');
  const scope = 'asset_api:read location_api:read device_api:read';

  const resp = await fetch(
    `${baseUrl.auth}?grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
      }
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Asset auth failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = now + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res, data, status = 200) {
  cors(res);
  res.setHeader('Content-Type', 'application/json');
  res.status(status).json(data);
}

function err(res, message, status = 500) {
  json(res, { error: message }, status);
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }

  const env = process.env;
  const gfEnv = (env.GEOFORCE_ENV || 'dev').toLowerCase();
  const baseUrl = URLS[gfEnv] || URLS.dev;
  const route = req.query.route;

  // ── HEALTH CHECK ────────────────────────────────────────────────────────────
  if (!route || route === 'health') {
    return json(res, {
      status: 'ok',
      env: gfEnv,
      endpoints: [
        'GET  /api?route=readings&esn=...&from=...&to=...&time_series=received',
        'GET  /api?route=asset&id=UNIT-14',
        'POST /api?route=assets',
        'GET  /api?route=locations',
      ]
    });
  }

  // ── READINGS ────────────────────────────────────────────────────────────────
  if (route === 'readings' && req.method === 'GET') {
    if (!env.GEOFORCE_READINGS_TOKEN) return err(res, 'GEOFORCE_READINGS_TOKEN not configured', 500);

    const { esn, from, to, time_series = 'received' } = req.query;
    if (!esn || !from || !to) return err(res, 'Missing required params: esn, from, to', 400);

    const url = new URL(baseUrl.readings);
    url.searchParams.set('esns', esn);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('time_series', time_series);

    const resp = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${env.GEOFORCE_READINGS_TOKEN}` }
    });

    if (!resp.ok) return err(res, `Readings API error (${resp.status}): ${await resp.text()}`, resp.status);
    return json(res, await resp.json());
  }

  // ── ASSET LOOKUP BY EXTERNAL ID ─────────────────────────────────────────────
  if (route === 'asset' && req.method === 'GET') {
    if (!env.GEOFORCE_ASSET_KEY || !env.GEOFORCE_ASSET_SECRET) return err(res, 'Asset API credentials not configured', 500);

    const { id } = req.query;
    if (!id) return err(res, 'Missing required param: id', 400);

    let jwt;
    try { jwt = await getAssetJWT(env, baseUrl); }
    catch (e) { return err(res, `Auth failed: ${e.message}`, 401); }

    const body = {
      filters: { hasAssignedDevice: true },
      include: ['device', 'name', 'externalAssetId', 'make', 'model', 'latestReading', 'latestReading.coordinates'],
      page: 1,
      perPage: 1000,
      units: 'imperial'
    };

    const resp = await fetch(`${baseUrl.asset}/assets/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) return err(res, `Asset API error (${resp.status}): ${await resp.text()}`, resp.status);

    const data = await resp.json();
    const normalise = s => (s || '').toString().toLowerCase().replace(/[\s\-_]/g, '');
    const match = (data.data || []).find(a =>
      normalise(a.externalAssetId) === normalise(id) ||
      normalise(a.name) === normalise(id)
    );

    if (!match) return json(res, { found: false, id }, 404);

    return json(res, {
      found: true,
      id: match.id,
      externalAssetId: match.externalAssetId,
      name: match.name,
      make: match.make,
      model: match.model,
      esn: match.device?.esn || null,
      deviceId: match.device?.id || null,
      latestReading: match.latestReading || null,
    });
  }

  // ── FULL ASSET QUERY ────────────────────────────────────────────────────────
  if (route === 'assets' && req.method === 'POST') {
    if (!env.GEOFORCE_ASSET_KEY || !env.GEOFORCE_ASSET_SECRET) return err(res, 'Asset API credentials not configured', 500);

    let jwt;
    try { jwt = await getAssetJWT(env, baseUrl); }
    catch (e) { return err(res, `Auth failed: ${e.message}`, 401); }

    const resp = await fetch(`${baseUrl.asset}/assets/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    if (!resp.ok) return err(res, `Asset API error (${resp.status}): ${await resp.text()}`, resp.status);
    return json(res, await resp.json());
  }

  // ── LOCATIONS / GEOFENCES ───────────────────────────────────────────────────
  if (route === 'locations' && req.method === 'GET') {
    if (!env.GEOFORCE_ASSET_KEY || !env.GEOFORCE_ASSET_SECRET) return err(res, 'Asset API credentials not configured', 500);

    let jwt;
    try { jwt = await getAssetJWT(env, baseUrl); }
    catch (e) { return err(res, `Auth failed: ${e.message}`, 401); }

    const resp = await fetch(`${baseUrl.location}/geofences`, {
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' }
    });

    if (!resp.ok) {
      if (resp.status === 403) return err(res, 'Location API not enabled — contact Geoforce support to request access.', 403);
      return err(res, `Location API error (${resp.status}): ${await resp.text()}`, resp.status);
    }

    const data = await resp.json();
    const features = (data.features || data).map(f => {
      if (f.geometry?.type === 'Polygon' && !f.properties?.centroid) {
        const coords = f.geometry.coordinates[0];
        const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
        const lng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
        return { ...f, properties: { ...f.properties, centroid: { lat, lng } } };
      }
      return f;
    });

    return json(res, { type: 'FeatureCollection', features });
  }

  return err(res, `Unknown route: ${req.method} ?route=${route}`, 404);
}
