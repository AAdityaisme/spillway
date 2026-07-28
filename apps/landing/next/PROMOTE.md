# Promote /next to / (run when Aadi says stop and picks this direction)

1. `cd ~/Desktop/V2`
2. Back up current live landing (already in git; branch `landing-pre-3d` also exists).
3. Move: `git mv apps/landing/index.html apps/landing/classic-index.html` (or delete outright — history has it), then copy `apps/landing/next/{index.html,styles.css,app.js,chart.js,og.png,apple-touch-icon.png}` to `apps/landing/` (fonts already live at `apps/landing/fonts/`).
4. Fix one path: in the copied `chart.js`, `../vendor/three.module.min.js` becomes `./vendor/three.module.min.js`.
5. Delete `/m/` mockup dirs + `/variants/` + old `spillway-home.css`, `hero-scene.js`, `gr-scene.js`, `thread.js` (all restorable from git).
6. Set og:image to the ABSOLUTE production URL (scrapers ignore relative paths).
7. Remove the `<meta name="robots" content="noindex" />` line (stealth guard) when the page goes truly public.
8. Launch film notes: the film needs BOTH `chart.js` AND the inline `<script>` right after `<body>` in `index.html` (first-paint gate + 7s failsafe) — a partial copy that drops the inline script brings back the light-flash-then-dark snap. Decide at public launch whether the film plays every visit (current, regrade-style) or once per session (`sessionStorage` gate around the inline script + `launch` init in chart.js) — every-visit is fine while the page is demoed live; once-per-session is kinder for a real audience returning to check pricing.
9. Re-run the verify matrix against `/` (including film.mjs), commit `feat(landing): promote the spillway line to /`, push.
