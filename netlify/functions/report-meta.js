/**
 * DISCOVERY ENDPOINT — run this once, then it's just a diagnostic tool.
 *
 * Hit /.netlify/functions/report-meta in a browser and it tells you:
 *   - every field the report returns, with its exact API name
 *   - every parameter the report requires, and which are mandatory
 *
 * We need this because parameter names are defined by the report itself,
 * not by ServiceTitan globally. Guessing them produces cryptic errors like
 * "Missed report parameter: [From]".
 */

const { getReportMeta } = require('./_st');
const cfg = require('../../config/board-config.json');

exports.handler = async () => {
  try {
    const meta = await getReportMeta(cfg.report.category, cfg.report.id);

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

    return json(200, { ok: true, summary, rawMeta: meta });
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
