/* Dashboard page: the shell plus the release dialog in the top bar. */

let ALL = [];

document.getElementById('view').innerHTML = `
  <h1 class="page">Notifications</h1>
  <div class="tabs">
    <div class="tab on">All Notifications</div>
    <div class="tab">Manage Notifications</div>
  </div>
  <div class="card" style="padding:0"><div class="empty-state">No notifications found</div></div>
  <p class="dek" style="margin-top:22px">
    A stand-in for any page in the dashboard. The flow starts from the
    <strong style="color:var(--ink)">rocket icon</strong> in the top bar, beside the notification bell.
  </p>`;

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

const relBtn = document.getElementById('relBtn');
const relPop = document.getElementById('relPop');

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

// "View all releases" is a real target="_blank" anchor in the markup, so the
// browser opens the new tab itself. This only tidies the dialog behind it.
document.getElementById('viewAll').onclick = () => {
    relPop.hidden = true;
    relBtn.classList.remove('active');
};

// Called by the "Check for new releases" button after a successful re-fetch.
window.onReleasesReloaded = (items) => { ALL = items; if (!relPop.hidden) renderPopover(); };

(async () => {
    const result = await loadReleases();
    ALL = result.items;
    renderSource(result);
})();
