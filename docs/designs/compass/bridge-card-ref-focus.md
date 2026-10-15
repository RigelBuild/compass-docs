# Design: Bridge card ref focus — `R` walks the focused card's title refs (RIG-5238)

Owner lane: compass-frontend
Refs: RIG-5238. Matt's ruling "B" on RIG-5234 (2026-10-11): a board key
cycles focus through the focused card's refs, and Escape returns to the card.
Option A (pointer-only title refs) shipped in compass PR #2192 (RIG-5178).
Governing spec: `apps/ui/src/design/surfaces.md` §"Focus and keyboard".
Contracts consumed: `keyboard/keymap.ts`, `dispatch.ts`, `roving.ts`,
`spine.ts`; `RefText` / `RefLink` in `components/RefText.tsx` (from #2192).
Builds on: `compass-bridge-keyboard-nav/design.md`, DL-220, DL-221, DL-224,
DL-252, `compass-leader-chords/design.md` §A4.
Ledger: DL-521 (§A5). It refines DL-221.

## Decisions (RIG-5330, Matt, 2026-10-13)

1. **Key letter: `R` / `Shift+R`** (option A). `L` was the alternative. The
   code, spec and ruling all say "refs", and on a board `L` reads as "lane".
2. **Routing the in-ref keys: a ref handle on the spine** (option B).
   - A hand-built `RovingGroupHandle`, `refGroup`, is registered and retracted
     beside the board group. It does not use `createRovingGroup`, whose effect
     writes tabindex. Refs are not stops, so spine invariant (a) holds.
   - A new row `Escape → board.exitCardRef` is added. The command is
     registered with `scope: "main"` and titled "Return to card".

   ```ts
   const refGroup: RovingGroupHandle = {
   	group: { zone: "main", id: "bridge-card-refs" },
   	isFocused: () => focusedRef() !== undefined,
   	handleCommand: onRefCommand,
   	focus: () => rovingGroup.focus(),
   };
   ```

   - There is one keydown path, with the same leader and editable-guard order
     as every other key. Escape gets a keymap row, so the overlay lists it.
     User remapping stays deferred, as `keymap.ts` notes.
   - This is the first Escape row. On a focused card, Escape reaches tier 3,
     and its `run` declines, but the dispatcher still calls
     `preventDefault()`.
   - A ref gets a focused card's zone exposure. The `when: "main"` rows are all
     Enter chords, which `RefLink` stops first.
   - Escape on a ref leaves the tour callout open: the dispatcher calls
     `preventDefault()`, and Kobalte dismisses only an Escape that is not
     default-prevented.
3. **Screen-reader announcement inside a `<button>`: T4 acceptance check**
   (option A). ARIA makes a button's children presentational, so the focused
   `role="link"` span may not be announced (DL-097's chip compromise). If T4
   fails, the PR stays in draft and a new record moves title refs out of the
   card button. The key model stays.

## Problem / Intent

PR #2192 renders Bridge card title refs as `RefLink` spans (`role="link"`,
`.ref-link`, `tabindex="-1"`), so the board keeps one Tab stop (DL-220). A
keyboard user can see a ref but cannot reach it. This record adds a board key
that moves focus into the focused card's title refs and cycles through them.
Enter or Space opens the ref without activating the card. Escape returns to
the card.

## Approach

### A1 — Keys: `R` and `Shift+R`

- `R` runs `board.focusCardRef`: the first ref from the card, the next ref
  from a ref. `Shift+R` runs `board.focusCardRefPrev`: the last ref, then the
  previous one.
- Both are keymap rows and registered `board.*` commands with
  `scope: "main"`, like `board.openCardCrossLink`. `isGroupRelative` routes
  them to the focused board group at tier 1. The rows feed the overlay, the
  palette chip and `shortcutForAria`.
- No collision: `DEFAULT_KEYMAP` has no bare-letter single chord, and no `G`
  or `W` sequence ends in `R`. `r` is not reserved by leader-chords, and no
  component handles it. `eventToChord` keeps Shift on letters, so `Shift+R`
  is its own chord. The editable-target guard leaves `r` to text fields.
- These are the first bare-letter rows since DL-252. They act only on the
  focused card, which is the leader-chords rule for bare letters.

### A2 — Focus model

- The walk set is `card.querySelectorAll(".card-title .ref-link")`, in title
  order. Unlinked tokens render as text and are never in it. The PR chip and
  the issue-key chip keep `Space` (DL-221).
- Entry acts on the focused stop, which is normally the cursor card.
- Refs keep `tabindex="-1"` for their whole life. The board keeps one
  `tabindex="0"`.
- "Ref mode" is not stored. It is the fact that `document.activeElement` is a
  `.ref-link` inside a board stop (the owner). Focus can leave by any route
  with nothing to clean up.

### A3 — Keys while a ref has focus

Keys are normalized with `eventToChord` and matched against resolved
`DEFAULT_KEYMAP` rows. `RefLink` takes every `Enter` and `Space`, modifiers
included, before the dispatcher. `refGroup` handles the other rows in the
table below. Any other chord behaves as it does on a focused card:
`Shift+ArrowLeft` has no row, and `Mod+Alt+ArrowLeft` has a row
(`workspace.focusPaneLeft`) with no registered command, so the dispatcher
skips it.

| Key | Effect |
| --- | --- |
| `R` / `Shift+R` rows | Next / previous ref, with wrap. |
| `Enter`, `Space`, with any modifier | Open the ref (`RefLink`'s own `onKeyDown`). `Shift+Enter` does not reach `board.openAssignedAgent`. |
| `Escape` | Make the owner the cursor and focus it. |
| The six `list.move*` rows | Exit to the owner, then move the cursor from it. |
| Anything else | Not handled. |

- **Wrap** follows the ruling ("cycles").
- **Enter and Space.** `RefLink` calls `preventDefault()` and
  `stopPropagation()`, then opens through `openExternal`. The card does not select and the
  dispatcher never sees the key.
- **Exit** uses the owner, not the stored cursor. They differ after a pointer
  focuses a ref. The exit computes its target from `owner.id`, writes the
  cursor, then focuses the target. It never reads `cursorId()` after the
  write, because Solid 2 defers writes until flush.
- **Tab** is native and not trapped.
- **Re-render.** If a store push rebuilds the title, focus drops to `<body>`.
  The roving effect does not pull it back.

The board group's identity gate cannot see a ref. Its `isFocused()` is
`stops().some((s) => s.el === document.activeElement)`. On a ref,
`activeGroup()` returns `refGroup` instead (`spine.ts`:
`for (const g of groups) if (g.isFocused()) return g;`), so `activeZone()` is
still `main`. The keys above reach a handler through `refGroup` (Decision 2).

### A4 — Announcement

- **`aria-keyshortcuts`** on the cursor card names only the chords with a
  target there. `Space` comes first if the card has a cross-link. `R` follows
  if its title has a linked ref. Both values come from `shortcutForAria`. With
  neither, the attribute is removed. This also stops announcing `Space` on
  chip-less cards.
- **Ref presence** is `hasLinkedRef(action.title, refLinkRules())`. It is
  computed inside the existing attribute effect, for the cursor card only.
  Bridge calls `useRefLinkRules()` once, at the top.
- **Cards with no target.** Both keys stay claimed and do nothing, as `Space`
  does on a chip-less card.
- The focused ref is announced as a link with its text. There is no live
  region.
- The overlay and palette list "Focus next link in card title — R" and "Focus
  previous link in card title — Shift+R".

### A5 — Ledger (DL-521, refines DL-221)

DL-221 gave nested chips a registered `board.*` command on the cursor card.
PR #2192 demoted title refs the same way but gave them no keyboard path.
Recorded as DL-521:

> Bridge card title refs (linked `.ref-link` spans, `tabindex="-1"`) are
> reached from the focused card by `R` / `Shift+R` (`board.focusCardRef` /
> `board.focusCardRefPrev`, keymap rows, group-relative, `scope: "main"`). On
> a ref, `R` / `Shift+R` cycle the owner's linked title refs with wrap,
> Enter/Space open the ref, and Escape (`board.exitCardRef`, a keymap row)
> focuses the owner and makes it the cursor. `list.move*` chords exit to the
> owner and move. These keys reach the board through a `refGroup` spine handle.
> Chips keep `Space`. `aria-keyshortcuts` names only chords with a target.

## Source evidence (RigelBuild/compass `main` at `33db6167`)

- **A1, no collision.** `apps/ui/src/keyboard/keymap.ts` `DEFAULT_KEYMAP` has
  no bare-letter single chord. Its letter rows are all `Mod+` chords or `G` /
  `W` sequences (`"G B"`, `"G D"`, `"G L"`, `"G S"`, `"W H"` … `"W X"`). None
  ends in `R`.
- **A1, `Shift+R`.** `apps/ui/src/keyboard/dispatch.ts` `eventToChord`
  drops Shift only for a single character outside ASCII `a-z` with no command
  modifier, so `Shift+R` keeps it:
  `const shiftEncodedByKey = !hasCommandModifier && key.length === 1 && !/[a-z]/i.test(key);`
- **A1, text fields.** `dispatch.ts` `installKeymap` runs the editable-target
  guard before matching:
  `if (!hasCommandModifier && isEditableTarget(event.target)) return;`
- **Decision 2, tier-3 Escape.** `dispatch.ts` tier 3 calls
  `command.run(); event.preventDefault();` for any registered command in its
  zone. That includes a `run` that declines.
- **Decision 2, the tour callout.** `@kobalte/core` 2.0.0-alpha.0
  dismissable layer: `props.onEscapeKeyDown?.(e); if (!e.defaultPrevented &&
  props.onDismiss) { … props.onDismiss(); }`
- **A2, the handle shape.** `apps/ui/src/keyboard/roving.ts`:
  `export interface RovingGroupHandle { readonly group: RovingGroup;
  handleCommand(id: CommandId): boolean; isFocused(): boolean; focus(): void;`
- **A2, no pull-back.** `roving.ts` `createRovingGroup` refocuses only when a
  stop already holds focus: `const focusInGroup = stops.some((s) => s.el ===
  document.activeElement); if (focusInGroup && active.id !== lastFocusedId)`.
  A focused ref is not a stop, so a rebuild leaves it focused. The handle
  matches stops exactly: `isFocused(): boolean { return opts.stops().some((s)
  => s.el === document.activeElement); }`.
- **A3, Enter and Space.** `apps/ui/src/components/RefText.tsx` `RefLink`:
  `if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault(); event.stopPropagation(); openExternal(safe());`
- **A3, `tabindex`.** `RefLink` renders `role="link"` with
  `tabindex={props.inRovingGroup ? -1 : 0}`.
- **T1, the rules seam.** `apps/ui/src/mount.tsx` `mountShell` renders
  `<RefLinkRulesContext value={store.refLinkRules}>`. `test-router.tsx`
  `mountApp` does not yet, which is why T1 adds it.

## Alternatives considered

1. **Widen `isFocused` to containment** (rejected). A ref would count as the
   board, so arrows and Home/End on it would go to the board's `onCommand` and
   move the cursor instead of exiting cleanly. It would also change the gate
   for every surface. (DL-224 rejected a `setActiveGroup` signal, not
   containment.)
2. **Arrows walk the refs** (rejected). That APG in-cell walk is for an ARIA
   grid, and DL-220 refuses that role. A variant in which Left/Right walk and
   Up/Down exit was also rejected. On a two-ref card, arrows that do two jobs
   look stuck.
3. **Refs as roving stops** (rejected). This undoes DL-221.
4. **Local handler with no command** (rejected). It would have no overlay row,
   no palette entry and no derived `aria-keyshortcuts`.
5. **A leader sequence, `F2`, Tab cycling, or `scope: "global"`** (rejected).
   - `G` and `W` already have meanings.
   - `F2` needs `Fn` on a Mac.
   - Tab cycling traps Tab.
   - A global scope would run from any surface.
6. **A grid `onKeyDown` for the in-ref keys** (RIG-5330, not chosen). It
   relied on delegation order and a focus change during dispatch, left a
   pending leader armed on an arrow, and could not remap Escape.

## Global Constraints

- **Dependency.** Compass PR #2192 (merged) supplies the `RefLink` spans.
- **DL-220.** Nothing writes tabindex on a ref.
- **DL-224.** The board group's `isFocused()` stays identity-based. On a ref,
  `refGroup` is the active group, in zone `main`.
- **One chord source.** No letter or arrow literals outside `keymap.ts` and
  tests.
- **One "linked" rule.** `RefLink` and `hasLinkedRef` both call `refHref`.
- **Test dispatch.** Dispatch a bubbling, cancelable `keydown` on
  `document.activeElement`, then call `flushSync()`.

## Plan

### T1 — Linked-ref rule and the rules seam

- `RefText.tsx`: move `RefLink`'s URL rule into `refHref` and add
  `hasLinkedRef`.
- `store.ts`: add `AppStoreOptions.initialRefLinkRules` beside `initialIssues`.
  It seeds the `refLinkRules` signal (default `[]`).
- `test-router.tsx`: `mountApp` wraps the router in `<RefLinkRulesContext
  value={store.refLinkRules}>`, as `mount.tsx` `mountShell` does.
- `live/compass-fake.ts`: export `FIXTURE_REF_LINK_RULES`, and have the fake
  copy it. `boot-fixture.ts` passes it as `initialRefLinkRules`.

```ts
// apps/ui/src/components/RefText.tsx
export function refHref(token: RefToken, rules: readonly RefLinkRule[]): string | null;
export function hasLinkedRef(text: string, rules: readonly RefLinkRule[]): boolean;
// apps/ui/src/store.ts — AppStoreOptions
readonly initialRefLinkRules?: readonly RefLinkRule[];
// apps/ui/src/live/compass-fake.ts
export const FIXTURE_REF_LINK_RULES: readonly RefLinkRule[];
```

Tests (`RefText.test.tsx`): `hasLinkedRef` returns true for `"Fix RIG-12"`.
It returns false for `"Fix OPS-4"`, for a URL token that contains `RIG-12`,
and for a template that yields `javascript:`.

### T2 — Entry keys and announcement

- `keymap.ts`: add `R → board.focusCardRef` and
  `Shift+R → board.focusCardRefPrev` after `Shift+Enter`.
- `Bridge.tsx`:
  - Register both commands. Titles are as in A4; keywords are
    `["ref", "link", "title", "issue", "pr"]`.
  - Add `title` to the card `StopAction` (the PR title on the PRs tab).
  - `onCommand` maps both ids to `enterRefs`.
  - The attribute effect applies A4.
- `surfaces.md` §"Focus and keyboard": "`R` / `Shift+R` move focus through the
  focused card's title links; `Escape` returns to the card."

```ts
// apps/ui/src/components/Bridge.tsx — module scope
const CARD_REF_SELECTOR = ".card-title .ref-link";
function cardRefs(card: HTMLElement): HTMLElement[];
// card StopAction gains: title: string
// inside Bridge
const refLinkRules = useRefLinkRules();
const focusedStop = (): Stop | undefined; // rovingStops() entry whose el is document.activeElement
const enterRefs = (edge: "first" | "last"): boolean; // focusedStop() ?? cursor stop; always true
```

Tests (`Bridge.test.tsx`, `mountApp("/", { initialIssues, initialRefLinkRules:
FIXTURE_REF_LINK_RULES })`):

- The fixture sets `ws-965`'s title to `"Port RIG-12 from
  rigelbuild/compass#3 and OPS-4"`.
- With ten commands today, there are thirteen registered board commands. All
  of them retract on unmount.
- With stub titles, `ws-1022` gives `"Space"` and `ws-965` has no attribute.
  With the fixture title, `ws-965` gives `"R"`. With a ref added to its
  title, `ws-1022` gives `"Space R"`.
- `R` on a ref-less card or gutter is claimed. Focus and selection do not
  change.
- `R` on a toolbar button is not claimed.
- `Shift+R` on `ws-965` focuses `rigelbuild/compass#3`.

### T3 — The in-ref keys

Add these helpers and register `refGroup` and `board.exitCardRef` (Decision 2).

```ts
// apps/ui/src/components/Bridge.tsx — inside Bridge
const focusedRef = (): { ref: HTMLElement; owner: Stop } | undefined;
const stepRef = (at: { ref: HTMLElement; owner: Stop }, delta: 1 | -1): void; // wraps
const exitRef = (owner: Stop, dir?: BoardDirection): void;
// target = dir ? (moveCursor(stops(), owner.id, dir) ?? owner.id) : owner.id;
// setCursorId(target); (els.get(target) ?? owner.el).focus()
const onRefCommand = (id: CommandId): boolean;
// false unless focusedRef(); the two walk ids step; exitCardRef exits;
// a DIRECTIONS id exits and moves; else false.
// The new commands' run: () => onRefCommand(id) || onCommand(id)
```

Tests (same mount):

- **Flow.**
  1. From the cursor card, `ArrowLeft` lands on "Issue RIG-965".
  2. `r` focuses `RIG-12`; `r` again focuses `rigelbuild/compass#3`. `OPS-4`
     is never focused.
  3. `r` wraps to `RIG-12`, and `Shift+R` wraps back.
  4. `Enter` calls `window.open` once with
     `("https://github.com/rigelbuild/compass/issues/3", "_blank",
     "noreferrer,noopener")`. The selection stays `ws-1022`, and the view stays
     `bridge`.
  5. `Escape` focuses the RIG-965 card. It is the only `tabindex="0"`.

  Every `.ref-link` keeps `tabIndex === -1`.
- **Space** on a ref in `ws-1022`'s title opens it. The tab stays Issues.
- **Arrow exit.** From a ref on RIG-965, `ArrowRight` moves the cursor and
  focus to "Issue RIG-1022".
- **(a) Modifiers.** `Shift+ArrowLeft` and `Alt+ArrowLeft` on a ref are not
  prevented, and focus does not move.
- **(b) PRs tab.** Put `RIG-12` in PR #453's title. Focus that card, press
  `R`, then `Escape`. Focus returns to the card, whose stop id is composite.
- **(c) Pointer entry.** The cursor is on RIG-1022. Call `ref.focus()` on
  RIG-965.
  - `Escape` makes RIG-965 the cursor.
  - In a fresh mount, `ArrowLeft` lands on "compass-ui lane".
- **(d) Tour callout.** Open the board callout as `startCallout` does, then
  press `Escape` on a ref. Focus moves to the card, and `store.tour.open()`
  stays `true`.
- **Leader.** On a ref, press `g`, `Escape`, `s`. The view stays `bridge`, and
  focus is still on the ref. A second `Escape` exits.
- **Overlay** (`keyboard-e2e.test.tsx`). After `?`, the rows list both titles
  and "Return to card — Escape".

### T4 — Screen-reader acceptance check

Before the PR leaves draft, test with VoiceOver and NVDA in the desktop shell.
After `R`, the ref inside the card `<button>` must be announced as a link with
its text. Record the result in the PR body.

## Tasks

- [ ] T1 — Linked-ref rule and the rules seam
- [ ] T2 — Entry keys and announcement
- [ ] T3 — The in-ref keys
- [ ] T4 — Screen-reader acceptance check

## Deferred (non-load-bearing)

- Ratifying `r` in the leader-chords reservation list (its Open Question 4).
- Screen-reader browse-mode quick keys take bare letters (JAWS `R` = regions).
  Accept; the palette is the fallback.
- A card outline while a ref has focus (`.cx-card:has(:focus-visible)`).
- A Playwright check of Tab order from a ref.
