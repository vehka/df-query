// A small force-directed layout + SVG renderer for the stockpile/workshop
// flow graph. Hand-rolled so the viewer stays dependency-free.

const REPULSION = 9000;
const SPRING = 0.008;
const SPRING_LENGTH = 90;
const CENTER_PULL = 0.004;
const DAMPING = 0.85;
const ITERATIONS = 400;

/**
 * @param {Array<{id:number,label:string,kind:string}>} nodes
 * @param {Array<{from:number,to:number}>} edges
 * @param {{width:number,height:number}} size
 */
export function layout(nodes, edges, { width, height }) {
  const points = new Map();
  // Deterministic starting ring, so the same fort lays out the same way twice.
  nodes.forEach((node, i) => {
    const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
    const radius = Math.min(width, height) * 0.35;
    points.set(node.id, {
      node,
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    });
  });

  const list = [...points.values()];
  const links = edges
    .map((e) => ({ a: points.get(e.from), b: points.get(e.to) }))
    .filter((l) => l.a && l.b);

  for (let step = 0; step < ITERATIONS; step++) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) {
          // Perfectly coincident nodes have no direction to separate along.
          dx = (i % 7) - 3;
          dy = (j % 7) - 3;
          distSq = dx * dx + dy * dy || 1;
        }
        const force = REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        a.vx += (dx / dist) * force;
        a.vy += (dy / dist) * force;
        b.vx -= (dx / dist) * force;
        b.vy -= (dy / dist) * force;
      }
    }

    for (const { a, b } of links) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - SPRING_LENGTH) * SPRING;
      a.vx += (dx / dist) * force;
      a.vy += (dy / dist) * force;
      b.vx -= (dx / dist) * force;
      b.vy -= (dy / dist) * force;
    }

    for (const p of list) {
      p.vx += (width / 2 - p.x) * CENTER_PULL;
      p.vy += (height / 2 - p.y) * CENTER_PULL;
      p.vx *= DAMPING;
      p.vy *= DAMPING;
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  return points;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) el.setAttribute(key, value);
  }
  return el;
}

export function renderGraph(nodes, edges, { width = 900, height = 620, onSelect } = {}) {
  const points = layout(nodes, edges, { width, height });

  // Fit the settled layout to the viewport rather than trusting the constants.
  const xs = [...points.values()].map((p) => p.x);
  const ys = [...points.values()].map((p) => p.y);
  const pad = 60;
  const minX = Math.min(...xs, 0) - pad;
  const minY = Math.min(...ys, 0) - pad;
  const maxX = Math.max(...xs, width) + pad;
  const maxY = Math.max(...ys, height) + pad;

  const svg = svgEl('svg', {
    class: 'flow-graph',
    viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  const defs = svgEl('defs');
  const marker = svgEl('marker', {
    id: 'arrow', viewBox: '0 0 10 10', refX: 10, refY: 5,
    markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
  });
  marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'arrow-head' }));
  defs.append(marker);
  svg.append(defs);

  const edgeLayer = svgEl('g', { class: 'edges' });
  for (const edge of edges) {
    const a = points.get(edge.from);
    const b = points.get(edge.to);
    if (!a || !b) continue;
    // Stop short of the target node so the arrowhead is not buried under it.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const trim = 16;
    edgeLayer.append(svgEl('line', {
      x1: a.x, y1: a.y,
      x2: b.x - (dx / dist) * trim,
      y2: b.y - (dy / dist) * trim,
      'marker-end': 'url(#arrow)',
    }));
  }
  svg.append(edgeLayer);

  const nodeLayer = svgEl('g', { class: 'nodes' });
  for (const node of nodes) {
    const p = points.get(node.id);
    if (!p) continue;
    const group = svgEl('g', { class: `node ${node.kind}`, transform: `translate(${p.x} ${p.y})` });
    if (node.kind === 'stockpile') {
      group.append(svgEl('circle', { r: 11 }));
    } else {
      group.append(svgEl('rect', { x: -11, y: -11, width: 22, height: 22, rx: 3 }));
    }
    const label = svgEl('text', { y: 26, 'text-anchor': 'middle' });
    label.textContent = node.label;
    group.append(label);
    if (onSelect) group.addEventListener('click', () => onSelect(node));
    nodeLayer.append(group);
  }
  svg.append(nodeLayer);

  return svg;
}
