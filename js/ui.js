// The controls and helpers every view shares: building DOM, formatting, the
// hash, the date-range and session-type filters, and the swatches of the
// colour key. Knows nothing about which view is showing; what a control
// needs from the export is passed in.

import { TYPE_GROUPS, TYPE_PRESETS, NOT_SET } from './legend.js';

// --------------------------------------------------------------------------
// tiny DOM helpers; all text goes in through textContent

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

export const day = (iso) => (iso ? iso.slice(0, 10) : '—');
export const fmt = (v) => (v == null ? '—' : Number(v).toPrecision(6).replace(/\.?0+(e|$)/, '$1'));

// --------------------------------------------------------------------------
// the hash: #/<path>?<view state>, so every view is a shareable link

export function parseHash() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent),
           q: new URLSearchParams(qs || '') };
}

// the hash for path `parts` and query `q`; empty values are left out
export function hashHref(parts, q = {}) {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== ''));
  const s = qs.toString();
  return '#/' + parts.map(encodeURIComponent).join('/') + (s ? '?' + s : '');
}

// replace the query without adding history or re-rendering
export function patchQuery(changes) {
  const { parts, q } = parseHash();
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === '') q.delete(k); else q.set(k, v);
  }
  history.replaceState(null, '', hashHref(parts, Object.fromEntries(q)));
}

// --------------------------------------------------------------------------
// date range: presets count back from the last session in the data, not from
// today, so "last 12 months" always has something in it. `coverage` is the
// manifest's

export function rangeFromQuery(q, coverage) {
  const from = q.get('from'), to = q.get('to');
  return from || to ? [from || day(coverage.first_epoch), to || day(coverage.last_epoch)] : null;
}

function presetRange(months, coverage) {
  if (!months) return null;
  const last = new Date(coverage.last_epoch);
  const from = new Date(last);
  from.setUTCMonth(from.getUTCMonth() - months);
  return [from.toISOString().slice(0, 10), last.toISOString().slice(0, 10)];
}

export function rangeControls(range, apply, coverage) {
  const from = el('input', { type: 'date', value: range ? range[0].slice(0, 10) : '' });
  const to = el('input', { type: 'date', value: range ? range[1].slice(0, 10) : '' });
  const presets = [['All', 0], ['24 mo', 24], ['12 mo', 12], ['6 mo', 6]];
  const buttons = presets.map(([label, m]) => el('button', {
    type: 'button',
    'aria-pressed': String(m === 0 ? !range : false),
    onclick: () => set(presetRange(m, coverage)),
  }, label));
  function set(r) {
    from.value = r ? r[0].slice(0, 10) : '';
    to.value = r ? r[1].slice(0, 10) : '';
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(i === 0 && !r)));
    apply(r);
  }
  const custom = () => set(from.value || to.value ? [from.value || day(coverage.first_epoch),
                                                     to.value || day(coverage.last_epoch)] : null);
  from.addEventListener('change', custom);
  to.addEventListener('change', custom);
  return { node: el('span', { class: 'filters-range' },
                    el('span', { class: 'seg', role: 'group', 'aria-label': 'Date range' }, buttons),
                    ' ', el('label', {}, 'From', from), ' ', el('label', {}, 'to', to)),
           set };
}

// --------------------------------------------------------------------------
// swatches: the marks as the plots draw them, for the key, menu and tables

const SVG = 'http://www.w3.org/2000/svg';

function svgBox() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', '10'); svg.setAttribute('height', '10'); svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

// a small marker in a type group's colour and shape
export function swatch(group) {
  const svg = svgBox();
  const { symbol, colour } = TYPE_GROUPS[group];
  const mark = document.createElementNS(SVG, symbol === 'circle' ? 'circle' : 'polygon');
  const points = { square: '1,1 9,1 9,9 1,9', 'triangle-up': '5,1 9.5,9 0.5,9', diamond: '5,0 10,5 5,10 0,5' };
  if (symbol === 'circle') { mark.setAttribute('cx', '5'); mark.setAttribute('cy', '5'); mark.setAttribute('r', '4'); }
  else mark.setAttribute('points', points[symbol]);
  mark.setAttribute('style', `fill: var(${colour})`);
  svg.append(mark);
  return svg;
}

// a not-set cross of this kind
export function notSetSwatch(kind) {
  const svg = svgBox();
  const mark = document.createElementNS(SVG, 'path');
  mark.setAttribute('d', 'M1.5,1.5 L8.5,8.5 M8.5,1.5 L1.5,8.5');
  mark.setAttribute('style', `fill: none; stroke: var(${NOT_SET[kind].colour}); ` +
                             `stroke-width: ${NOT_SET[kind].width}`);
  svg.append(mark);
  return svg;
}

// --------------------------------------------------------------------------
// the session-type filter plus the colour key, which is the legend for every
// plot on the page.
//
// available: the export's types ({type, n, group}); chosen: the Set of
// types shown, or null for all; nShown: how many sessions that keeps;
// go(set): apply a new choice (null for all); notSet: the kinds of not-set
// mark the page shows, which join the key. Null when no session has a type
// (none is in a master file); shown for even one type, so it is clear what
// the data holds
export function typeFilter({ available, chosen, nShown, go, notSet = [] }) {
  if (!available.length) return null;
  const names = available.map((t) => t.type);
  const ticked = chosen || new Set(names);
  const boxes = available.map((t) => el('label', {},
    el('input', { type: 'checkbox', value: t.type, checked: ticked.has(t.type) }),
    swatch(t.group), t.type, el('span', { class: 'count' }, t.n)));
  const menu = el('div', { class: 'types-menu' },
    el('span', { class: 'seg', role: 'group', 'aria-label': 'Session type presets' },
      TYPE_PRESETS.map((p) => el('button', {
        type: 'button', onclick: () => go(p.match ? new Set(names.filter(p.match)) : null),
      }, p.label))),
    boxes);
  menu.addEventListener('change', () => {
    const picked = new Set(boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value));
    // nothing ticked means nothing to show; read it as "all" instead
    go(picked.size && picked.size < available.length ? picked : null);
  });
  const what = !chosen ? 'All session types' : chosen.size === 1 ? [...chosen][0] : `${chosen.size} session types`;
  const groups = [...new Set(available.filter((t) => ticked.has(t.type)).map((t) => t.group))].sort();
  return el('span', { class: 'filters-types' },
    el('details', { class: 'types' }, el('summary', {}, `${what} (${nShown})`), menu),
    ' ',
    el('span', { class: 'key', 'aria-label': 'Colour key' },
      groups.map((g) => el('span', {}, swatch(g), TYPE_GROUPS[g].label)),
      Object.keys(NOT_SET).filter((k) => notSet.includes(k))
        .map((k) => el('span', {}, notSetSwatch(k), NOT_SET[k].label))));
}
