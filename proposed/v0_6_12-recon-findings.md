# v0.6.12 — Recon findings (Phase 0)

**Branch:** `feat/v0.6.12-dashboard-honesty` (off main @ `758e116` — post-merge of v0.7 PRs #50 + #51 + BOM PR #52)
**Baseline:** `npm test` 1373 passed / 1 skipped · `npm run build` (which runs `tsc`) clean.

## Scope confirmation

v0.7 PRs already merged before the run started, as the operator noted. The federation surfaces are now real — Phase 4 Federation drill page can read live peer roster, mDNS state, etc.

## Dashboard inventory

`src/dashboard/` totals **15,477 lines**. 16 top-level pages render through `src/dashboard/index.ts`:

```
about · capabilities · decide · diagnostics · family-mode · helm · home ·
mcps · permissions · placeholders · plans · settings · streams · toolkit ·
tools · topology
```

161 dashboard test files, all green at baseline. The big render functions inline a CSS string + a JS string — each page is essentially self-contained, which is what produced the design-token sprawl this BOM addresses.

## Token cardinality baseline (measured, not estimated)

Direct grep across `src/dashboard/**/*.ts`:

### Font sizes — **18 distinct values**
```
   106 font-size: 11px
    54 font-size: 10px
    51 font-size: 12px
    25 font-size: 13px
    18 font-size: 14px
    17 font-size: 9.5px      ← sub-pixel
    17 font-size: 10.5px     ← sub-pixel
    14 font-size: 9px        ← below 11px floor
     4 font-size: 11px        (no space)
     3 font-size: 10px        (no space)
     3 font-size: 18px
     3 font-size: 15px        ← non-canonical
     2 font-size: 8px         ← below 11px floor
     2 font-size: 16px
     2 font-size: 11.5px     ← sub-pixel
     1 font-size: 12px        (no space)
     1 font-size: 8.5px       ← sub-pixel + below floor
     1 font-size: 12.5px     ← sub-pixel
```
Target after Phase 1: **7 sizes** (11/12/13/14/16/18/22), zero sub-pixel, nothing below 11px.

### Font weights — **6 distinct values**
```
    32 font-weight: 600
    17 font-weight: 700
     8 font-weight: 500
     2 font-weight: 450      ← non-standard
     1 font-weight: 800
     1 font-weight: 350      ← non-standard
```
Target: **2 weights** (400/500). 600/700/800/450/350 all collapse to 500.

### Border-radii — **17 distinct values**
```
    33 border-radius: 6px     → --radius-sm
    25 border-radius: 8px     → --radius-md
    21 border-radius: 4px     → --radius-sm
    19 border-radius: 12px    → --radius-lg
    16 border-radius: 999px   → --radius-pill
    16 border-radius: 10px    → --radius-md
     8 border-radius: 7px     → --radius-sm
     5 border-radius: 2px     → --radius-sm
     4 border-radius: 14px    → --radius-lg
     4 border-radius: 3px     → --radius-sm
     3 border-radius: 9px     → --radius-md
     3 border-radius: 99px    → --radius-pill
     3 border-radius: 5px     → --radius-sm
     1 border-radius: 1px     → --radius-sm
     1 border-radius: 1.5px   → --radius-sm
     1 border-radius: 8px     (no space) → --radius-md
```
Target: **4 radii** (6/10/12/999). All collapse cleanly to those four.

## Phase 1 codemod approach

Replace literal CSS values across `src/dashboard/**/*.ts`. The dashboard pages all use template-literal CSS blocks, so a regex codemod is safe (no JS/TS expressions intermixed in the matching positions). Strategy:

1. Add the canonical tokens to `tokens.ts`.
2. Run a Node.js codemod (script in `tmp/codemod/`, not checked in) that:
   - `font-size:\s*9(\.5)?px` → `--font-size-xs (11px floor — promote)` (and any sub-pixel)
   - `font-size:\s*8(\.5)?px` → same — promote to 11px
   - `font-size:\s*10\.5px` → `font-size: 11px`
   - `font-size:\s*11\.5px` → `font-size: 12px`
   - `font-size:\s*12\.5px` → `font-size: 12px`
   - `font-size:\s*15px` → `font-size: 14px`
   - `font-weight:\s*(600|700|800|450|350)` → `font-weight: 500`
   - `border-radius:\s*(7|5|4|3|2|1\.5|1)px` → `border-radius: 6px`
   - `border-radius:\s*(9|10)px` → `border-radius: 10px` (10 already canonical; 9 → 10)
   - `border-radius:\s*14px` → `border-radius: 12px`
   - `border-radius:\s*99px` → `border-radius: 999px`
3. Re-run grep to verify cardinality dropped to the target counts.
4. `npm test` — fix any HTML-string-assertion failures (per CLAUDE.md §1, delete asserts that conflict with the new spec in the same commit).

I'll keep the values inline (no `var(--radius-sm)` substitution) because the dashboard CSS is generated in template literals and the operator's iron palette already uses both inline literals and CSS vars side-by-side; introducing vars everywhere would multiply diff churn without functional benefit. The canonical token comments in `tokens.ts` document what each inline value means.

## Diagnostics page (Phase 2-3 target)

Today the diagnostics page is `~1500 LOC` of "Section 1/2/3" (MCPs / fleet / workers) gauge-and-trend layout. Phase 2 replaces the *landing* with a 5-tile overview; the existing dense layout splits into 5 detail pages under `/dashboard/diagnostics/<engine|connections|workers|federation|alerts>`. The current `renderDiagnosticsPage()` becomes the **Engine** detail (because it's already memory + perf + storage + traffic-adjacent), with Connections (MCPs section) + Workers (workers section) + Federation (new, fleet/peer rows split out) extracted into their own routes.

## Hard rule applied

Every top-level tile/chip/badge added in Phases 2-4 will declare its drill route inline so the no-orphan-components audit in Phase 8 can verify mechanically.

## Stop conditions monitored

Per operator directive: `npm test` regression, `npm run build` failure, `tsc --noEmit` failure, or a genuine NO-GO. Continuous run otherwise. Sensitivity = `careful` per BOM front-matter, so status check before each commit.

— end recon —
