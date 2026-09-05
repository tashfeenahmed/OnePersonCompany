/* One Person Company — shared shell.
 *
 * Renders the sidebar every page shares, keeps projects/sessions/dashboards in
 * localStorage so the prototype behaves like the real thing across reloads, and
 * hands out a couple of small helpers (icon tiles, modals) the pages reuse.
 */

/* ------------------------------------------------------------------ state */

const STORE_KEY = 'opc-state';

const SEED = {
  projects: [
    {
      id: 'p-landing', name: 'Landing page', color: '#c1663f', open: true,
      desc: 'Marketing site, pricing and the copy that goes with it.',
      sessions: ['Pricing table variants', 'Hero copy rewrite', 'Lighthouse score pass'],
    },
    {
      id: 'p-billing', name: 'Billing service', color: '#635bff', open: true,
      desc: 'Stripe integration, invoices and the move to usage-based pricing.',
      sessions: ['Stripe webhook retries', 'Invoice PDF renderer', 'Proration edge cases', 'Migrate to usage-based'],
    },
    {
      id: 'p-tools', name: 'Internal tools', color: '#2f7d4f', open: false,
      desc: 'The small scripts that keep the week running.',
      sessions: ['CSV import cleanup', 'Slack digest cron'],
    },
    {
      id: 'p-unsorted', name: 'Unsorted', color: '#85837c', open: false,
      desc: 'Chats that have not found a home yet.',
      sessions: ['Domain DNS check', 'Notes on onboarding'],
    },
  ],
  dashboards: [
    {
      id: 'd-morning', name: 'Morning check', icon: 'sunrise',
      widgets: [
        { id: 'w1', type: 'stripe.mrr', w: 1 },
        { id: 'w2', type: 'stripe.churn', w: 1 },
        { id: 'w3', type: 'hetzner.spend', w: 1 },
        { id: 'w4', type: 'uptime.status', w: 1 },
        { id: 'w5', type: 'gsc.clicks', w: 2 },
        { id: 'w6', type: 'github.commits', w: 2 },
      ],
    },
    {
      id: 'd-growth', name: 'Growth', icon: 'trend',
      widgets: [
        { id: 'w7', type: 'gsc.impressions', w: 2 },
        { id: 'w8', type: 'bing.keywords', w: 2 },
        { id: 'w9', type: 'meta.spend', w: 1 },
        { id: 'w10', type: 'meta.roas', w: 1 },
        { id: 'w11', type: 'hn.mentions', w: 2 },
      ],
    },
  ],
  activeSession: 'Pricing table variants',
};

const PROJECT_COLORS = ['#c1663f', '#635bff', '#2f7d4f', '#3b7bd8', '#a8446f', '#a86524', '#85837c'];

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.projects)) return parsed;
    }
  } catch (e) { /* private window, cleared storage — fall through to the seed */ }
  return JSON.parse(JSON.stringify(SEED));
}

const State = loadState();

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(State)); } catch (e) {}
}

function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 8);
}

/* ------------------------------------------------------------------ theme */

function initTheme() {
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem('opc-theme'); } catch (e) {}
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
}

function toggleTheme() {
  const root = document.documentElement;
  let cur = root.getAttribute('data-theme');
  if (!cur) cur = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('opc-theme', next); } catch (e) {}
}

initTheme();

/* ------------------------------------------------------------------ icons */

const SVG = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  folder: '<path d="M4 20V7a2 2 0 0 1 2-2h3.6a1 1 0 0 1 .8.4l1.2 1.6H18a2 2 0 0 1 2 2v11"/><path d="M2 20h20"/>',
  plug: '<path d="M12 2H9v3a2 2 0 0 1-2 2H4v3a2 2 0 0 1 0 4v3h3a2 2 0 0 1 4 0h3v-3a2 2 0 0 1 2-2h3V9a2 2 0 0 1 0-4V2h-3"/>',
  grid: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  drag: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  wide: '<path d="M3 12h18"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/>',
  dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  agents: '<circle cx="12" cy="7" r="3"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="18" r="2.4"/><path d="M12 10v3M12 13 6.6 16M12 13l5.4 3"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
};

function svgIcon(name, cls) {
  return '<svg class="' + (cls || 'icon') + '" viewBox="0 0 24 24">' + SVG[name] + '</svg>';
}

/** A rounded brand tile: real Simple Icons glyph on a tint of its brand colour,
 *  or a tinted monogram when the service has no brand mark anywhere. */
function brandTile(spec) {
  const el = document.createElement('div');
  el.className = 'tile';
  const icons = window.ICONS || {};
  if (spec.icon && icons[spec.icon]) {
    const { svg, hex } = icons[spec.icon];
    el.style.setProperty('--tile-bg', hex + '1f');
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="' + hex + '">' + svg + '</svg>';
  } else {
    const tint = spec.tint || '#8b8981';
    el.style.setProperty('--tile-bg', tint + '1f');
    el.innerHTML = '<span class="mono" style="color:' + tint + '">' + (spec.mono || (spec.name || '?')[0]) + '</span>';
  }
  return el;
}

/* ------------------------------------------------------------------ sidebar */

/** @param {string} active  one of: chat | projects | plugins | dashboards */
function renderSidebar(active) {
  const el = document.querySelector('.sidebar');
  if (!el) return;

  el.innerHTML =
    '<div class="brand">' +
      '<div class="brand-mark">1</div>' +
      '<div class="brand-name">One Person Company</div>' +
    '</div>' +

    '<a class="new-chat" href="index.html">' +
      svgIcon('plus') + 'New chat' +
      '<span class="kbd">⌘K</span>' +
    '</a>' +

    '<nav class="nav">' +
      '<a class="nav-item" href="projects.html"' + (active === 'projects' ? ' aria-current="page"' : '') + '>' +
        svgIcon('folder') + 'Projects' +
        '<span class="count" id="sbProjectCount"></span>' +
      '</a>' +
      '<a class="nav-item" href="subagents.html"' + (active === 'subagents' ? ' aria-current="page"' : '') + '>' +
        svgIcon('agents') + 'Sub-agents' +
        '<span class="count" id="sbAgentBadge"></span>' +
      '</a>' +
      '<a class="nav-item" href="plugins.html"' + (active === 'plugins' ? ' aria-current="page"' : '') + '>' +
        svgIcon('plug') + 'Plugins' +
      '</a>' +
      '<a class="nav-item" href="dashboards.html"' + (active === 'dashboards' ? ' aria-current="page"' : '') + '>' +
        svgIcon('grid') + 'Dashboards' +
        '<span class="count" id="sbDashCount"></span>' +
      '</a>' +
    '</nav>' +

    '<div class="sessions">' +
      '<div class="sessions-head">' +
        '<span class="sessions-title">Sessions</span>' +
        '<button class="icon-btn" title="Search sessions">' + svgIcon('search') + '</button>' +
      '</div>' +
      '<div id="sbProjects"></div>' +
    '</div>' +

    '<div class="user">' +
      '<div class="avatar">T</div>' +
      '<div>' +
        '<div class="user-name">Alex</div>' +
        '<div class="user-plan">Solo workspace</div>' +
      '</div>' +
      '<button class="icon-btn theme-toggle" id="themeToggle" style="margin-left:auto" title="Switch theme" aria-label="Switch theme">' +
        svgIcon('sun', 'icon icon-sun') + svgIcon('moon', 'icon icon-moon') +
      '</button>' +
    '</div>';

  el.querySelector('#themeToggle').addEventListener('click', toggleTheme);
  renderSidebarProjects();
}

function renderSidebarProjects() {
  const host = document.getElementById('sbProjects');
  if (!host) return;

  const count = document.getElementById('sbProjectCount');
  if (count) count.textContent = State.projects.length;
  const dcount = document.getElementById('sbDashCount');
  if (dcount) dcount.textContent = State.dashboards.length;
  const abadge = document.getElementById('sbAgentBadge');
  if (abadge && window.SUBAGENT_BADGE) abadge.textContent = window.SUBAGENT_BADGE;

  host.innerHTML = '';
  host.style.display = 'flex';
  host.style.flexDirection = 'column';
  host.style.gap = '10px';

  State.projects.forEach(p => {
    const wrap = document.createElement('div');
    wrap.className = 'project';
    wrap.dataset.open = String(p.open !== false);

    const head = document.createElement('button');
    head.className = 'project-head';
    head.innerHTML =
      svgIcon('chevron', 'icon chev') +
      '<span class="swatch" style="background:' + p.color + '"></span>' +
      '<span class="pname"></span>' +
      '<span class="project-count">' + p.sessions.length + '</span>';
    head.querySelector('.pname').textContent = p.name;
    head.addEventListener('click', () => {
      p.open = wrap.dataset.open !== 'true';
      wrap.dataset.open = String(p.open);
      saveState();
    });

    const list = document.createElement('div');
    list.className = 'project-list';
    p.sessions.forEach(s => {
      const b = document.createElement('button');
      b.className = 'session';
      b.textContent = s;
      if (s === State.activeSession) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => {
        State.activeSession = s;
        saveState();
        renderSidebarProjects();
      });
      list.appendChild(b);
    });

    if (!p.sessions.length) {
      const none = document.createElement('div');
      none.className = 'session';
      none.style.color = 'var(--faint)';
      none.textContent = 'No sessions yet';
      list.appendChild(none);
    }

    wrap.append(head, list);
    host.appendChild(wrap);
  });

  const add = document.createElement('button');
  add.className = 'nav-item';
  add.style.fontSize = '12.5px';
  add.innerHTML = svgIcon('plus') + 'New project';
  add.addEventListener('click', () => openProjectModal());
  host.appendChild(add);
}

/* ------------------------------------------------------------------ modal */

function ensureScrim() {
  let scrim = document.querySelector('.scrim');
  if (!scrim) {
    scrim = document.createElement('div');
    scrim.className = 'scrim';
    document.body.appendChild(scrim);
  }
  return scrim;
}

/**
 * A small modal. `opts.body` is an element, `opts.onConfirm` returns false to
 * keep it open (a blank required field), anything else closes it.
 */
function openModal(opts) {
  const scrim = ensureScrim();
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML =
    '<div class="modal-head">' +
      '<div class="modal-title"></div>' +
      (opts.sub ? '<div class="modal-sub"></div>' : '') +
    '</div>' +
    '<div class="modal-body"></div>' +
    '<div class="modal-foot">' +
      '<button class="btn" data-confirm></button>' +
      '<button class="btn ghost" data-cancel>Cancel</button>' +
      (opts.destructive ? '<button class="btn danger right" data-destroy></button>' : '') +
    '</div>';

  modal.querySelector('.modal-title').textContent = opts.title;
  if (opts.sub) modal.querySelector('.modal-sub').textContent = opts.sub;
  modal.querySelector('.modal-body').appendChild(opts.body);
  modal.querySelector('[data-confirm]').textContent = opts.confirmLabel || 'Save';
  if (opts.destructive) modal.querySelector('[data-destroy]').textContent = opts.destructive.label;

  document.body.appendChild(modal);
  requestAnimationFrame(() => {
    modal.dataset.open = 'true';
    document.body.classList.add('overlay-open');
    const first = modal.querySelector('input, textarea');
    if (first) first.focus();
  });

  function close() {
    modal.dataset.open = 'false';
    document.body.classList.remove('overlay-open');
    scrim.removeEventListener('click', close);
    document.removeEventListener('keydown', onKey);
    setTimeout(() => modal.remove(), 200);
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  modal.querySelector('[data-cancel]').addEventListener('click', close);
  modal.querySelector('[data-confirm]').addEventListener('click', () => {
    if (opts.onConfirm && opts.onConfirm() === false) return;
    close();
  });
  if (opts.destructive) {
    modal.querySelector('[data-destroy]').addEventListener('click', () => {
      opts.destructive.onClick();
      close();
    });
  }
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  return { close, modal };
}

/* ------------------------------------------------------------------ projects */

/** Create or edit a project. Pass a project to edit, nothing to create. */
function openProjectModal(project, afterSave) {
  const editing = !!project;
  const draft = {
    name: project ? project.name : '',
    desc: project ? project.desc || '' : '',
    color: project ? project.color : PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
  };

  const body = document.createElement('div');
  body.innerHTML =
    '<div class="field">' +
      '<label for="pmName">Name</label>' +
      '<input id="pmName" placeholder="Billing service" autocomplete="off">' +
    '</div>' +
    '<div class="field">' +
      '<label for="pmDesc">What it is</label>' +
      '<textarea id="pmDesc" placeholder="One line, so a session six weeks from now still lands in the right place."></textarea>' +
    '</div>' +
    '<div class="field">' +
      '<label>Colour</label>' +
      '<div class="swatches" id="pmColors"></div>' +
    '</div>';

  const nameEl = body.querySelector('#pmName');
  const descEl = body.querySelector('#pmDesc');
  nameEl.value = draft.name;
  descEl.value = draft.desc;

  const colors = body.querySelector('#pmColors');
  PROJECT_COLORS.forEach(c => {
    const b = document.createElement('button');
    b.className = 'swatch-pick';
    b.style.background = c;
    b.setAttribute('aria-pressed', String(c === draft.color));
    b.setAttribute('aria-label', c);
    b.addEventListener('click', () => {
      draft.color = c;
      colors.querySelectorAll('.swatch-pick').forEach(x =>
        x.setAttribute('aria-pressed', String(x.style.background === b.style.background)));
    });
    colors.appendChild(b);
  });

  openModal({
    title: editing ? 'Edit project' : 'New project',
    sub: editing ? null : 'Sessions you start from here are filed under it.',
    body,
    confirmLabel: editing ? 'Save' : 'Create project',
    destructive: editing ? {
      label: 'Delete',
      onClick: () => {
        State.projects = State.projects.filter(p => p !== project);
        saveState();
        renderSidebarProjects();
        if (afterSave) afterSave();
      },
    } : null,
    onConfirm: () => {
      const name = nameEl.value.trim();
      if (!name) { nameEl.focus(); return false; }
      if (editing) {
        project.name = name;
        project.desc = descEl.value.trim();
        project.color = draft.color;
      } else {
        State.projects.push({
          id: uid('p'), name, desc: descEl.value.trim(),
          color: draft.color, open: true, sessions: [],
        });
      }
      saveState();
      renderSidebarProjects();
      if (afterSave) afterSave();
    },
  });
}
