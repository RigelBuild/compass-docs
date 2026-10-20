# Stack marker detection in PR descriptions (RIG-5587)

<!-- LENGTH §Plan: three executor tasks plus one parked task -->

## Open Questions

Questions 1, 2 and 4 are load-bearing. Matt rules on them in RIG-6034. They
do not depend on each other. T3 is parked on question 4.

DL-637 text and status are finalized from the RIG-6034 ruling before merge.

1. **Old blocks that the new reader no longer finds (load-bearing).** Today's
   reader is lexical, so it finds every block that jj-vine wrote. The new
   reader keeps an old block as user text in these shapes:
   - Below a fence, or below an HTML block that ends at a closer string
     (`<pre>`, `<script>`, `<style>`, `<textarea>`, `<?`, CDATA), when that
     block is open to the end. The new block goes to the top, and the old copy
     shows inside the open block as code or raw text.
   - Below an open comment (`<!--`) or declaration (`<!DOCTYPE`). The old
     start line holds `-->` and `>`, so it closes the user's block. The old
     stack body shows as normal text, and the new block goes below it. The PR
     shows two stacks.
   - Inside a `<details>` or other HTML wrapper, with no blank line before the
     start marker. The PR shows two stacks.
   - A block whose title has a line break that hides its end marker. The PR
     shows two stacks.

   On 2026-10-20, all 95 open RigelBuild PRs with a stack block had the same
   blocks under both readers, so no open PR has these shapes.
   1. Keep the old copy as user text. One rule, and no example is ever
      deleted. Cost: an affected PR keeps a stale copy, sometimes as a second
      visible stack, until the user deletes it.
   2. Also delete a lexical pair whose body starts with a generated header
      (`This PR is part of a stack`, `This MR is part of a stack`), even when
      its start marker is not real. This covers all four shapes. Cost: a
      second reader rule, and a user example that copies a whole generated
      block is deleted.
   3. Delete any lexical pair inside a block that is open to the end. This is
      the `f8ba8842` rule from #47, which RIG-5582 rejected because it deletes
      examples.

   **Recommendation:** option 1. T1 tests assume it.

2. **Where the block goes when the bottom check fails (load-bearing).**
   1. At the top, before all user text. This is the `Top` layout, so there is
      no new layout. Cost: the stack moves above all user text, even when the
      open block is a comment that does not render.
   2. Just before the block that is open at the end. The writer takes the
      start of the last top-level block from the same parse, and falls back to
      the top layout. A prototype was stable on every case. Benefit: more user
      text stays above the stack, and with an open comment the PR looks the
      same as `Bottom`. Cost: a third layout, a walk over the parse events to
      find top-level blocks, and its own tests.

   **Recommendation:** option 1. No open RigelBuild PR fails the bottom check,
   and one fallback that reuses `Top` is simpler to explain and test. The
   design below assumes it.

3. **Offer the fix upstream (not load-bearing).** The design works upstream
   (see [Upstream](#upstream)). The fork is complete without it.
   1. Offer it on Codeberg after the fork ships, after the pending upstream
      fix that replaces every block (commit `b9bb1510`).
   2. Keep it in the fork.

   **Recommendation:** option 1, as a separate change after T1 merges.

4. **What the writer does when no candidate passes the check
   (load-bearing).** Two things reach writer step 4. A title with a line break
   can hide the new end marker: `format_bookmark_entry` inserts `mr.title()`
   as is, and the `FirstRevisionFullMessage` and `HeadRevisionFullMessage`
   title formats copy the whole commit message. On GitLab, Forgejo and Azure
   the stack shows every title, not only this PR's. Also, removing an old block
   can join user text so that a marker example becomes real: a list item, the
   old block, then an indented example. Whether each forge keeps line breaks
   in stored titles was not checked.
   1. Join the lines of each title with spaces (T3), so generated text cannot
      hide its end marker. Step 4 returns the current description unchanged
      and warns; only the join case reaches it. Cost: stack bytes change for a
      title with a line break, which renders broken today.
   2. Return the current description unchanged and warn, and leave titles as
      they are. No user text is rewritten. Cost: until the title changes, the
      PR keeps a stale stack, and with `description.sync` on its text is not
      synced either.
   3. Write no block and warn, built as `join_parts(&[before, after])`. Cost:
      the stack disappears, and in the join case the next submit reads the
      example as a real block and deletes it.

   **Recommendation:** option 1. T1 builds step 4 for options 1 and 2, and T3
   adds the title change. Option 3 changes T1 step 5 and drops T3.

## Problem / Intent

jj-vine finds its stack block in a PR description by the whole-line markers
`<!-- start jj-vine stack -->` and `<!-- end jj-vine stack -->`, so a marker
example that a user writes in a code block or a raw HTML block is taken as
real and deleted on the next submit. This record says how jj-vine tells its
own markers from examples, and how it writes the block so that it always finds
that block again. The goal is no deleted examples and no duplicate stacks.

## Approach

The design has two parts. The reader decides which markers are real. The
writer keeps a layout only when the reader finds the new block in it again.
DL-637 records the rule.

This record builds on three earlier decisions:

- RIG-5565 (Matt, option B, 2026-10-17): find code blocks with pulldown-cmark,
  with its adoption cited.
- RIG-5582 (Matt, option A, 2026-10-17): fork PR #47 shipped line-exact
  matching only, and protection of examples moved to this record. #47 showed
  that protecting a block that is open at the end duplicates the stack, and
  not protecting it deletes examples.
- DL-558: Compass agents stop using jj-vine after a cutover. Until then a
  Compass tool strips plain jj-vine blocks. So the marker strings stay as they
  are.

### The reader: a real marker is its own HTML block

Each marker that jj-vine writes is on its own line at column 0. The start
marker follows a blank line or begins the text. CommonMark parses that line as
the start of an HTML block (a comment). A comment line can also interrupt a
paragraph or end a list, so the end marker starts an HTML block too. A marker
example that a user writes is part of some other block: a fenced code block,
an indented code block, or a raw HTML block such as `<details>` or `<pre>`.
The parser starts no HTML block at that marker.

So the reader keeps the whole-line match and adds one check. pulldown-cmark
must report `Event::Start(Tag::HtmlBlock)` at the first non-space byte of the
marker line. Pairing does not change from `split_around_stack_blocks` today:
each end marker closes the nearest open start, an enclosing block absorbs the
blocks inside it, and unpaired markers stay user text.

The check uses the first non-space byte, not the line start. For a line with
one to three leading spaces, the parser puts the HTML block start at the `<`.
With four or more spaces the line is indented code, and the parser reports no
start.

The parser runs with `Parser::new_ext(description, Options::ENABLE_FOOTNOTES)`
and `into_offset_iter()`, the same call as commit `f8ba8842` on #47. GitHub
renders footnotes, so a fence inside a footnote definition is code. With the
table option on, a probe gave the same HTML block starts, so it is not needed.

### The writer: keep only a layout the reader finds again

The reader alone cannot solve the hard case from #47 rounds 5 and 6. When the
user text ends inside an open fence or HTML block, a block written below it
becomes part of that block. The reader does not find it, and every submit adds
one more block.

So the writer checks its own output. It builds a candidate, runs the reader on
it, and keeps it only when the reader finds exactly the new block at the
offset where the writer put it. For an empty stack, the reader must find no
block.

1. Build the candidate for the configured placement. `Bottom` is the user
   text, then the block. `Top` is the block, then the user text. An empty
   stack gives the user text only, joined as today.
2. Check the candidate. If it passes, keep it.
3. If the `Bottom` candidate fails, the user text ends inside an open block.
   Build and check the top candidate. This is direction 2 of RIG-5587, but the
   writer does not ask the parser which block is open.
4. If no candidate passes, return the PR's current description unchanged,
   because a block that the reader cannot find is added again on every
   submit. With `description.sync` on, the user text is new commit text, not
   the current description, so the writer gets the current description as a
   separate argument. Open Question 4 lists what reaches this step.

The writer also returns which candidate it kept. Submit warns about the PR
when the block falls back to the top and the description changes, and on
every submit that reaches step 4.

The output is stable. For one jj-vine version and fixed user text, the next
submit keeps the same candidate and returns the same bytes, so
`UpdateMRTitleDescriptionAction` reports `MRUpdateType::Unchanged`. The choice
depends only on the user text. The stack body comes after the new start
marker, so it cannot change whether that marker is real. It can only hide the
end marker, and then every candidate fails. The output changes only when:

- the user edits the text, for example closes the fence, and the block moves
  back to the bottom;
- an older jj-vine also submits the PR (see note (f));
- a title gains or loses a line break, if T3 does not ship;
- an empty stack removes a block that has no text before it. The result starts
  with a newline, which the next submit trims, as today.

Each parse is linear in the text length, and the writer parses at most three
texts per PR. `remove_jj_vine_stack_from_description` uses the same reader,
so the sync check in `src/submit/plan.rs` no longer sees a change when a
description holds a marker example.

### Cases

| Case | User text | Result |
| --- | --- | --- |
| (a) closed fence | A marker example in a closed fence, then an old block | The example stays. The new block replaces the old one. |
| (b) indented code | A marker example indented four spaces | The example stays, with its indent. |
| (c) raw HTML | A marker example inside `<details>` or `<pre>` | The example stays. |
| (d) unclosed fence | The text ends inside an open fence, with or without a marker example | The bottom check fails. The block goes to the top. The example stays. |
| (e) unclosed HTML | The text ends inside an open comment, `<pre>`, `<script>`, `<style>`, `<textarea>`, CDATA, processing instruction or declaration | The bottom check fails. The block goes to the top. |
| (f) old descriptions | A block written by an earlier jj-vine | Replaced once, except in the shapes of Open Question 1. |
| (g) CRLF | Any case above with CRLF line ends | Same result. The reader trims the `\r`, and the writer joins with `\n`. |

Notes on the cases:

- (b) Today each piece of user text is trimmed with `str::trim`, which
  removes the indent of its first line. An indented example at the start of
  the text, or right after a removed block, would then move to column 0 and
  become a real marker. So the split now removes only whole blank lines at
  the start and keeps the first line's indent. This changes bytes only when a
  piece of user text starts with spaces or tabs. Narrowing case (b) instead
  would leave that example silently changed.
- (c) A `<details>` block ends at a blank line, by CommonMark. Markers that a
  user puts after a blank line inside `<details>` are their own HTML blocks,
  so the reader treats them as real and replaces them. Comments do not render,
  so no visible example is lost. A `<pre>` block ends only at `</pre>`, so
  blank lines inside it do not matter.
- (d) A fence inside a list, a quote or a footnote ends when its container
  ends. A marker at column 0 after a blank line ends that container, so the
  bottom check passes and the block stays at the bottom.
- (e) An open `<div>` or `<details>` also ends at a blank line, so the bottom
  check passes. Only the HTML block kinds that end at a closer string move the
  block.
- (f) If an older jj-vine and this one both submit a PR that ends inside an
  open block, each one rewrites the other's block on every submit. DL-558
  removes jj-vine from Compass agents, so this mix does not last.
- Bare CR line ends are not supported, the same as today.

### Forge renderers

Correctness does not depend on the forge. The reader and the writer use the
same parser, so the check holds whatever GitHub, GitLab, Forgejo or Azure
render. The known differences from GFM make the reader keep more markers as
user text, not fewer ([evidence](evidence.md#pulldown-cmark-and-gfm-differences)).

### Dependency

pulldown-cmark 0.13.4 comes back, as in commit `5355d640` on #47:
`pulldown-cmark = { version = "0.13.4", default-features = false }`. The lock
file gains pulldown-cmark 0.13.4 and unicase 2.10.0. Without default features
it does not build the `getopts` binary or the HTML renderer. The main branch of
pulldown-cmark adds a default `std` feature and fails to build without `std`
or `hashbrown`. When a release has it, add `features = ["std"]`. The lock
file, which the nix build also reads, keeps 0.13.4 until then. The adoption
that RIG-5565 B asks for is in [evidence](evidence.md#adoption).

### Upstream

The design works upstream too, for the v0.5.4 layout that puts the block where
the first block was. The port notes are in
[evidence](evidence.md#upstream-port).

## Alternatives considered

- **Unique markers** (RIG-5587 direction 1), such as a per-stack id. Old
  descriptions and the Compass strip tool use the plain strings, so the reader
  must still find plain markers. A user example can also copy any marker form.
- **Close the open block** (direction 3). The writer would add a closer to
  user text. That changes how the text renders and needs one closer for each
  block kind.
- **Protect a block unless it is open to the end** (`f8ba8842`). An example in
  a block that is open to the end is deleted, and the result changes when the
  user edits the text. RIG-5582 rejected it.
- **Lexical match** (today). It deletes examples.

## Plan

### Global Constraints

- Base: `rigel-release` at `9f12f96a` or later. Edition 2024.
- Follow the crate lints in `src/lib.rs`: `clippy::pedantic`,
  `std_instead_of_core` (use `core::ops::Range`), `arithmetic_side_effects`
  (use `strict_add` and `strict_sub` as the current code does) and
  `string_slice` (use `#[expect(clippy::string_slice, reason = "...")]`).
- `START_MARKER` and `END_MARKER` do not change.
- No public signature changes and no new `pub` items. New items are private
  or `pub(crate)`.
- A description with no marker example and no open block at the end gives the
  same bytes as today, except that user text keeps the indent of its first
  line (note (b)). The existing tests of `insert_stack_into_description` and
  `remove_jj_vine_stack_from_description` stay unchanged and pass.
- Parser options: `Options::ENABLE_FOOTNOTES` only.
- `README.md` and `README.djot` stay byte-identical (`just check-readmes`).
- `just` passes: `build`, `lint` (`fmt`, `clippy --tests`, `check-readmes`)
  and `test-unit`.
- Commit subjects use Conventional Commits and end with `(RIG-5587)`.
- T1, T2 and T4 ship in one PR, one commit each. T3 is parked on Open
  Question 4. If Matt picks option 1, T3 joins the same PR as its own commit.

### T1. Parser-checked reader and checked writer

The reader and the writer ship together. The reader alone duplicates the
stack in case (d), and the writer alone does nothing.

Files: `Cargo.toml`, `Cargo.lock`, `src/description.rs`.

Interfaces:

```rust
// src/description.rs
use core::ops::Range;
use pulldown_cmark::{Event, Options, Parser, Tag};

/// Which candidate `place_stack` kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StackLayout {
    /// The configured placement, or the user text alone for an empty stack.
    Configured,
    /// `Bottom` failed the check, so the block is at the top.
    TopFallback,
    /// No candidate passed, so the current description is returned as is.
    Kept,
}

/// Byte offsets where the parser starts an HTML block, ascending.
fn html_block_starts(description: &str) -> Vec<usize>;

/// Every real stack block, in order. A range runs from the `<` of a start
/// marker to the end of its end marker.
fn stack_block_ranges(description: &str) -> Vec<Range<usize>>;

/// Drops whole blank lines at the start, keeps the indent of the first
/// line, and trims the end.
fn trim_blank_lines(segment: &str) -> &str;

/// Joins the non-empty parts with "\n\n".
fn join_parts(parts: &[&str]) -> String;

// Same signature; built on stack_block_ranges and trim_blank_lines.
fn split_around_stack_blocks(description: &str) -> (String, String);

/// The writer: the new description and the candidate it kept. The blocks in
/// `user_description` are replaced; `current_description` is the fallback.
#[must_use]
pub(crate) fn place_stack(
    stack_description: &str,
    user_description: &str,
    current_description: &str,
    placement: StackPlacement,
) -> (String, StackLayout);

// Same signature. Returns
// place_stack(stack_description, existing_description, existing_description, placement).0.
pub fn insert_stack_into_description(
    stack_description: &str,
    existing_description: &str,
    placement: StackPlacement,
) -> String;

// Same signature and body; inherits the reader.
pub fn remove_jj_vine_stack_from_description(description: &str) -> String;
```

Steps:

1. Add the dependency line from [Dependency](#dependency) to `[dependencies]`
   in alphabetical order, and update `Cargo.lock`.
2. `html_block_starts`: run the parser from [the reader
   section](#the-reader-a-real-marker-is-its-own-html-block) and keep
   `range.start` of each `Event::Start(Tag::HtmlBlock)`. Events come in text
   order, so the list is ascending.
3. `stack_block_ranges`: walk `description.split_inclusive('\n')`. A line is a
   marker when `line.trim()` equals a marker constant. The marker offset is the
   line start plus `line.len() - line.trim_start().len()`. The marker is real
   when `html_block_starts` holds that offset (binary search). Pair real
   markers as the current loop does. A pair pushes
   `start..end.strict_add(END_MARKER.len())`, where `start` and `end` are the
   two marker offsets.
4. `split_around_stack_blocks`: keep the current segment and join code over
   the ranges from step 3, and trim each segment with `trim_blank_lines`
   instead of `str::trim`. `trim_blank_lines` finds the first
   non-whitespace character, slices from the start of its line, and calls
   `trim_end`. It returns `""` for an all-whitespace segment.
5. `place_stack`: split `user_description` into `before` and `after`, then
   apply [the writer section](#the-writer-keep-only-a-layout-the-reader-finds-again).
   - Empty stack: the candidate is today's empty-stack output (`before`, then
     `\n{after}` when `after` is not empty). Keep it with `Configured` when
     `stack_block_ranges` finds no block in it. Otherwise return
     `current_description` with `Kept`.
   - Otherwise `block` is
     `format!("{START_MARKER}\n{stack_description}\n{END_MARKER}")`. A check
     passes when `stack_block_ranges(&candidate) == [start..start.strict_add(block.len())]`.
   - `Bottom`: the candidate is `join_parts(&[&before, &after, &block])`, with
     `start = candidate.len().strict_sub(block.len())`. Keep it with
     `Configured`.
   - Top: the candidate is `join_parts(&[&block, &before, &after])`, with
     `start = 0`. Keep it with `Configured` for `Top` and `TopFallback` for
     `Bottom`.
   - Else return `current_description.to_owned()` with `Kept`.

   These candidates give the same bytes as the current branches.
6. Doc comment on `insert_stack_into_description`: "Insert or replace the
   marked stack block at `placement`. If the text ends inside an open code or
   HTML block, the block goes to the top. If no layout gives a block that can
   be found again, the description is returned unchanged. An empty stack
   removes the block; retained user text is trimmed and may reorder."

### T1 tests

Add these tests to the `description.rs` test module, in the style of the
existing tests (`assert_str_eq!`). Add two module-level helpers. `fn
block(body: &str) -> String` returns
`format!("{START_MARKER}\n{body}\n{END_MARKER}")`, the same as the local
closure in `unpaired_markers_between_blocks_stay_user_text`.
`fn assert_bottom_stable(stack: &str, existing: &str, expected: &str)` checks
the `Bottom` output, then checks that a second call returns the same bytes.
Every test that writes a description checks the second call.

| Test | Case |
| --- | --- |
| `fenced_marker_example_stays_user_text` | (a), backtick and tilde fences, Bottom and Top |
| `longer_fence_keeps_inner_backtick_line_as_content` | (a), a four-backtick fence holds a three-backtick line |
| `fence_in_list_quote_and_footnote_stays_user_text` | (a) in containers |
| `indented_marker_example_stays_user_text` | (b) |
| `leading_indented_example_keeps_its_indent` | (b) note, at the start and after a removed block |
| `markers_indented_up_to_three_spaces_are_real` | (b) edge |
| `markers_in_html_block_stay_user_text` | (c), `<details>` and `<pre>` with blank lines |
| `markers_after_blank_line_in_details_are_real` | (c) note |
| `unclosed_fence_at_end_moves_block_to_top` | (d), backtick and tilde, with and without an example |
| `unclosed_fence_after_old_block_moves_block_to_top` | (d), the open fence is after the old block |
| `unclosed_fence_in_list_keeps_block_at_bottom` | (d) note |
| `closing_the_fence_moves_block_back_to_bottom` | (d), the user closes the fence |
| `unclosed_html_at_end_moves_block_to_top` | (e), comment, `<pre>`, `<script>`, `<style>`, `<textarea>`, CDATA, `<?php`, `<!DOCTYPE html` |
| `unclosed_pre_keeps_marker_example` | (e) with a marker example |
| `unclosed_div_or_details_keeps_block_at_bottom` | (e) note |
| `generated_block_is_replaced_once` | (f), a body in the formatter's shape |
| `block_inside_unclosed_fence_stays_user_text` | Open Question 1, fence shape |
| `block_below_open_comment_or_declaration_stays_user_text` | Open Question 1, comment and declaration shape |
| `block_in_details_wrapper_stays_user_text` | Open Question 1, wrapper shape |
| `crlf_fence_stays_user_text` | (g) with (a) |
| `crlf_unclosed_fence_moves_block_to_top` | (g) with (d) |
| `top_placement_with_unclosed_fence_is_idempotent` | (d) with `Top` |
| `empty_stack_keeps_marker_examples` | empty stack with (a) |
| `remove_keeps_marker_examples` | `remove_jj_vine_stack_from_description` with (a) |
| `stack_that_hides_its_end_marker_keeps_description` | writer step 4, block at the end and at offset 0 |
| `removal_that_exposes_an_example_keeps_description` | writer step 4, the join case, also with an empty stack |
| `place_stack_reports_layout` | `Configured`, `TopFallback` and `Kept`; on `Kept` it returns `current_description`, not `user_description` |

These tests pin these bytes:

```rust
// (d) and (e): the block goes to the top.
assert_bottom_stable("New", "Intro\n\n```md\ncode", &format!("{}\n\nIntro\n\n```md\ncode", block("New")));
assert_bottom_stable("New", "Intro\n\n<!-- note\nx", &format!("{}\n\nIntro\n\n<!-- note\nx", block("New")));
let existing = format!("Intro\n\n{}\n\n```\ncode", block("Old"));
assert_bottom_stable("New", &existing, &format!("{}\n\nIntro\n\n```\ncode", block("New")));

// (d): the user closes the fence, and the block moves back.
let existing = format!("{}\n\nIntro\n\n```md\ncode\n```", block("New"));
assert_bottom_stable("New", &existing, &format!("Intro\n\n```md\ncode\n```\n\n{}", block("New")));

// Open Question 1, option 1: old blocks stay user text.
let old = format!("```md\ncode\n\n{}", block("Old"));
assert_bottom_stable("New", &old, &format!("{}\n\n{old}", block("New")));
let old = format!("Intro\n\n<!-- note\nx\n\n{}", block("Old"));
assert_bottom_stable("New", &old, &format!("{old}\n\n{}", block("New")));
let old = format!("Intro\n\n<details>\n<summary>Stack</summary>\n{}\n</details>", block("Old"));
assert_bottom_stable("New", &old, &format!("{old}\n\n{}", block("New")));

// (b): a leading indented example keeps its indent.
let example = format!("    {START_MARKER}\n    ex\n    {END_MARKER}");
let existing = format!("{}\n\n{example}\n\nIntro", block("Old"));
assert_bottom_stable("New", &existing, &format!("{example}\n\nIntro\n\n{}", block("New")));

// Writer step 4: the description is returned unchanged.
for existing in [format!("Intro\n\n{}", block("Old")), format!("{}\n\nIntro", block("Old"))] {
    assert_bottom_stable("Title\n<!-- x", &existing, &existing);
}
let existing = format!("- item\n\n{}\n\n{example}", block("Old"));
assert_bottom_stable("New", &existing, &existing);
```

A prototype of this design passed all these cases and the existing
expectations of the 14 tests from `parse_empty_description` to
`generate_no_trailing_whitespace_when_no_user_content`.

### T2. Per-PR warning

Files: `src/submit/execute/update_mr_title_description.rs`,
`src/commands/submit.rs`.

`MRUpdate.warnings` already reaches the user as `Warning: ...`, but the
summary drops the `Updated` entry of a PR that was just created, and keeps one
entry per PR. A warning on a dropped entry is lost, and a new PR is the usual
place for a fallback.

Interfaces:

```rust
// src/submit/execute/update_mr_title_description.rs
use crate::description::{StackLayout, place_stack};

/// The warning for a stack block that is not where the placement puts it.
fn stack_layout_warning(layout: StackLayout, description_changed: bool) -> Option<&'static str>;

// src/commands/submit.rs
/// The table rows, one per MR in iid order, and the warnings of every update,
/// including updates that the rows drop.
fn summarize_mr_updates(merge_requests: &[MRUpdate]) -> (Vec<&MRUpdate>, Vec<&str>);
```

Steps:

1. `stack_layout_warning`: a `match` with no wildcard. `TopFallback` with a
   changed description gives "the description ends inside an open code or
   HTML block, so the stack block is at the top". `Kept` gives "jj-vine
   could not write a stack block that it can find again, so the stack block
   is not updated". Everything else gives `None`.
2. `UpdateMRTitleDescriptionAction::execute`: replace the
   `insert_stack_into_description` call with
   `place_stack(&stack_description, description_user_part, current_mr.description(), ctx.execute.config.description.placement)`.
   On `Kept` the result equals `current_mr.description()`, so
   `description_unchanged` is true and no edit deletes the stack. Map
   `stack_layout_warning(layout, !description_unchanged)` to
   `vec![format!("{} {}: {warning}", ctx.execute.forge.mr_name(), ctx.execute.forge.format_merge_request_id(current_mr.iid()))]`.
   Set the result in both `MRUpdate` values that now hold `warnings: None`.
   A dry run returns before them and prints no warning, as today.
3. `summarize_mr_updates`: move the sort, the removal of `Updated` entries for
   created PRs, and the `dedup_by_key` from `submit` into it. Collect the
   warnings of every entry first. `submit` prints them with the existing
   `warn!` format before the table, and the table loop ignores `warnings`.

Tests:

- `stack_layout_warning_only_for_fallback_change_and_kept`: all five inputs
  that matter.
- `execute_warns_once_when_stack_falls_back_to_top`: in the style of
  `execute_places_refreshed_stack_above_existing_user_text`, with
  `Intro\n\n```md\ncode` and `Bottom`. The first run gives one warning. A
  second run, with the updated MR in `SubmissionPlan.existing_mrs`, gives
  `MRUpdateType::Unchanged` and `warnings: None`.
- `execute_keeps_current_description_when_title_hides_end_marker`: the same
  setup with `Bottom`, an MR titled `"Hidden\n<!-- note"` whose description is
  `format!("User notes\n\n{START_MARKER}\nOld stack\n{END_MARKER}")`, and an
  action built with `.description(Some("Synced notes".to_owned()))`. The
  result is `MRUpdateType::Unchanged` with the `Kept` warning, and the
  TestForge description is still the old one.
- `summary_keeps_warnings_of_dropped_updates`: a `Created` and a warned
  `Updated` entry for one PR, and two `Unchanged` entries for another, the
  second warned. Two rows and both warnings come back.

### T3. One-line titles (parked on Open Question 4)

Files: `src/description.rs`.

Interfaces:

```rust
// src/description.rs
use std::borrow::Cow;

/// The title with each run of line breaks replaced by one space.
fn one_line_title(title: &str) -> Cow<'_, str>;
```

Steps:

1. `one_line_title`: return `Cow::Borrowed(title)` when it has no `'\r'` or
   `'\n'`, so other titles keep their bytes. Otherwise split on both
   characters, trim each part, drop empty parts and join with `" "`.
   CommonMark reads a bare `'\r'` as a line end, so it is split too.
2. `format_bookmark_entry`: pass both title sites, this PR's title and
   `mr.title()`, through `one_line_title`.

Tests:

- `one_line_title_joins_lines`: `"a\nb"`, `"a\r\n\r\nb"`, `"a\rb"` and a
  title with no line break.
- `multiline_title_is_one_line_in_stack`: the formatter test setup with
  `id_expands_title` false and titles that hold `"\n<!-- note"`. The stack
  shows each title on one line, and `place_stack` keeps it with `Configured`.

### T4. README

Files: `README.md`, `README.djot`.

In the placement paragraph that starts "On resubmission, placement moves an
existing stack block", add after its first sentence: "Marker lines inside code
blocks or HTML blocks are kept as text. If the description ends inside an open
code block or HTML block, the stack block goes to the top, because a block
below it would be part of the open block, and submit prints a warning." Make
the same edit in both files.

## Tasks

- [ ] T1. Parser-checked reader and checked writer in `src/description.rs`,
  with the pulldown-cmark dependency and the T1 tests.
- [ ] T2. Per-PR warning in `update_mr_title_description.rs` and
  `commands/submit.rs`.
- [ ] T3. One-line titles in `format_bookmark_entry`, after Matt rules on Open
  Question 4.
- [ ] T4. README placement paragraph in `README.md` and `README.djot`.
- [ ] `just` passes on the PR head.
