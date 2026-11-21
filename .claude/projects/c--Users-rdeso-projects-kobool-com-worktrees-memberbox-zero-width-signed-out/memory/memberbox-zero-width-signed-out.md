---
name: memberbox-zero-width-signed-out
description: Make MemberBox width zero in signed-out state
metadata:
  type: project
---

In v3, `#MemberBox` (a `table-cell` in `#HeaderGrid`) keeps a width of ~4px when signed out because `renderLogin()` fills it with `&nbsp;`. Emptying the cell content collapses a table-cell to 0px width (verified in browser: `width:0` alone with `&nbsp;` content does NOT collapse, but empty content does).

Changes (complete):
- `v3/modules/mem-ui.js` `renderLogin()`: `$("#MemberBox").html("").addClass("signed-out")` instead of `.html("&nbsp;")`.
- `v3/modules/mem-ui.js` `renderBox()`: `$("#MemberBox").removeClass("signed-out")` when filling MemberBox with real (signed-in or guest) content.
- `v3/css/base.scss`: `#MemberBox.signed-out { width: 0; overflow: hidden; }` as an explicit, durable guard.

Verification:
- Browser experiment confirmed empty table-cell content collapses to 0px width; `width:0` with `&nbsp;` content does NOT collapse.
- `npm run build` compiles base.scss to dist/v3/css/base.css containing `#MemberBox.signed-out{width:0;overflow:hidden}` and mem-ui.js containing both signed-out edits.
- `npm test`: all 50 tests pass, including mem-ui guest-menu test and dist smoke test.

Linked: none yet.
