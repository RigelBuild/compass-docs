# Stack marker detection: evidence (RIG-5587)

Evidence for the [stack marker detection](design.md#approach) record. The
record holds the design; this file holds the facts it rests on.

## Adoption

RIG-5565 B asks for the adoption of pulldown-cmark to be cited. From crates.io
on 2026-10-19:

- MIT license, repository `raphlinus/pulldown-cmark`, Rust 1.71.1 or later.
- 179.9 million downloads and 1,867 crates that depend on it.
- `just` 1.59.0 depends on `^0.13.4`. `clap_derive` 4.6.7 and `prost-build`
  0.14.4 depend on 0.13 as an optional dependency.
- Its README states the goal of 100% CommonMark compliance.

Its other dependencies, bitflags and memchr, are already in the jj-vine lock
file. Only pulldown-cmark 0.13.4 and unicase 2.10.0 are new.

## pulldown-cmark and GFM differences

The reader and the writer use the same parser, so these differences change only
how a forge renders the text. Each one makes the reader keep more markers as
user text, not fewer.

- pulldown-cmark 0.13.4 ends a `<textarea>` HTML block only at `</textarea>`,
  like `<pre>`, `<script>` and `<style>`. GFM lists only `<script>`, `<pre>`
  and `<style>` for that kind, so it ends a `<textarea>` block at a blank line.
- pulldown-cmark starts a declaration block at `<!` and any ASCII letter. GFM
  needs an uppercase letter.
- GFM's tag filter escapes tags such as `<textarea>`, `<style>` and
  `<title>` when it renders HTML. It acts after block parsing, so it does not
  change which blocks exist.

## Upstream port

Upstream `main` is v0.5.4. Its `insert_stack_into_description` takes two
arguments and has no `StackPlacement`. It puts the block where the first block
was.

- The reader does not depend on placement, so it ports as is.
- The writer check works the same way for the upstream layout: build `before`,
  the block, then `after`, check the block at its offset, and fall back to the
  top layout. A prototype of that layout passed every case in the record's
  Cases table.
- A port also needs the every-block splitter from
  `split_around_stack_blocks`. The pending upstream commit `b9bb1510` adds it.
- Upstream `MRUpdate` has the same `warnings` field, and its submit summary has
  the same dedup, so the T2 change ports too.
