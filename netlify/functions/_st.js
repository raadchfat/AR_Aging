/**
 * Shared ServiceTitan API helper.
 * Handles OAuth token caching and Reporting API calls.
 *
 * Env vars required (set in Netlify → Site settings → Environment variables):
 *   ST_CLIENT_ID
 *   ST_CLIENT_SECRET
 *   ST_APP_KEY
 *   ST_TENANT_ID
 */

const AUTH_URL = 'https://auth.servicetitan.io/connect/token';
const API_BASE = 'https://api.servicetitan.io';

// Module-scope token cache. Netlify keeps warm containers alive between
// invocations, so this avoids re-authenticating on every poll.
let cachedToken = null;
let cachedExpiry = 0;

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

async function getToken() {
  const now = Date.now();
  // Refresh 60s before actual expiry to avoid edge-of-life failures.
  if (cachedToken && now < cachedExpiry - 60000) return cachedToken;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env('ST_CLIENT_ID'),
    client_secret: env('ST_CLIENT_SECRET'),
  });

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  cachedToken = json.access_token;
  cachedExpiry = now + (json.expires_in || 900) * 1000;
  return cachedToken;
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'ST-App-Key': env('ST_APP_KEY'),
    'Content-Type': 'application/json',
  };
}

function reportBase() {
  return `${API_BASE}/reporting/v2/tenant/${env('ST_TENANT_ID')}`;
}

/**
 * Fetch the report's own definition: its fields and the parameters it requires.
 * This is what lets us stop guessing at parameter names.
 */
async function getReportMeta(category, reportId) {
  const token = await getToken();
  const url = `${reportBase()}/report-category/${category}/reports/${reportId}`;
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Report meta failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return res.json();
}

/**
 * Fetch report data. `parameters` is an array of { name, value }.
 * Returns { fields, rows } where rows are plain objects keyed by field name.
 */
async function getReportData(category, reportId, parameters, pageSize = 500) {
  const token = await getToken();
  const url = `${reportBase()}/report-category/${category}/reports/${reportId}/data?page=1&pageSize=${pageSize}&includeTotal=true`;

  const res = await fetch(url, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ parameters }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Report data failed (${res.status}): ${text.slice(0, 600)}`);
  }

  const json = await res.json();
  return { raw: json, fields: json.fields || [], rows: toObjects(json) };
}

/**
 * ServiceTitan returns data as an array of arrays aligned to `fields`.
 * Defensive: if it ever returns objects instead, pass them through.
 */
function toObjects(json) {
  const fields = json.fields || [];
  const data = json.data || [];
  if (!data.length) return [];
  if (!Array.isArray(data[0])) return data;

  const names = fields.map((f) => f.name || f.label);
  return data.map((row) => {
    const obj = {};
    names.forEach((n, i) => {
      obj[n] = row[i];
    });
    return obj;
  });
}

module.exports = { getToken, getReportMeta, getReportData, env };
