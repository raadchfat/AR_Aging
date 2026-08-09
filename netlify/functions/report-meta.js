/**
 * DISCOVERY ENDPOINT — diagnostics for the AR board. No customer names ever
 * leave this endpoint; every mode returns shape, not detail.
 *
 *   /api/report-meta                          fields + parameters
 *   /api/report-meta?categories=1             categories this app can read
 *   /api/report-meta?category=X&list=1        reports inside a category
 *   /api/report-meta?id=435                   inspect another report
 *   /api/report-meta?dynamicSet=business-units resolve a numbered dropdown
 *   /api/report-meta?distribution=1           money per aging bucket
 *   /api/report-meta?shape=1                  the diagnostic that matters:
 *                                             credits, concentration, and
 *                                             repeated exact amounts
 *
 * Add &exclUnapplied=1 or &exclUnapplied=0 to either data mode to override
 * the ExcludeUnappliedPayments parameter and compare the two runs.
 */

const {
  getReportMeta,
  getReportDataAll,
  getDynamicSet,
  listReportCategories,
  listReports,
  findReport,
  categoryKey,
} = require('./_st');

const cfg = require('../../config/board-config.json');

const AGING = ['Current', 'Aging30', 'Aging60', 'Aging90', 'Aging120', 'AgingPast120'];

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};

  try {
    if (q.categories) {
      const cats = await listReportCategories();
      return json(200, {
        ok: true,
        mode: 'categories',
        count: cats.length,
        categories: cats.map((c) => ({ key: categoryKey(c), name: (c && c.name) || null })),
      });
    }

    if (q.list) {
      const cat = q.category || cfg.report.category;
      if (!cat) return json(400, { ok: false, error: 'Use ?category=<key>&list=1' });
      const reports = await listReports(cat);
      return json(200, {
        ok: true,
        mode: 'reports',
        category: cat,
        count: reports.length,
        reports: reports.map((r) => ({ id: r.id, name: r.name || null })),
      });
    }

    if (q.dynamicSet) {
      const set = await getDynamicSet(q.dynamicSet);
      return json(200, {
        ok: true,
        mode: 'dynamicSet',
        dynamicSetId: q.dynamicSet,
        values: set.values,
      });
    }

    const reportId = q.id || cfg.report.id;
    if (!reportId) return json(400, { ok: false, error: 'No report ID.' });

    let category = q.category || cfg.report.category || null;
    if (!category) {
      const search = await findReport(reportId);
      if (!search.found) {
        return json(404, {
          ok: false,
          error: `Report ${reportId} not found in any readable category.`,
          tried: search.tried,
        });
      }
      category = search.category;
    }

    if (q.distribution || q.shape) {
      const params = { ...(cfg.report.parameters || {}) };
      if (q.exclUnapplied === '1') params.ExcludeUnappliedPayments = true;
      if (q.exclUnapplied === '0') params.ExcludeUnappliedPayments = false;

      const parameters = Object.entries(params).map(([name, value]) => ({ name, value }));
      const { fields, rows, pagesFetched, hitPageLimit } = await getReportDataAll(
        category,
        reportId,
        parameters
      );

      return json(
        200,
        q.shape
          ? shapeReport(rows, fields, params, pagesFetched, hitPageLimit, category, reportId)
          : distributionReport(rows, fields, params, pagesFetched, hitPageLimit, category, reportId)
      );
    }

    const meta = await getReportMeta(category, reportId);
    return json(200, {
      ok: true,
      mode: 'meta',
      category,
      reportId,
      summary: {
        reportName: meta.name || '(unnamed)',
        fields: (meta.fields || []).map((f) => ({ name: f.name, label: f.label, type: f.type })),
        parameters: (meta.parameters || []).map((p) => ({
          name: p.name,
          label: p.label,
          dataType: p.dataType,
          isRequired: p.isRequired,
        })),
      },
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
};

/** Money per aging bucket, splitting positives from credits. */
function distributionReport(rows, fields, params, pagesFetched, hitPageLimit, category, reportId) {
  const minBalance = (cfg.ar && cfg.ar.minBalance) || 0;
  const columns = {};

  for (const key of AGING) {
    columns[key] = { owedCount: 0, owedTotal: 0, creditCount: 0, creditTotal: 0, net: 0 };
  }

  let netAllCustomers = 0;
  let customersWithNetOwed = 0;

  for (const row of rows) {
    let rowNet = 0;
    for (const key of AGING) {
      const v = num(row[key]);
      const c = columns[key];
      if (v > 0) {
        c.owedCount++;
        c.owedTotal += v;
      } else if (v < 0) {
        c.creditCount++;
        c.creditTotal += v;
      }
      c.net += v;
      rowNet += v;
    }
    netAllCustomers += rowNet;
    if (rowNet > 0) customersWithNetOwed++;
  }

  for (const key of AGING) {
    columns[key].owedTotal = round2(columns[key].owedTotal);
    columns[key].creditTotal = round2(columns[key].creditTotal);
    columns[key].net = round2(columns[key].net);
  }

  const perBoardView = ((cfg.ar && cfg.ar.buckets) || []).map((b) => {
    let gross = 0;
    let netOnly = 0;
    let cards = 0;
    for (const row of rows) {
      const amt = b.fields.reduce((s, f) => s + num(row[f]), 0);
      const rowNet = AGING.reduce((s, f) => s + num(row[f]), 0);
      if (amt >= minBalance) {
        cards++;
        gross += amt;
        if (rowNet > 0) netOnly += amt;
      }
    }
    return {
      label: b.label,
      cardsThatWouldShow: cards,
      grossDollars: round2(gross),
      dollarsExcludingCustomersWhoNetToZeroOrCredit: round2(netOnly),
    };
  });

  return {
    ok: true,
    mode: 'distribution',
    category,
    reportId,
    parametersUsed: params,
    rowsReturned: rows.length,
    pagesFetched,
    hitPageLimit,
    fieldNamesSeen: fields.map((f) => f.name),
    customersWithNetOwed,
    netTotalOwed: round2(netAllCustomers),
    minBalanceApplied: minBalance,
    perAgingColumn: columns,
    perBoardView,
  };
}

/**
 * The diagnostic that decides the board design.
 *
 * Answers three questions without exposing a single customer name:
 *   1. How much of the old balance is offset by credits sitting elsewhere?
 *   2. Is the tail a long flat spread, or a handful of big accounts?
 *   3. Do the same exact dollar amounts repeat? Dozens of customers owing an
 *      identical figure is one broken recurring charge, not dozens of
 *      delinquent people — and it would be fixed in billing, not on a TV.
 */
function shapeReport(rows, fields, params, pagesFetched, hitPageLimit, category, reportId) {
  const old = [];
  let oldGross = 0;
  let creditsElsewhere = 0;
  let customersOldButNetClear = 0;

  for (const row of rows) {
    const oldAmt = num(row.Aging120) + num(row.AgingPast120);
    if (oldAmt <= 0) continue;

    const rowNet = AGING.reduce((s, f) => s + num(row[f]), 0);
    const offset = AGING.filter((f) => f !== 'Aging120' && f !== 'AgingPast120').reduce(
      (s, f) => Math.min(0, num(row[f])) + s,
      0
    );

    oldGross += oldAmt;
    creditsElsewhere += offset;
    if (rowNet <= 0) customersOldButNetClear++;

    old.push(round2(oldAmt));
  }

  old.sort((a, b) => b - a);

  const share = (n) => round2(old.slice(0, n).reduce((s, v) => s + v, 0));
  const counts = new Map();
  for (const v of old) counts.set(v, (counts.get(v) || 0) + 1);

  const repeated = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] * b[0] - a[1] * a[0])
    .slice(0, 20)
    .map(([amount, count]) => ({ amount, customers: count, total: round2(amount * count) }));

  return {
    ok: true,
    mode: 'shape',
    category,
    reportId,
    parametersUsed: params,
    rowsReturned: rows.length,
    pagesFetched,
    hitPageLimit,

    old91Plus: {
      customers: old.length,
      grossTotal: round2(oldGross),
      creditsSittingInOtherColumns: round2(creditsElsewhere),
      customersOldButNetClear,
      median: old.length ? old[Math.floor(old.length / 2)] : 0,
      largest: old[0] || 0,
      smallest: old[old.length - 1] || 0,
    },

    concentration: {
      top10: share(10),
      top25: share(25),
      top50: share(50),
      top100: share(100),
      all: round2(oldGross),
    },

    repeatedExactAmounts: repeated,
    repeatedNote:
      'Amounts owed by 3 or more customers, biggest total first. A large ' +
      'cluster on one figure points at a single billing or membership ' +
      'failure rather than many separate delinquencies.',
  };
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

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
