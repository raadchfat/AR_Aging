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
 * A report category comes back as an object, but the value we need to put in
 * the URL path is its key/id (e.g. "accounting"), not its display name.
 */
function categoryKey(c) {
  if (!c) return null;
  if (typeof c === 'string') return c;
  return c.id || c.key || c.value || c.name || null;
}

/** List every report category this app has been approved to read. */
async function listReportCategories() {
  const token = await getToken();
  const out = [];

  for (let page = 1; page <= 20; page++) {
    const url = `${reportBase()}/report-categories?page=${page}&pageSize=100`;
    const res = await fetch(url, { headers: headers(token) });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Category list failed (${res.status}): ${text.slice(0, 400)}`);
    }

    const json = await res.json();
    const data = json.data || json.items || (Array.isArray(json) ? json : []);
    out.push(...data);
    if (!json.hasMore) break;
  }

  return out;
}

/**
 * List the reports inside one category. A 403/404 means "this app isn't
 * approved for that category" rather than a real failure, so return empty
 * instead of throwing — otherwise one locked category aborts the whole search.
 */
async function listReports(category, maxPages = 20) {
  const token = await getToken();
  const out = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${reportBase()}/report-category/${encodeURIComponent(
      category
    )}/reports?page=${page}&pageSize=200`;
    const res = await fetch(url, { headers: headers(token) });

    if (res.status === 403 || res.status === 404) return out;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Report list failed for "${category}" (${res.status}): ${text.slice(0, 400)}`
      );
    }

    const json = await res.json();
    const data = json.data || json.items || [];
    out.push(...data);
    if (!json.hasMore) break;
  }

  return out;
}

/** Find which category a given report ID lives in. Stops on first match. */
async function findReport(reportId) {
  const target = String(reportId);
  const categories = await listReportCategories();
  const tried = [];

  for (const c of categories) {
    const key = categoryKey(c);
    if (!key) continue;

    let reports = [];
    try {
      reports = await listReports(key);
    } catch (err) {
      tried.push({ category: key, error: err.message });
      continue;
    }

    tried.push({ category: key, reportCount: reports.length });

    const hit = reports.find((r) => String(r.id) === target);
    if (hit) return { found: true, category: key, report: hit, tried };
  }

  return {
    found: false,
    category: null,
    report: null,
    tried,
    categories: categories.map(categoryKey),
  };
}

/**
 * Resolve a dynamic value set — the numbered dropdowns a report uses.
 *
 * This matters more than it looks. A parameter like DateType is typed as
 * "Number" with a dynamicSetId of "job-date-filter-type". Passing the wrong
 * number doesn't error; it silently filters the report by a different date
 * column, which produces an aging board that looks completely plausible and
 * is completely wrong.
 *
 * Tries both path spellings because this endpoint has been documented both
 * ways, and surfaces the failure clearly rather than guessing.
 */
async function getDynamicSet(dynamicSetId) {
  const token = await getToken();
  const attempts = [
    `${reportBase()}/dynamic-value-sets/${encodeURIComponent(dynamicSetId)}`,
    `${reportBase()}/dynamic-value-set/${encodeURIComponent(dynamicSetId)}`,
  ];

  const errors = [];

  for (const url of attempts) {
    const res = await fetch(url, { headers: headers(token) });
    if (res.ok) {
      const json = await res.json();
      return { url, raw: json, values: toObjects(json) };
    }
    const text = await res.text();
    errors.push(`${url} → ${res.status}: ${text.slice(0, 200)}`);
  }

  throw new Error(
    `Dynamic value set "${dynamicSetId}" could not be read. Attempts:\n` +
      errors.join('\n')
  );
}

/** Fetch the report's own definition: its fields and required parameters. */
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
 * Fetch one page of report data. `parameters` is an array of { name, value }.
 * Returns { fields, rows } where rows are plain objects keyed by field name.
 */
async function getReportData(category, reportId, parameters, pageSize = 500, page = 1) {
  const token = await getToken();
  const url = `${reportBase()}/report-category/${category}/reports/${reportId}/data?page=${page}&pageSize=${pageSize}&includeTotal=true`;

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
 * Fetch every page of report data.
 *
 * A single page caps at 500 rows. An AR report reaching back years will blow
 * past that, and a truncated feed would silently drop the oldest balances —
 * exactly the ones the board exists to surface. maxPages is a runaway guard,
 * and hitPageLimit is returned so the caller can warn instead of lying.
 */
async function getReportDataAll(category, reportId, parameters, pageSize = 500, maxPages = 20) {
  const all = [];
  let fields = [];
  let pagesFetched = 0;
  let hitPageLimit = false;

  for (let page = 1; page <= maxPages; page++) {
    const { raw, fields: f, rows } = await getReportData(
      category,
      reportId,
      parameters,
      pageSize,
      page
    );
    if (page === 1) fields = f;
    all.push(...rows);
    pagesFetched = page;

    if (!raw.hasMore) break;
    if (page === maxPages) hitPageLimit = true;
  }

  return { fields, rows: all, pagesFetched, hitPageLimit };
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

module.exports = {
  getToken,
  getReportMeta,
  getReportData,
  getReportDataAll,
  getDynamicSet,
  listReportCategories,
  listReports,
  findReport,
  categoryKey,
  toObjects,
  env,
};
