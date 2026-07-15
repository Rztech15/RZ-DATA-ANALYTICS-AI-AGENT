// RZ Data Analytics AI data worker — runs parsing, profiling, and all query_dataset /
// analyze_trend computation OFF the main thread, so loading or querying a
// large file never freezes the UI. The main thread sends small messages in
// ({id, type, payload}) and gets small messages back ({id, ok, result|error}).
//
// After a successful 'profile' call, this worker caches the dataset's rows
// in its own memory — later 'query'/'trend' calls don't need the rows
// re-sent, only the (tiny) query arguments, so repeated questions stay fast.

importScripts(
  'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
);

const MAX_ROWS = 100000;

let cachedFields = [];
let cachedRows = [];

// ---------- Parsing ----------

function parseCsvText(text) {
  const results = Papa.parse(text, { header: true, dynamicTyping: false, skipEmptyLines: true });
  return { fields: results.meta.fields || [], rows: results.data };
}

function parseExcelBuffer(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const fields = rows.length ? Object.keys(rows[0]) : [];
  const extraSheets = wb.SheetNames.length > 1 ? wb.SheetNames.slice(1) : [];
  return { fields, rows, sheetUsed: sheetName, extraSheets };
}

function parseJsonText(text) {
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : (parsed.data && Array.isArray(parsed.data) ? parsed.data : null);
  if (!rows) throw new Error("JSON file must be an array of records (or an object with a 'data' array).");
  const fieldSet = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => fieldSet.add(k)));
  return { fields: Array.from(fieldSet), rows };
}

function capRows(parsed) {
  if (parsed.rows.length > MAX_ROWS) {
    parsed.rows = parsed.rows.slice(0, MAX_ROWS);
    parsed.rowCapNote = `Only the first ${MAX_ROWS.toLocaleString()} rows were loaded (source had more) to keep things responsive.`;
  }
  return parsed;
}

// ---------- Profiling (ported verbatim from the app's original logic) ----------

function isDateLike(name) {
  return /date|day|month|year|time/i.test(name);
}

function computeProfile(data, fields) {
  const rowCount = data.length;
  const cols = fields.map((f) => {
    let missing = 0, numeric = 0;
    const seen = new Set();
    data.forEach((row) => {
      const v = row[f];
      if (v === null || v === undefined || v === "") missing++;
      else {
        if (!isNaN(parseFloat(v)) && isFinite(v)) numeric++;
        seen.add(v);
      }
    });
    const type = numeric / Math.max(rowCount - missing, 1) > 0.8 ? "numeric" : "text";
    return { name: f, type, missing, missingPct: rowCount ? ((missing / rowCount) * 100).toFixed(1) : "0", distinct: seen.size };
  });
  const seenRows = new Set();
  let dupRows = 0;
  data.forEach((row) => {
    const key = JSON.stringify(row);
    if (seenRows.has(key)) dupRows++;
    seenRows.add(key);
  });
  const totalMissing = cols.reduce((a, c) => a + c.missing, 0);
  const totalCells = rowCount * fields.length;
  const qualityScore = totalCells ? Math.max(0, 100 - (totalMissing / totalCells) * 100 - (dupRows / Math.max(rowCount, 1)) * 30) : 100;

  const keyLike = cols.filter(c => /id$|code|key$|sku|invoice|order/i.test(c.name) && c.distinct > 1);
  const duplicateKeys = keyLike.map(c => {
    const nonMissing = rowCount - c.missing;
    const dupCount = nonMissing - c.distinct;
    return { name: c.name, dupCount };
  }).filter(k => k.dupCount > 0);

  const anomalies = [];
  const moneyLike = /price|cost|amount|revenue|salary|profit|total|fee|charge/i;
  const qtyLike = /quantity|qty|units|count/i;
  const ageLike = /^age$|_age$|age_/i;

  cols.forEach(c => {
    if (c.type !== 'numeric') return;
    const values = data.map(r => parseFloat(r[c.name])).filter(v => !isNaN(v));
    if (!values.length) return;

    if ((moneyLike.test(c.name) || qtyLike.test(c.name))) {
      const negCount = values.filter(v => v < 0).length;
      if (negCount > 0) anomalies.push({ type: 'Negative values', column: c.name, count: negCount });
    }
    if (ageLike.test(c.name)) {
      const badAge = values.filter(v => v < 0 || v > 120).length;
      if (badAge > 0) anomalies.push({ type: 'Impossible age', column: c.name, count: badAge });
    }

    const sorted = [...values].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    if (iqr > 0) {
      const lower = q1 - 1.5 * iqr, upper = q3 + 1.5 * iqr;
      const outliers = values.filter(v => v < lower || v > upper).length;
      if (outliers > 0) anomalies.push({ type: 'Statistical outliers', column: c.name, count: outliers });
    }
  });

  cols.forEach(c => {
    if (!isDateLike(c.name)) return;
    const today = new Date();
    let futureCount = 0;
    data.forEach(r => {
      const d = new Date(r[c.name]);
      if (!isNaN(d.getTime()) && d > today) futureCount++;
    });
    if (futureCount > 0) anomalies.push({ type: 'Future dates', column: c.name, count: futureCount });
  });

  return { rowCount, colCount: fields.length, cols, dupRows, qualityScore: qualityScore.toFixed(0), duplicateKeys, anomalies };
}

// ---------- Query engine (ported from the app's tool implementation) ----------

function coerceNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[, $%]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function applyDataFilters(rows, filters) {
  if (!Array.isArray(filters) || !filters.length) return rows;
  return rows.filter(row => filters.every(f => {
    if (!f || !f.column) return true;
    const raw = row[f.column];
    const op = f.op || '=';
    if (op === 'contains') return String(raw ?? '').toLowerCase().includes(String(f.value ?? '').toLowerCase());
    const numRaw = coerceNumber(raw);
    const numVal = coerceNumber(f.value);
    if (numRaw !== null && numVal !== null) {
      switch (op) {
        case '=': return numRaw === numVal;
        case '!=': return numRaw !== numVal;
        case '>': return numRaw > numVal;
        case '<': return numRaw < numVal;
        case '>=': return numRaw >= numVal;
        case '<=': return numRaw <= numVal;
      }
    }
    const sRaw = String(raw ?? '').toLowerCase();
    const sVal = String(f.value ?? '').toLowerCase();
    return op === '!=' ? sRaw !== sVal : sRaw === sVal;
  }));
}

function computeAggregateValue(rows, metric, column) {
  if (metric === 'count') return rows.length;
  if (metric === 'distinct_count') return new Set(rows.map(r => String(r[column] ?? ''))).size;
  const nums = rows.map(r => coerceNumber(r[column])).filter(n => n !== null);
  if (!nums.length) return null;
  switch (metric) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    case 'median': {
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    default: return null;
  }
}

function pearsonCorrelation(rows, colA, colB) {
  const pairs = rows.map(r => [coerceNumber(r[colA]), coerceNumber(r[colB])]).filter(([a, b]) => a !== null && b !== null);
  if (pairs.length < 2) return null;
  const n = pairs.length;
  const meanA = pairs.reduce((s, p) => s + p[0], 0) / n;
  const meanB = pairs.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, denA = 0, denB = 0;
  pairs.forEach(([a, b]) => { num += (a - meanA) * (b - meanB); denA += (a - meanA) ** 2; denB += (b - meanB) ** 2; });
  const den = Math.sqrt(denA * denB);
  return den === 0 ? null : num / den;
}

function runDataQuery(args) {
  if (!cachedRows.length) return { error: 'No dataset is currently loaded.' };
  const { metric, column, column2, group_by, filters, sort, limit } = args || {};
  if (!metric) return { error: 'metric is required.' };
  for (const [label, col] of [['column', column], ['column2', column2], ['group_by', group_by]]) {
    if (col && !cachedFields.includes(col)) {
      return { error: `${label} "${col}" not found. Available columns: ${cachedFields.join(', ')}` };
    }
  }

  let rows;
  try { rows = applyDataFilters(cachedRows, filters); }
  catch (e) { return { error: 'Invalid filters: ' + e.message }; }
  const matched_rows = rows.length;
  if (!matched_rows) return { metric, matched_rows: 0, note: 'No rows matched the given filters.' };

  if (metric === 'correlation') {
    if (!column || !column2) return { error: 'correlation requires both column and column2.' };
    return { metric, column, column2, value: pearsonCorrelation(rows, column, column2), matched_rows };
  }

  if (group_by) {
    const groups = new Map();
    rows.forEach(r => {
      const key = String(r[group_by] ?? '(blank)');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });
    let result = Array.from(groups.entries()).map(([group, groupRows]) => ({
      group, value: computeAggregateValue(groupRows, metric, column), row_count: groupRows.length
    }));
    if (sort === 'asc') result.sort((a, b) => (a.value ?? -Infinity) - (b.value ?? -Infinity));
    else if (sort === 'desc') result.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
    if (limit && Number.isFinite(limit)) result = result.slice(0, limit);
    return { metric, column, group_by, matched_rows, groups: result };
  }

  return { metric, column, value: computeAggregateValue(rows, metric, column), matched_rows };
}

// ---------- Trend / forecast engine (ported from the app's tool implementation) ----------

function periodStart(date, period) {
  const y = date.getFullYear(), m = date.getMonth(), day = date.getDate();
  switch (period) {
    case 'day': return new Date(y, m, day);
    case 'week': {
      const d = new Date(y, m, day);
      const dow = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - dow);
      return d;
    }
    case 'quarter': return new Date(y, Math.floor(m / 3) * 3, 1);
    case 'year': return new Date(y, 0, 1);
    case 'month':
    default: return new Date(y, m, 1);
  }
}

function periodKey(date, period) {
  const y = date.getFullYear(), m = date.getMonth() + 1, day = date.getDate();
  const pad = n => String(n).padStart(2, '0');
  switch (period) {
    case 'day': return `${y}-${pad(m)}-${pad(day)}`;
    case 'week': return `${y}-${pad(m)}-${pad(day)}`;
    case 'quarter': return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case 'year': return `${y}`;
    case 'month':
    default: return `${y}-${pad(m)}`;
  }
}

function advancePeriod(date, period, n) {
  const d = new Date(date);
  switch (period) {
    case 'day': d.setDate(d.getDate() + n); break;
    case 'week': d.setDate(d.getDate() + 7 * n); break;
    case 'quarter': d.setMonth(d.getMonth() + 3 * n); break;
    case 'year': d.setFullYear(d.getFullYear() + n); break;
    case 'month':
    default: d.setMonth(d.getMonth() + n); break;
  }
  return d;
}

function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] || 0, r2: 0 };
  const xs = values.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (values[i] - meanY); den += (xs[i] - meanX) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;
  const predicted = xs.map(x => slope * x + intercept);
  const ssRes = values.reduce((s, v, i) => s + (v - predicted[i]) ** 2, 0);
  const ssTot = values.reduce((s, v) => s + (v - meanY) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

function runAnalyzeTrend(args) {
  if (!cachedRows.length) return { error: 'No dataset is currently loaded.' };
  const { date_column, value_column, metric = 'sum', period = 'month', filters, forecast_periods } = args || {};
  if (!date_column || !cachedFields.includes(date_column)) {
    return { error: `date_column "${date_column}" not found. Available columns: ${cachedFields.join(', ')}` };
  }
  if (!value_column || !cachedFields.includes(value_column)) {
    return { error: `value_column "${value_column}" not found. Available columns: ${cachedFields.join(', ')}` };
  }
  let rows;
  try { rows = applyDataFilters(cachedRows, filters); }
  catch (e) { return { error: 'Invalid filters: ' + e.message }; }
  if (!rows.length) return { matched_rows: 0, note: 'No rows matched the given filters.' };

  const buckets = new Map();
  let unparsedDates = 0;
  rows.forEach(r => {
    const d = new Date(r[date_column]);
    if (isNaN(d.getTime())) { unparsedDates++; return; }
    const rep = periodStart(d, period);
    const key = periodKey(rep, period);
    if (!buckets.has(key)) buckets.set(key, { repDate: rep, rows: [] });
    buckets.get(key).rows.push(r);
  });
  if (!buckets.size) return { error: `No valid dates found in "${date_column}".`, unparsed_rows: unparsedDates };

  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => buckets.get(a).repDate - buckets.get(b).repDate);
  const series = sortedKeys.map(k => ({ period: k, value: computeAggregateValue(buckets.get(k).rows, metric, value_column) }));
  const values = series.map(p => p.value ?? 0);
  const reg = linearRegression(values);
  const scale = Math.max(...values.map(v => Math.abs(v)), 1);
  const direction = Math.abs(reg.slope) < scale * 0.005 ? 'flat' : (reg.slope > 0 ? 'increasing' : 'decreasing');

  let period_over_period_change_pct = null;
  if (values.length >= 2) {
    const prev = values[values.length - 2], curr = values[values.length - 1];
    period_over_period_change_pct = prev === 0 ? null : Number((((curr - prev) / Math.abs(prev)) * 100).toFixed(2));
  }

  const result = {
    date_column, value_column, metric, period,
    matched_rows: rows.length,
    unparsed_dates: unparsedDates,
    periods: series,
    trend: { direction, slope_per_period: Number(reg.slope.toFixed(4)), fit_quality_r2: Number(reg.r2.toFixed(3)) },
    period_over_period_change_pct
  };

  const n = Math.min(Number(forecast_periods) || 0, 12);
  if (n > 0) {
    const lastRep = buckets.get(sortedKeys[sortedKeys.length - 1]).repDate;
    const startX = values.length - 1;
    result.forecast = Array.from({ length: n }, (_, i) => ({
      period: periodKey(advancePeriod(lastRep, period, i + 1), period),
      projected_value: Number((reg.slope * (startX + i + 1) + reg.intercept).toFixed(2))
    }));
    result.forecast_note = 'Simple linear-trend projection from historical data — does not account for seasonality or external factors. Present as a rough estimate, not a guarantee.';
  }

  return result;
}

// ---------- Message dispatch ----------

self.onmessage = (e) => {
  const { id, type, payload } = e.data || {};
  try {
    let result;
    switch (type) {
      case 'parse_csv':
        result = capRows(parseCsvText(payload.text));
        break;
      case 'parse_excel':
        result = capRows(parseExcelBuffer(payload.arrayBuffer));
        break;
      case 'parse_json':
        result = capRows(parseJsonText(payload.text));
        break;
      case 'profile':
        cachedFields = payload.fields;
        cachedRows = payload.rows;
        result = computeProfile(payload.rows, payload.fields);
        break;
      case 'query':
        result = runDataQuery(payload);
        break;
      case 'trend':
        result = runAnalyzeTrend(payload);
        break;
      case 'clear':
        cachedFields = [];
        cachedRows = [];
        result = { cleared: true };
        break;
      default:
        throw new Error('Unknown worker message type: ' + type);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};
