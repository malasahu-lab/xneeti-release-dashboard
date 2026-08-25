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
    // eslint-disable-next-line no-use-before-define
    try {
        const res = await fetch(LIVE_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const items = json.releases || [];
        if (!items.length) throw new Error('empty payload');
        window.CURRENT_RELEASES = items;
        return { items, source: 'live' };
    } catch (err) {
        console.warn('Live fetch failed, using bundled snapshot', err);
        window.CURRENT_RELEASES = window.RELEASES_FALLBACK || [];
        return { items: window.CURRENT_RELEASES, source: 'fallback', error: err };
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
            ` <button id="srcRefresh">Check for new releases</button>` +
            ` <button id="srcRun" class="ghost">Run update ↗</button>`;
    } else {
        el.className = 'src stale';
        el.innerHTML =
            `<span class="led"></span> Offline snapshot · ${items.length} releases · live source unreachable` +
            ` <button id="srcRefresh">Retry</button>`;
    }

    const btn = document.getElementById('srcRefresh');
    if (btn) btn.onclick = () => checkForNewReleases(items.length);
    const run = document.getElementById('srcRun');
    if (run) run.onclick = runUpdate;
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

/* ------------------------------------------------------------------ *
 * Running the update from the dashboard.
 *
 * The page cannot start the workflow itself. Triggering one needs a token
 * with actions:write, and anything shipped to a public page is public — so
 * that token would let anyone fire this repo's Actions. The button therefore
 * opens GitHub's own "Run workflow" control in a new tab.
 *
 * Watching it, though, needs no auth at all: the runs API is readable
 * anonymously for a public repo and sends access-control-allow-origin: *.
 * So once you start the run, this page follows it to completion on its own
 * and reloads the log when it finishes.
 * ------------------------------------------------------------------ */

const REPO = 'malasahu-lab/xneeti-release-dashboard';
const WORKFLOW = 'log-releases.yml';
const RUNS_API = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`;
const DISPATCH_URL = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`;

const POLL_MS = 6000;
const GIVE_UP_MS = 5 * 60 * 1000;

async function latestRun() {
    const res = await fetch(RUNS_API, { cache: 'no-store' });
    // Unauthenticated GitHub allows 60 requests/hour per IP. Say so plainly
    // rather than looking like the workflow broke.
    if (res.status === 403 || res.status === 429) throw new Error('rate-limited');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const r = (await res.json()).workflow_runs[0];
    return r ? { id: r.id, status: r.status, conclusion: r.conclusion, url: r.html_url } : null;
}

function pill(html, cls = 'src') {
    const el = document.getElementById('srcPill');
    if (el) { el.className = cls; el.innerHTML = html; }
}

const spinner = '<span class="spin"></span>';

async function runUpdate() {
    let baseline = null;
    try {
        baseline = await latestRun();
    } catch (err) {
        pill(`<span class="led"></span> Could not reach GitHub${err.message === 'rate-limited' ? ' — rate limit reached, try again shortly' : ''}`, 'src err');
        return;
    }

    const before = (window.CURRENT_RELEASES || []).length;
    window.open(DISPATCH_URL, '_blank', 'noopener');
    pill(`${spinner} Opened GitHub — click <strong>Run workflow</strong> there, this page will follow it`, 'src busy');

    const started = Date.now();
    let sawNewRun = false;

    while (Date.now() - started < GIVE_UP_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));

        let run;
        try {
            run = await latestRun();
        } catch (err) {
            if (err.message === 'rate-limited') {
                pill('<span class="led"></span> GitHub rate limit reached — the run may still be going. Reload in a minute.', 'src stale');
                return;
            }
            continue; // a blip; keep watching
        }
        if (!run) continue;

        const isNew = !baseline || run.id !== baseline.id;
        if (isNew) sawNewRun = true;

        if (!sawNewRun) {
            pill(`${spinner} Waiting for you to start the run on GitHub…`, 'src busy');
            continue;
        }

        if (run.status !== 'completed') {
            pill(`${spinner} Update running…`, 'src busy');
            continue;
        }

        if (run.conclusion !== 'success') {
            pill(`<span class="led"></span> The update run ${run.conclusion || 'did not succeed'} — <a href="${run.url}" target="_blank" rel="noopener">see the log</a>`, 'src err');
            return;
        }

        // The commit has landed, but Pages needs a moment to republish it.
        pill(`${spinner} Update finished — fetching the new log…`, 'src busy');
        for (let i = 0; i < 10; i++) {
            const result = await loadReleases();
            if (result.items.length !== before) {
                if (typeof window.onReleasesReloaded === 'function') window.onReleasesReloaded(result.items);
                renderSource(result);
                const gained = result.items.length - before;
                document.getElementById('srcPill').insertAdjacentHTML('beforeend',
                    ` <strong style="color:var(--good)">+${gained} new</strong>`);
                return;
            }
            await new Promise((r) => setTimeout(r, 5000));
        }
        const result = await loadReleases();
        if (typeof window.onReleasesReloaded === 'function') window.onReleasesReloaded(result.items);
        renderSource(result);
        document.getElementById('srcPill').insertAdjacentHTML('beforeend',
            ' <strong>no new releases</strong>');
        return;
    }

    pill('<span class="led"></span> Gave up watching after 5 minutes — reload to see where it got to', 'src stale');
}
