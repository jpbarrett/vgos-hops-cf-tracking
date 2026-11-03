// The data layer: fetches the export and answers lookups. Knows the export
// format, nothing about plotting.

import { typeGroup } from './legend.js';

export const SUPPORTED_SCHEMA = 2;

export class ExportError extends Error {}

async function getJSON(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new ExportError(`could not fetch ${url}: ${e.message}`);
  }
  if (!res.ok) throw new ExportError(`could not fetch ${url}: HTTP ${res.status}`);
  return opts.text ? res.text() : res.json();
}

// "2026-01-07T00:00:00Z" -> "2026-01-07 00:00:00": Plotly reads dates without
// a zone, and every epoch in the export is UTC
const plotDate = (iso) => iso.replace('T', ' ').replace('Z', '');

export class DataExport {
  constructor(base) {
    this.base = base;
    this._series = new Map();
    this._cf = new Map();
  }

  async open() {
    // the manifest is never cached; everything else is keyed by its hash
    this.manifest = await getJSON(this.base + 'manifest.json', { cache: 'no-cache' });
    const v = this.manifest.schema_version;
    if (v !== SUPPORTED_SCHEMA) {
      throw new ExportError(`export schema version ${v} is not supported ` +
                            `(this viewer reads version ${SUPPORTED_SCHEMA})`);
    }
    const f = this.manifest.files;
    const [catalogue, stations, sessions] = await Promise.all(
      [f.catalogue, f.stations, f.sessions].map((p) => getJSON(this._url(p))));

    this.catalogue = catalogue.series;
    this.byKey = new Map(this.catalogue.map((e) => [e.key, e]));
    this.stations = stations.stations;
    this.global = stations.global;
    this.sessions = sessions.sessions.map((s) => ({ ...s, x: plotDate(s.epoch) }));
    this.sessionById = new Map(this.sessions.map((s) => [s.id, s]));
    // every correlated station whose control file has no polarization
    // offsets, in epoch order, each with its session
    this.notSet = this.sessions.flatMap((s) => s.offsets_not_set.map((m) => (
      { ...m, session: s, n_obs: s.correlated[m.station] ?? null })));
    // session types, VGOS-OPS first, then the rest by name. A session in no
    // master file has none, and is in no type
    const counts = new Map();
    for (const s of this.sessions) if (s.type) counts.set(s.type, (counts.get(s.type) || 0) + 1);
    this.types = [...counts.keys()].sort((p, q) => (q === 'VGOS-OPS') - (p === 'VGOS-OPS') || p.localeCompare(q))
      .map((type) => ({ type, n: counts.get(type), group: typeGroup(type) }));
    return this;
  }

  _url(path) {
    return this.base + path + '?v=' + encodeURIComponent(this.manifest.data_hash.slice(7, 19));
  }

  // one series file, fetched once
  seriesFile(path) {
    if (!this._series.has(path)) {
      this._series.set(path, getJSON(this._url(path)).then((d) => d.series));
    }
    return this._series.get(path);
  }

  // a session's control file as text, fetched once; null if the export has
  // none for it (its `cf` is null)
  controlFile(sessionId) {
    const s = this.sessionById.get(sessionId);
    if (!s || !s.cf) return Promise.resolve(null);
    if (!this._cf.has(s.cf)) this._cf.set(s.cf, getJSON(this._url(s.cf), { text: true }));
    return this._cf.get(s.cf);
  }

  async points(key) {
    const entry = this.byKey.get(key);
    if (!entry) throw new ExportError(`no such series: ${key}`);
    const file = await this.seriesFile(entry.file);
    return file[key];
  }

  // a group is what one page shows: a station, or the session-wide set.
  // Per-baseline settings are out of scope and not in the export
  group(kind, id) {
    if (kind === 'station') {
      const st = this.stations.find((s) => s.code === id);
      if (!st) return null;
      return { kind, id, file: st.file, title: `${st.code}`, name: st.name,
               sessions: this.sessions.filter((s) => s.stations.includes(id) || id in s.correlated),
               entries: this.catalogue.filter((e) => e.file === st.file) };
    }
    if (kind === 'global') {
      return { kind, id: null, file: this.global.file, title: 'Session-wide parameters',
               name: null, sessions: this.sessions,
               entries: this.catalogue.filter((e) => e.file === this.global.file) };
    }
    return null;
  }

  groupOf(entry) {
    if (entry.file.startsWith('series/station/')) return ['station', entry.station];
    return ['global', null];
  }
}

// the keywords offsets_not_set can name: a station's polarization offsets
// (EXPORT_SCHEMA.md, sessions.json)
export const OFFSET_KEYWORDS = new Set(['pc_phase_offset_x', 'pc_phase_offset_y',
                                        'pc_delay_x', 'pc_delay_y']);

// --------------------------------------------------------------------------
// session types; how they are grouped and drawn is in legend.js

// which sessions a filter keeps: `types` is a Set of session types, or null
// for all of them
export function keepSession(types, session) {
  return !types || (session != null && types.has(session.type));
}

// { n, n_changes } of one series over the chosen session types, added up
// from the export's per-type counts (EXPORT_SCHEMA.md, by_type). Changes are
// only ever counted within a type: across types, a parameter each type sets
// differently would count every alternation as a change.
//
// Returns null when the series has no points in the chosen types. Points of
// sessions with no type are in no by_type entry: a series with only those
// has an empty by_type, and counts only when every type is shown, from its
// all-types fields.
export function typeCounts(entry, types) {
  const by = entry.by_type;
  if (!by || !Object.keys(by).length) {
    return types ? null : { n: entry.n, n_changes: entry.n_changes };
  }
  const parts = Object.entries(by).filter(([t]) => !types || types.has(t)).map(([, c]) => c);
  if (!parts.length) return null;
  return { n: parts.reduce((sum, c) => sum + c.n, 0),
           n_changes: parts.reduce((sum, c) => sum + c.n_changes, 0) };
}
