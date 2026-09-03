/* Release Management page: list + detail.
 *
 * Detail is addressed by hash (#/fe-v1.5.18) so a specific release is a
 * shareable link — the same reason the real design routes by id rather than
 * version.
 */

let ALL = [];
const state = { page: 1, size: 25, search: '', type: '', tag: '' };

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

function toolbarHTML() {
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
    search.oninput = () => { state.search = search.value; state.page = 1; renderRows(); };

    const bind = (id, key, cast = (v) => v) => {
        const el = document.getElementById(id);
        el.value = String(state[key]);
        el.onchange = () => { state[key] = cast(el.value); state.page = 1; renderRows(); };
    };
    bind('fType', 'type');
    bind('fTag', 'tag');
    bind('fSize', 'size', Number);

    renderRows();
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
