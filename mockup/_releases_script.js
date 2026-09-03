/* Release Management page: list + detail.
 *
 * Detail is addressed by hash (#/fe-v1.5.18) so a specific release is a
 * shareable link — the same reason the real design routes by id rather than
 * version.
 */

let ALL = [];
const state = { page: 1, size: 25, search: '', type: '', tag: '', from: '', to: '' };

/* The table shows local time, so the date filter has to compare local dates
 * too. Comparing the UTC date would put anything deployed between midnight
 * and 05:30 IST on the wrong day. */
const localDay = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* the release dialog stays available on this page too */
const relBtn = document.getElementById('relBtn');
const relPop = document.getElementById('relPop');

function renderPopover() {
    document.getElementById('popRows').innerHTML = liveReleases(ALL)
        .map(
            (r, i) => `
      <div class="pop-row">
        <span class="pop-dot"></span>
        <div class="pop-body">
          <div class="pop-top">
            <span class="pop-comp">${esc(r.component_label)}</span>
            <span class="pop-ver">${esc(r.version)}</span>
          </div>
          <p class="pop-sum clamp" id="sum${i}">${esc(r.overview)}</p>
          <ul class="pop-extra" id="ex${i}">
            ${r.highlights.slice(0, 3).map((h) => `<li>${esc(h)}</li>`).join('')}
          </ul>
          <div class="pop-meta">${ago(r.deployed_at)} · @${esc(r.deployed_by)}</div>
          <button class="pop-more" data-i="${i}">Show more</button>
        </div>
      </div>`,
        )
        .join('');

    document.querySelectorAll('.pop-more').forEach((btn) => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const i = btn.dataset.i;
            const ex = document.getElementById('ex' + i);
            const open = ex.dataset.open === 'true';
            ex.dataset.open = String(!open);
            document.getElementById('sum' + i).classList.toggle('clamp', open);
            btn.textContent = open ? 'Show more' : 'Show less';
        };
    });
}

relBtn.onclick = (e) => {
    e.stopPropagation();
    const open = !relPop.hidden;
    relPop.hidden = open;
    relBtn.classList.toggle('active', !open);
    if (!open) {
        renderPopover();
        const dot = document.getElementById('relDot');
        if (dot) dot.style.display = 'none';
    }
};
document.addEventListener('click', (e) => {
    if (!relPop.hidden && !relPop.contains(e.target)) {
        relPop.hidden = true;
        relBtn.classList.remove('active');
    }
});
// Already on the release page — go back to the list rather than reloading.
document.getElementById('viewAll').onclick = (e) => {
    e.preventDefault();
    relPop.hidden = true;
    relBtn.classList.remove('active');
    if (location.hash) location.hash = '';
    else renderList();
};

/* ---------------- list ---------------- */
function filtered() {
    let list = ALL.slice();
    if (state.type) list = list.filter((r) => r.component_label === state.type);
    if (state.tag) {
        list = list.filter((r) => (state.tag === 'failed' ? r.status === 'failed' : r.risk_tag === state.tag));
    }
    if (state.from) list = list.filter((r) => localDay(r.deployed_at) >= state.from);
    if (state.to) list = list.filter((r) => localDay(r.deployed_at) <= state.to);
    if (state.search.trim()) {
        const q = state.search.trim().toLowerCase();
        list = list.filter(
            (r) =>
                r.version.toLowerCase().includes(q) ||
                r.deployed_by.toLowerCase().includes(q) ||
                (r.commit || '').toLowerCase().includes(q) ||
                r.overview.toLowerCase().includes(q),
        );
    }
    return list.sort((a, b) => new Date(b.deployed_at) - new Date(a.deployed_at));
}

function pageNumbers(cur, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    if (cur <= 4) return [1, 2, 3, 4, 5, -1, total];
    if (cur >= total - 3) return [1, -1, total - 4, total - 3, total - 2, total - 1, total];
    return [1, -1, cur - 1, cur, cur + 1, -2, total];
}

/* The toolbar is rendered ONCE. Rebuilding the whole view on every keystroke
 * destroyed the input mid-typing — the focus() call afterwards was aiming at
 * the old, detached element, so the caret vanished after one character.
 * Typing now only re-renders the rows and the pager. */

/** Stop the picker offering dates with no releases in them. */
function dateBounds() {
    const days = ALL.map((r) => localDay(r.deployed_at)).sort();
    return { min: days[0] || '', max: days[days.length - 1] || '' };
}

function toolbarHTML() {
    const bounds = dateBounds();
    return `
    <h1 class="page">Release Management</h1>
    <p class="dek">Every production deploy, translated into plain language — what shipped, who shipped it, and how risky it was.</p>

    <div class="toolbar">
      <input class="field" id="search" placeholder="Search version, author or commit…" value="${esc(state.search)}">
      <select class="field" id="fType">
        <option value="">All components</option>
        <option value="Frontend">Frontend</option>
        <option value="Backend (ECS)">Backend (ECS)</option>
        <option value="Backend (EC2 + Scheduler)">Backend (EC2 + Scheduler)</option>
      </select>
      <select class="field" id="fTag">
        <option value="">All tags</option>
        <option value="feature">Feature</option>
        <option value="bugfix">Bug fix</option>
        <option value="hotfix">Hotfix</option>
        <option value="breaking">Breaking</option>
        <option value="chore">Chore</option>
        <option value="failed">Deploy failed</option>
      </select>
      <select class="field" id="fSize">
        <option value="25">25 / page</option>
        <option value="50">50 / page</option>
        <option value="100">100 / page</option>
      </select>

      <div class="cal-wrap">
        <button class="field cal-btn" id="fDate" aria-haspopup="dialog" aria-expanded="false">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>
          </svg>
          <span id="fDateLabel">${esc(dateLabel())}</span>
          <span class="caret">⌄</span>
        </button>
        <div class="cal-pop" id="calPop" role="dialog" aria-label="Filter by date" hidden></div>
      </div>

      <button class="field clear" id="fClear" ${state.from || state.to || state.search || state.type || state.tag ? '' : 'hidden'}>Clear filters</button>
    </div>

    <div class="card" style="overflow:hidden">
      <table>
        <thead><tr>
          <th style="width:130px">Version</th>
          <th style="width:180px">Type</th>
          <th style="width:130px">Release tag</th>
          <th style="width:165px">Deployed by</th>
          <th style="width:180px">Date &amp; time</th>
          <th>Short description</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>

    <div class="pager" id="pager"></div>`;
}

function rowsHTML(rows) {
    if (!rows.length) {
        return `<tr><td colspan="6" style="text-align:center;padding:48px;color:var(--ink-3)">No releases match these filters.</td></tr>`;
    }
    return rows.map((r) => `
      <tr data-id="${esc(r.id)}">
        <td class="ver">${esc(r.version)}</td>
        <td class="type">${esc(LABEL_SHORT[r.component_label] || r.component_label)}</td>
        <td>${chip(r)}</td>
        <td class="by">@${esc(r.deployed_by)}</td>
        <td class="when">${fmt(r.deployed_at)}</td>
        <td class="desc"><span title="${esc(r.overview)}">${esc(r.overview)}</span></td>
      </tr>`).join('');
}

function pagerHTML(total, start, pages) {
    return `
      <div class="pager-info">${total ? `Showing ${start + 1}–${Math.min(start + state.size, total)} of ${total} releases` : ''}</div>
      <div class="pager-btns">
        <button class="pg" id="prev" ${state.page === 1 ? 'disabled' : ''}>‹</button>
        ${pageNumbers(state.page, pages)
            .map((n) => (n < 0 ? `<span class="pg dots">…</span>` : `<button class="pg ${n === state.page ? 'on' : ''}" data-pg="${n}">${n}</button>`))
            .join('')}
        <button class="pg" id="next" ${state.page === pages ? 'disabled' : ''}>›</button>
      </div>`;
}

/** Re-render only the rows and pager. The toolbar — and the focused input —
 *  are left alone. */
function afterFilterChange() {
    const clear = document.getElementById('fClear');
    if (clear) clear.hidden = !(state.from || state.to || state.search || state.type || state.tag);
    renderRows();
}

function renderRows() {
    const all = filtered();
    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / state.size));
    if (state.page > pages) state.page = pages;
    const start = (state.page - 1) * state.size;

    document.getElementById('rows').innerHTML = rowsHTML(all.slice(start, start + state.size));
    document.getElementById('pager').innerHTML = pagerHTML(total, start, pages);

    document.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
        tr.onclick = () => { location.hash = '/' + tr.dataset.id; };
    });
    document.querySelectorAll('[data-pg]').forEach((b) => {
        b.onclick = () => {
            state.page = Number(b.dataset.pg);
            renderRows();
            document.querySelector('.content').scrollTop = 0;
        };
    });
    const p = document.getElementById('prev');
    const n = document.getElementById('next');
    if (p) p.onclick = () => { if (state.page > 1) { state.page--; renderRows(); } };
    if (n) n.onclick = () => { if (state.page < pages) { state.page++; renderRows(); } };
}

function renderList() {
    document.getElementById('view').innerHTML = toolbarHTML();

    const search = document.getElementById('search');
    search.value = state.search;
    search.oninput = () => { state.search = search.value; state.page = 1; afterFilterChange(); };

    const bind = (id, key, cast = (v) => v) => {
        const el = document.getElementById(id);
        el.value = String(state[key]);
        el.onchange = () => { state[key] = cast(el.value); state.page = 1; afterFilterChange(); };
    };
    bind('fType', 'type');
    bind('fTag', 'tag');
    bind('fSize', 'size', Number);

    wireCalendar();

    document.getElementById('fClear').onclick = () => {
        Object.assign(state, { search: '', type: '', tag: '', from: '', to: '', page: 1 });
        renderList();
    };

    renderRows();
}


/* ------------------------------------------------------------------ *
 * Date filter — one calendar, single date or range.
 *
 * First click sets the start and filters to that single day. A second
 * click extends it into a range. A third starts over. Days that actually
 * have releases are marked, so you can see where the deploys are rather
 * than hunting through empty dates.
 * ------------------------------------------------------------------ */

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const DOW = ['Su','Mo','Tu','We','Th','Fr','Sa'];

let calMonth = null;    // Date pinned to the 1st of the displayed month
let pendingStart = null; // set while a range is half-chosen

const prettyDay = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
};

function dateLabel() {
    if (!state.from && !state.to) return 'All dates';
    if (state.from === state.to) return prettyDay(state.from);
    return `${prettyDay(state.from)} – ${prettyDay(state.to)}`;
}

/** How many releases fall on each local day — drives the dots in the grid. */
function dayCounts() {
    const counts = {};
    for (const r of ALL) {
        const d = localDay(r.deployed_at);
        counts[d] = (counts[d] || 0) + 1;
    }
    return counts;
}

function calendarHTML() {
    const bounds = dateBounds();
    const counts = dayCounts();
    const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
    const daysInMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0).getDate();
    const lead = first.getDay();

    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<span class="cal-day blank"></span>');
    for (let d = 1; d <= daysInMonth; d++) {
        const ymd = `${calMonth.getFullYear()}-${String(calMonth.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const outside = (bounds.min && ymd < bounds.min) || (bounds.max && ymd > bounds.max);
        const lo = pendingStart || state.from;
        const hi = pendingStart ? pendingStart : state.to;
        const selected = lo && hi && ymd >= (lo < hi ? lo : hi) && ymd <= (lo < hi ? hi : lo);
        const edge = ymd === state.from || ymd === state.to || ymd === pendingStart;
        cells.push(
            `<button class="cal-day${selected ? ' in' : ''}${edge ? ' edge' : ''}${outside ? ' out' : ''}"` +
            `${outside ? ' disabled' : ''} data-d="${ymd}">${d}` +
            `${counts[ymd] ? `<i class="cal-dot" title="${counts[ymd]} release${counts[ymd] > 1 ? 's' : ''}"></i>` : ''}` +
            `</button>`);
    }

    const canPrev = !bounds.min || `${calMonth.getFullYear()}-${String(calMonth.getMonth() + 1).padStart(2, '0')}` > bounds.min.slice(0, 7);
    const canNext = !bounds.max || `${calMonth.getFullYear()}-${String(calMonth.getMonth() + 1).padStart(2, '0')}` < bounds.max.slice(0, 7);

    return `
    <div class="cal-presets">
      <button data-preset="today">Today</button>
      <button data-preset="7">Last 7 days</button>
      <button data-preset="30">Last 30 days</button>
      <button data-preset="all">All time</button>
    </div>
    <div class="cal-head">
      <button class="cal-nav" data-nav="-1" ${canPrev ? '' : 'disabled'}>‹</button>
      <strong>${MONTHS[calMonth.getMonth()]} ${calMonth.getFullYear()}</strong>
      <button class="cal-nav" data-nav="1" ${canNext ? '' : 'disabled'}>›</button>
    </div>
    <div class="cal-grid">
      ${DOW.map((d) => `<span class="cal-dow">${d}</span>`).join('')}
      ${cells.join('')}
    </div>
    <div class="cal-foot">
      <span>${pendingStart ? 'Pick an end date, or click the same day again' : 'Click a day, or a second day for a range'}</span>
    </div>`;
}

function paintCalendar() {
    const pop = document.getElementById('calPop');
    pop.innerHTML = calendarHTML();

    pop.querySelectorAll('[data-nav]').forEach((b) => {
        b.onclick = (e) => {
            e.stopPropagation();
            calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + Number(b.dataset.nav), 1);
            paintCalendar();
        };
    });

    pop.querySelectorAll('[data-preset]').forEach((b) => {
        b.onclick = (e) => {
            e.stopPropagation();
            const p = b.dataset.preset;
            if (p === 'all') { state.from = state.to = ''; }
            else {
                const end = new Date();
                const start = new Date();
                if (p !== 'today') start.setDate(start.getDate() - (Number(p) - 1));
                state.from = localDay(start);
                state.to = localDay(end);
            }
            pendingStart = null;
            commitDate();
            closeCalendar();
        };
    });

    pop.querySelectorAll('[data-d]').forEach((b) => {
        b.onclick = (e) => {
            e.stopPropagation();
            const d = b.dataset.d;
            if (!pendingStart) {
                // First click: filter to that single day straight away.
                pendingStart = d;
                state.from = state.to = d;
            } else {
                state.from = d < pendingStart ? d : pendingStart;
                state.to = d < pendingStart ? pendingStart : d;
                pendingStart = null;
            }
            commitDate();
            paintCalendar();
            if (!pendingStart) closeCalendar();
        };
    });
}

function commitDate() {
    state.page = 1;
    const lbl = document.getElementById('fDateLabel');
    if (lbl) lbl.textContent = dateLabel();
    const btn = document.getElementById('fDate');
    if (btn) btn.classList.toggle('on', Boolean(state.from || state.to));
    afterFilterChange();
}

function openCalendar() {
    const bounds = dateBounds();
    const anchor = state.to || state.from || bounds.max;
    calMonth = anchor ? new Date(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)) - 1, 1) : new Date();
    pendingStart = null;
    document.getElementById('calPop').hidden = false;
    document.getElementById('fDate').setAttribute('aria-expanded', 'true');
    paintCalendar();
}

function closeCalendar() {
    const pop = document.getElementById('calPop');
    if (pop) pop.hidden = true;
    pendingStart = null;
    const btn = document.getElementById('fDate');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

function wireCalendar() {
    const btn = document.getElementById('fDate');
    const pop = document.getElementById('calPop');
    btn.classList.toggle('on', Boolean(state.from || state.to));

    btn.onclick = (e) => {
        e.stopPropagation();
        if (pop.hidden) openCalendar(); else closeCalendar();
    };
    pop.onclick = (e) => e.stopPropagation();
    document.addEventListener('click', () => { if (!pop.hidden) closeCalendar(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) closeCalendar(); });
}

/* ---------------- detail ---------------- */
function renderDetail(id) {
    const r = ALL.find((x) => x.id === id);
    if (!r) { location.hash = ''; return; }

    const failed = r.status === 'failed';
    const tickets = [...new Set(((r.overview + ' ' + r.highlights.join(' ')).match(/XNEETI-\d+/gi) || []).map((t) => t.toUpperCase()))];

    document.getElementById('view').innerHTML = `
    <button class="back" id="back">← All releases</button>

    <div class="d-head">
      <span class="d-ver">${esc(r.version)}</span>
      <span class="chip chore">${esc(r.component_label)}</span>
      ${chip(r)}
    </div>
    <p class="d-meta">Deployed ${fmt(r.deployed_at)} by <span class="mono">@${esc(r.deployed_by)}</span></p>

    ${failed ? `<div class="banner">⚠ This deploy did not ship. Production stayed on the previous version — nothing changed.</div>` : ''}

    <div class="card d-card">
      <p class="d-overview">${esc(r.overview)}</p>
      ${r.highlights.length ? `<ul class="d-hl">${r.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
    </div>

    ${
        tickets.length
            ? `<div class="card d-card">
      <h2 class="d-sec">Linked tickets</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${tickets.map((t) => `<a class="ticket" href="https://xneeti.atlassian.net/browse/${t}" target="_blank" rel="noopener">${t} ↗</a>`).join('')}
      </div>
    </div>`
            : ''
    }

    <div class="card d-card">
      <h2 class="d-sec">Technical details</h2>
      <dl class="d-grid">
        <dt>Commit</dt><dd>${esc(r.commit || 'not recorded')}</dd>
        <dt>Ref</dt><dd>${esc(r.ref)}${r.ref_inferred ? '<span class="inferred">(inferred from deploy time)</span>' : ''}</dd>
        <dt>Pipeline</dt><dd class="sans">${esc(r.component_label)}</dd>
        <dt>Workflow run</dt><dd class="sans">${
            r.run_url ? `<a href="${esc(r.run_url)}" target="_blank" rel="noopener">View on GitHub ↗</a>` : '<span class="muted">not recorded</span>'
        }</dd>
      </dl>
    </div>`;

    document.getElementById('back').onclick = () => { location.hash = ''; };
}

/* ---------------- routing ---------------- */
function route() {
    if (!ALL.length) return;
    const id = location.hash.startsWith('#/') ? decodeURIComponent(location.hash.slice(2)) : '';
    if (id) renderDetail(id);
    else renderList();
}

window.addEventListener('hashchange', route);

document.getElementById('view').innerHTML = '<div class="loading">Loading releases…</div>';

// Called by the "Check for new releases" button after a successful re-fetch.
window.onReleasesReloaded = (items) => { ALL = items; route(); };

(async () => {
    const result = await loadReleases();
    ALL = result.items;
    renderSource(result);
    route();
})();
