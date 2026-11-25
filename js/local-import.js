// One imported control file: telling the reader's files apart, working out
// which session they are, deriving the points, and keeping them for this tab.
// Knows nothing about the page, and runs in Node as well as the browser.
//
// Nothing here leaves the browser. An import is kept in sessionStorage as the
// two files' text, and derived afresh from them after a reload.

import { parseControlFile } from './cf2json.js';
import { keepSession } from './loader.js';
import { deriveSeries, parseStationIds } from './local-series.js';

// what an imported point's `s` says. Must not contain ':', which separates
// the fields of the ?cf= parameter
export const LOCAL_ID = 'local';

const STORAGE_KEY = 'local-import';

export class ImportError extends Error {}

/**
 * Whether a file is a station file rather than a control file: by its name if
 * that says, otherwise by whether every line of it reads as one.
 */
export function isStationFile(name, text) {
  if (/\.cf$/i.test(name)) {
    return false;
  }
  if (/\.(tsv|codes)$/i.test(name) || /station/i.test(name)) {
    return true;
  }
  try {
    return parseStationIds(text).skippedLines.length === 0;
  } catch (err) {
    return false;
  }
}

/** Whether year, month and day are a date that exists. */
function isRealDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * What the reader gave for the session: a session id (20260930-vo6273) or a
 * date (2026-09-30) -> { id, date }, where id is null for a date alone, or
 * null if it is neither.
 */
export function parseSessionInput(text) {
  const trimmed = text.trim();
  let match = trimmed.match(/^(\d{4})(\d{2})(\d{2})-[A-Za-z0-9]+$/);
  let id = trimmed;
  if (match === null) {
    match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    id = null;
  }
  if (match === null) {
    return null;
  }
  const [, year, month, day] = match;
  if (!isRealDate(Number(year), Number(month), Number(day))) {
    return null;
  }
  return { id: id, date: `${year}-${month}-${day}` };
}

/** A date as the session input takes it: today, in UTC like every epoch here. */
export function todayDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * The session an import is: { label, exportedId, epoch, x, type, correlator }.
 * A session already in the export takes its epoch, type and correlator from
 * there, and exportedId says which it is. Any other has only its date.
 */
function identifySession(session, sessionById) {
  const exported = session.id === null ? undefined : sessionById.get(session.id);
  if (exported !== undefined) {
    return { label: session.id, exportedId: session.id, epoch: exported.epoch, x: exported.x,
             type: exported.type, correlator: exported.correlator };
  }
  let label = session.date;
  if (session.id !== null) {
    label = session.id;
  }
  return { label: label, exportedId: null, epoch: `${session.date}T00:00:00Z`,
           x: `${session.date} 00:00:00`, type: null, correlator: null };
}

/**
 * Two files and a session -> an import, or a thrown error whose message is for
 * the reader: an ImportError, a StationIdsError or a ControlFileError.
 *
 * files is { controlName, controlText, stationName, stationText, session }.
 * data is the open export. The result is
 * { files, session, stationFile, series, ignored, text }; series and ignored
 * are what deriveSeries returns, and text is the control file.
 */
export async function importSession(files, data) {
  const session = parseSessionInput(files.session);
  if (session === null) {
    throw new ImportError(`"${files.session}" is not a session: give a session id such as ` +
                          '20260930-vo6273, or a date such as 2026-09-30');
  }
  const stationFile = parseStationIds(files.stationText);
  const doc = await parseControlFile(files.controlText);
  const { series, ignored } = deriveSeries(doc, stationFile.stations, data.byKey, LOCAL_ID);
  return {
    files: files,
    session: identifySession(session, data.sessionById),
    stationFile: stationFile,
    series: series,
    ignored: ignored,
    text: files.controlText,
  };
}

/**
 * What to show a series' imported value beside: its point in the session
 * itself if the export has that session, otherwise the last point of the
 * chosen session types before it. { value, session }, or null if there is none.
 */
export function lastHistoricalPoint(points, local, sessionById, types) {
  const ownId = local.session.exportedId;
  for (let i = points.s.length - 1; i >= 0; i--) {
    const session = sessionById.get(points.s[i]);
    let wanted;
    if (ownId !== null) {
      wanted = points.s[i] === ownId;
    } else {
      wanted = keepSession(types, session) && session.epoch < local.session.epoch;
    }
    if (wanted) {
      return { value: points.v[i], session: session };
    }
  }
  return null;
}

/**
 * Whether an import sets a series to a value it does not have in the chosen
 * session types. `points` are the import's, `history` the export's.
 */
export function differsFromHistory(points, history, sessionById, types) {
  const seen = new Set();
  for (let i = 0; i < history.v.length; i++) {
    if (keepSession(types, sessionById.get(history.s[i]))) {
      seen.add(history.v[i]);
    }
  }
  return points.v.some((value) => !seen.has(value));
}

/**
 * The export's coverage, stretched to hold an import dated outside it, so that
 * the date presets count back from whichever is latest. local may be null.
 */
export function coverageWith(coverage, local) {
  if (local === null) {
    return coverage;
  }
  const epoch = local.session.epoch;
  return {
    ...coverage,
    first_epoch: epoch < coverage.first_epoch ? epoch : coverage.first_epoch,
    last_epoch: epoch > coverage.last_epoch ? epoch : coverage.last_epoch,
  };
}

// --------------------------------------------------------------------------
// keeping an import for this tab. Any of these may fail: storage can be turned
// off or full, and then an import simply does not outlast a reload

/** Keep an import's files. */
export function saveImport(storage, files) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(files));
  } catch (err) {
    console.warn(`the import will not survive a reload: ${err.message}`);
  }
}

/** Forget the import. */
export function clearImport(storage) {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn(`could not clear the import: ${err.message}`);
  }
}

/**
 * The import kept in this tab, derived afresh against this export, or null if
 * there is none. One that no longer imports is forgotten.
 */
export async function restoreImport(storage, data) {
  let kept = null;
  try {
    kept = storage.getItem(STORAGE_KEY);
  } catch (err) {
    return null;
  }
  if (kept === null) {
    return null;
  }
  try {
    return await importSession(JSON.parse(kept), data);
  } catch (err) {
    console.warn(`dropped the kept import: ${err.message}`);
    clearImport(storage);
    return null;
  }
}
