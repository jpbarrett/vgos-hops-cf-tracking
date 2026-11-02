// The #/local page: choosing a control file and a station file, then what they
// came to, beside the export. What the import means is in local-import.js;
// this is only the page.

import { clearImport, importSession, isStationFile, lastHistoricalPoint, saveImport, todayDate } from './local-import.js';
import { parseStationIds } from './local-series.js';
import { day, el, fmt, parseHash } from './ui.js';

const STATION_FORMAT_NOTE = {
  'station_ids.tsv': 'A station_ids.tsv comes from the vgosDB and lists the stations that observed. Blocks for any other ' +
                     'id are left out, as left over from another session.',
  'station.codes': 'A station.codes may name a station that was not correlated, and nothing in it can show that, ' +
                   'so such a station\'s block is treated as applied.',
};

const CHANNEL_NOTE = 'Channel values are matched by letter, on the assumption that this session ' +
                     'follows the standard channel plan: that needs the correlator report to check.';

// the files chosen so far, before they are imported. sessionTyped: the reader
// wrote the session, so a station file does not replace it
const pending = { control: null, station: null, session: '', sessionTyped: false, error: null };

/** Forget the files chosen so far. */
function resetPending() {
  pending.control = null;
  pending.station = null;
  pending.session = '';
  pending.sessionTyped = false;
  pending.error = null;
}

/** Take a file as the control file. */
async function pickControl(file) {
  pending.control = { name: file.name, text: await file.text() };
}

/** Take a file as the station file, which fills in the session if it names one. */
async function pickStation(file) {
  const text = await file.text();
  try {
    const parsed = parseStationIds(text);
    pending.station = { name: file.name, text: text };
    if (!pending.sessionTyped) {
      pending.session = parsed.session ?? '';
    }
  } catch (err) {
    pending.station = null;
    pending.error = `${file.name}: ${err.message}`;
  }
}

/** Files dropped on the page, which say for themselves which is which. */
async function addFiles(fileList) {
  pending.error = null;
  for (const file of fileList) {
    if (isStationFile(file.name, await file.text())) {
      await pickStation(file);
    } else {
      await pickControl(file);
    }
  }
}

/** One line of the form: a file chooser for this place, and what it holds. */
function fileRow(label, chosen, pick, page) {
  const chooser = el('input', {
    type: 'file', 'aria-label': label,
    onchange: async (ev) => {
      if (ev.target.files.length === 0) {
        return;
      }
      pending.error = null;
      await pick(ev.target.files[0]);
      page.rerender();
    },
  });
  let name = el('span', { class: 'note' }, 'No file chosen');
  if (chosen !== null) {
    name = chosen.name;
  }
  return el('tr', {}, el('th', {}, label),
            el('td', { class: 'wrap' }, el('label', { class: 'file-choice' }, chooser, 'Choose file'), ' ', name));
}

/** The form that chooses the two files and the session. */
function importForm(page) {
  const sessionInput = el('input', {
    type: 'text', value: pending.session, placeholder: `${todayDate()}, or a session id`,
    'aria-label': 'Session',
    oninput: (ev) => {
      pending.session = ev.target.value;
      pending.sessionTyped = ev.target.value.trim() !== '';
    },
  });
  const ready = pending.control !== null && pending.station !== null;
  const button = el('button', {
    type: 'button', class: 'action', disabled: !ready,
    onclick: async () => {
      button.disabled = true;
      button.textContent = 'Parsing…';
      await runImport(page);
    },
  }, 'Import');

  return el('section', { class: 'import-form' },
    el('p', { class: 'note' },
      'The station codes file is a station_ids.tsv or a HOPS station.codes. You can also drop the files ' +
      'anywhere on this page. Both stay in this browser tab: nothing is uploaded. Unless the station ' +
      'codes file names one, the session is today\'s date until you give a session id or another date.'),
    el('table', {}, el('tbody', {},
      fileRow('Control file', pending.control, pickControl, page),
      fileRow('Station codes file', pending.station, pickStation, page),
      el('tr', {}, el('th', {}, 'Session'), el('td', {}, sessionInput)))),
    pending.error !== null && el('p', { class: 'error' }, pending.error),
    button);
}

/** Import what the form holds; on failure, say why and keep it to try again. */
async function runImport(page) {
  const files = {
    controlName: pending.control.name, controlText: pending.control.text,
    stationName: pending.station.name, stationText: pending.station.text,
    session: pending.session.trim() || todayDate(),
  };
  try {
    const local = await importSession(files, page.data);
    saveImport(sessionStorage, files);
    resetPending();
    page.setLocal(local);
  } catch (err) {
    pending.error = err.message;
    page.rerender();
  }
}

/** The facts of the import and what they rest on, as a table and its notes. */
function importSummary(local) {
  const session = local.session;
  let stationFile = local.files.stationName;
  if (stationFile !== local.stationFile.format) {
    stationFile = `${stationFile} (${local.stationFile.format})`;
  }
  const facts = [
    ['Control file', local.files.controlName],
    ['Station codes file', stationFile],
    ['Session', session.label],
    ['Date', day(session.epoch)],
    ['Session type', session.type ?? 'not known'],
    ['Correlator', session.correlator ?? 'not known'],
  ];
  const notes = [STATION_FORMAT_NOTE[local.stationFile.format], CHANNEL_NOTE];
  if (session.exportedId === null) {
    notes.unshift('This session is not in the export, so its type and correlator are not known, ' +
                  'and it is placed at midnight on its date.');
  } else {
    notes.unshift('This session is in the export: its values are shown beside the export\'s own.');
  }
  return [
    el('table', { class: 'facts' }, el('tbody', {}, facts.map(([name, value]) =>
      el('tr', {}, el('th', {}, name), el('td', { class: 'wrap' }, value))))),
    notes.map((note) => el('p', { class: 'note' }, note)),
  ];
}

/** Station code -> how many of the imported series are its. */
function seriesPerStation(local, byKey) {
  const counts = new Map();
  for (const key of Object.keys(local.series)) {
    const station = byKey.get(key).station;
    counts.set(station, (counts.get(station) ?? 0) + 1);
  }
  return counts;
}

/** The station file's stations, with what the control file set for each. */
function stationTable(local, data) {
  const counts = seriesPerStation(local, data.byKey);
  const inExport = new Map(data.stations.map((station) => [station.code, station]));
  const rows = [];
  for (const [mk4, station] of local.stationFile.stations) {
    const known = inExport.get(station.code);
    let name = station.name;
    if (name === null && known !== undefined) {
      name = known.name;
    }
    rows.push(el('tr', {},
      el('td', {}, mk4), el('td', {}, station.code), el('td', {}, name ?? ''),
      el('td', { class: 'num' }, counts.get(station.code) ?? 0),
      el('td', {}, known !== undefined ? 'yes' : 'no')));
  }
  return el('div', { class: 'table-wrap' }, el('table', { class: 'facts' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Id'), el('th', {}, 'Station'), el('th', {}, 'Name'),
                       el('th', { class: 'num' }, 'Series'), el('th', {}, 'In the export'))),
    el('tbody', {}, rows)));
}

/** A set of names, sorted and comma-separated. */
function listed(names) {
  return [...names].sort().join(', ');
}

/** One <li> for each kind of thing left out of the import. */
function leftOutItems(local) {
  const { ignored, stationFile } = local;
  const items = [];
  if (ignored.absentIds.size > 0) {
    items.push(`Blocks for ${listed(ignored.absentIds)}: not in the station codes file.`);
  }
  if (ignored.perBaselineRows > 0) {
    items.push(`${ignored.perBaselineRows} values set per baseline: only station and ` +
               'session-wide parameters are tracked.');
  }
  if (ignored.nonNumericKeywords.size > 0) {
    items.push(`Keywords with no numeric value: ${listed(ignored.nonNumericKeywords)}.`);
  }
  if (ignored.excludedKeywords.size > 0) {
    items.push(`Keywords the export leaves out: ${listed(ignored.excludedKeywords)}.`);
  }
  if (stationFile.skippedLines.length > 0) {
    items.push(`Lines of the station codes file that could not be read: ${stationFile.skippedLines.join(' | ')}.`);
  }
  return items.map((text) => el('li', {}, text));
}

/** The left-out items and the series with no history. */
function leftOut(local) {
  const items = leftOutItems(local);
  const noHistory = local.ignored.noHistory;
  if (items.length === 0 && noHistory.size === 0) {
    return el('p', { class: 'note' }, 'Nothing was left out.');
  }
  return [
    items.length > 0 && el('ul', {}, items),
    noHistory.size > 0 && el('details', {},
      el('summary', {}, `${noHistory.size} series the export has no history for`),
      el('p', { class: 'note wrap' }, listed(noHistory))),
  ];
}

/** Which of the imported series to list: `where` is a station code, '*' or '' for all. */
function chosenKeys(local, byKey, where) {
  const keys = [];
  for (const key of Object.keys(local.series).sort()) {
    const station = byKey.get(key).station ?? '*';
    if (where === '' || where === station) {
      keys.push(key);
    }
  }
  return keys;
}

/** The table rows of one series: each imported point beside the export's. */
function valueRows(key, local, page, history) {
  const entry = page.data.byKey.get(key);
  const points = local.series[key];
  const shown = lastHistoricalPoint(history, local, page.data.sessionById, page.types);
  const rows = [];
  for (let i = 0; i < points.v.length; i++) {
    let stated;
    if (points.r) {
      stated = points.r[String(i)];
    }
    rows.push(el('tr', {},
      el('td', {}, el('a', { href: page.seriesHref(key) }, entry.label.replace(/^session /, 'Session-wide '))),
      el('td', { class: 'num' }, fmt(points.v[i])),
      el('td', { class: 'num' }, stated !== undefined ? fmt(stated) : ''),
      el('td', { class: 'num' }, shown !== null ? fmt(shown.value) : ''),
      el('td', {}, shown !== null ? shown.session.id : ''),
      el('td', {}, shown !== null ? shown.session.type ?? '' : ''),
      el('td', { class: 'num' }, points.l[i]),
      el('td', {}, points.c[i])));
  }
  return rows;
}

/**
 * Every imported value beside the export's. Deliberately in key order, with
 * nothing marked or ranked, like the plots: it is the reader who judges what
 * changed.
 */
async function valueTable(keys, local, page) {
  const files = new Set(keys.map((key) => page.data.byKey.get(key).file));
  const series = new Map();
  for (const file of files) {
    series.set(file, await page.data.seriesFile(file));
  }
  const rows = [];
  for (const key of keys) {
    const history = series.get(page.data.byKey.get(key).file)[key];
    rows.push(...valueRows(key, local, page, history));
  }
  const headings = [['Series'], ['Value', 'num'], ['As stated', 'num'], ['In the export', 'num'],
                    ['From session'], ['Type'], ['Line', 'num'], ['Condition']];
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, headings.map(([text, kind]) => el('th', { class: kind }, text)))),
    el('tbody', {}, rows)));
}

/** The select of what the value table lists. */
function whereSelect(local, byKey, where, go) {
  const stations = new Set();
  let hasGlobal = false;
  for (const key of Object.keys(local.series)) {
    const station = byKey.get(key).station;
    if (station === null) {
      hasGlobal = true;
    } else {
      stations.add(station);
    }
  }
  return el('select', { onchange: (ev) => go(ev.target.value) },
    el('option', { value: '' }, 'Everything'),
    hasGlobal && el('option', { value: '*', selected: where === '*' }, 'Session-wide'),
    [...stations].sort().map((code) => el('option', { value: code, selected: code === where }, code)));
}

/** The page for an import: what it came to, then its values. */
async function importedPage(main, local, page) {
  const where = page.q.get('where') ?? '';
  const keys = chosenKeys(local, page.data.byKey, where);
  const go = (value) => {
    const { q } = parseHash();
    location.hash = page.href(['local'], { ...Object.fromEntries(q), where: value });
  };
  const remove = el('button', {
    type: 'button', class: 'action',
    onclick: () => {
      clearImport(sessionStorage);
      page.setLocal(null);
    },
  }, 'Remove this import');
  const tc = page.typeControls();
  const status = el('p', { class: 'status' }, 'Loading the export\'s values…');
  const form = (pending.control !== null || pending.station !== null) ? importForm(page) : null;

  main.replaceChildren(...[
    el('div', { class: 'crumbs' }, el('a', { href: page.href([]) }, 'All stations')),
    el('h1', {}, `Imported: ${local.session.label}`),
    el('p', { class: 'sub' }, `${Object.keys(local.series).length} series with history in the export.`),
    form,
    ...importSummary(local).flat(),
    remove,
    el('h2', {}, 'Stations'),
    stationTable(local, page.data),
    el('h2', {}, 'Left out'),
    leftOut(local),
    el('h2', {}, 'Values'),
    el('div', { class: 'filters' }, tc, el('label', {}, 'Show', whereSelect(local, page.data.byKey, where, go))),
    el('p', { class: 'note' }, local.session.exportedId !== null
      ? '"In the export" is this session\'s own value.'
      : '"In the export" is the last value before this session, of the session types chosen above. ' +
        'Types can set a parameter differently, so choose the type this session is.'),
    status,
  ].flat().filter(Boolean));

  const table = await valueTable(keys, local, page);
  if (status.isConnected) {
    status.replaceWith(table);
  }
}

/**
 * The #/local page. page is what it needs of the app: { data, types, q, href,
 * seriesHref, typeControls, rerender, setLocal }.
 */
export async function viewLocal(main, local, page) {
  if (local !== null) {
    await importedPage(main, local, page);
    return;
  }
  main.replaceChildren(
    el('div', { class: 'crumbs' }, el('a', { href: page.href([]) }, 'All stations')),
    el('h1', {}, 'Import a control file'),
    el('p', { class: 'sub' }, 'Parse your own control file with HOPS\' parser, and see its values ' +
                              'beside the history in this export.'),
    importForm(page));
}

/** Let files be dropped anywhere on the page. `show` goes to #/local. */
export function bindFileDrop(show) {
  const hasFiles = (ev) => ev.dataTransfer !== null && ev.dataTransfer.types.includes('Files');
  window.addEventListener('dragover', (ev) => {
    if (hasFiles(ev)) {
      ev.preventDefault();
    }
  });
  window.addEventListener('drop', async (ev) => {
    if (!hasFiles(ev)) {
      return;
    }
    ev.preventDefault();
    await addFiles(ev.dataTransfer.files);
    show();
  });
}
