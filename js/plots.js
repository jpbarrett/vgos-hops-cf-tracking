// The plotting layer: turns points into Plotly figures. Knows nothing about
// fetching; swapping Plotly out means rewriting this file only.
/* global Plotly */

import { keepSession } from './loader.js';
import { IMPORTED, TYPE_GROUPS, typeGroup, NOT_SET, NOT_SET_SYMBOL } from './legend.js';
import { fmt } from './ui.js';

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function theme() {
  return {
    surface: token('--surface'), primary: token('--text-primary'),
    secondary: token('--text-secondary'), muted: token('--text-muted'),
    grid: token('--grid'), axis: token('--axis'), series: token('--series'),
    accent: token('--accent'),
    types: TYPE_GROUPS.map((g) => token(g.colour)),
    diverging: [[0, token('--div-low')], [0.5, token('--div-mid')], [1, token('--div-high')]],
    sequential: [[0, token('--seq-low')], [1, token('--seq-high')]],
  };
}

const CONFIG = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d'],
  toImageButtonOptions: { format: 'svg' },
};

function baseLayout(t, { height, range, ytitle, compact }) {
  const axis = {
    gridcolor: t.grid, linecolor: t.axis, zeroline: false,
    tickfont: { size: 10, color: t.secondary }, automargin: true,
    exponentformat: 'e',      // 1e-5, not the SI "10µ"
  };
  return {
    height,
    margin: compact ? { l: 8, r: 8, t: 8, b: 8 } : { l: 12, r: 12, t: 12, b: 12 },
    paper_bgcolor: t.surface, plot_bgcolor: t.surface,
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: t.primary },
    showlegend: false,
    // hovering reports the point to bindInfo; no label is drawn over the
    // plot. A dotted rule through the hovered session marks the point instead
    hovermode: 'closest',
    xaxis: { ...axis, type: 'date', ...(range ? { range, autorange: false } : { autorange: true }),
             showspikes: true, spikemode: 'across', spikesnap: 'data', spikedash: 'dot',
             spikethickness: 1, spikecolor: t.muted },
    yaxis: { ...axis, title: ytitle ? { text: ytitle, font: { size: 11, color: t.secondary } } : undefined },
  };
}

// The hovered point is described in `info`, an element the page reserves
// for it (a card's meta line, a line above a big plot), and never drawn
// over the plot where it would hide the point and its neighbours. `describe`
// turns Plotly's hover point into text, or null for nothing; it is replaced
// on every redraw, while the listeners are bound once per div. Leaving the
// plot puts back what `info` said before.
function bindInfo(div, info, describe) {
  div._describe = describe;
  if (!info || div._infoBound) return;
  div._infoBound = true;
  const idle = info.textContent;
  div.on('plotly_hover', (ev) => {
    const text = ev.points && ev.points[0] && div._describe(ev.points[0]);
    if (!text) return;
    info.textContent = text;
    info.classList.add('active');
  });
  div.on('plotly_unhover', () => {
    info.textContent = idle;
    info.classList.remove('active');
  });
}

const withUnit = (v, unit) => `${fmt(v)}${unit ? ' ' + unit : ''}`;

// clicking a point hands `pick` what to show of the control file: the
// session, and the block and keyword the value came from. A not-set mark
// has no block, only its session. Bound once per div, like bindInfo
function bindPick(div, pick) {
  div._pick = pick;
  if (!pick || div._pickBound) return;
  div._pickBound = true;
  div.on('plotly_click', (ev) => {
    const p = ev.points && ev.points[0];
    const what = p && div._pick && div._pickOf && div._pickOf(p);
    if (what) div._pick(what);
  });
}

// value · session · type · correlator, and on a big plot the control-file
// block it came from
function describePoint(entry, pts, i, sessionById, { deviation, compact }) {
  const s = sessionById.get(pts.s[i]);
  const parts = [deviation ? `${withUnit(pts.d[i], entry.unit)} from median (value ${withUnit(pts.v[i], entry.unit)})`
                           : withUnit(pts.v[i], entry.unit),
                 pts.s[i]];
  if (s && s.type) parts.push(s.type);
  if (s && s.correlator) parts.push(s.correlator);
  const raw = pts.r && pts.r[String(i)];
  if (raw !== undefined) parts.push(`stated as ${fmt(raw)}`);
  if (!compact) parts.push(`${pts.c[i]}, line ${pts.l[i] ?? '?'}`);
  return parts.join(' · ');
}

// points -> arrays for one trace, from the points at `indices`. Circular
// series are broken wherever two consecutive values are more than 180
// apart: a line drawn from +179 to -179 shows a 358 degree jump that never
// happened. The line is also broken across each of `breaks` (plot dates, in
// order): sessions where the value was not set although it should have
// been, so the line does not carry the value over them. customdata is each
// point's index into `pts`, for describePoint.
//
// deviation plots each point's offset from the series' circular median (the
// export's `d`) instead of its value
export function traceArrays(entry, pts, sessionById, deviation = false,
                            indices = pts.v.map((_, i) => i), breaks = []) {
  const x = [], y = [], cd = [];
  const useDev = deviation && Array.isArray(pts.d);
  const vals = useDev ? pts.d : pts.v;
  let prev = null, prevX = null, b = 0;
  for (const i of indices) {
    const s = sessionById.get(pts.s[i]);
    const xi = s ? s.x : null;
    while (b < breaks.length && xi != null && breaks[b] < xi) b++;
    const crossed = prevX != null && b > 0 && breaks[b - 1] > prevX;
    if (prev != null && (crossed || (entry.circular && Math.abs(vals[i] - vals[prev]) > 180))) {
      x.push(null); y.push(null); cd.push(null);
    }
    prev = i;
    prevX = xi;
    x.push(xi);
    y.push(vals[i]);
    cd.push(i);
  }
  return { x, y, cd };
}

// the hover line for a session where the station correlated but its
// control file set no polarisation offsets (an export offsets_not_set entry)
function describeNotSet(m) {
  const s = m.session;
  const parts = [m.kind === 'session' ? 'not set for any station' : 'not set', s.id];
  if (s.type) parts.push(s.type);
  if (s.correlator) parts.push(s.correlator);
  parts.push(`${m.station} correlated${m.n_obs != null ? `, ${m.n_obs} obs` : ''}`);
  if (m.kind === 'station' && m.uncorrelated_ids.length) {
    parts.push(`offsets given to ${m.uncorrelated_ids.join(', ')}, which did not correlate`);
  }
  return parts.join(' · ');
}

// the not-set marks, in a strip of their own below the plot (legend.js)
function notSetTrace(missing, compact) {
  return {
    type: 'scatter', mode: 'markers', name: 'offsets not set', meta: 'not-set', yaxis: 'y2',
    x: missing.map((m) => m.session.x), y: missing.map(() => 0.5),
    customdata: missing.map((_, i) => i), hoverinfo: 'none',
    marker: { symbol: NOT_SET_SYMBOL, size: compact ? 8 : 10, color: 'rgba(0,0,0,0)',
              line: { color: missing.map((m) => token(NOT_SET[m.kind].colour)),
                      width: missing.map((m) => NOT_SET[m.kind].width) } },
  };
}

// --------------------------------------------------------------------------
// an imported control file: `imported` is { points, session }, the points of
// one series in the form of an export series file, and the session they are
// (local-import.js). They are drawn apart from the export's, never joined to
// them by a line: nothing is known about how the session relates to its
// neighbours, not even its type

// smaller than any other marker on a plot, so that it wins the hover
const IMPORTED_TARGET_SIZE = 5;

/** Arrays for the trace of a series' imported points. */
export function importedArrays(imported, deviation = false) {
  const { points, session } = imported;
  let values = points.v;
  if (deviation && Array.isArray(points.d)) {
    values = points.d;
  }
  return { x: values.map(() => session.x), y: values, cd: values.map((_, i) => i) };
}

/** The hover line of an imported point. */
export function describeImported(entry, imported, i, { deviation = false, compact = true } = {}) {
  const { points, session } = imported;
  let value = withUnit(points.v[i], entry.unit);
  if (deviation && Array.isArray(points.d)) {
    value = `${withUnit(points.d[i], entry.unit)} from median (value ${value})`;
  }
  const parts = [value, `imported ${session.label}`];
  if (session.type) parts.push(session.type);
  if (session.correlator) parts.push(session.correlator);
  const stated = points.r && points.r[String(i)];
  if (stated !== undefined) parts.push(`stated as ${fmt(stated)}`);
  if (!compact) parts.push(`${points.c[i]}, line ${points.l[i]}`);
  return parts.join(' · ');
}

/**
 * An invisible trace across `span`, for a plot with nothing but imported
 * points: alone, a star would stretch the date axis over a millisecond.
 */
function spanTrace(span, imported, deviation) {
  const y = importedArrays(imported, deviation).y[0];
  return { type: 'scatter', mode: 'markers', x: span, y: span.map(() => y), hoverinfo: 'skip',
           showlegend: false, marker: { size: 1, opacity: 0 } };
}

/**
 * The traces of a series' imported points: the stars, drawn last, over the
 * rest, and an invisible marker on each that takes the hover and the click.
 * Inside overlapping marks Plotly picks the smallest, so a star, the largest
 * mark on the plot, would lose to any neighbour touching it, and in dense
 * recent sessions could not be reached at all.
 */
function importedTraces(imported, t, deviation, compact) {
  const a = importedArrays(imported, deviation);
  const stars = {
    type: 'scatter', mode: 'markers', name: IMPORTED.label, x: a.x, y: a.y, hoverinfo: 'skip',
    // a session at the end of the range sits on the plot's edge
    cliponaxis: false,
    marker: { symbol: IMPORTED.symbol, size: compact ? 12 : 15, color: token(IMPORTED.colour),
              line: { color: t.surface, width: IMPORTED.ringWidth } },
  };
  const target = {
    type: 'scatter', mode: 'markers', name: IMPORTED.label, meta: 'imported',
    x: a.x, y: a.y, customdata: a.cd, hoverinfo: 'none', showlegend: false,
    marker: { size: IMPORTED_TARGET_SIZE, opacity: 0 },
  };
  return [stars, target];
}

/** A dotted rule through the imported session, so that its date reads against the history. */
function importedRule(imported, t) {
  const x = imported.session.x;
  return { type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1, layer: 'below',
           line: { color: t.muted, width: 1, dash: 'dot' } };
}

/**
 * The column of imported values beside a heatmap's `rows`: { z, value }, each
 * with one single-element row per heatmap row, null where the import has no
 * value. Null if it has none at all. Where a series has several points, the
 * last, as in the heatmap's own columns.
 */
export function importedColumn(rows, imported, deviation = false) {
  const z = [];
  const value = [];
  let found = false;
  for (const entry of rows) {
    const points = imported.series[entry.key];
    if (points === undefined) {
      z.push([null]);
      value.push([null]);
      continue;
    }
    found = true;
    const last = points.v.length - 1;
    if (deviation && Array.isArray(points.d)) {
      z.push([points.d[last]]);
    } else {
      z.push([points.v[last]]);
    }
    value.push([points.v[last]]);
  }
  return found ? { z, value } : null;
}

// one series over time; compact for small multiples, full size for detail.
//
// Only sessions of the chosen `types` are drawn, one trace per session type
// so that a line never joins two types: where they set a parameter
// differently, that line would draw a step that no control file made.
//
// `missing` are the sessions where this station correlated but the value
// was not set (offsets_not_set entries, already filtered to this series and
// the chosen types). Each is marked, and breaks its type's line.
//
// `imported` is this series' imported points, or null. They show whatever the
// chosen types, since an import may have no type to choose. `span` is the
// dates to give the axis if they are all there is to draw
export function plotSeries(div, entry, pts, sessionById,
                           { range = null, compact = true, deviation = false,
                             types = null, info = null, missing = [], pick = null,
                             imported = null, span = null } = {}) {
  const t = theme();
  deviation = deviation && Array.isArray(pts.d);
  const byType = new Map();
  pts.s.forEach((sid, i) => {
    const s = sessionById.get(sid);
    if (!keepSession(types, s)) return;
    const k = s ? s.type : null;
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(i);
  });
  const breaksOf = (type) => missing.filter((m) => m.session.type === type).map((m) => m.session.x).sort();
  const ytitle = deviation ? `${entry.unit || ''} from median ${fmt(entry.circ_median)}`.trim()
                           : (entry.unit || entry.keyword);
  const layout = baseLayout(t, { height: compact ? 210 : 420, range, compact,
                                 ytitle: compact ? null : ytitle });
  // VGOS-OPS last, so the 24-hour sessions draw over the denser intensives
  const order = [...byType.keys()].sort((p, q) => (p === 'VGOS-OPS') - (q === 'VGOS-OPS'));
  const traces = order.map((type) => {
    const g = type ? typeGroup(type) : 0;
    const colour = t.types[g] || t.series;
    const a = traceArrays(entry, pts, sessionById, deviation, byType.get(type), breaksOf(type));
    return {
      type: 'scatter', mode: 'lines+markers', name: type ?? 'unknown type',
      x: a.x, y: a.y, customdata: a.cd,
      connectgaps: false, hoverinfo: 'none',
      line: { color: colour, width: compact ? 1.5 : 2 },
      marker: { color: colour, size: compact ? 6 : 8, symbol: TYPE_GROUPS[g].symbol,
                line: { color: colour, width: 1.5 } },
    };
  });
  if (missing.length) {
    traces.push(notSetTrace(missing, compact));
    // the strip is the bottom of the plot, the x axis under it
    layout.yaxis.domain = [0.09, 1];
    layout.yaxis2 = { domain: [0, 0.07], range: [0, 1], visible: false, fixedrange: true };
    layout.xaxis.anchor = 'y2';
  }
  if (imported) {
    if (byType.size === 0 && span !== null) traces.push(spanTrace(span, imported, deviation));
    traces.push(...importedTraces(imported, t, deviation, compact));
    layout.shapes = [importedRule(imported, t)];
  }
  // small panels have no room for the toolbar; the detail view keeps it
  return Plotly.react(div, traces, layout, compact ? { ...CONFIG, displayModeBar: false } : CONFIG)
    .then((d) => {
      bindInfo(div, info, (p) => {
        if (p.customdata == null) return null;
        if (p.data && p.data.meta === 'not-set') return describeNotSet(missing[p.customdata]);
        if (p.data && p.data.meta === 'imported') {
          return describeImported(entry, imported, p.customdata, { deviation, compact });
        }
        return describePoint(entry, pts, p.customdata, sessionById, { deviation, compact });
      });
      div._pickOf = (p) => {
        if (p.customdata == null) return null;
        if (p.data && p.data.meta === 'not-set') return { session: missing[p.customdata].session.id };
        if (p.data && p.data.meta === 'imported') {
          const n = p.customdata;
          return { session: imported.points.s[n], line: imported.points.l[n], keyword: entry.keyword };
        }
        const i = p.customdata;
        return { session: pts.s[i], line: pts.l[i], keyword: entry.keyword };
      };
      bindPick(div, pick);
      return d;
    });
}

// channels x sessions for one keyword at one station. Every session is a
// column, so one the station missed is a blank stripe rather than its
// neighbours stretched over it.
//
// deviation colours each cell by its offset from that channel's circular
// median rather than by its value. A diverging scale centred on zero is only
// right for values near zero: on raw phases, a channel sitting near 180
// flips between the two ends of the scale while barely moving.
//
// `imported` is { series, session }, or null. Its values get a column of their
// own beside the date axis, on the same rows and colour scale. As a column
// among the dates it would be under a pixel wide with 2000 sessions on the
// axis, and would share its date with the session itself on a re-fringe
export function plotChannelHeatmap(div, entries, filePoints, sessions,
                                   { range = null, deviation = false, info = null,
                                     imported = null } = {}) {
  const t = theme();
  const rows = [...entries].sort((p, q) => (p.freq_mhz ?? 0) - (q.freq_mhz ?? 0));
  deviation = deviation && rows.every((e) => Array.isArray(filePoints[e.key].d));
  const unit = rows[0] && rows[0].unit ? ` ${rows[0].unit}` : '';
  const col = new Map(sessions.map((s, i) => [s.id, i]));
  const z = rows.map(() => new Array(sessions.length).fill(null));
  const value = rows.map(() => new Array(sessions.length).fill(null));
  rows.forEach((e, r) => {
    const pts = filePoints[e.key];
    pts.s.forEach((sid, i) => {
      if (!col.has(sid)) return;
      const c = col.get(sid);
      z[r][c] = deviation ? pts.d[i] : pts.v[i];
      value[r][c] = pts.v[i];
    });
  });

  const column = imported ? importedColumn(rows, imported, deviation) : null;

  // value · channel · imported session · type · correlator
  const describeColumn = (r) => {
    if (!rows[r] || column.z[r][0] == null) return null;
    const e = rows[r], s = imported.session;
    const parts = [deviation ? `${fmt(column.z[r][0])}${unit} from median (value ${fmt(column.value[r][0])}${unit}, ` +
                               `channel median ${fmt(e.circ_median)})`
                             : `${fmt(column.z[r][0])}${unit}`,
                   `${e.channel ?? '?'}${e.freq_mhz != null ? ' ' + e.freq_mhz.toFixed(1) + ' MHz' : ''}`,
                   `imported ${s.label}`];
    if (s.type) parts.push(s.type);
    if (s.correlator) parts.push(s.correlator);
    return parts.join(' · ');
  };

  // value · channel · session · type · correlator
  const describe = (p) => {
    const [r, c] = Array.isArray(p.pointNumber) ? p.pointNumber : [p.y, -1];
    if (p.data && p.data.meta === 'imported') return describeColumn(r);
    if (!rows[r] || !sessions[c] || z[r][c] == null) return null;
    const e = rows[r], s = sessions[c];
    const parts = [deviation ? `${fmt(z[r][c])}${unit} from median (value ${fmt(value[r][c])}${unit}, ` +
                               `channel median ${fmt(e.circ_median)})`
                             : `${fmt(z[r][c])}${unit}`,
                   `${e.channel ?? '?'}${e.freq_mhz != null ? ' ' + e.freq_mhz.toFixed(1) + ' MHz' : ''}`,
                   s.id];
    if (s.type) parts.push(s.type);
    if (s.correlator) parts.push(s.correlator);
    return parts.join(' · ');
  };

  const flat = z.flat().filter((v) => v != null);
  if (column) flat.push(...column.z.flat().filter((v) => v != null));
  const signed = rows.some((e) => e.circular) || flat.some((v) => v < 0);
  let colour;
  if (signed) {
    // symmetric about zero so "no correction" reads as nothing; the 99th
    // percentile keeps one wild value from washing out the rest
    const abs = flat.map(Math.abs).sort((p, q) => p - q);
    const lim = abs.length ? (abs[Math.floor(0.99 * (abs.length - 1))] || 1) : 1;
    colour = { colorscale: t.diverging, zmin: -lim, zmax: lim, zmid: 0 };
  } else {
    colour = { colorscale: t.sequential };
    // two traces only share a scale when it is stated
    if (column) {
      colour.zmin = Math.min(...flat);
      colour.zmax = Math.max(...flat);
    }
  }

  const labels = rows.map((e) => `${e.channel ?? '?'}  ${e.freq_mhz != null ? e.freq_mhz.toFixed(0) : ''}`);

  const layout = baseLayout(t, { height: Math.max(360, 26 + rows.length * 18), range });
  layout.hovermode = 'closest';
  layout.yaxis = { ...layout.yaxis, tickmode: 'array', tickvals: rows.map((_, i) => i),
                   ticktext: labels, autorange: 'reversed', showgrid: false,
                   tickfont: { size: 10, color: t.secondary } };
  layout.xaxis.showgrid = false;
  // band separators, so a whole band stepping at once stands out from one
  // channel drifting
  layout.shapes = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].band !== rows[i - 1].band) {
      layout.shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: i - 0.5, y1: i - 0.5,
                           line: { color: t.primary, width: 1 }, opacity: 0.5 });
    }
  }

  const colorbar = { thickness: 10, outlinewidth: 0, tickfont: { size: 10, color: t.secondary },
                     title: { text: deviation ? `${unit.trim()}<br>from<br>median` : unit.trim(),
                              font: { size: 10, color: t.secondary } } };
  const trace = {
    type: 'heatmap', x: sessions.map((s) => s.x), y: rows.map((_, i) => i), z,
    ...colour, hoverongaps: false, xgap: 0, ygap: 1, hoverinfo: 'none', colorbar,
  };
  const traces = [trace];
  if (column) {
    traces.push({ type: 'heatmap', meta: 'imported', name: IMPORTED.label, xaxis: 'x2',
                  x: ['imported'], y: rows.map((_, i) => i), z: column.z,
                  ...colour, showscale: sessions.length === 0, colorbar,
                  hoverongaps: false, ygap: 1, hoverinfo: 'none' });
    layout.xaxis.domain = [0, 0.94];
    // with no sessions the date axis has nothing to say, and would make up dates
    if (sessions.length === 0) {
      layout.xaxis.showticklabels = false;
      layout.xaxis.ticks = '';
    }
    layout.xaxis2 = { type: 'category', domain: [0.955, 1], anchor: 'y', fixedrange: true,
                      showgrid: false, linecolor: t.axis, automargin: true,
                      tickfont: { size: 10, color: t.primary } };
  }
  return Plotly.react(div, traces, layout, CONFIG).then(() => {
    bindInfo(div, info, describe);
    return rows;
  });
}

// zooming any one plot moves them all
export function onRangeChange(div, callback) {
  div.on('plotly_relayout', (ev) => {
    if (ev['xaxis.autorange']) callback(null);
    else if (ev['xaxis.range[0]'] !== undefined) callback([ev['xaxis.range[0]'], ev['xaxis.range[1]']]);
  });
}

export function setRange(div, range) {
  return Plotly.relayout(div, range ? { 'xaxis.range': range, 'xaxis.autorange': false }
                                    : { 'xaxis.autorange': true });
}

export function purge(root) {
  root.querySelectorAll('.js-plotly-plot').forEach((d) => Plotly.purge(d));
}
