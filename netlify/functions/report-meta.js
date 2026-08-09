/**
 * DISCOVERY ENDPOINT — run this before writing any field mapping.
 *
 * Usage — open these in a browser:
 *
 *   /api/report-meta
 *       Fields and parameters for the configured report.
 *
 *   /api/report-meta?categories=1
 *       Every report category this app is approved to read.
 *
 *   /api/report-meta?category=accounting&list=1
 *       Every report inside one category, with IDs.
 *
 *   /api/report-meta?id=435
 *       Inspect any other report without editing config.
 *
 *   /api/report-meta?dynamicSet=business-units
 *       Resolve a numbered dropdown to its real values.
 *
 *   /api/report-meta?distribution=1
 *       Run the configured report for real and report how the money is
 *       actually spread across the aging buckets — counts and dollar totals
 *       only, NO customer names. This exists so the board gets designed
 *       around the shape of the real data instead of an assumption, without
 *       pulling customer detail anywhere it doesn't need to go.
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

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};

  try {
    if (q.categories) {
      const cats = await listReportCategories();
      return json(200, {
        ok: true,
        mode: 'categories',
        count: cats.length,
        categories: cats.map((c) => ({
          key: categoryKey(c),
          name: c && c.name ? c.name : null,
        })),
      });
    }

    if (q.list) {
      const cat = q.category || cfg.report.category;
      if (!cat) {
        return json(400, { ok: false, error: 'Use ?category=<key>&list=1' });
      }
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
        resolvedFrom: set.url,
        values: set.values,
      });
    }

    const reportId = q.id || cfg.report.id;
    if (!reportId) return json(400, { ok: false, error: 'No report ID.' });

    let category = q.category || cfg.report.category || null;
    let discovered = false;

    if (!category) {
      const search = await findReport(reportId);
      if (!search.found) {
        return json(404, {
          ok: false,
          error: `Report ${reportId} not found in any readable category.`,
          categoriesSearched: search.categories,
          tried: search.tried,
        });
      }
      category = search.category;
      discovered = true;
    }

    // --- Distribution: run the report, return shape only, never names -------
    if (q.distribution) {
      const parameters = Object.entries(cfg.report.parameters || {}).map(
        ([name, value]) => ({ name, value })
      );

      const { fields, rows, pagesFetched, hitPageLimit } = await getReportDataAll(
        category,
        reportId,
        parameters
      );

      const AGING = ['Current', 'Aging30', 'Aging60', 'Aging90', 'Aging120', 'AgingPast120'];
      const minBalance = (cfg.ar && cfg.ar.minBalance) || 0;

      const columns = {};
      for (const key of AGING) {
        columns[key] = { customersWithMoney: 0, aboveMinBalance: 0, total: 0 };
      }

      let customersWithAnyBalance = 0;
      let grandTotal = 0;

      for (const row of rows) {
        let rowOwed = 0;
        for (const key of AGING) {
          const v = num(row[key]);
          if (v > 0) {
            columns[key].customersWithMoney++;
            columns[key].total += v;
            if (v >= minBalance) columns[key].aboveMinBalance++;
          }
          rowOwed += v;
        }
        if (rowOwed > 0) customersWithAnyBalance++;
        grandTotal += rowOwed;
      }

      for (const key of AGING) columns[key].total = round2(columns[key].total);

      const boardBuckets = ((cfg.ar && cfg.ar.buckets) || []).map((b) => {
        let total = 0;
        let cards = 0;
        for (const row of rows) {
          const amt = b.fields.reduce((s, f) => s + num(row[f]), 0);
          if (amt >= minBalance) {
            cards++;
            total += amt;
          }
        }
        return {
          label: b.label,
          cardsThatWouldShow: cards,
          totalDollars: round2(total),
        };
      });

      return json(200, {
        ok: true,
        mode: 'distribution',
        category,
        reportId,
        rowsReturned: rows.length,
        pagesFetched,
        hitPageLimit,
        fieldNamesSeen: fields.map((f) => f.name),
        customersWithAnyBalance,
        grandTotalOwed: round2(grandTotal),
        minBalanceApplied: minBalance,
        perAgingColumn: columns,
        perBoardView: boardBuckets,
        note:
          'No customer names or amounts per customer are included in this ' +
          'response by design.',
      });
    }

    const meta = await getReportMeta(category, reportId);

    return json(200, {
      ok: true,
      mode: 'meta',
      category,
      categoryWasDiscovered: discovered,
      reportId,
      summary: {
        reportName: meta.name || '(unnamed)',
        fields: (meta.fields || []).map((f) => ({
          name: f.name,
          label: f.label,
          type: f.type,
        })),
        parameters: (meta.parameters || []).map((p) => ({
          name: p.name,
          label: p.label,
          dataType: p.dataType,
          isRequired: p.isRequired,
          isArray: p.isArray,
          dynamicSetId: (p.acceptValues && p.acceptValues.dynamicSetId) || null,
        })),
      },
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
};

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
