// The control file panel: ?cf=<session>[:<line>[:<keyword>]]
//
// Clicking a point opens its session's control file beside the plots, with
// the block the value came from highlighted and the keyword's line marked.
// Line numbers are the export's own (each point's `l`), which count lines of
// exactly this text. Block 0 is the part before the first `if`. Opened from
// a not-set mark, there is no block: the blocks for any uncorrelated id the
// session's offsets went to are highlighted instead

import { el, patchQuery } from './ui.js';

// the left edge drags to resize; the width is a per-reader convenience, kept
// in localStorage when the browser allows it
const CF_WIDTH_KEY = 'cf-panel-width';

function parseCf(value) {
  if (!value) return null;
  const [session, line, keyword] = value.split(':');
  return { session, line: line === '' || line == null ? null : Number(line), keyword: keyword || null };
}

// the uncommented part of a line, split into words
const codeOf = (line) => line.split('*', 1)[0].trim().split(/\s+/).filter(Boolean);

// [first, last] lines (1-based) of the block starting at `line`
function blockRange(lines, line) {
  const isIf = (i) => codeOf(lines[i - 1])[0] === 'if';
  let first = line >= 1 ? line : 1;
  let last = first;
  while (last < lines.length && !isIf(last + 1)) last++;
  return [first, last];
}

// the panel for one export. open(what) shows a control file and records it
// in the hash; sync(q) follows the hash after a render; button(what, label)
// is a table's link to it
export function controlFilePanel(data) {
  const panel = el('aside', { class: 'cf-panel', hidden: true, 'aria-label': 'Control file' });
  document.body.append(panel);
  let seq = 0;

  try {
    const w = Number(localStorage.getItem(CF_WIDTH_KEY));
    if (w > 0) panel.style.setProperty('--cf-width', `${w}px`);
  } catch (e) { /* storage unavailable: the default width */ }

  function grip() {
    const g = el('div', { class: 'grip', role: 'separator', 'aria-orientation': 'vertical',
                          'aria-label': 'Drag to resize' });
    g.addEventListener('pointerdown', (down) => {
      down.preventDefault();
      g.setPointerCapture(down.pointerId);
      panel.classList.add('resizing');
      let width = panel.getBoundingClientRect().width;
      const move = (ev) => {
        width = Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, 360), window.innerWidth));
        panel.style.setProperty('--cf-width', `${width}px`);
      };
      const up = () => {
        g.removeEventListener('pointermove', move);
        panel.classList.remove('resizing');
        try { localStorage.setItem(CF_WIDTH_KEY, String(width)); } catch (e) { /* not kept */ }
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up, { once: true });
    });
    return g;
  }

  function hide() {
    panel.hidden = true;
    panel.replaceChildren();
  }

  function open(what) {
    patchQuery({ cf: [what.session, what.line ?? '', what.keyword ?? ''].join(':').replace(/:+$/, '') });
    show(what);
  }

  function close() {
    patchQuery({ cf: null });
    hide();
  }

  async function show(what) {
    const mine = ++seq;
    const s = data.sessionById.get(what.session);
    const closeButton = el('button', { type: 'button', class: 'close', 'aria-label': 'Close', onclick: close }, '×');
    const head = el('header', {},
      el('div', {}, el('strong', {}, what.session),
         el('div', { class: 'note' }, [s?.type, s?.correlator, s?.cf].filter(Boolean).join(' · '))),
      closeButton);
    panel.hidden = false;
    panel.replaceChildren(grip(), head, el('p', { class: 'status' }, 'Loading control file…'));
    let text;
    try {
      text = await data.controlFile(what.session);
    } catch (err) {
      if (mine === seq) panel.replaceChildren(grip(), head, el('p', { class: 'error' }, String(err.message || err)));
      return;
    }
    if (mine !== seq) return;
    if (text == null) {
      panel.replaceChildren(grip(), head, el('p', { class: 'status' }, 'This export has no control file for this session.'));
      return;
    }
    const lines = text.replace(/\n$/, '').split('\n');

    // what to highlight: the point's block and its keyword line, or for a
    // not-set mark the blocks of the ids its offsets went to
    const block = new Set(), hit = new Set();
    let sub = 'Whole file';
    if (what.line != null) {
      const [a, b] = blockRange(lines, what.line);
      for (let i = a; i <= b; i++) block.add(i);
      for (let i = a; i <= b; i++) {
        if (what.keyword && codeOf(lines[i - 1])[0] === what.keyword) { hit.add(i); break; }
      }
      sub = (what.line >= 1 ? `Block at line ${what.line}` : 'Lines before the first if') +
            (what.keyword ? `, ${what.keyword}${hit.size ? ` on line ${[...hit][0]}` : ' (continued from an earlier line)'}` : '');
    } else if (s) {
      const ids = [...new Set(s.offsets_not_set.flatMap((m) => m.uncorrelated_ids))];
      const stations = s.offsets_not_set.map((m) => m.station);
      if (stations.length) sub = `Offsets not set for ${stations.join(', ')}`;
      if (ids.length) {
        sub += `; highlighted: the blocks for ${ids.join(', ')}, which did not correlate`;
        lines.forEach((ln, i) => {
          const t = codeOf(ln);
          if (t[0] === 'if' && t.some((w, k) => w === 'station' && ids.includes(t[k + 1]))) {
            const [a, b] = blockRange(lines, i + 1);
            for (let j = a; j <= b; j++) block.add(j);
            hit.add(i + 1);
          }
        });
      }
    }

    const body = el('div', { class: 'cf-text', role: 'region', tabindex: '0' },
      lines.map((ln, i) => el('div', { class: hit.has(i + 1) ? 'hit' : block.has(i + 1) ? 'block' : null },
        el('span', { class: 'ln' }, i + 1), el('span', { class: 'code' }, ln || ' '))));
    panel.replaceChildren(grip(), head, el('div', { class: 'note cf-sub' }, sub,
      ` · ${lines.length} lines · as parsed; prose after the last statement is shown commented`), body);
    const target = body.children[([...hit][0] ?? [...block][0] ?? 1) - 1];
    if (target) body.scrollTop = Math.max(0, target.offsetTop - body.clientHeight / 3);
  }

  function sync(q) {
    const what = parseCf(q.get('cf'));
    if (what && data.sessionById.has(what.session)) show(what);
    else if (!panel.hidden) hide();
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !panel.hidden) close();
  });

  const button = (what, label) => el('button', { type: 'button', class: 'linkish', onclick: () => open(what) }, label);

  return { open, sync, button };
}
