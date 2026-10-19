# ADR 0021: Bidirectional immutable chat attachments

Status: implementation of the user's approved scope (2026-10-13). The user approved an input-left plus button (bottom-left when expanded), drag/drop and paste, bidirectional files/images/video, and native video understanding in this increment. The user's later clarification supersedes automatic video input: video is an ordinary file for every model, and the model must explicitly read it when needed. PDF/Word also remain ordinary file references for the main model's tools; the application does not parse them.

## One attachment store and one cognition loop

An attachment is an immutable local snapshot with an opaque UUID, display filename,
byte-detected MIME, byte count and SHA-256. The private directory is outside the
source checkout, Memory and extension code artifacts. Its path is available to
ordinary model file tools, but is never a browser-supplied read target or public
DTO. HTTP accepts bytes and opaque IDs only, never remote URLs or local paths.
The store checks regular files, symlinks, sizes and digest on reads. Content is
written and synced before a reference is published. Source changes/deletions do
not change history. This is ordinary host-OS access, not a new sandbox.

Uploads are staged snapshots, not messages. A user submits one immutable envelope
of ID, timestamp, text and ordered attachment IDs. The existing fenced PG
Event/Wake transaction binds the resolved references to that message. Retrying the
same envelope returns the existing receipt; differing content/order conflicts.
No second attachment database or chat lifecycle is introduced. Browser pending
state contains metadata/IDs, never media base64. Uncertain receipt retries do not
restart cognition.

The main model explicitly uses `send_attachment` with existing local paths and
optional text to publish files. It runs through normal persisted intent/effect/
outcome. Only its known successful durable publication is projected to chat.
Ordinary read/image/tool results remain private.
The publication keeps its intent record's position in the Timeline, so it can
complete after newer records have pushed that position out of the latest
window. The web service follows pending tool entries it has read (at most 512,
in memory) and re-reads those outside the latest window on each latest poll; a
completed visible publication is returned as a separate `updates` list on
`GET /api/timeline` for ten minutes (at most 32), never in `items`, so history
cursors and gaps are unaffected. The browser applies an update only to a known
item or within the stretch it has already loaded; older ones appear in place
when that history is read. A server restart forgets tracking; the publication
still appears whenever its stretch is read again. Unknown outcomes retain existing
recovery semantics and are never automatically replayed. Complete snapshots that
were never referenced may remain on disk; automatic deletion is limited to failed
operation temporary files, avoiding a GC race with a database commit. No automatic
age-based deletion of complete snapshots or historical references is introduced.
An offline orphan collector requires a separate coordinated design.

## Provider-neutral durable input and native media

CognitionTurn carries ordered AttachmentReference values independently of Pi.
Wake rendering preserves the complete source payload and filenames/paths, including
when text overflows into its reconstructible ordinary spool file. Pi stores
validated `miraAttachments` on the original user record, not media bytes. Recovery
compares both the original input and exact ordered reference metadata.

At the existing request boundary, the adapter reads and hashes immutable snapshots,
then creates request-local native Pi image blocks for vision-capable models. The
original records are untouched. Documents remain file references for normal tools.
Unsupported image models receive explicit text stating image bytes were NOT
provided; they must not claim to have viewed them. Video arrival never attempts
native understanding, regardless of the selected model. No automatic OCR/document parse,
frame extraction or secondary reasoning runtime is added.

The existing ordinary `read` tool is wrapped at server composition to identify
local MP4/WebM by bytes, including uploaded blobs with extensionless names. An
explicit read snapshots the video and persists its immutable references in that
successful tool result. Only these explicit read results are eligible for native
video hydration. Unsupported models receive a truthful ordinary-file/limit result;
upload itself is unaffected. No new read service or second runtime is added.

Pi 1.0.2 has no video content block. For built-in Google Gemini only, request-local
`miraNativeVideos` on that `read` tool result identifies an ordered text slot. The existing Google
transport clones the request, inserts unique temporary slot markers, and its public
`onPayload` hook replaces those exact slots with the reference text in the function response plus adjacent native
`inlineData` video parts before the real Google SDK serializes HTTP. Pi still owns
message/tool conversion and the main loop. Video is never disguised as an image.
The SDK wire serialization is tested with multiple users and intervening tool
calls/results; a synthetic intercepted HTTP response is not a live model or video
understanding quality test.

Native video initially supports MP4/WebM, provider `google`, API
`google-generative-ai`, Gemini model IDs. Both runtime hydration and Google video
transport cap aggregate inline media at 12 MiB; Google request parameters are
limited to 19,000,000 bytes before SDK serialization, leaving conservative headroom
below the 20 MB inline request guidance. This does not promise any model's token
capacity. Larger files can be stored/downloaded but cannot be sent as native media
in that request; runtime selects newest complete eligible user-image/tool-read-video groups within the budget and provides explicit unviewed-file references for omitted groups, so an oversized file cannot permanently block the active Wake. The transport still rejects oversized native metadata before network transmission. No
provider Files API upload, remote URL fetch, extra credential, dependency upgrade
or paid call is added.

Compaction passes each attachment-bearing original History ID/count to the summary
request, explicitly omitting media bytes. The runtime reuses the existing immutable
ordinary-file spool writer for a derived index node keyed by the new checkpoint ID.
Each node holds only current source references and a pointer to the previous index
file; it never copies a lifetime list or Memory history. Overflow sources retain the
validated original Wake file pointer (`CognitionTurn.overflowInput` / user metadata
`miraOverflowInput`); other sources include their exact attachment references.
Validated checkpoint metadata `miraAttachmentIndex` and a short summary instruction
point directly to this file, readable with ordinary line pagination. Both merged
source records and Memory-heavy checkpoints may exceed `history_read` limits, so
neither is required to traverse this file chain. File contents remain source material,
not permission. A programmatic runtime must provide `writeOverflowInput` before
attachment compaction; Web and demo assemblies reuse their existing spool writer.
Missing files return ordinary read errors; differing content is never overwritten,
and completed derived files have no automatic cleanup. File-write failures,
cancellation, ownership loss and CAS conflicts cannot publish the checkpoint. The
request text projection is shared by hydration and token estimation, including all
added native labels and omission notices; documents already represented by the
Wake's original text or overflow file are not injected a second time. Media token
estimation includes conservative image/video allowances and remains a heuristic,
not provider tokenization. All checkpoint publication retains existing CAS,
cancellation, Memory snapshot and tool-pair boundaries.

## HTTP/UI and limits

Protected fetch remains required for all attachment operations, with exact Host,
Origin, fetch metadata and x-mira-client checks. Previews/downloads use Blob URLs;
CSP adds only blob image/media sources. No direct unauthenticated media endpoint or
active HTML/SVG embedding is added. Downloads are attachments with nosniff. The
bounded Blob approach avoids a second streaming/range authorization mechanism.

Per message: 10 files, individual 50 MiB (raster images 10 MiB), total 100 MiB.
Raster headers are checked for at most 16,384 pixels per side and 40 million pixels.
MIME is detected from bytes; unknown/active formats remain octet-stream download
files. These storage bounds differ from the smaller native-provider request bound.
The UI preserves the quiet single Timeline: compact two-column image thumbnails,
odd final image left-aligned, click preview, playable supported video, file cards
and downloads. There is no new management/chat/account concept.

## Verification claims

Offline unit, actual SDK serialization, real PostgreSQL and real browser gates are
separate. The real attachment suite runs UI -> production HTTP -> PG Event/Wake ->
Pi -> synthetic provider -> ordinary attachment tool -> immutable store and restarts
the service. Browser screenshots use synthetic files. No live model credentials,
production database, production model invocation, merge or deployment is authorized
by this implementation.

Official protocol references:
- https://ai.google.dev/gemini-api/docs/video-understanding
- https://ai.google.dev/api/generate-content
