/**
 * DISCOVERY ENDPOINT — run this before writing any field mapping.
 *
 * Parameter names and field names are defined by the individual report, not
 * by ServiceTitan globally, and they come back as camelCase API names rather
 * than the labels you see in an Excel export. Guessing them produces either
 * cryptic errors ("Missed report parameter: [From]") or, worse, a board full
 * of silent zeros.
 *
 * Usage — open these in a browser:
 *
 *   /api/report-meta
 *       Full discovery. If config has no category set, this finds which
 *       category the configured report ID lives in, then dumps its fields
 *       and parameters.
 *
 *   /api/report-meta?categories=1
 *       Just list every report category this app is approved to read.
 *       Run this first if discovery fails — it tells you instantly whether
 *       the app's scope is the problem.
 *
 *   /api/report-meta?category=accounting&list=1
 *       List every report inside one category, with its ID and name.
 *
 *   /api/report-meta?id=50188174
 *       Inspect a specific report ID, searching for its category.
 *
 *   /api/report-meta?category=accounting&id=50188174
 *       Skip the search entirely when you already know both.
 */

const {
  getReportMeta,
  listReportCategories,
  listReports,
  findReport,
  categoryKey,
} = require('./_st');

const cfg = require('../../config/board-config.json');

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};

  try {
    // --- Mode 1: list the categories this app can see -----------------------
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
        note:
          'The "key" value is what goes in config.report.category. If the ' +
          'category holding your AR report is missing from this list, the ' +
          'app has not been approved for it.',
      });
    }

    // --- Mode 2: list the reports inside one category -----------------------
    if (q.list) {
      const cat = q.category || cfg.report.category;
      if (!cat) {
        return json(400, {
          ok: false,
          error: 'No category given. Use /api/report-meta?category=<key>&list=1',
        });
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

    // --- Mode 3: full discovery for one report ------------------------------
    const reportId = q.id || cfg.report.id;
    if (!reportId) {
      return json(400, { ok: false, error: 'No report ID in config or query.' });
    }

    let category = q.category || cfg.report.category || null;
    let discovered = false;

    if (!category) {
      const search = await findReport(reportId);
      if (!search.found) {
        return json(404, {
          ok: false,
          error: `Report ${reportId} was not found in any category this app can read.`,
          hint:
            'Almost always this means the app is not approved for the ' +
            'category the report lives in. Check "tried" below — if the ' +
            'accounting/financial category is missing entirely, fix the app ' +
            'scope in the ServiceTitan developer portal and re-approve it.',
          categoriesSearched: search.categories,
          tried: search.tried,
        });
      }
      category = search.category;
      discovered = true;
    }

    const meta = await getReportMeta(category, reportId);

    const summary = {
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
        acceptValues: p.acceptValues || null,
      })),
    };

    return json(200, {
      ok: true,
      mode: 'meta',
      category,
      categoryWasDiscovered: discovered,
      reportId,
      nextStep: discovered
        ? `Put "category": "${category}" into config/board-config.json under "report".`
        : 'Category came from config.',
      summary,
      rawMeta: meta,
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body, null, 2),
  };
}
