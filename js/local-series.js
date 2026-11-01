// Turns one imported control file into series points, the way the export does
// for the archive, so that they can be plotted against it. Knows nothing about
// the page, and runs in Node as well as the browser.
//
// This is the part of cfseries.load() and export_web.build() that applies to
// a single session, and it has to agree with them: a value here that differs
// from the export's would draw a change no control file made. The names follow
// the Python, to make the two easy to read side by side. What needs a
// correlator report or a master file (epoch, session type, the channel plan
// check) is not here, since an import has neither.

// keywords left out of the export, and those whose values are angles in
// degrees: cfseries.EXCLUDED_KEYWORDS and cfseries.CIRCULAR_KEYWORDS
const EXCLUDED_KEYWORDS = new Set(['notches']);
const CIRCULAR_KEYWORDS = new Set([
  'pc_phases', 'pc_phases_x', 'pc_phases_y', 'pc_phases_l', 'pc_phases_r',
  'pc_phase_offset_x', 'pc_phase_offset_y', 'pc_phase_offset_l', 'pc_phase_offset_r',
]);

const PHASE_LOW = -180;
const PHASE_SPAN = 360;

export class StationIdsError extends Error {}

// --------------------------------------------------------------------------
// numbers

/**
 * The remainder of value / divisor (positive) as Python's % gives it, always
 * in [0, divisor). JS % keeps the sign of value, so -190 % 360 is -190.
 */
function flooredRemainder(value, divisor) {
  const remainder = value % divisor;
  if (remainder < 0) {
    return remainder + divisor;
  }
  return remainder;
}

/** A phase folded into [-180, 180). cfseries.limit_periodic_quantity_to_range */
export function wrapPhase(value) {
  return PHASE_LOW + flooredRemainder(value - PHASE_LOW, PHASE_SPAN);
}

/** The signed smallest (a - b) around the circle. cfseries.minimum_angular_difference */
export function phaseDifference(a, b) {
  return flooredRemainder(a - b + PHASE_SPAN / 2, PHASE_SPAN) - PHASE_SPAN / 2;
}

/** A number as the export writes it, to 10 significant digits. export_web._num */
function exportNumber(value) {
  return Number(value.toPrecision(10));
}

// --------------------------------------------------------------------------
// the station map

/** The lines of a station file that hold something, without its # comments. */
function contentLines(text) {
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== '' && !line.startsWith('#')) {
      lines.push(line);
    }
  }
  return lines;
}

/**
 * The text of a station_ids.tsv, whose header is `columns`, -> the result of
 * parseStationIds. cfseries.load_station_ids
 */
function parseStationIdsTsv(lines, columns) {
  const mk4Column = columns.indexOf('mk4');
  const codeColumn = columns.indexOf('code');
  const nameColumn = columns.indexOf('name');
  const sessionColumn = columns.indexOf('session');

  const stations = new Map();
  let session = null;
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const mk4 = cells[mk4Column];
    const code = cells[codeColumn];
    if (!mk4 || !code) {
      throw new StationIdsError(`no mk4 id and code in the line: ${line}`);
    }
    if (stations.has(mk4)) {
      throw new StationIdsError(`mk4 id ${mk4} is listed twice`);
    }
    let name = null;
    if (nameColumn >= 0 && cells[nameColumn]) {
      name = cells[nameColumn];
    }
    stations.set(mk4, { code: code, name: name });

    if (sessionColumn >= 0) {
      const rowSession = cells[sessionColumn];
      if (session !== null && rowSession !== session) {
        throw new StationIdsError(`the station file names two sessions: ${session} and ${rowSession}`);
      }
      session = rowSession;
    }
  }
  return { format: 'station_ids.tsv', session: session, stations: stations, skippedLines: [] };
}

/** A 2-character station code in HOPS' canonical case: Gs, K2. */
function canonicalCode(code) {
  return code[0].toUpperCase() + code.slice(1).toLowerCase();
}

/**
 * The lines of a HOPS station.codes file -> the result of parseStationIds.
 * Each line is a mk4 id and a station code, then anything at all, and a line
 * that is not is skipped, both as MHO_StationCodeMap does. HOPS also skips a
 * second mapping for an id or code with a warning, keeping the first; here
 * that is an error, since which station an id belongs to is not ours to pick.
 */
function parseStationCodes(lines) {
  const stations = new Map();
  const mk4OfCode = new Map();
  const skippedLines = [];

  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2 || tokens[0].length !== 1 || tokens[1].length !== 2) {
      skippedLines.push(line);
      continue;
    }
    const mk4 = tokens[0];
    const code = canonicalCode(tokens[1]);

    if (stations.has(mk4) && stations.get(mk4).code !== code) {
      throw new StationIdsError(`mk4 id ${mk4} is both ${stations.get(mk4).code} and ${code}`);
    }
    if (mk4OfCode.has(code) && mk4OfCode.get(code) !== mk4) {
      throw new StationIdsError(`station ${code} is both ${mk4OfCode.get(code)} and ${mk4}`);
    }
    stations.set(mk4, { code: code, name: null });
    mk4OfCode.set(code, mk4);
  }
  return { format: 'station.codes', session: null, stations: stations, skippedLines: skippedLines };
}

/**
 * The text of a station file, a station_ids.tsv or a HOPS station.codes, told
 * apart by what is in it, -> { format, session, stations, skippedLines }.
 *
 * stations is a Map of mk4 id -> { code, name }; name may be null. session is
 * the session id, null if the file does not say, and skippedLines any lines
 * that could not be read. format is the one it was read as, which matters to
 * what the map can be trusted for: a station_ids.tsv lists only the stations
 * that observed, read from the vgosDB, while a station.codes is a list of ids
 * made for correlation and may name a station that did not.
 *
 * Throws a StationIdsError for a file that cannot be used: station ids are
 * never guessed.
 */
export function parseStationIds(text) {
  const lines = contentLines(text);
  if (lines.length === 0) {
    throw new StationIdsError('the station file is empty');
  }

  const columns = lines[0].split('\t');
  let parsed;
  if (columns.includes('mk4') && columns.includes('code')) {
    parsed = parseStationIdsTsv(lines, columns);
  } else {
    parsed = parseStationCodes(lines);
  }

  if (parsed.stations.size === 0) {
    throw new StationIdsError('the station file lists no stations: it should be a ' +
                              'station_ids.tsv or a station.codes');
  }
  return parsed;
}

// --------------------------------------------------------------------------
// conditions

/** The token after each appearance of `word` among the condition's tokens. */
function tokensAfter(tokens, word) {
  const found = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i] === word) {
      found.push(tokens[i + 1]);
    }
  }
  return found;
}

/**
 * Who a block applies to: a list of { station, absentId, baseline }, one per
 * target, as cfseries.resolve_condition. station is the 2-character code, or
 * null for a session-wide block or an id the session's map lacks, which
 * absentId then names: that id never observed. A baseline stays as the
 * condition wrote it, its two mk4 ids rather than the codes: those blocks are
 * only ever told apart and then dropped, so the spelling does not matter.
 */
function resolveCondition(tokens, stations) {
  // a condition with a `not` in it is not a list of the stations it applies to
  if (tokens.includes('not')) {
    return [{ station: null, absentId: null, baseline: null }];
  }

  const stationIds = tokensAfter(tokens, 'station');
  const baselines = tokensAfter(tokens, 'baseline');

  if (stationIds.length > 0) {
    // a station qualified by a baseline keeps it as context
    let baseline = null;
    if (baselines.length === 1) {
      baseline = baselines[0];
    }
    const targets = [];
    for (const mk4 of stationIds) {
      if (stations.has(mk4)) {
        targets.push({ station: stations.get(mk4).code, absentId: null, baseline: baseline });
      } else {
        targets.push({ station: null, absentId: mk4, baseline: baseline });
      }
    }
    return targets;
  }

  if (baselines.length > 0) {
    const targets = [];
    for (const baseline of baselines) {
      targets.push({ station: null, absentId: null, baseline: baseline });
    }
    return targets;
  }

  return [{ station: null, absentId: null, baseline: null }];
}

// --------------------------------------------------------------------------
// statements

/** A statement's value as a number, or null if it is not one. */
function numberOrNull(value) {
  if (typeof value === 'number') {
    return value;
  }
  return null;
}

/** The first list among a compound value's fields, other than channel_names. */
function firstListField(value) {
  for (const [name, field] of Object.entries(value)) {
    if (name !== 'channel_names' && Array.isArray(field)) {
      return field;
    }
  }
  return [];
}

/** The rows of a statement with channel_names, one per channel. */
function explodeChannels(value) {
  const names = Array.from(value.channel_names || '');
  const values = firstListField(value);
  const parts = [];
  for (let i = 0; i < names.length; i++) {
    const number = i < values.length ? numberOrNull(values[i]) : null;
    parts.push({ indexKind: 'channel', index: i, suffix: names[i], value: number });
  }
  // values with no channel letter still get a row
  for (let i = names.length; i < values.length; i++) {
    parts.push({ indexKind: 'channel', index: i, suffix: `[${i}]`, value: numberOrNull(values[i]) });
  }
  return parts;
}

/**
 * A statement's value -> a list of { indexKind, index, suffix, value }, one per
 * number it holds, as cfseries.explode. suffix is what the series key ends in,
 * null for a plain scalar.
 */
function explode(keyword, value) {
  if (Array.isArray(value)) {
    const isSampler = keyword.startsWith('sampler_delay');
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      parts.push({
        indexKind: isSampler ? 'sampler' : 'vector',
        index: i,
        suffix: isSampler ? `#${i}` : `[${i}]`,
        value: numberOrNull(value[i]),
      });
    }
    return parts;
  }

  if (value !== null && typeof value === 'object') {
    if ('channel_names' in value) {
      return explodeChannels(value);
    }
    const parts = [];
    for (const field of Object.keys(value).sort()) {
      parts.push({ indexKind: 'field', index: null, suffix: field, value: numberOrNull(value[field]) });
    }
    return parts;
  }

  return [{ indexKind: 'none', index: null, suffix: null, value: numberOrNull(value) }];
}

/** Every row of the control file, in the order of its statements, with each statement numbered. */
function statementRows(doc, stations, ignored) {
  const rows = [];
  let statementNumber = 0;

  for (const block of doc.conditions) {
    const tokens = block.value || [];
    const condition = tokens.join(' ');
    const targets = resolveCondition(tokens, stations);

    for (const statement of block.statements || []) {
      const keyword = statement.name;
      if (EXCLUDED_KEYWORDS.has(keyword)) {
        ignored.excludedKeywords.add(keyword);
        continue;
      }
      const parts = explode(keyword, statement.value);
      statementNumber++;

      for (const target of targets) {
        if (target.absentId !== null) {
          ignored.absentIds.add(target.absentId);
          continue;
        }
        for (const part of parts) {
          rows.push({
            keyword: keyword,
            target: target,
            part: part,
            condition: condition,
            line: block.line_number,
            statementNumber: statementNumber,
          });
        }
      }
    }
  }
  return rows;
}

/** Where a row applies: a station, else its baseline, else * for the session. */
function whereOf(row) {
  if (row.target.station !== null) {
    return row.target.station;
  }
  if (row.target.baseline !== null) {
    return row.target.baseline;
  }
  return '*';
}

/** The series key of a row. cfseries.series_key */
function seriesKey(row) {
  const key = `${whereOf(row)}:${row.keyword}`;
  if (row.part.suffix === null) {
    return key;
  }
  return `${key}:${row.part.suffix}`;
}

/**
 * What a later statement replaces this row's value for. Channels are replaced
 * one by one, anything else as a whole statement; and a block whose condition
 * has an `and` applies more narrowly than its key says, so it is kept apart
 * from the plain value.
 */
function overrideGroup(row) {
  let unit = `${whereOf(row)}:${row.keyword}`;
  if (row.part.indexKind === 'channel') {
    unit = seriesKey(row);
  }
  let qualifier = '';
  if (/\band\b/.test(row.condition)) {
    qualifier = row.condition;
  }
  return `${unit}|${qualifier}`;
}

/** The rows fourfit applies: the last statement of each. cfseries._drop_overridden */
function dropOverridden(rows) {
  const lastStatement = new Map();
  for (const row of rows) {
    const group = overrideGroup(row);
    if (!lastStatement.has(group) || row.statementNumber > lastStatement.get(group)) {
      lastStatement.set(group, row.statementNumber);
    }
  }
  return rows.filter((row) => row.statementNumber === lastStatement.get(overrideGroup(row)));
}

// --------------------------------------------------------------------------
// series

/** Row order within a series: export_web sorts by line, then by index. */
function compareRows(a, b) {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return (a.part.index ?? -1) - (b.part.index ?? -1);
}

/** One series' rows -> its points, in the form of an export series file. */
function seriesPoints(rows, entry, sessionId) {
  const points = { s: [], v: [], l: [], c: [] };
  const circular = CIRCULAR_KEYWORDS.has(rows[0].keyword);
  const stated = {};
  const deviations = [];

  const ordered = [...rows].sort(compareRows);
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i];
    let wrapped = row.part.value;
    if (circular) {
      wrapped = wrapPhase(row.part.value);
    }
    const value = exportNumber(wrapped);
    if (circular) {
      // from the rounded value: circ_median is rounded in the catalogue, so
      // the unrounded one would leave a value equal to the median 3e-14 off
      deviations.push(exportNumber(phaseDifference(value, entry.circ_median)));
    }
    points.s.push(sessionId);
    points.v.push(value);
    points.l.push(row.line);
    points.c.push(row.condition);
    if (exportNumber(row.part.value) !== value) {
      stated[String(i)] = exportNumber(row.part.value);
    }
  }

  if (Object.keys(stated).length > 0) {
    points.r = stated;
  }
  if (circular) {
    points.d = deviations;
  }
  return points;
}

/**
 * A parsed control file -> { series, ignored }.
 *
 * doc is what parseControlFile returns, stations the Map from parseStationIds,
 * byKey the export's catalogue entries by key, and sessionId what the points'
 * `s` will say.
 *
 * series is an object of series key -> points, in the form of an export series
 * file (EXPORT_SCHEMA.md), holding the series the catalogue has. A key may
 * have more than one point, for the same reason it may in the export.
 *
 * ignored says what was left out, for the page to report: excludedKeywords and
 * nonNumericKeywords, Sets of keywords; absentIds, a Set of mk4 ids with no
 * station in the map; perBaselineRows, a count; and noHistory, a Set of series
 * keys the catalogue does not have.
 */
export function deriveSeries(doc, stations, byKey, sessionId) {
  const ignored = {
    excludedKeywords: new Set(),
    nonNumericKeywords: new Set(),
    absentIds: new Set(),
    perBaselineRows: 0,
    noHistory: new Set(),
  };

  const rowsByKey = new Map();
  for (const row of dropOverridden(statementRows(doc, stations, ignored))) {
    if (row.target.baseline !== null) {
      ignored.perBaselineRows++;
      continue;
    }
    if (row.part.value === null) {
      ignored.nonNumericKeywords.add(row.keyword);
      continue;
    }
    const key = seriesKey(row);
    if (!byKey.has(key)) {
      ignored.noHistory.add(key);
      continue;
    }
    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, []);
    }
    rowsByKey.get(key).push(row);
  }

  const series = {};
  for (const [key, rows] of rowsByKey) {
    series[key] = seriesPoints(rows, byKey.get(key), sessionId);
  }
  return { series: series, ignored: ignored };
}
