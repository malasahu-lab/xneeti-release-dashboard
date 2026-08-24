# Xneeti dashboard mockup — Release Management

A clickable stand-in for the Xneeti dashboard, built to demo the proposed
Release Management flow before any of it is merged into the real product.

**The chrome is a mockup. The release data is real and live.** Every page fetches
`https://malasahu-lab.github.io/xneeti-release-dashboard/releases.json` on load,
so a release the hourly routine picks up shows here without editing anything.

## The flow

1. **`index.html`** — any dashboard page. Rocket icon in the top bar, beside the
   notification bell.
2. Click it → dialog with what is **live on production** right now (latest
   frontend + latest backend), each with a plain-language summary and *Show more*.
3. **View all releases** → opens `releases.html` **in a new tab**.
4. **`releases.html`** — the full table: Version, Type, Release tag, Deployed by,
   Date & time, Short description. Search, component filter, tag filter,
   pagination (25 / 50 / 100).
5. Click any row → the release detail page, with linked Jira tickets, commit,
   ref and a link to the GitHub workflow run.

Detail pages are addressed by hash (`releases.html#/fe-v1.15.19`), so a specific
release is a shareable link.

## Running it

```sh
python3 -m http.server 8755 --directory .
```

Then open <http://localhost:8755/index.html>.

`file://` works too, since the live JSON is served with `access-control-allow-origin: *`.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `releases.html` | **Generated** — do not edit by hand |
| `_shell.html` | Shared chrome: sidebar, top bar, release dialog |
| `_index_script.js` | Dashboard page behaviour |
| `_releases_script.js` | List + detail + hash routing |
| `app.js` | Live fetch, fallback, formatting helpers |
| `styles.css` | All styling |
| `data-fallback.js` | Offline snapshot, used only if the live fetch fails |
| `build.py` | Assembles the two HTML pages |
| `refresh-snapshot.sh` | Re-pulls the offline snapshot from the live log |

After editing any `_`-prefixed source file or `app.js`:

```sh
python3 build.py
```

## The status pill

The pill at the bottom says which data the page is actually showing —
green *"Live data · N releases"* or amber *"Offline snapshot · live source
unreachable"*. It is there so the demo never silently shows stale numbers.

## Not real

The sidebar, greeting, notification bell and Notifications page are inert
scaffolding. Only the rocket icon, the dialog, and the release pages do anything.
