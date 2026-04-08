/**
 * Geoforce API Proxy — Cloudflare Worker
 *
 * Exposes three endpoints your HTML app calls:
 *
 *   GET  /api/readings?esn=...&from=...&to=...&time_series=...
 *   POST /api/assets          (body: Asset API query object)
 *   GET  /api/asset?id=...    (looks up a single asset by externalAssetId)
 *
 * Environment variables (set in Cloudflare dashboard, never in code):
 *   GEOFORCE_READINGS_TOKEN   — JWT for the Readings API
 *   GEOFORCE_ASSET_KEY        — Key for Asset API (used to get JWT)
 *   GEOFORCE_ASSET_SECRET     — Secret for Asset API (used to get JWT)
 *   GEOFORCE_ENV              — "prod" or "dev" (defaults to "dev")
 */

// ── BASE URLS ────────────────────────────────────────────────────────────────
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

// ── JWT CACHE ────────────────────────────────────────────────────────────────
// Cloudflare Workers are stateless between requests, but within a single
// request we cache the token. For a real production system you'd use
// Cloudflare KV to cache across requests and avoid re-fetching every time.
let cachedAssetToken = null;
let cachedAssetTokenExpiry = 0;

async function getAssetJWT(env, baseUrl) {
  const now = Date.now();

  // Return cached token if still valid (with 60s buffer before expiry)
  if (cachedAssetToken && now < cachedAssetTokenExpiry - 60000) {
    return cachedAssetToken;
  }

  // Build Basic auth header: base64(key:secret)
  const credentials = btoa(`${env.GEOFORCE_ASSET_KEY}:${env.GEOFORCE_ASSET_SECRET}`);

  // Request all scopes we need in one token
  const scope = 'asset_api:read location_api:read device_api:read';
  const resp = await fetch(
    `${baseUrl.auth}?grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/json',
      }
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Asset auth failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();

  // Cache token — JWT is valid 1 hour (3600s), store expiry in ms
  cachedAssetToken       = data.access_token;
  cachedAssetTokenExpiry = now + (data.expires_in || 3600) * 1000;

  return cachedAssetToken;
}

// ── CORS HEADERS ─────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status);
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Determine environment
    const gfEnv  = (env.GEOFORCE_ENV || 'dev').toLowerCase();
    const baseUrl = URLS[gfEnv] || URLS.dev;

    // ── HEALTH CHECK ──────────────────────────────────────────────────────────
    if (path === '/') {
      return jsonResponse({
        status: 'ok',
        env:    gfEnv,
        endpoints: [
          'GET  /api/readings?esn=...&from=...&to=...&time_series=received',
          'GET  /api/asset?id=UNIT-14',
          'POST /api/assets       (full Asset API query)',
          'GET  /api/locations    (geofences — requires Location API access)',
        ]
      });
    }

    // ── READINGS API ──────────────────────────────────────────────────────────
    // GET /api/readings?esn=204206514&from=2026-03-30T12:00:00Z&to=2026-03-30T20:00:00Z
    if (path === '/api/readings' && method === 'GET') {
      if (!env.GEOFORCE_READINGS_TOKEN) {
        return errorResponse('GEOFORCE_READINGS_TOKEN not configured', 500);
      }

      const esn        = url.searchParams.get('esn');
      const from       = url.searchParams.get('from');
      const to         = url.searchParams.get('to');
      const time_series = url.searchParams.get('time_series') || 'received';

      if (!esn || !from || !to) {
        return errorResponse('Missing required params: esn, from, to', 400);
      }

      const readingsUrl = new URL(baseUrl.readings);
      readingsUrl.searchParams.set('esns',        esn);
      readingsUrl.searchParams.set('from',        from);
      readingsUrl.searchParams.set('to',          to);
      readingsUrl.searchParams.set('time_series', time_series);

      const resp = await fetch(readingsUrl.toString(), {
        headers: {
          'Authorization': `Bearer ${env.GEOFORCE_READINGS_TOKEN}`,
          'Content-Type':  'application/json',
        }
      });

      if (!resp.ok) {
        const body = await resp.text();
        return errorResponse(`Readings API error (${resp.status}): ${body}`, resp.status);
      }

      const data = await resp.json();
      return jsonResponse(data);
    }

    // ── ASSET LOOKUP BY EXTERNAL ID ───────────────────────────────────────────
    // GET /api/asset?id=UNIT-14
    // Returns the first matching asset including its ESN
    if (path === '/api/asset' && method === 'GET') {
      if (!env.GEOFORCE_ASSET_KEY || !env.GEOFORCE_ASSET_SECRET) {
        return errorResponse('GEOFORCE_ASSET_KEY / GEOFORCE_ASSET_SECRET not configured', 500);
      }

      const externalId = url.searchParams.get('id');
      if (!externalId) {
        return errorResponse('Missing required param: id', 400);
      }

      let jwt;
      try {
        jwt = await getAssetJWT(env, baseUrl);
      } catch (e) {
        return errorResponse(`Auth failed: ${e.message}`, 401);
      }

      // Query Asset API — filter by externalAssetId via name search
      // The Asset API doesn't have a direct externalAssetId filter,
      // so we fetch all assets and filter client-side within the worker
      const body = {
        filters: { hasAssignedDevice: true },
        include: ['device', 'name', 'externalAssetId', 'make', 'model', 'latestReading', 'latestReading.coordinates'],
        page:    1,
        perPage: 1000,
        units:   'imperial'
      };

      const resp = await fetch(`${baseUrl.asset}/assets/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        const text = await resp.text();
        return errorResponse(`Asset API error (${resp.status}): ${text}`, resp.status);
      }

      const data = await resp.json();

      // Find asset matching the externalAssetId (case-insensitive)
      const normalise = s => (s || '').toString().toLowerCase().replace(/[\s\-_]/g, '');
      const match = (data.data || []).find(a =>
        normalise(a.externalAssetId) === normalise(externalId) ||
        normalise(a.name)            === normalise(externalId)
      );

      if (!match) {
        return jsonResponse({ found: false, id: externalId }, 404);
      }

      return jsonResponse({
        found:           true,
        id:              match.id,
        externalAssetId: match.externalAssetId,
        name:            match.name,
        make:            match.make,
        model:           match.model,
        esn:             match.device?.esn  || null,
        deviceId:        match.device?.id   || null,
        latestReading:   match.latestReading || null,
      });
    }

    // ── FULL ASSET QUERY (pass-through) ───────────────────────────────────────
    // POST /api/assets  — body is a standard Asset API query object
    if (path === '/api/assets' && method === 'POST') {
      if (!env.GEOFORCE_ASSET_KEY || !env.GEOFORCE_ASSET_SECRET) {
        return errorResponse('GEOFORCE_ASSET_KEY / GEOFORCE_ASSET_SECRET not configured', 500);
      }

      let jwt;
      try {
        jwt = await getAssetJWT(env, baseUrl);
      } catch (e) {
        return errorResponse(`Auth failed: ${e.message}`, 401);
      }

      const reqBody = await request.text();

      const resp = await fetch(`${baseUrl.asset}/assets/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type':  'application/json',
        },
        body: reqBody
      });

      if (!resp.ok) {
        const text = await resp.text();
        return errorResponse(`Asset API error (${resp.status}): ${text}`, resp.status);
      }

      const data = await resp.json();
      return jsonResponse(data);
    }

    // ── LOCATION API — GEOFENCES ─────────────────────────────────────────────
    // GET /api/locations
    // Returns all named geofences (well sites, yards, customer locations)
    // with their polygon boundaries in GeoJSON format.
    // Used for: accurate time-on-site, automatic job site matching,
    //           unauthorized stop detection, home yard identification.
    // NOTE: Location API is pending general release — contact Geoforce support.
    if (path === '/api/locations' && method === 'GET') {
      if (!env.GEOFORCE_ASSET_KEY || !env.GEOFORCE_ASSET_SECRET) {
        return errorResponse('GEOFORCE_ASSET_KEY / GEOFORCE_ASSET_SECRET not configured', 500);
      }

      let jwt;
      try {
        jwt = await getAssetJWT(env, baseUrl);
      } catch (e) {
        return errorResponse(`Auth failed: ${e.message}`, 401);
      }

      const resp = await fetch(`${baseUrl.location}/geofences`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type':  'application/json',
        }
      });

      if (!resp.ok) {
        const text = await resp.text();
        // Location API may return 403 if not yet enabled on the account
        if (resp.status === 403) {
          return errorResponse(
            'Location API not enabled on this account. Contact Geoforce support to request access.',
            403
          );
        }
        return errorResponse(`Location API error (${resp.status}): ${text}`, resp.status);
      }

      const data = await resp.json();

      // Enrich each geofence with a centroid if not already provided
      // so the app can use it as a map marker without parsing the full polygon
      const enriched = (data.features || data).map(f => {
        if (f.geometry?.type === 'Polygon' && !f.properties?.centroid) {
          const coords = f.geometry.coordinates[0];
          const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
          const lng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
          return { ...f, properties: { ...f.properties, centroid: { lat, lng } } };
        }
        return f;
      });

      return jsonResponse({ type: 'FeatureCollection', features: enriched });
    }

    // ── 404 ───────────────────────────────────────────────────────────────────
    return errorResponse(`Unknown endpoint: ${method} ${path}`, 404);
  }
};
