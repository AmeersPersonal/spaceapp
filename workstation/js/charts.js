// charts.js — pure SVG string builders for the two evidence charts.
//
// No DOM, no globals, no imports. Every function takes plain data and returns
// an SVG string that main.js assigns with innerHTML. All text that comes from
// data is escaped. Class names are the contract with css/components.css §5.11.
//
// The scientific rule enforced here: a prediction never looks like a
// measurement. Observed values are solid lines and round dots; model values
// are dashed lines and rotated squares, drawn only past the NOW boundary and
// over a hatched region. The point chart never draws a forecast value.

const WIDTH = 300;
const HEIGHT = 130;
const PAD = Object.freeze({ l: 30, r: 8, t: 10, b: 20 });
const HIT_RADIUS = 9;
const DOT_RADIUS = 2.5;
const DIAMOND_SIDE = 5;
const DIAMOND_ACTIVE_SIDE = 8;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

// ---------- small helpers ----------

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeId(id) {
  const cleaned = String(id ?? 'chart').replace(/[^A-Za-z0-9_-]/g, '-');
  return cleaned || 'chart';
}

function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: m[1], month, day: m[3] };
}

// '2026-04-21' → '21 APR'
export function formatShortDate(iso) {
  const d = parseIso(iso);
  return d ? `${d.day} ${MONTHS[d.month - 1]}` : String(iso ?? '');
}

// '2026-04-21' → '21 APR 2026'
export function formatLongDate(iso) {
  const d = parseIso(iso);
  return d ? `${d.day} ${MONTHS[d.month - 1]} ${d.year}` : String(iso ?? '');
}

function fmt2(v) {
  return Number(v).toFixed(2);
}

// Axis tick text: 0 / .5 / 1 for the unit domain; otherwise trimmed decimals.
function formatTick(v) {
  if (Number.isInteger(v)) return String(v);
  let s = Number(v).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  s = s.replace(/^(-?)0\./, '$1.');
  return s;
}

function countWord(n) {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

function round(v) {
  return Math.round(v * 100) / 100;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------- frame ----------

export function plotFrame({
  id,
  width = WIDTH,
  height = HEIGHT,
  n,
  nowIndex,
  hasForecast,
  yDomain = [0, 1],
  title,
  desc,
  firstLabel = '',
  lastLabel = '',
} = {}) {
  const sid = safeId(id);
  const pad = { ...PAD };
  const count = Math.max(0, Number(n) || 0);
  const span = count > 1 ? count - 1 : 1;
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const [d0, d1raw] = yDomain;
  const d1 = d1raw === d0 ? d0 + 1 : d1raw;

  const x = (i) => round(pad.l + (i / span) * plotW);
  const y = (v) => round(pad.t + (1 - (v - d0) / (d1 - d0)) * plotH);

  const showNow = Boolean(hasForecast) && isNum(nowIndex) && nowIndex >= 0 && count > 1;
  const nowX = showNow ? x(nowIndex + 0.5) : null;
  const rightX = width - pad.r;

  // Namespaced so they can never collide with the page's DOM contract
  // (index.html already has an h3#point-title).
  const titleId = `chart-${sid}-title`;
  const descId = `chart-${sid}-desc`;

  let open = '';
  open += `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" `
    + `aria-labelledby="${titleId} ${descId}" data-chart="${sid}">`;
  open += `<title id="${titleId}">${escapeXml(title ?? '')}</title>`;
  open += `<desc id="${descId}">${escapeXml(desc ?? '')}</desc>`;

  if (showNow) {
    open += '<defs>'
      + `<pattern id="chart-${sid}-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">`
      + '<line class="chart-hatch-line" x1="0" y1="0" x2="0" y2="6"/>'
      + '</pattern></defs>';
    open += `<rect class="chart-hatch" fill="url(#chart-${sid}-hatch)" x="${nowX}" y="${pad.t}" `
      + `width="${round(rightX - nowX)}" height="${plotH}"/>`;
  }

  // Three solid hairline grid lines with tick labels at domain min, mid, max.
  const ticks = [d0, (d0 + d1) / 2, d1];
  for (const t of ticks) {
    const ty = y(t);
    open += `<line class="chart-grid" x1="${pad.l}" x2="${rightX}" y1="${ty}" y2="${ty}"/>`;
    open += `<text class="chart-axis" x="${pad.l - 4}" y="${ty + 3}" text-anchor="end">${escapeXml(formatTick(t))}</text>`;
  }

  // First and last date labels.
  const labelY = height - 6;
  if (firstLabel) {
    open += `<text class="chart-axis" x="${pad.l}" y="${labelY}" text-anchor="start">${escapeXml(firstLabel)}</text>`;
  }
  if (lastLabel && count > 1) {
    open += `<text class="chart-axis" x="${rightX}" y="${labelY}" text-anchor="end">${escapeXml(lastLabel)}</text>`;
  }

  // NOW boundary is drawn in `close` so it sits above the data marks.
  let close = '';
  if (showNow) {
    close += `<line class="chart-now" x1="${nowX}" x2="${nowX}" y1="${pad.t}" y2="${pad.t + plotH}"/>`;
    close += `<text class="chart-axis chart-now-label" x="${nowX + 3}" y="${pad.t + 8}" text-anchor="start">NOW</text>`;
  }
  close += '</svg>';

  return {
    open,
    close,
    x,
    y,
    pad,
    width,
    height,
    plotW,
    plotH,
    nowX,
    rightX,
    showNow,
  };
}

// ---------- shared mark builders ----------

// Empty-state messages sit between the mid and bottom grid lines (CSS sets
// dominant-baseline: middle, so no manual baseline offset here). When the NOW
// boundary is drawn, the message centres in the observed region so the NOW
// line never runs through it.
function messageY(frame) {
  return round(frame.pad.t + frame.plotH * 0.75);
}

function emptyText(frame, message) {
  const right = frame.showNow ? frame.nowX : frame.rightX;
  const cx = round((frame.pad.l + right) / 2);
  return `<text class="chart-empty" x="${cx}" y="${messageY(frame)}" text-anchor="middle">${escapeXml(message)}</text>`;
}

function hatchText(frame, message) {
  const cx = round((frame.nowX + frame.rightX) / 2);
  return `<text class="chart-empty" x="${cx}" y="${messageY(frame)}" text-anchor="middle">${escapeXml(message)}</text>`;
}

function polyline(points, className) {
  if (points.length < 2) return '';
  const pts = points.map((p) => `${p.x},${p.y}`).join(' ');
  return `<polyline class="${className}" fill="none" points="${pts}"/>`;
}

function diamond(cx, cy, side, className, index) {
  const half = side / 2;
  return `<rect class="${className}" data-index="${index}" x="${round(cx - half)}" y="${round(cy - half)}" `
    + `width="${side}" height="${side}" transform="rotate(45 ${cx} ${cy})"/>`;
}

// One point = an invisible hit target (r=9) wrapping the visible mark.
// Both carry data-index so main.js's click delegation works wherever the click lands.
function markGroup({ index, cx, cy, kind, active, tooltip }) {
  const t = `<title>${escapeXml(tooltip)}</title>`;
  let mark;
  if (kind === 'observed') {
    const cls = active ? 'chart-dot chart-dot--active' : 'chart-dot';
    mark = `<circle class="${cls}" data-index="${index}" cx="${cx}" cy="${cy}" r="${active ? 4.5 : DOT_RADIUS}">${t}</circle>`;
  } else if (active) {
    mark = diamond(cx, cy, DIAMOND_ACTIVE_SIDE, 'chart-diamond--active', index).replace('/>', `>${t}</rect>`);
  } else {
    // Deliberately NOT `.chart-dot`: that class is filled in the measurement
    // colour. A model marker must never inherit it.
    mark = diamond(cx, cy, DIAMOND_SIDE, 'chart-dot--model', index).replace('/>', `>${t}</rect>`);
  }
  return `<g class="chart-hit" data-index="${index}" cursor="pointer">${t}`
    + `<circle cx="${cx}" cy="${cy}" r="${HIT_RADIUS}" fill="none" pointer-events="all"/>`
    + `${mark}</g>`;
}

function splitTimeline(timeline) {
  const list = Array.isArray(timeline) ? timeline : [];
  const observed = [];
  const forecast = [];
  list.forEach((step, i) => {
    if (!step) return;
    if (step.kind === 'forecast') forecast.push({ ...step, i });
    else observed.push({ ...step, i });
  });
  return { list, observed, forecast };
}

function listValues(entries, key) {
  return entries
    .filter((e) => isNum(e[key]))
    .map((e) => `${formatLongDate(e.date)} ${fmt2(e[key])}`)
    .join(', ');
}

// ---------- risk chart ----------

export function riskChart({ timeline, activeIndex, label } = {}) {
  const { list, observed, forecast } = splitTimeline(timeline);
  const n = list.length;
  const nowIndex = observed.length - 1;
  const hasForecast = forecast.length > 0;
  const name = label || 'Risk over time';

  const obsPts = observed
    .filter((s) => isNum(s.risk))
    .map((s) => ({ i: s.i, v: s.risk, date: s.date, kind: 'observed' }));
  const fcPts = forecast
    .filter((s) => isNum(s.probability))
    .map((s) => ({ i: s.i, v: s.probability, date: s.date, kind: 'forecast' }));

  // Generated accessible description, with a table equivalent appended.
  let desc;
  if (obsPts.length === 0) {
    desc = `${name}: no observed values.`;
  } else {
    const first = obsPts[0].v;
    const last = obsPts[obsPts.length - 1].v;
    const delta = last - first;
    const verb = delta > 0.005 ? 'rises' : delta < -0.005 ? 'falls' : 'holds';
    const passes = `${countWord(obsPts.length)} sample pass${obsPts.length === 1 ? '' : 'es'}`;
    desc = verb === 'holds'
      ? `Risk holds at ${fmt2(last)} over ${passes}`
      : `Risk ${verb} from ${fmt2(first)} to ${fmt2(last)} over ${passes}`;
    if (fcPts.length > 0) {
      const lo = Math.min(...fcPts.map((p) => p.v));
      const hi = Math.max(...fcPts.map((p) => p.v));
      desc += lo === hi
        ? `; model projects ${fmt2(lo)}`
        : `; model projects ${fmt2(lo)}–${fmt2(hi)}`;
    } else {
      desc += '; no model projection';
    }
    desc += '.';
  }
  desc += ` Observed: ${listValues(observed, 'risk') || 'none'}.`;
  if (hasForecast) {
    desc += ` Placeholder model: ${listValues(forecast, 'probability') || 'none'}. Model values are synthetic and not validated.`;
  }

  const frame = plotFrame({
    id: 'risk',
    n,
    nowIndex,
    hasForecast,
    title: hasForecast ? `${name}: observed sample passes and placeholder model projection` : `${name}: observed sample passes`,
    desc,
    firstLabel: n > 0 ? formatShortDate(list[0].date) : '',
    lastLabel: n > 1 ? formatShortDate(list[n - 1].date) : '',
  });

  const allPts = [...obsPts, ...fcPts];
  if (n <= 1 || allPts.length === 0) {
    return frame.open + emptyText(frame, 'No data to plot') + frame.close;
  }

  let body = '';
  const toXY = (p) => ({ x: frame.x(p.i), y: frame.y(p.v) });
  body += polyline(obsPts.map(toXY), 'chart-line');

  // Model segment starts at the last observed point so the curve is continuous
  // across NOW, but every segment past NOW is dashed.
  const bridge = obsPts.length > 0 ? [obsPts[obsPts.length - 1], ...fcPts] : fcPts;
  body += polyline(bridge.map(toXY), 'chart-line chart-line--model');

  for (const p of allPts) {
    const { x, y } = toXY(p);
    const tooltip = p.kind === 'observed'
      ? `${formatLongDate(p.date)}: ${fmt2(p.v)}`
      : `${formatLongDate(p.date)}: model ${fmt2(p.v)}`;
    body += markGroup({ index: p.i, cx: x, cy: y, kind: p.kind, active: p.i === activeIndex, tooltip });
  }

  return frame.open + body + frame.close;
}

// ---------- point chart ----------

export function pointChart({
  values,
  timeline,
  activeIndex,
  label,
  unit,
  noun,
  yDomain = [0, 1],
  emptyMessage = 'No point selected',
} = {}) {
  const { list, observed, forecast } = splitTimeline(timeline);
  const n = list.length;
  const nowIndex = observed.length - 1;
  const hasForecast = forecast.length > 0;
  const name = label || 'Value at a point';
  const unitText = unit || 'display intensity (synthetic, uncalibrated)';
  const nounText = noun || 'pixel brightness';

  const series = Array.isArray(values) ? values : [];
  if (series.length > 0 && series.length !== observed.length) {
    throw new Error(
      `pointChart: values.length (${series.length}) must equal the observed pass count (${observed.length}); `
      + 'future values are never plotted.',
    );
  }

  const pts = [];
  series.forEach((v, k) => {
    if (isNum(v) && observed[k]) pts.push({ i: observed[k].i, v, date: observed[k].date });
  });

  let desc;
  if (pts.length === 0) {
    desc = `${name}: ${series.length === 0 ? 'no point selected' : 'no values'}.`;
  } else {
    const lo = Math.min(...pts.map((p) => p.v));
    const hi = Math.max(...pts.map((p) => p.v));
    desc = `${name}: ${countWord(pts.length)} observed value${pts.length === 1 ? '' : 's'} `
      + `from ${fmt2(lo)} to ${fmt2(hi)}, in ${unitText}. `
      + `Values: ${pts.map((p) => `${formatLongDate(p.date)} ${fmt2(p.v)}`).join(', ')}.`;
  }
  if (hasForecast) {
    desc += ` No future ${nounText} values: no satellite pass has occurred after NOW.`;
  }

  const frame = plotFrame({
    id: 'point',
    n,
    nowIndex,
    hasForecast,
    yDomain,
    title: `${name} (${unitText})`,
    desc,
    firstLabel: n > 0 ? formatShortDate(list[0].date) : '',
    lastLabel: n > 1 ? formatShortDate(list[n - 1].date) : '',
  });

  if (n <= 1 || pts.length === 0) {
    const message = series.length === 0 ? emptyMessage : 'No data to plot';
    // Lock 7: the future region states it is empty even before a point exists.
    const future = frame.showNow ? hatchText(frame, 'No data yet') : '';
    return frame.open + emptyText(frame, message) + future + frame.close;
  }

  let body = '';
  const toXY = (p) => ({ x: frame.x(p.i), y: frame.y(p.v) });
  body += polyline(pts.map(toXY), 'chart-line');

  for (const p of pts) {
    const { x, y } = toXY(p);
    body += markGroup({
      index: p.i,
      cx: x,
      cy: y,
      kind: 'observed',
      active: p.i === activeIndex,
      tooltip: `${formatLongDate(p.date)}: ${fmt2(p.v)}`,
    });
  }

  // The future region is explicitly empty. Nothing is extrapolated.
  if (frame.showNow) {
    body += hatchText(frame, 'No data yet');
  }

  return frame.open + body + frame.close;
}
