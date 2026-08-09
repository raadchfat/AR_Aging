/**
 * AR BOARD FEED — served at /api/ar
 *
 * Returns everything the board needs in one response: three cumulative
 * gauges, the worklist, the membership tile, the slipping count, and the
 * week-over-week movement.
 *
 * Two things worth knowing before changing anything in here.
 *
 * 1. CACHING IS NOT OPTIONAL. ServiceTitan allows roughly five calls per
 *    report per minute per tenant. Every browser that loads the board would
 *    otherwise trigger its own call, so one TV plus a phone plus a forgotten
 *    tab is enough to start returning 429s during the workday. The module
 *    holds the result for refreshMinutes and serves every visitor from that
 *    copy.
 *
 * 2. `Total` IS NOT THE BALANCE. The report's Total field is invoice total —
 *    a customer can show $14,602 there while owing $105.93. Amount owed is
 *    the sum of the six aging columns. Never wire Total to a card.
 */

const { getReportDataAll } = require('./_st');
const cfg = require('../../config/board-config.json');

const AGING = ['Current', 'Aging30', 'Aging60', 'Aging90', 'Aging120', 'AgingPast120'];

let cache = { at: 0, payload: null };

// Last week's snapshot is cached separately and for far longer, because the
// numbers as of a fixed past date do not change. Without this, every refresh
// fired two report calls back to back against a five-per-minute ceiling and
// the comparison was the thing that got rate-limited away.
let priorCache = { date: '', snap: null, failedAt: 0 };

async function getPrior(priorDate) {
  if (priorCache.date === priorDate && priorCache.snap) {
    return { snap: priorCache.snap, error: null };
  }
  if (priorCache.date === priorDate && Date.now() - priorCache.failedAt < 5 * 60 * 1000) {
    return { snap: null, error: 'Comparison unavailable — retrying in a few minutes.' };
  }
  try {
    const snap = await snapshot(priorDate);
    priorCache = { date: priorDate, snap, failedAt: 0 };
    return { snap, error: null };
  } catch (err) {
    const keep = priorCache.date === priorDate ? priorCache.snap : null;
    priorCache = { date: priorDate, snap: keep, failedAt: Date.now() };
    return { snap: keep, error: err.message };
  }
}

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const debug = q.debug === '1';
  const ttlMs = (cfg.ar.refreshMinutes || 15) * 60 * 1000;

  try {
    if (!debug && q.nocache !== '1' && cache.payload && Date.now() - cache.at < ttlMs) {
      return json(200, {
        ...cache.payload,
        servedFromCache: true,
        cacheAgeSeconds: Math.round((Date.now() - cache.at) / 1000),
      });
    }

    const tz = cfg.timezone || 'America/Chicago';
    const today = ymd(new Date(), tz);
    const priorDate = ymd(new Date(Date.now() - (cfg.ar.compareDaysAgo || 7) * 86400000), tz);

    const current = await snapshot(today);

    // Week-over-week movement comes from re-running the same report with an
    // earlier AsOfDate rather than from stored history — no database, and the
    // comparison uses ServiceTitan's numbers on both ends. If the historical
    // run fails for any reason, the board drops the delta rather than the data.
    const { snap: prior, error: priorError } = await getPrior(priorDate);

    const payload = build(current, prior, today, priorDate, priorError, debug);
    cache = { at: Date.now(), payload };

    return json(200, { ...payload, servedFromCache: false, cacheAgeSeconds: 0 });
  } catch (err) {
    // Serve stale rather than blank. A board showing five-hour-old numbers
    // with an honest timestamp beats a board showing an error.
    if (cache.payload) {
      return json(200, {
        ...cache.payload,
        servedFromCache: true,
        stale: true,
        cacheAgeSeconds: Math.round((Date.now() - cache.at) / 1000),
        error: err.message,
      });
    }
    return json(500, { ok: false, error: err.message });
  }
};

async function snapshot(asOfDate) {
  const params = { ...(cfg.report.parameters || {}), AsOfDate: asOfDate };
  const parameters = Object.entries(params).map(([name, value]) => ({ name, value }));

  const { rows, pagesFetched, hitPageLimit } = await getReportDataAll(
    cfg.report.category,
    cfg.report.id,
    parameters
  );

  const m = cfg.ar.membership || {};
  const tol = m.tolerance || 0.02;
  const amounts = m.enabled === false ? [] : m.amounts || [];

  const real = [];
  const membership = [];

  for (const row of rows) {
    const cols = {};
    let owed = 0;
    for (const f of AGING) {
      const v = num(row[f]);
      cols[f] = v;
      owed += v;
    }
    if (owed <= 0) continue;

    const entry = { name: String(row.CustomerName || '').trim(), owed: round2(owed), cols };

    if (amounts.some((a) => Math.abs(owed - a) <= tol)) membership.push(entry);
    else real.push(entry);
  }

  return { asOfDate, rows: rows.length, real, membership, pagesFetched, hitPageLimit };
}

function sumFields(list, fields) {
  let t = 0;
  for (const e of list) for (const f of fields) t += Math.max(0, e.cols[f] || 0);
  return round2(t);
}

function baseTotal(list) {
  let t = 0;
  for (const e of list) t += Math.max(0, e.owed);
  return round2(t);
}

function build(cur, prior, today, priorDate, priorError, debug) {
  const bands = cfg.ar.bands || { goodMax: 20, warnMax: 50 };
  const labels = cfg.ar.bandLabels || { good: 'ON TRACK', warn: 'WATCH', bad: 'CRITICAL' };

  const base = baseTotal(cur.real);
  const priorBase = prior ? baseTotal(prior.real) : null;

  const gauges = (cfg.ar.gauges || []).map((g) => {
    const amount = sumFields(cur.real, g.fields);
    const pct = base > 0 ? round1((amount / base) * 100) : 0;

    let priorPct = null;
    if (prior && priorBase > 0) {
      priorPct = round1((sumFields(prior.real, g.fields) / priorBase) * 100);
    }

    const band = pct <= bands.goodMax ? 'good' : pct < bands.warnMax ? 'warn' : 'bad';

    return {
      key: g.key,
      label: g.label,
      percent: pct,
      amount,
      band,
      // Status colour never travels alone — the board prints this word and the
      // number beside every dial, so the reading survives colour blindness,
      // a washed-out screen, and a photo of the screen.
      bandLabel: labels[band],
      priorPercent: priorPct,
      deltaPercent: priorPct === null ? null : round1(pct - priorPct),
    };
  });

  const oldestFields = (cfg.ar.oldest && cfg.ar.oldest.fields) || ['Aging120', 'AgingPast120'];
  const oldest = sumFields(cur.real, oldestFields);
  const priorOldest = prior ? sumFields(prior.real, oldestFields) : null;

  const slipCfg = cfg.ar.slipping || { fields: ['Aging60', 'Aging90'] };
  const slipping = cur.real.filter(
    (e) => slipCfg.fields.reduce((s, f) => s + Math.max(0, e.cols[f] || 0), 0) > 0
  );

  // Rank by past-due money, never by total owed. A customer invoiced $30,500
  // two weeks ago owes nothing late and does not belong on a collections
  // worklist — sorting by total put five such customers in the top twenty
  // and pushed real past-due accounts off the screen entirely.
  const wcfg = cfg.ar.worklist || {};
  const basis = wcfg.basis || ['Aging60', 'Aging90', 'Aging120', 'AgingPast120'];
  const minPastDue = wcfg.minPastDue || 0;

  const withPastDue = cur.real
    .map((e) => ({ ...e, pastDue: round2(basis.reduce((s, f) => s + Math.max(0, e.cols[f] || 0), 0)) }))
    .filter((e) => e.pastDue >= minPastDue)
    .sort((a, b) => b.pastDue - a.pastDue);

  const worklist = withPastDue.slice(0, wcfg.size || 20).map((e, i) => ({
    rank: i + 1,
    name: displayName(e.name),
    pastDue: e.pastDue,
    totalOwed: e.owed,
    // Flagged so the board can say so out loud: this customer owes more than
    // is actually late, and the caller should ask about the past-due part only.
    hasCurrentToo: e.owed - e.pastDue > 0.5,
    oldestBucket: oldestBucketLabel(e.cols),
  }));

  const shown = worklist.reduce((s, e) => s + e.pastDue, 0);
  const notShownTotal = round2(withPastDue.reduce((s, e) => s + e.pastDue, 0) - shown);

  const membershipTotal = round2(cur.membership.reduce((s, e) => s + e.owed, 0));
  const mcfg = cfg.ar.membership || {};

  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    asOfDate: today,
    comparedTo: prior ? priorDate : null,
    comparisonAvailable: !!prior,
    comparisonError: priorError,

    title: cfg.ar.title || 'ACCOUNTS RECEIVABLE',
    subtitle: cfg.ar.subtitle || '',
    bands,

    totals: {
      collectableAR: base,
      collectableARPrior: priorBase,
      collectableARDelta: priorBase === null ? null : round2(base - priorBase),
      customers: cur.real.length,
    },

    gauges,

    oldestTile: {
      label: (cfg.ar.oldest && cfg.ar.oldest.label) || 'Over 90 Days',
      amount: oldest,
      prior: priorOldest,
      delta: priorOldest === null ? null : round2(oldest - priorOldest),
      customers: cur.real.filter(
        (e) => oldestFields.reduce((s, f) => s + Math.max(0, e.cols[f] || 0), 0) > 0
      ).length,
    },

    membershipTile: {
      enabled: mcfg.enabled !== false,
      label: mcfg.label || 'Membership Dues',
      note: mcfg.note || '',
      owner: mcfg.owner || '',
      customers: cur.membership.length,
      amount: membershipTotal,
    },

    slippingTile: {
      label: slipCfg.label || 'Slipping',
      sublabel: slipCfg.sublabel || '',
      customers: slipping.length,
      amount: sumFields(slipping, slipCfg.fields),
      emptyMessage: slipCfg.emptyMessage || 'Nothing slipping.',
    },

    worklist,
    worklistLabel: wcfg.columnLabel || 'Past Due',
    worklistOverflow: {
      customersNotShown: Math.max(0, withPastDue.length - worklist.length),
      amountNotShown: notShownTotal < 0 ? 0 : notShownTotal,
      minPastDue,
    },

    checklist: cfg.ar.checklist || [],
  };

  if (debug) {
    payload.debug = {
      reportId: cfg.report.id,
      category: cfg.report.category,
      parameters: cfg.report.parameters,
      currentRows: cur.rows,
      pagesFetched: cur.pagesFetched,
      hitPageLimit: cur.hitPageLimit,
      realCustomers: cur.real.length,
      membershipCustomers: cur.membership.length,
      priorRows: prior ? prior.rows : null,
      membershipAmountsMatched: mcfg.amounts,
      note: 'debug=1 bypasses the cache and always hits ServiceTitan.',
    };
  }

  return payload;
}

function oldestBucketLabel(cols) {
  const order = ['AgingPast120', 'Aging120', 'Aging90', 'Aging60', 'Aging30', 'Current'];
  const map = cfg.ar.bucketLabels || {};
  for (const f of order) if (Math.max(0, cols[f] || 0) > 0) return map[f] || f;
  return '';
}

function displayName(name) {
  const style = (cfg.ar.privacy && cfg.ar.privacy.nameStyle) || 'full';
  if (!name) return '(no name)';
  if (style === 'hidden') return 'Customer';
  if (style === 'initial') {
    const parts = name.split(/\s+/);
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[parts.length - 1][0]}.`;
  }
  return name;
}

function ymd(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: JSON.stringify(body, null, 2),
  };
}
