// App shell: loads the snapshot, owns the nav, and drives manual refreshes.

import { h, clear } from './util.js';
import { Db } from './db.js';
import * as skills from './views/skills.js';
import * as stockpiles from './views/stockpiles.js';
import * as flow from './views/flow.js';
import * as animals from './views/animals.js';
import * as equipment from './views/equipment.js';
import * as squads from './views/squads.js';
import * as visitors from './views/visitors.js';
import * as instruments from './views/instruments.js';

const VIEWS = [
  { id: 'skills', label: 'Skills', module: skills },
  { id: 'stockpiles', label: 'Stockpiles', module: stockpiles },
  { id: 'flow', label: 'Flow', module: flow },
  { id: 'animals', label: 'Animals', module: animals },
  { id: 'squads', label: 'Squads', module: squads },
  { id: 'equipment', label: 'Equipment', module: equipment },
  { id: 'visitors', label: 'Visitors', module: visitors },
  { id: 'instruments', label: 'Instruments', module: instruments },
];

const el = {
  nav: document.getElementById('nav'),
  view: document.getElementById('view'),
  status: document.getElementById('status'),
  banner: document.getElementById('banner'),
  refresh: document.getElementById('refresh'),
  fort: document.getElementById('fort'),
};

let db = null;
let current = location.hash.slice(1) || 'skills';

function showBanner(message, kind = 'error') {
  clear(el.banner);
  if (!message) {
    el.banner.hidden = true;
    return;
  }
  el.banner.hidden = false;
  el.banner.className = `banner ${kind}`;
  el.banner.append(message);
}

function renderNav() {
  clear(el.nav);
  for (const view of VIEWS) {
    el.nav.append(h('button', {
      class: current === view.id ? 'active' : '',
      onclick: () => {
        current = view.id;
        location.hash = view.id;
        renderNav();
        renderView();
      },
    }, view.label));
  }
}

function renderView() {
  clear(el.view);
  if (!db) {
    el.view.append(h('p', { class: 'empty' },
      'No snapshot loaded yet. Start Dwarf Fortress with DFHack, load your fort, then hit Refresh.'));
    return;
  }
  const view = VIEWS.find((v) => v.id === current) || VIEWS[0];
  view.module.render(el.view, db);
}

function renderHeader() {
  clear(el.fort);
  clear(el.status);
  if (!db) return;
  const m = db.meta;
  el.fort.append(h('strong', {}, m.fort_name || 'Unnamed fortress'),
    m.group_name ? h('span', { class: 'muted' }, ` · ${m.group_name}`) : null);
  const age = Math.round((Date.now() / 1000 - (m.generated_at || 0)) / 60);
  el.status.append(
    `${m.month_name} ${m.day}, year ${m.year}`,
    h('span', { class: 'muted' },
      ` · snapshot ${age <= 0 ? 'just now' : `${age} min old`}`));
}

async function loadSnapshot() {
  const response = await fetch('/api/snapshot');
  if (response.status === 404) {
    db = null;
    renderHeader();
    renderView();
    return;
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  db = new Db(payload);
  renderHeader();
  renderView();
}

async function refresh() {
  el.refresh.disabled = true;
  el.refresh.textContent = 'Refreshing…';
  showBanner(null);
  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.statusText);
    await loadSnapshot();
    showBanner(payload.message, 'ok');
    setTimeout(() => showBanner(null), 4000);
  } catch (error) {
    showBanner(String(error.message || error));
  } finally {
    el.refresh.disabled = false;
    el.refresh.textContent = 'Refresh';
  }
}

el.refresh.addEventListener('click', refresh);
window.addEventListener('hashchange', () => {
  current = location.hash.slice(1) || 'skills';
  renderNav();
  renderView();
});

renderNav();
loadSnapshot().catch((error) => {
  renderView();
  showBanner(String(error.message || error));
});
