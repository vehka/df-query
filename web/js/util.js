// Small DOM + formatting helpers shared by every view.

/** Create an element. Children may be nodes, strings, or nested arrays. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : String(child));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * Lua's JSON writer emits `{}` for tables it cannot tell apart from objects,
 * and the dumper's own maps are objects. Normalise anything we expect to
 * iterate as a list.
 */
export function asList(value) {
  return Array.isArray(value) ? value : [];
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

// The vertical half of a coordinate is DF's elevation, which only `db`
// knows how to compute -- hence the argument. Without one these fall back
// to the raw z index, which is what an old snapshot can offer anyway.
function level(z, db) {
  return db ? db.elevLabel(z) : `z${z}`;
}

/** DF coordinates, in the order the game's cursor readout uses. */
export function formatPos(pos, db) {
  if (!pos) return '—';
  return `${pos.x}, ${pos.y}, ${level(pos.z, db)}`;
}

export function formatBox(b, db) {
  if (b.x1 === b.x2 && b.y1 === b.y2) return `${b.x1}, ${b.y1}, ${level(b.z, db)}`;
  return `${b.x1},${b.y1}–${b.x2},${b.y2} ${level(b.z, db)}`;
}

export function debounce(fn, ms = 150) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Case-insensitive substring match, tolerant of missing haystacks. */
export function matches(haystack, needle) {
  if (!needle) return true;
  return String(haystack || '').toLowerCase().includes(needle.toLowerCase());
}

/** Sort helper: descending by `key`, then ascending by name for stability. */
export function byDesc(key, nameKey = 'name') {
  return (a, b) => (key(b) - key(a)) || String(a[nameKey]).localeCompare(String(b[nameKey]));
}

export function pct(value) {
  return `${Math.round(value * 100)}%`;
}
