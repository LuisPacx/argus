# War Room Proposals page, Figma variations

Figma file: https://www.figma.com/design/IL9OUYFESwRlLXJQOa15Kl (argus War Room — variations). Three top-level 1440 px frames, side by side, each with auto-layout, a local colour-variable collection, text styles, and a text label above.

Content is shaped from the live /api/proposals (real Rubric keys on a 0-10 scale, buildability gate at 5, real DexScreener/GitHub collision checks, real actions per status: new = Shortlist + Dismiss, spec-drafted = Edit Spec + Dismiss). Controls shown are only ones index.vue has: New Proposal, Shortlist, Dismiss, Edit Spec, nav (Narratives, Activity, Rubric). One card is shown as spec-drafted for range; the live data is all `new`.

1. Ledger, node 5:24, `ledger.png`. Neutral product UI, table rows with 1px rules. Inter 11/12/13/14/20; white and greys, one indigo accent #4F46E5, green/amber only for collision dots; 1440 frame, 1240 content, 24 px column gaps, 20 px row padding.
2. Broadsheet, node 7:22, `broadsheet.png`. Monochrome editorial, single 880 px column. Newsreader (display 52, names 28, lede 17) with Inter small caps labels; paper #FAF8F4, ink #1B1B19, colour only for status (ochre new, green spec-drafted) and collision red; hairline rules, text-link actions, score as large numeral.
3. Soft Cards, node 8:29, `soft-cards.png`. Light surfaces, 2-column card grid plus a sidebar for research usage and Signals. Plus Jakarta Sans 12/14/18/30; bg #F2F3F7, white cards radius 20 with a two-layer soft shadow style, violet accent #5B5BD6 with tinted chips; 24 px card padding, 20 px gaps, pill buttons.
