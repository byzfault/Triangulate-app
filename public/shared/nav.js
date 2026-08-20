/**
 * Suite navigation, shared by every tool page.
 *
 * Each page carries a single <div id="nav" data-tool="..."> and this fills it in, so adding
 * a tool means adding one entry to TOOLS rather than editing every page's markup.
 */
const TOOLS = [
  {
    id: 'triangulate',
    name: 'Triangulate',
    href: '/triangulate/',
    blurb: 'Find wallets that bought every token in a set',
  },
  {
    id: 'copytracker',
    name: 'Copy Tracker',
    href: '/copy-tracker/',
    blurb: 'Trace which wallets a trader is copying',
  },
  {
    id: 'usage',
    name: 'API Usage',
    href: '/usage/',
    blurb: 'Free, quota and paid request accounting',
  },
];

function buildNav(host) {
  const current = host.dataset.tool;

  host.innerHTML = `
    <button class="nav-burger" id="navBurger" aria-label="Open menu" aria-expanded="false" aria-controls="navMenu">
      <span></span><span></span><span></span>
    </button>
    <a class="nav-suite" href="/triangulate/" aria-label="Triangulate">
      <img class="nav-logo" src="/shared/triangulate-logo-wordmark.svg" alt="Triangulate" width="430" height="120">
    </a>
    <nav class="nav-menu" id="navMenu" hidden>
      <p class="nav-heading">Tools</p>
      ${TOOLS.map(
        (t) => `
        <a class="nav-item${t.id === current ? ' is-current' : ''}" href="${t.href}">
          <span class="nav-item-name">${t.name}</span>
          <span class="nav-item-blurb">${t.blurb}</span>
        </a>`,
      ).join('')}
      <p class="nav-foot" id="navUsage">—</p>
    </nav>
    <div class="nav-scrim" id="navScrim" hidden></div>
  `;

  const burger = host.querySelector('#navBurger');
  const menu = host.querySelector('#navMenu');
  const scrim = host.querySelector('#navScrim');

  const setOpen = (open) => {
    menu.hidden = !open;
    scrim.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    burger.classList.toggle('is-open', open);
    if (open) refreshUsage(host);
  };

  burger.addEventListener('click', () => setOpen(menu.hidden));
  scrim.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) setOpen(false);
  });
}

/** A running quota figure in the menu, so cost is visible from anywhere in the suite. */
async function refreshUsage(host) {
  const el = host.querySelector('#navUsage');
  if (!el) return;
  try {
    const res = await fetch('/api/usage');
    if (!res.ok) throw new Error();
    const u = await res.json();
    if (u.exhausted) {
      el.textContent = 'Solana Tracker: no credits left';
      el.className = 'nav-foot is-hot';
      return;
    }
    const pct = Math.round(u.quota.percent);
    el.textContent = `${u.quota.used.toLocaleString()} / ${u.quota.limit.toLocaleString()} monthly requests used (${pct}%)`;
    el.className = 'nav-foot' + (pct >= 90 ? ' is-hot' : pct >= 70 ? ' is-warm' : '');
  } catch {
    el.textContent = 'Usage unavailable';
  }
}

const host = document.getElementById('nav');
if (host) buildNav(host);
