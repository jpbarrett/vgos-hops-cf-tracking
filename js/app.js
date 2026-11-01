// Routing and views. Gets data from loader.js, hands it to plots.js; the
// shared controls are in ui.js and the control file panel in
// control-file-panel.js.

import { dataUrl } from './config.js';
import { DataExport, OFFSET_KEYWORDS, typeCounts, keepSession } from './loader.js';
import { NOT_SET } from './legend.js';
import { plotSeries, plotChannelHeatmap, onRangeChange, setRange, purge } from './plots.js';
import { el, day, fmt, parseHash, hashHref, patchQuery, coverageRange, rangeFromQuery, rangeControls,
         importedSwatch, notSetSwatch, typeFilter } from './ui.js';
import { controlFilePanel } from './control-file-panel.js';
import { coverageWith, differsFromHistory, restoreImport } from './local-import.js';
import { bindFileDrop, viewLocal } from './local-view.js';

const main = document.getElementById('main');
let data;
// the control file panel, once the export is open
let cf;
// the session-type filter: a Set of types, or null for all. Read from the
// hash on every render and carried by every link, so it follows the reader
// from page to page
let types = null;
// the imported control file, or null. Kept apart from `data`, so that nothing
// counted from the export ever includes it
let local = null;

// cfseries names session-wide series "session <keyword>"
const label = (e) => e.label.replace(/^session /, 'Session-wide ');

// --------------------------------------------------------------------------
// routes: #/  #/station/Gs  #/global  #/series/<key>  #/missing  #/local

function href(parts, q = {}) {
  // the type filter rides along unless the caller sets it
  return hashHref(parts, 'types' in q ? q : { ...q, types: typesParam(types) });
}

const groupHref = (kind, id, q) => href(kind === 'global' ? ['global'] : [kind, id], q);
const seriesHref = (key, q) => href(['series', key], q);

// --------------------------------------------------------------------------
// session types: ?types=VGOS-OPS,VGOS-INT-A; absent means all

function parseTypes(q) {
  const known = new Set(data.types.map((t) => t.type));
  const want = (q.get('types') || '').split(',').filter((t) => known.has(t));
  return want.length && want.length < known.size ? new Set(want) : null;
}

function typesParam(set) {
  return set ? data.types.map((t) => t.type).filter((t) => set.has(t)).join(',') : null;
}

const keep = (s) => keepSession(types, s);

// the filter and colour key for this page; notSet: the kinds of not-set mark
// the page shows; imported: whether it shows an imported value
function typeControls({ notSet = [], imported = false } = {}) {
  return typeFilter({
    available: data.types, chosen: types, nShown: data.sessions.filter(keep).length, notSet, imported,
    go: (set) => {
      const { parts, q } = parseHash();
      location.hash = href(parts, { ...Object.fromEntries(q), types: typesParam(set) });
    },
  });
}

// this series' imported points, as plotSeries wants them, or null
function importedFor(key) {
  if (!local || !local.series[key]) return null;
  return { points: local.series[key], session: local.session };
}

// the correlated sessions, of the chosen types, where the control file set
// no value for this series although its station took part. Only the
// polarisation offsets are tracked this way (offsets_not_set in the export)
function notSetFor(entry) {
  if (!entry.station || !OFFSET_KEYWORDS.has(entry.keyword)) return [];
  return data.notSet.filter((m) => m.station === entry.station && m.keywords.includes(entry.keyword) &&
                                   keep(m.session));
}

// "3 missed, 2 session-wide", or null for none
function notSetCounts(list) {
  const a = list.filter((m) => m.kind === 'station').length, b = list.length - a;
  if (!list.length) return null;
  return [a && `${a} missed`, b && `${b} session-wide`].filter(Boolean).join(', ');
}

// --------------------------------------------------------------------------
// views

function viewHome() {
  const m = data.manifest;
  const sessions = data.sessions.filter(keep);
  // what each station has within the chosen session types
  const notSet = data.notSet.filter((m) => keep(m.session));
  const per = data.stations.map((s) => {
    const mine = sessions.filter((x) => x.stations.includes(s.code));
    const series = data.catalogue.filter((e) => e.file === s.file && typeCounts(e, types)).length;
    const ns = notSet.filter((m) => m.station === s.code);
    return { s, n: mine.length, series, first: mine[0]?.epoch, last: mine.at(-1)?.epoch,
             missed: ns.filter((m) => m.kind === 'station').length,
             wide: ns.filter((m) => m.kind === 'session').length };
  }).filter((r) => r.n > 0);
  const nsCell = (code, n, kind) => el('td', { class: 'num' },
    n ? el('a', { href: href(['missing'], { station: code, kind }) }, n) : '');
  const stations = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'Station'), el('th', {}, 'Name'), el('th', { class: 'num' }, 'Sessions'),
      el('th', { class: 'num' }, 'Series'), el('th', {}, 'First'), el('th', {}, 'Last'),
      el('th', { class: 'num', title: NOT_SET.station.label }, 'Offsets missed'),
      el('th', { class: 'num', title: NOT_SET.session.label }, 'Session-wide'))),
    el('tbody', {}, per.map(({ s, n, series, first, last, missed, wide }) => el('tr', {},
      el('td', {}, s.file ? el('a', { href: groupHref('station', s.code) }, s.code) : s.code),
      el('td', {}, s.name ?? ''),
      el('td', { class: 'num' }, n), el('td', { class: 'num' }, series),
      el('td', {}, day(first)), el('td', {}, day(last)),
      nsCell(s.code, missed, 'station'), nsCell(s.code, wide, 'session')))));

  const nGlobal = data.catalogue.filter((e) => e.file === data.global.file && typeCounts(e, types)).length;
  const others = el('ul', {},
    data.global.file && el('li', {}, el('a', { href: groupHref('global') }, 'Session-wide parameters'),
                           ` (${nGlobal} series)`));
  const checks = el('ul', {},
    el('li', {}, el('a', { href: href(['missing']) }, 'Polarisation offsets not set'),
       ` (${notSetCounts(notSet) ?? 'none'})`, el('br'),
       el('span', { class: 'note' }, 'Stations that correlated, but whose control file gives no ' +
                                     'pc_phase_offset_y or pc_delay_y.')));

  const nSeries = data.catalogue.filter((e) => typeCounts(e, types)).length;
  const tc = typeControls();
  main.replaceChildren(
    el('h1', {}, m.name || 'Control file parameters'),
    el('p', { class: 'sub' },
       `${sessions.length} sessions, ${day(sessions[0]?.epoch)} to ${day(sessions.at(-1)?.epoch)}. ` +
       `${nSeries.toLocaleString()} parameter series across ${per.length} stations.`),
    tc && el('div', { class: 'filters' }, tc),
    el('div', { class: 'cols' },
      el('section', {}, el('h2', {}, 'Stations'), el('div', { class: 'table-wrap' }, stations)),
      el('section', {}, el('h2', {}, 'Session-wide'), others,
         el('h2', {}, 'Checks'), checks)));
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => a.keyword.localeCompare(b.keyword)
                                     || (a.index ?? -1) - (b.index ?? -1)
                                     || (a.field ?? '').localeCompare(b.field ?? ''));
}

async function viewGroup(kind, id, q) {
  const g = data.group(kind, id);
  if (!g) return notFound(`No ${kind} ${id ?? ''} in this export.`);
  if (!g.file) return notFound(`${g.title} has no numeric series.`);
  // only what the chosen session types have, and whatever was imported: an
  // import shows whatever the filter, since it may have no type to choose
  g.sessions = g.sessions.filter(keep);
  g.entries = g.entries.filter((e) => typeCounts(e, types) || importedFor(e.key));
  const stats = new Map(g.entries.map((e) => [e.key, typeCounts(e, types) ?? { n: 0, n_changes: 0 }]));
  const tab = q.get('view') === 'channels' ? 'channels' : 'params';
  // sessions it correlated in with no polarisation offsets; marked on the
  // offset panels, so they join the key there
  const notSet = kind === 'station' ? data.notSet.filter((m) => m.station === id && keep(m.session)) : [];
  const tc = typeControls({ notSet: tab === 'params' ? [...new Set(notSet.map((m) => m.kind))] : [],
                            imported: g.entries.some((e) => importedFor(e.key)) });
  const channelKw = [...new Set(g.entries.filter((e) => e.index_kind === 'channel').map((e) => e.keyword))].sort();
  const paramEntries = g.entries.filter((e) => e.index_kind !== 'channel');

  const heading = [
    el('div', { class: 'crumbs' }, el('a', { href: '#/' }, 'All stations')),
    el('h1', {}, g.name ? `${g.title} ${g.name}` : g.title),
    el('p', { class: 'sub' }, kind === 'station'
      ? (g.sessions.length ? `${g.sessions.length} sessions, ${day(g.sessions[0]?.epoch)} to ${day(g.sessions.at(-1)?.epoch)}`
                           : 'No sessions of the chosen session types')
      : `${g.entries.length} series`,
      notSet.length > 0 && [`. Polarisation offsets not set in ${notSet.length} correlated ` +
                            `session${notSet.length === 1 ? '' : 's'} (${notSetCounts(notSet)}): `,
                            el('a', { href: href(['missing'], { station: id }) }, 'list')]),
    el('nav', { class: 'tabs' },
      el('a', { href: groupHref(kind, id, { ...Object.fromEntries(q), view: null }),
                'aria-current': tab === 'params' ? 'page' : null },
         `Parameters (${paramEntries.length})`),
      channelKw.length > 0 && el('a', { href: groupHref(kind, id, { ...Object.fromEntries(q), view: 'channels' }),
                                        'aria-current': tab === 'channels' ? 'page' : null },
                                 `Channels (${channelKw.length} keywords)`)),
  ];
  if (!g.sessions.length && !g.entries.some((e) => importedFor(e.key))) {
    main.replaceChildren(...heading, tc && el('div', { class: 'filters' }, tc),
      el('p', { class: 'status' }, `${g.title} has no sessions of the chosen session types.`));
    return;
  }
  main.replaceChildren(...heading, el('p', { class: 'status' }, 'Loading series…'));
  const filePoints = await data.seriesFile(g.file);

  const plots = [];
  let syncing = false;
  const coverage = coverageWith(data.manifest.coverage, local);
  const range = rangeFromQuery(q, coverage);
  const rc = rangeControls(range, (r) => {
    patchQuery({ from: r ? r[0] : null, to: r ? r[1] : null });
    syncing = true;
    Promise.all(plots.map((d) => setRange(d, r))).finally(() => { syncing = false; });
  }, coverage);
  // zooming one panel moves them all, and the date inputs follow
  const follow = (div) => onRangeChange(div, (r) => {
    if (syncing) return;
    const clean = r && [String(r[0]).slice(0, 10), String(r[1]).slice(0, 10)];
    rc.set(clean);
  });

  if (tab === 'channels') {
    const kw = channelKw.includes(q.get('kw')) ? q.get('kw') : channelKw[0];
    const select = el('select', { onchange: (ev) => { location.hash = groupHref(kind, id, { ...Object.fromEntries(q), view: 'channels', kw: ev.target.value }); } },
      channelKw.map((k) => el('option', { value: k, selected: k === kw }, k)));
    const div = el('div', { class: 'plot heat' });
    const info = el('div', { class: 'info' }, 'Hover a cell to see its value, channel, session and correlator.');
    const entries = g.entries.filter((e) => e.keyword === kw && e.index_kind === 'channel');
    // deviation colouring is on by default for phases; ?dev=0 turns it off
    const hasDev = entries.length > 0 && entries.every((e) => e.circular);
    let deviation = hasDev && q.get('dev') !== '0';
    let rows = [];
    // every session in the station's active span is a column, including the
    // ones it missed, so a gap shows as a blank stripe instead of the
    // neighbouring sessions stretched across it
    const first = g.sessions[0]?.epoch, last = g.sessions.at(-1)?.epoch;
    const columns = data.sessions.filter((s) => keep(s) && s.epoch >= first && s.epoch <= last);
    const draw = async () => {
      // keep whatever range the plot is zoomed to
      const xa = div.layout && div.layout.xaxis;
      const now = xa && !xa.autorange && xa.range ? xa.range : range;
      rows = await plotChannelHeatmap(div, entries, filePoints, columns, { range: now, deviation, info, imported: local });
    };
    const devBox = hasDev && el('label', {},
      el('input', { type: 'checkbox', checked: deviation, onchange: (ev) => {
        deviation = ev.target.checked;
        patchQuery({ dev: deviation ? null : '0' });
        draw();
      } }),
      'Colour by deviation from channel median');
    main.replaceChildren(...heading,
      el('div', { class: 'filters' }, tc, rc.node, el('label', {}, 'Keyword', select), devBox),
      el('p', { class: 'note' }, 'One row per channel, ordered by sky frequency; lines separate the bands. ' +
         'A blank column is a session with no value for this station. Click a cell to open that channel.' +
         (hasDev ? ' Deviation colours each cell by its distance around the circle from that channel\'s ' +
                   'typical value, so a channel that sits near ±180° does not flip between the two ' +
                   'ends of the scale. Turn it off to colour by the phase itself.' : '')),
      el('div', { class: 'wide' }, info, div));
    await draw();
    div.on('plotly_click', (ev) => {
      const p = ev.points && ev.points[0];
      if (p && rows[p.y]) location.hash = seriesHref(rows[p.y].key, { dev: deviation ? '1' : null });
    });
    plots.push(div);
    follow(div);
    return;
  }

  const keywords = [...new Set(paramEntries.map((e) => e.keyword))].sort();
  const kwSel = q.get('kw') && keywords.includes(q.get('kw')) ? q.get('kw') : '';
  const showConstant = q.get('constant') === '1';
  let shown = sortEntries(paramEntries.filter((e) => !kwSel || e.keyword === kwSel));
  // constant within the chosen types: no step inside any of them. A value
  // imported that breaks one is what the reader came to see, so that stays
  const isConstant = (e) => {
    const imported = importedFor(e.key);
    return stats.get(e.key).n_changes === 0 &&
           !(imported && differsFromHistory(imported.points, filePoints[e.key], data.sessionById, types));
  };
  const nConstant = shown.filter(isConstant).length;
  if (!showConstant) shown = shown.filter((e) => !isConstant(e));

  const select = el('select', { onchange: (ev) => { location.hash = groupHref(kind, id, { ...Object.fromEntries(q), kw: ev.target.value }); } },
    el('option', { value: '' }, 'All keywords'),
    keywords.map((k) => el('option', { value: k, selected: k === kwSel }, k)));
  const constBox = el('input', { type: 'checkbox', checked: showConstant,
    onchange: (ev) => { location.hash = groupHref(kind, id, { ...Object.fromEntries(q), constant: ev.target.checked ? '1' : null }); } });

  const grid = el('div', { class: 'panels' });
  main.replaceChildren(...heading,
    el('div', { class: 'filters' }, tc, rc.node, el('label', {}, 'Keyword', select),
       el('label', {}, constBox, `Show constant series (${nConstant})`)),
    el('p', { class: 'note' }, 'One panel per series, on a shared time axis with independent y axes. ' +
       (data.types.length > 1 ? 'Each session type is its own line, so a line never joins two types. ' : '') +
       'Zoom any panel to zoom them all. Click a point to read its control file.'),
    grid);
  if (!shown.length) grid.append(el('p', { class: 'status' }, 'Nothing to show with these filters.'));

  for (const e of shown) {
    if (!grid.isConnected) return;          // navigated away mid-render
    const div = el('div', { class: 'plot' });
    // the page already names the station or the session-wide group
    const title = e.label.replace(/^(\S+ \([^)]*\)|session) /, '');
    // the counts give way to the hovered point while the cursor is on the plot
    const missing = notSetFor(e);
    const meta = el('div', { class: 'meta info' }, `${stats.get(e.key).n} points, ${stats.get(e.key).n_changes} changes` +
         (e.unit ? `, ${e.unit}` : '') + (missing.length ? `; not set: ${notSetCounts(missing)}` : ''));
    grid.append(el('div', { class: 'card' },
      el('h3', {}, el('a', { href: seriesHref(e.key) }, title)), meta, div));
    await plotSeries(div, e, filePoints[e.key], data.sessionById,
                     { range, types, info: meta, missing, pick: cf.open, imported: importedFor(e.key),
                       span: coverageRange(coverage) });
    plots.push(div);
    follow(div);
  }
}

// the points table's rows for a series' imported points, as [epoch, <tr>]
function importedRows(imported, hasDev, keyword) {
  if (!imported) return [];
  const { points, session } = imported;
  const rows = [];
  for (let i = 0; i < points.v.length; i++) {
    const stated = points.r ? points.r[String(i)] : undefined;
    rows.push([session.epoch, el('tr', { class: 'imported' },
      el('td', {}, day(session.epoch)),
      el('td', {}, importedSwatch(), ` imported ${session.label}`),
      el('td', {}, session.type ?? ''), el('td', {}, session.correlator ?? ''),
      el('td', { class: 'num' }, fmt(points.v[i])),
      el('td', { class: 'num' }, stated !== undefined ? fmt(stated) : ''),
      hasDev && el('td', { class: 'num' }, fmt(points.d[i])),
      el('td', {}, points.c[i]),
      el('td', { class: 'num' }, cf.button({ session: points.s[i], line: points.l[i], keyword }, points.l[i])))]);
  }
  return rows;
}

async function viewSeries(key, q) {
  const e = data.byKey.get(key);
  if (!e) return notFound(`No series ${key} in this export.`);
  const [kind, id] = data.groupOf(e);
  const pts = await data.points(key);
  const st = typeCounts(e, types);
  const missing = notSetFor(e);
  const imported = importedFor(key);
  const tc = typeControls({ notSet: [...new Set(missing.map((m) => m.kind))], imported: imported !== null });
  const div = el('div', { class: 'plot big' });
  const info = el('div', { class: 'info' }, 'Hover a point to see its value, session and correlator; ' +
                                             'click it to read the control file.');
  const coverage = coverageWith(data.manifest.coverage, local);
  const range = rangeFromQuery(q, coverage);
  const rc = rangeControls(range, (r) => {
    patchQuery({ from: r ? r[0] : null, to: r ? r[1] : null });
    setRange(div, r);
  }, coverage);
  // here the value itself is the default; ?dev=1 (set when arriving from a
  // deviation-coloured heatmap) plots the offset from the median instead
  const hasDev = Array.isArray(pts.d);
  let deviation = hasDev && q.get('dev') === '1';
  const draw = () => {
    const xa = div.layout && div.layout.xaxis;
    const now = xa && !xa.autorange && xa.range ? xa.range : range;
    return plotSeries(div, e, pts, data.sessionById,
                      { range: now, compact: false, deviation, types, info, missing, pick: cf.open, imported,
                        span: coverageRange(coverage) });
  };
  const devBox = hasDev && el('label', {},
    el('input', { type: 'checkbox', checked: deviation, onchange: (ev) => {
      deviation = ev.target.checked;
      patchQuery({ dev: deviation ? '1' : null });
      draw();
    } }),
    `Plot deviation from median (${fmt(e.circ_median)}${e.unit ? ' ' + e.unit : ''})`);

  // the per-type breakdown, for the chosen types
  const byType = Object.entries(e.by_type || {}).filter(([t]) => !types || types.has(t))
    .map(([t, b]) => `${t}: ${b.n} points, ${b.n_changes} changes`);
  const facts = [
    ['Key', e.key], ['Keyword', e.keyword],
    e.channel && ['Channel', `${e.channel}${e.freq_mhz != null ? `, ${e.freq_mhz.toFixed(1)} MHz, band ${e.band}` : ''}`],
    e.index_kind === 'sampler' && ['Sampler', `${String.fromCharCode(65 + e.index)} (index ${e.index})`],
    e.field && ['Field', e.field],
    ['Points', st ? `${st.n} of ${e.n}` + (types ? ' in the chosen session types' : '') +
                    `; all types ${day(e.first_epoch)} to ${day(e.last_epoch)}` : `none in the chosen session types (${e.n} in all)`],
    ['Range', `${fmt(e.vmin)} to ${fmt(e.vmax)}${e.unit ? ' ' + e.unit : ''}` + (e.circular ? ', wrapped to ±180' : '') +
      ' (all types)'],
    st && ['Changes', `${st.n_changes}, counted between consecutive sessions of the same type`],
    byType.length > 1 && ['By session type', byType.join('; ')],
    missing.length > 0 && ['Not set', `in ${missing.length} session${missing.length === 1 ? '' : 's'} ` +
      `${e.station} correlated in (${notSetCounts(missing)}); marked ✕ and listed below`],
  ].filter(Boolean);

  const rows = pts.v.map((v, i) => {
    const s = data.sessionById.get(pts.s[i]);
    if (!keep(s)) return null;
    const raw = pts.r ? pts.r[String(i)] : undefined;
    return [s?.epoch ?? '', el('tr', {},
      el('td', {}, day(s?.epoch)), el('td', {}, pts.s[i]), el('td', {}, s?.type ?? ''),
      el('td', {}, s?.correlator ?? ''),
      el('td', { class: 'num' }, fmt(v)),
      el('td', { class: 'num' }, raw !== undefined ? fmt(raw) : ''),
      hasDev && el('td', { class: 'num' }, fmt(pts.d[i])),
      el('td', {}, pts.c[i]),
      el('td', { class: 'num' }, pts.l[i] == null ? ''
        : cf.button({ session: pts.s[i], line: pts.l[i], keyword: e.keyword }, pts.l[i])))];
  }).filter(Boolean);
  // the sessions it was not set in, in their place among the points
  for (const m of missing) {
    const s = m.session;
    rows.push([s.epoch, el('tr', { class: 'not-set' },
      el('td', {}, day(s.epoch)), el('td', {}, cf.button({ session: s.id }, s.id)), el('td', {}, s.type ?? ''),
      el('td', {}, s.correlator ?? ''),
      el('td', { class: 'num' }, notSetSwatch(m.kind), ' not set'), el('td', {}), hasDev && el('td', {}),
      el('td', { class: 'wrap', colspan: 2 }, NOT_SET[m.kind].label +
         (m.n_obs != null ? `; ${m.n_obs} obs correlated` : '') +
         (m.uncorrelated_ids.length ? `; offsets given to ${m.uncorrelated_ids.join(', ')}, which did not correlate` : '')))]);
  }
  rows.push(...importedRows(imported, hasDev, e.keyword));
  rows.sort((p, q) => (p[0] < q[0]) - (p[0] > q[0]));

  main.replaceChildren(
    el('div', { class: 'crumbs' }, el('a', { href: '#/' }, 'All stations'), ' / ',
       el('a', { href: groupHref(kind, id) }, kind === 'global' ? 'Session-wide' : id)),
    el('h1', {}, label(e)),
    el('div', { class: 'filters' }, tc, rc.node, devBox),
    el('div', { class: 'wide' }, info, div),
    el('h2', {}, 'Summary'),
    el('table', {}, el('tbody', {}, facts.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', { class: 'wrap' }, String(v)))))),
    el('h2', {}, 'Points, newest first'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Date', 'Session', 'Type', 'Correlator', 'Value', 'As stated',
                                    hasDev && 'From median', 'Condition', 'Line']
        .map((h, i) => h && el('th', { class: [4, 5, 6, 8].includes(i) ? 'num' : null }, h)))),
      el('tbody', {}, rows.map(([, tr]) => tr)))));
  await draw();
  onRangeChange(div, (r) => {
    const clean = r && [String(r[0]).slice(0, 10), String(r[1]).slice(0, 10)];
    rc.set(clean);
  });
}

// every correlated station whose control file set no polarisation offsets,
// newest first: ?station= and ?kind= narrow it
function viewMissing(q) {
  const all = data.notSet.filter((m) => keep(m.session));
  const codes = [...new Set(all.map((m) => m.station))].sort();
  const station = codes.includes(q.get('station')) ? q.get('station') : '';
  const kind = Object.hasOwn(NOT_SET, q.get('kind') ?? '') ? q.get('kind') : '';
  const list = all.filter((m) => (!station || m.station === station) && (!kind || m.kind === kind)).reverse();
  const go = (changes) => { location.hash = href(['missing'], { ...Object.fromEntries(q), ...changes }); };

  const stSel = el('select', { onchange: (ev) => go({ station: ev.target.value }) },
    el('option', { value: '' }, 'All stations'),
    codes.map((c) => el('option', { value: c, selected: c === station }, c)));
  const kindSel = el('span', { class: 'seg', role: 'group', 'aria-label': 'Kind' },
    [['', 'Both'], ['station', 'Missed'], ['session', 'Session-wide']].map(([k, t]) =>
      el('button', { type: 'button', 'aria-pressed': String(k === kind), onclick: () => go({ kind: k }) }, t)));
  const tc = typeControls({ notSet: [...new Set(list.map((m) => m.kind))] });

  // to the station's pc_delay_y, to see the miss in place among its values
  const seriesLink = (m) => {
    const key = `${m.station}:pc_delay_y`;
    return el('a', { href: data.byKey.has(key) ? seriesHref(key) : groupHref('station', m.station) }, m.station);
  };
  const table = el('table', {},
    el('thead', {}, el('tr', {}, ['', 'Date', 'Session', 'Type', 'Correlator', 'Station', 'Obs', 'Not set', 'Note']
      .map((h, i) => el('th', { class: i === 6 ? 'num' : null }, h)))),
    el('tbody', {}, list.map((m) => {
      const s = m.session;
      return el('tr', {},
        el('td', { title: NOT_SET[m.kind].label }, notSetSwatch(m.kind)),
        el('td', {}, day(s.epoch)), el('td', {}, cf.button({ session: s.id }, s.id)), el('td', {}, s.type ?? ''),
        el('td', {}, s.correlator ?? ''),
        el('td', {}, seriesLink(m)), el('td', { class: 'num' }, m.n_obs ?? ''),
        el('td', {}, m.keywords.length === OFFSET_KEYWORDS.size ? 'x and y phase offsets and delays'
                                                                 : m.keywords.join(', ')),
        el('td', { class: 'wrap' }, m.kind === 'session' ? 'no station in the session has offsets'
          : m.uncorrelated_ids.length ? `offsets given to ${m.uncorrelated_ids.join(', ')}, which did not correlate` : ''));
    })));

  main.replaceChildren(
    el('div', { class: 'crumbs' }, el('a', { href: '#/' }, 'All stations')),
    el('h1', {}, 'Polarisation offsets not set'),
    el('p', { class: 'sub' }, `${list.length} correlated station-session${list.length === 1 ? '' : 's'}` +
       (list.length ? ` (${notSetCounts(list)})` : '') + '.'),
    el('div', { class: 'filters' }, tc, el('label', {}, 'Station', stSel), kindSel),
    el('p', { class: 'note' },
       'A station is listed when the vgosDB has fringe-fitted observations for it but the control file ' +
       'sets neither pc_phase_offset_y nor pc_delay_y for it. "Missed" means other stations in the ' +
       'session have offsets, so the correlator applied them and left this one out. "Session-wide" means ' +
       'no station in the session has them; that may have been deliberate. A station calibrated with ' +
       'per-channel delay_offs instead is not listed. The same sessions are marked ✕ on the offset plots. ' +
       'Click a session to read its control file.'),
    list.length ? el('div', { class: 'table-wrap' }, table)
                : el('p', { class: 'status' }, 'None with these filters.'));
}

// what the #/local page needs of this module
function localPage(q) {
  return { data, types, q, href, seriesHref, typeControls, rerender: render, setLocal };
}

// the header's link says what is imported
function showImport() {
  const link = document.getElementById('import-link');
  link.textContent = local ? `Imported: ${local.session.label}` : 'Import a control file';
}

function setLocal(imported) {
  local = imported;
  showImport();
  if (parseHash().parts[0] === 'local') render();
  else location.hash = href(['local']);
}

function notFound(msg) {
  main.replaceChildren(el('div', { class: 'crumbs' }, el('a', { href: '#/' }, 'All stations')),
                       el('p', { class: 'error' }, msg));
}

// --------------------------------------------------------------------------

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  purge(main);
  const { parts, q } = parseHash();
  types = parseTypes(q);
  try {
    if (parts[0] === 'station' && parts[1]) await viewGroup('station', parts[1], q);
    else if (parts[0] === 'global') await viewGroup('global', null, q);
    else if (parts[0] === 'series' && parts[1]) await viewSeries(parts.slice(1).join('/'), q);
    else if (parts[0] === 'missing') viewMissing(q);
    else if (parts[0] === 'local') await viewLocal(main, local, localPage(q));
    else viewHome();
    if (seq === renderSeq) cf.sync(q);
  } catch (err) {
    if (seq === renderSeq) main.replaceChildren(el('p', { class: 'error' }, String(err.message || err)));
    console.error(err);
  }
  if (seq === renderSeq) window.scrollTo(0, 0);
}

async function start() {
  const base = dataUrl();
  if (typeof Plotly === 'undefined') {
    main.replaceChildren(el('p', { class: 'error' },
      'Plotly did not load. It comes from cdn.jsdelivr.net, so this page needs network access.'));
    return;
  }
  try {
    data = await new DataExport(base).open();
    cf = controlFilePanel(data, () => local);
  } catch (err) {
    main.replaceChildren(el('p', { class: 'error' },
      `Could not open the data export at ${base}\n\n${err.message}\n\n` +
      'Serve this directory over HTTP (python3 -m http.server) rather than opening the file directly, ' +
      'write the export when running locally (./export_web.py -o webapp/full-data), ' +
      'or point at another export with ?data=<url>.'));
    return;
  }
  const m = data.manifest;
  document.getElementById('dataset').textContent =
    `${m.name ?? ''} · data through ${day(m.coverage.last_epoch)}`;
  document.getElementById('footer').append(
    `Data generated ${m.generated_at.replace('T', ' ').replace('Z', ' UTC')}`,
    m.source.commit ? ` from ${m.source.commit.slice(0, 10)}${m.source.dirty ? ' (uncommitted changes)' : ''}` : '',
    ` · schema v${m.schema_version} · `, el('a', { href: base + 'manifest.json' }, 'manifest'));

  // a reload keeps an import, derived afresh against this export
  local = await restoreImport(sessionStorage, data);
  showImport();
  bindFileDrop(() => { setLocal(local); });

  window.addEventListener('hashchange', render);
  // a theme change needs a redraw: plot colours are read from the CSS tokens
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
  render();
}

start();
