# MCP model usability acceptance

## Method and limits

Native cold-start agents used the rendered Mira system prompt, real skill catalog
and management-tool schemas from `scripts/tool-usability.mts`. They selected
skills and commands without an implementation answer key. Their chosen commands
executed against the real package preparer, ArtifactStore, extension tools,
Cordis Host and official SDK stdio server fixture. The adapter retained one live
Host for each scenario. No paid model API, real account or provider credentials
were used. Source/fixtures were not supplied as explanatory context.

This is a native model-selected tool-level test, not the user's configured model,
a full Pi/PG conversation, or a live-provider OAuth acceptance. The ordinary skill
loader/main and child prompt/ordinary read path is separately tested by
`bundled-skills.test.mts`. The deterministic MCP runtime, PostgreSQL and browser
gates remain separate; they must pass for the exact published commit. No universal
claim that every configured model will select the same actions follows.

## Observed baseline

- Existing `mira-extension-authoring` metadata was enough for one cold agent to
  discover the MCP package and linked workflow without special instructions.
- Actual package preparation, staging, digest-bound import smoke test, disabled
  install, activation, echo, disable/enable and second echo passed first attempts.
- Complete configuration replacement, catalog refresh, duplicate installation ID
  rejection, independent second installation, fresh package update and saved-revision
  rollback were exercised. Echo worked after update and rollback. A new preparation
  had a different artifact digest despite equal ordinary source bytes; this is
  artifact/topology identity evidence (the captured dependency namespace retained
  the distinct workspace paths), not a claim that server behavior changed.
- The second installation exposed no tools because of a global duplicate name.
  The original remained usable. The original model projection reported active code
  with no connection diagnostic, so the agent could not establish the specific
  cause from inspection alone. This was a real usability gap, not a passed case.
- A fresh agent discovered the dedicated `mira-mcp` skill, installed another local
  server, called known_error once and unknown_after_effect once. The first returned
  `isError:true`; the second returned unknown. The synthetic audit recorded exactly
  one effect. The agent reconciled the audit and reconnected through settings
  actions without replaying either call; fresh declarations returned afterward.
- In a separate planner-only phone/OAuth scenario, the agent identified the missing
  same-machine browser/existing HTTPS callback prerequisite. It did not invent an
  authorization grant/link, create a tunnel or contact a real provider.

## Shipped guidance and correction

`skills/mira-mcp/SKILL.md` is a concise connection-oriented catalog entry. It reuses
the shipped package and existing artifact/lifecycle tools, explains the prepared
entry and import-only smoke check, and distinguishes credentials, startup behavior,
connection state, catalog collisions and unknown outcomes. No new framework or MCP
management tools were added.

To correct the observed diagnostic gap, generic `extension_inspect.settings` adds
only validated connection state and fixed code. `name_conflict` and `invalid_tools`
are provider-neutral codes; the MCP consumer supplies them for rejected catalogs.
A non-MCP fixture verifies the same behavior and confirms that private details,
credentials, authorization URLs, unexpected codes and raw exceptions are not
forwarded. Lifecycle active and connection connected remain distinct observations.

## Post-correction cold-start recheck

A third independent native agent started from the updated delivered prompt, catalog
and schemas. It independently read the MCP skill, prepared/staged/import-tested the
package and installed two requested instances. It observed the second instance's
`error/name_conflict` from the real inspection result and explained the actual
global tool-name conflict. Under the scenario's explicit fallback instruction, it
disabled only that failed instance. The working instance's complete runtime/config/
activation snapshot stayed unchanged and its original `echo` returned hello.
No prefixes, aliases, blind reconnects or source edits were used.

Shell-adapter launch initially received EOF without a PTY, before any tool call;
the evaluator restarted it with a PTY. Truncated displays were resolved from the
complete captured transcript, without replaying mutations. These adapter issues
are recorded separately from the production-tool behavior. Each probe closed its
Host after saving evidence; saved configuration is not proof of a service still
running after fixture teardown.
