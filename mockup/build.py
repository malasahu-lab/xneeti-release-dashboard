#!/usr/bin/env python3
"""Assemble index.html and releases.html from the shared shell + per-page script.

Both pages share the same chrome (sidebar, top bar, release dialog), so the
markup lives once in _shell.html and each page supplies only its own script.
Run: python3 build.py
"""
import hashlib
import os

HERE = os.path.dirname(os.path.abspath(__file__))
read = lambda n: open(os.path.join(HERE, n)).read()
write = lambda n, s: open(os.path.join(HERE, n), 'w').write(s)

# Fingerprint the stylesheet so a rebuild can't be masked by a cached copy —
# an edit that silently does not apply is a genuinely confusing way to lose time.
CSS_VER = hashlib.md5(read('styles.css').encode()).hexdigest()[:8]
HEAD = ('<!DOCTYPE html>\n<meta charset="utf-8">\n<title>%s</title>\n'
        '<link rel="stylesheet" href="styles.css?v=' + CSS_VER + '">\n')
FOOT = ('\n\n<div class="src" id="srcPill"><span class="led"></span> Loading…</div>\n\n'
        '<script src="data-fallback.js"></script>\n<script src="app.js"></script>\n<script>\n%s\n</script>\n')

BTN = '<button class="btn-primary" id="viewAll">View all releases →</button>'

shell = read('_shell.html').rstrip()
assert BTN in shell, 'shell no longer contains the View-all button'

# Dashboard: a real target="_blank" anchor, so cmd-click and middle-click work.
index_shell = shell.replace(
    BTN, '<a class="btn-primary" id="viewAll" href="releases.html" target="_blank" rel="noopener">View all releases →</a>')

# Release page: same dialog, but the link just returns to the list.
rel_shell = shell.replace(BTN, '<a class="btn-primary" id="viewAll" href="releases.html">View all releases →</a>')
rel_shell = rel_shell.replace(
    '<button class="nav-item on"><span class="ic">\U0001f514</span> Notifications</button>',
    '<button class="nav-item"><span class="ic">\U0001f514</span> Notifications</button>\n'
    '    <button class="nav-item on"><span class="ic">\U0001f680</span> Release Management</button>')

write('index.html', HEAD % 'Xneeti — Dashboard' + index_shell + FOOT % read('_index_script.js'))
write('releases.html', HEAD % 'Release Management — Xneeti' + rel_shell + FOOT % read('_releases_script.js'))

for f in ('index.html', 'releases.html'):
    print(f, os.path.getsize(os.path.join(HERE, f)), 'bytes')
