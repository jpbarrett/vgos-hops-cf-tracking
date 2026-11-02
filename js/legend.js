// What the marks on the page mean: the session-type groups and the
// offsets-not-set crosses. Each is described once, here -- its label, its
// colour (a token in style.css) and its marker -- and the colour key, the
// type menu, the plots and the tables all draw from this.

// Four colour groups, not one per type: points of every type share one time
// axis, and only three categorical hues stay distinguishable in that case, so
// VGOS-RD is drawn in ink (black, or near-white on a dark page) rather than a
// fourth hue. The exact type is in every hover and table. A type belongs to
// the first group whose `match` accepts it; `symbol` is the Plotly marker, so
// a point's type never rests on colour alone
export const TYPE_GROUPS = [
  { label: 'VGOS-OPS', match: (t) => t === 'VGOS-OPS', colour: '--type-1', symbol: 'circle' },
  { label: 'VGOS-INT-A', match: (t) => t === 'VGOS-INT-A', colour: '--type-2', symbol: 'square' },
  { label: 'VGOS-RD', match: (t) => t === 'VGOS-RD', colour: '--type-rd', symbol: 'triangle-up' },
  { label: 'Other VGOS intensives', match: () => true, colour: '--type-3', symbol: 'diamond' },
];

// a session type's index in TYPE_GROUPS
export function typeGroup(type) {
  return TYPE_GROUPS.findIndex((g) => g.match(type));
}

// the type menu's presets; a null `match` means every type
export const TYPE_PRESETS = [
  { label: 'All', match: null },
  { label: 'VGOS-OPS', match: (t) => t === 'VGOS-OPS' },
  { label: 'Intensives', match: (t) => /^VGOS-(24)?INT-/.test(t) },
  { label: 'VGOS-RD', match: (t) => t === 'VGOS-RD' },
];

// the two kinds of offsets_not_set entry, as the key, the tables and the
// plots show them: a thin cross in a strip of its own below the plot, where
// no value can hide it or be hidden by it. A missed station is a heavy cross
// in the status colour; a session that set offsets for no station, a light
// one in muted ink
export const NOT_SET = {
  station: { label: 'Offsets not set', colour: '--accent', width: 2.5 },
  session: { label: 'Offsets not set for any station in the session', colour: '--text-muted', width: 1.5 },
};
export const NOT_SET_SYMBOL = 'x-thin';

// a value from an imported control file: a large orange star, the one mark on the
// page meant to stand out, ringed in the surface colour so that it stays
// readable on top of the points around it
export const IMPORTED = { label: 'Imported control file', colour: '--imported', symbol: 'star',
                          ringWidth: 2 };
