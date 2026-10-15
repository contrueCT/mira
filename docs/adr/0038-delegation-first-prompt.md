# ADR 0038: Delegation-first substantial work

Status: User-approved and implemented, 2026-10-15; exact-head CI remains separate
from local and native prompt-effect verification.

## Decision

Mira prefers a task worker for substantial, self-contained work that can run
independently. Short conversations and small actions stay with Mira. Assignment
includes the outcome, necessary context, authorization scope, files and checks;
only genuinely independent work is parallelized within the available capacity.
The main Mira stays responsive, sends changed requirements to the existing worker,
and uses asynchronous completion rather than occupying a whole turn with waits.
Spawning is not completion: Mira owns result review, recovery and final delivery.
Followup receipt/application is reported only as established by the tool result;
no immediate interruption of an in-flight tool or undoing its effects is promised. Tool availability, no nesting, shared-file ownership and
main-only Memory maintenance remain unchanged.

The new `<delegation>` section is original project wording added to the main
v0.2 template. The task worker's separate contract remains unchanged and does not
receive that main delegation instruction. No UI, scheduler, provider choice,
authorization engine or concurrency configuration changes are included.

## Published template identity and existing contexts

Previously, every saved prompt was validated by rendering the current source
asset. Changing the asset alone therefore rejected valid existing contexts.
Each new `MiraPromptSnapshot` now records `templateSha256`. Validation recognizes
only the current revision and the single previously published revision, whose
immutable bytes are kept in `mira-system-v0.2-pre-delegation.md`. An absent identity
means exactly that prior revision, not arbitrary historical text. Unknown hashes
and mismatched rendered text still fail closed. This is a narrow correction to
current v0.2 history validation, not a SemanticState/bootstrap migration layer.

Recovery validates each original snapshot against its own template and does not
rewrite records or reread Memory. At the next natural main-model request,
`prepareRequest` renders the current template using the latest persisted frozen
Memory and appends its identified system revision through the existing writer/CAS
path before calling the provider. With unchanged inputs this happens once; later
time/tool changes still produce normal identified revisions. A lost commit reply
recovers the committed revision without duplicating it. Compaction uses the saved
template identity and the single newly frozen Memory snapshot; it does not
implicitly upgrade a template during summary creation.

A running process caches its template at module load. Updating files alone does
not hot-reload the prompt. After starting the new code, the first normal main
request adopts the new guidance, without clearing conversation history or Memory
and without waiting for a compaction. This PR does not restart a user's instance.

The source manifest retains the original attachment hash and separately records
the revised asset. The prior published asset has its own fixed hash check. No
modified bytes are represented as the original attachment.

## Verification

Deterministic tests cover source preservation, real request prompt projection,
separate child instructions, old snapshot and compaction recovery, next-request
upgrade, frozen Memory, CAS failure, lost commit reply, restart, and corrupted or
unknown template identities. These tests use synthetic provider replies and do
not demonstrate model decision quality.

Native model-effect probes use the full rendered current prompt and actual tool
schemas with synthetic task context. They are separately reported in
[the acceptance record](../acceptance/delegation-first-prompt.md); they are not
production-provider validation and make no paid external provider calls.

The separate live-child-result delivery change is not implemented here. Existing
completion Event/Wake persistence and delivery semantics remain authoritative.
