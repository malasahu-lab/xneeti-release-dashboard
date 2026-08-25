/* Shared helpers for the Release Management mockup.
 *
 * Data is fetched live from the deployed release log, so a new release added by
 * the hourly routine shows up here without touching this file. The embedded
 * snapshot in data-fallback.js is only used if that fetch fails.
 */

const LIVE_URL = 'https://malasahu-lab.github.io/xneeti-release-dashboard/releases.json';

const TAG_LABEL = { feature: 'Feature', bugfix: 'Bug fix', hotfix: 'Hotfix', breaking: 'Breaking', chore: 'Chore' };
const LABEL_SHORT = {
    'Frontend': 'Frontend',
    'Backend (ECS)': 'Backend (ECS)',
    'Backend (EC2 + Scheduler)': 'Backend (EC2)',
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmt = (iso) =>
    new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const ago = (iso) => {
    const h = Math.floor((Date.now() - new Date(iso)) / 36e5);
    if (h < 1) return 'just now';
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    const d = Math.floor(h / 24);
    return d + (d === 1 ? ' day ago' : ' days ago');
};

const chip = (r) => {
    if (r.status === 'failed') return '<span class="chip failed">Deploy failed</span>';
    if (r.status === 'cancelled') return '<span class="chip cancelled">Cancelled</span>';
    return `<span class="chip ${r.risk_tag}">${TAG_LABEL[r.risk_tag] || r.risk_tag || '—'}</span>`;
};

/** Latest successful release per component — powers the header dialog. */
function liveReleases(all) {
    const pick = (pred) =>
        all.filter((r) => r.status === 'success' && pred(r)).sort((a, b) => new Date(b.deployed_at) - new Date(a.deployed_at))[0];
    return [pick((r) => r.component === 'frontend'), pick((r) => r.component_label === 'Backend (ECS)')].filter(Boolean);
}

/**
 * Fetch the live log, falling back to the bundled snapshot.
 * `cache: 'no-store'` so a refresh really does re-check rather than reusing a
 * cached copy — GitHub Pages sets max-age=600 otherwise.
 */
async function loadReleases() {
    try {
        const res = await fetch(LIVE_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const items = json.releases || [];
        if (!items.length) throw new Error('empty payload');
        return { items, source: 'live' };
    } catch (err) {
        console.warn('Live fetch failed, using bundled snapshot', err);
        return { items: window.RELEASES_FALLBACK || [], source: 'fallback', error: err };
    }
}

/** Bottom status pill: names the data source honestly rather than hiding it. */
function renderSource({ source, items }) {
    const el = document.getElementById('srcPill');
    if (!el) return;

    const newest = items.length
        ? items.slice().sort((a, b) => new Date(b.deployed_at) - new Date(a.deployed_at))[0].deployed_at
        : null;

    if (source === 'live') {
        el.className = 'src';
        el.innerHTML =
            `<span class="led"></span> Live data · ${items.length} releases` +
            (newest ? ` · latest ${ago(newest)}` : '') +
            ` <button id="srcRefresh">Check for new releases</button>`;
    } else {
        el.className = 'src stale';
        el.innerHTML =
            `<span class="led"></span> Offline snapshot · ${items.length} releases · live source unreachable` +
            ` <button id="srcRefresh">Retry</button>`;
    }

    const btn = document.getElementById('srcRefresh');
    if (btn) btn.onclick = () => checkForNewReleases(items.length);
}


/**
 * "Check for new releases" — re-fetches the log without reloading the page.
 * This only re-reads what has already been logged; it cannot make the pipeline
 * run. Nothing behind a static page can.
 */
async function checkForNewReleases(previousCount) {
    const el = document.getElementById('srcPill');
    if (el) el.innerHTML = '<span class="led"></span> Checking…';

    const result = await loadReleases();
    if (typeof window.onReleasesReloaded === 'function') window.onReleasesReloaded(result.items);
    renderSource(result);

    const gained = result.items.length - previousCount;
    if (gained > 0) {
        const el2 = document.getElementById('srcPill');
        if (el2) {
            el2.classList.add('fresh');
            el2.insertAdjacentHTML('beforeend',
                ` <strong style="color:var(--good)">+${gained} new</strong>`);
        }
    }
}
