# Auth gateway request body limits

## Problem

After bearer authorization, the auth gateway parses image, speech, and video submissions with `Request.json()` or `Request.formData()`. These methods consume the body before route-specific rejection. Transcriptions, embeddings, and rerank already have bounded readers; image, speech, and video do not. Bun's server-level request cap is a separate backstop, not a route-specific contract. An authorized or compromised client can send a large body, including one with missing or false `Content-Length`.

## Approach

Reuse the byte-counting pattern in `providers/transcriptions-server.ts` rather than add a fourth convention. Reject a declared length above the cap before reading; always count actual bytes, including unknown, malformed, or understated lengths. Check the cap before retaining a chunk, cancel an incomplete stream, and release the reader lock on every exit. If the client aborts mid-read, retain the route's 499 response rather than return 400 or 413. Avoid allocating from the declared length.

Apply the bounded read before JSON parsing or multipart construction for image, speech, and video routes. The cap measures wire bytes; a parsed multipart upload and its base64 copy have a larger peak memory cost. Limit image-file count and reject unexpected multipart parts before encoding them, without breaking supported edit references. Parse bounded multipart bytes with `new Response(bytes, { headers }).formData()` as the transcription route does. Routes keep their existing validation envelopes; excess bytes use HTTP 413.

Caps (RIG-4140 option A, Matt 2026-10-07) keep 35 MiB images working:

| Route | Wire-byte cap |
| --- | --- |
| Image JSON | 48 MiB |
| Image multipart | 36 MiB |
| Speech JSON | 25 MiB |
| Video JSON | 25 MiB |

A 35 MiB raw image is about 47 MiB as base64 in JSON, so 48 MiB admits it.

Image multipart accepts at most 16 image files, counting `image` and `image[]` together; this matches the upstream images-edit limit. It accepts at most 24 parts in total: the 16 files plus the 6 named fields `parseMultipart` reads, with slack. Count boundary delimiters in the bounded bytes before calling `formData()`, so part expansion is bounded before parsing. No server-wide cap is added.

The main protocol, pi-native, and System One routes also use `req.json()`. Their sizing and a server-wide `maxRequestBodySize` backstop are separate scope decisions; do not claim this design caps all gateway routes. Existing transcription/embedding/rerank caps remain unchanged.

Video-job access is separate: `resolveClientIdentity` reads caller-controlled attribution headers and cannot prove the submitting principal. Per RIG-4139 (option C, Matt 2026-10-07), every configured bearer may read every video job: all bearers are one trust domain, and video jobs are not used yet. Revisit before any multi-tenant use. Credential-affinity map growth is also separate from body parsing.

## Global Constraints

- Preserve 499 on mid-stream request abort and route-specific 400 on malformed bodies within the limit.
- Reject oversized multipart input before constructing `FormData` or copying files into base64 strings; bound accepted part count and file count.
- Count actual wire bytes regardless of declared length. `Content-Length` is only an early-reject hint.
- Do not use `resolveClientIdentity` as an authorization check for video jobs.

## Plan

1. Add failing tests for exact-cap JSON, one byte over, declared oversize, chunked unknown size, understated size, and multipart edits. Assert 413 and no provider call on oversize, stream cancellation, rejection of excessive multipart parts, and 400 for malformed accepted-size bodies. Exercise a mid-stream abort after headers and assert 499.
2. Extract or reuse the existing bounded reader pattern without changing transcriptions, embeddings, or rerank behavior. Apply it in image, speech, and video routes; release the reader lock on every exit and cancel non-complete reads. Parse multipart only from accepted bounded bytes and limit part/file expansion. The route supplies its own cap and 413 envelope.
3. Run affected formatting, lint, tests, and direct gateway HTTP smoke for oversized chunked and multipart requests. Check representative accepted images near the cap for peak memory amplification.

## Tasks

- [ ] Add failing boundary, multipart, and adversarial streaming tests for image, speech, and video routes. Interfaces: HTTP `POST` to image generation/edit, speech, and video submit; assert existing error envelopes with 413/400/499 and upstream-call counts.
- [ ] Reuse bounded reading for JSON/multipart with route-specific 413 and preserved 499 behavior. Interfaces: `Request` plus cap bytes to bounded bytes/too-large result; handlers in `routes/images.ts`, `routes/speech.ts`, and `routes/video.ts` own JSON/FormData parsing and response formatting.
- [ ] Verify affected TypeScript checks, gateway HTTP behavior, and accepted multipart memory budget. Interfaces: existing auth gateway boot harness and image multipart edit endpoint; no video-job access changes.
