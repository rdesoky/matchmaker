---
name: menu-hover-contrast-fix
description: Fixed light-mode hover contrast bugs on div#Menu root items across v2 and v3
metadata:
  type: project
---

Three light-mode hover contrast bugs fixed on div#Menu root items:

Bug A (anchored root items: Home, Contact us, Use Old Site): hovered anchor rendered WHITE text (var(--kb-text-inverse)=#ffffff, from `.menu > li > a`) on light-grey background (var(--kb-surface-hover)=#eeeeee) — ~1.2:1 contrast, invisible.
Root cause: hover `color` set on `<li>` is inherited and loses to the anchor's direct rule `.menu > li > a { color: var(--kb-text-inverse); }` (specificity 0,1,2 beats inherited 0,0,0).

Bug B (ctab root items: QA Forum, Browse, My Match…): hovered ctab rendered BLACK text on BLACK background. v3 `.menu .ctab:hover` sets bg #000000 (specificity 0,3,0) while `.menu > li:hover` forced color #000000 (0,2,1). Introduced by commit 1eee0af.

Bug C (direct-text root items: Refresh, Logout): hovered `<li>` kept black drop shadow (`#Menu .menu li { text-shadow: 0 0 2px var(--kb-text-shadow-strong) }`) making black text muddy on light background. My earlier `text-shadow: none` on `.menu > li:not(.ctab):hover` (specificity 0,2,2) did NOT outrank `#Menu .menu li` (specificity 1,1,1 due to the ID), so the shadow persisted.

Fixes applied:
- v3/css/base.scss: `.menu > li:hover` → `#Menu .menu > li:not(.ctab):hover { background-color: var(--kb-surface-hover); color: var(--kb-text); text-shadow: none; }` plus `#Menu .menu > li:not(.ctab):hover > a { color: var(--kb-text); text-shadow: none; }` (specificity 0,3,2 beats anchor 0,2,1). The `#Menu` prefix is required so `text-shadow: none` outranks `#Menu .menu li { text-shadow }` (1,2,2 > 1,1,1). ctab items excluded so they keep their own hover styling (black bg + white text).
- v2/css/base.scss: `.menu > li:hover > a { color: var(--kb-text); text-shadow: none; }`. v2 `.menu > li:hover` left unscoped: v2 ctab hover uses transparent/grey bg (no black-on-black), and v2 has no `#Menu .menu li { text-shadow }` rule (no shadow to remove).

Bug D (separate, reported later): hovered descendants of `#MemberBox` (e.g. visitor/stat links in the header popup) stayed WHITE (`--kb-text-inverse`=#ffffff) with a black drop shadow (`#MemberBox * { color: var(--kb-text-inverse); text-shadow: ... }`). Fix: added `#MemberBox *:hover { color: var(--kb-text); text-shadow: none; }` in v3/css/base.scss (specificity 1,0,2 beats `#MemberBox *` 1,0,1). v2 has no `#MemberBox *` rule, so no change needed there.

Bug E (separate, reported later): In dark mode, hovered menu items rendered background `--kb-surface-2` (#232b33) which is lighter than the menu background `--kb-menu-bg` (#1a2027). Fix: changed dark-mode hover rules in shared/theme.scss to use `--kb-surface-hover-soft` (#202831), the darkest hover surface token:
  - `.menu > li:hover` → background-color: var(--kb-surface-hover-soft) (specificity 0,2,1)
  - `#Menu .ctab:hover` → background-color: var(--kb-surface-hover-soft) !important (specificity 1,1,1, beats the ID-based override)

Other hover states verified OK: root direct-text (Refresh, Logout) black on #eeeeee with no shadow; ctab white on black #000000; submenu white on sienna #a52a2a (~6.9:1, AA).

Tokens (light mode, shared/theme.scss :root): --kb-surface-hover #eeeeee, --kb-text #000000, --kb-text-inverse #ffffff, --kb-menu-bg #808080, --kb-menu-hover-bg #a52a2a, --kb-menu-tab-hover-bg #000000, --kb-submenu-bg #d3d3d3, --kb-text-shadow-strong rgba(0,0,0,1).
Tokens (dark mode, shared/theme.scss html[data-theme="dark"]): --kb-menu-bg #1a2027, --kb-surface-hover-soft #202831, --kb-surface-2 #232b33, --kb-surface-hover-strong #35404d, --kb-menu-hover-bg #39485a, --kb-text #e6e9ee, --kb-text-inverse #ffffff.

Validation: `npm run build`, `npm run check` (0 warnings), `npm test` (53/53 pass, incl. dist smoke test). Compiled dist/shared/theme.css contains `html[data-theme=dark] .menu>li:hover{background-color:var(--kb-surface-hover-soft)}` and `#Menu .ctab:hover{background-color:var(--kb-surface-hover-soft) !important}`.

Related memory: [[chat-profile-menu-styling]].