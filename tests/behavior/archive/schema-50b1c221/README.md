# Historical reply native evidence

These are the exact, unmodified native first-attempt traces and evaluator
instructions first committed in `9535f9af2f6f8ec821d8f760eebe00b8f44f2326`.
They were copied from integrated commit
`ab63f3ad2cbedd16ac9fcf3d8a641f3ec4a293a1` before the new native evaluation.
They describe the older complete tool schema
`50b1c2212caeddbc626bec05f5459cd75539b7ae595e0ce8d61cf7efc4a5186f`.
They are not evaluations of the integrated MCP/settings declarations and must
never be relabeled with the new schema hash.

- `reply-native-traces.json` SHA-256:
  `e9daa1c8ac3727352ae6863008719abe5e23fe052622af81c2f150097f855349`
- `evaluator-instructions.json` SHA-256:
  `b59905ded8c9d1ceda3c24250289b758e116dcf43ca7a4c0af9b715cbcd58506`

The historical observation was six completed first native attempts, thirteen
provider decisions, and seven selected tool calls with successful outcomes.
The historical legacy-history sequence was `history_search`, `history_read`,
`send_reply`, then an empty final. This evidence remains a native behavioral
simulation using in-memory persistence and approximate search, not a live call
to the user's configured model.

Current observations and pending real-PG/browser validation are recorded in
[the acceptance report](../../../../docs/acceptance/reply-native-behavior.md).
Current replay consumes `../../fixtures/reply-native-traces.json`; this archive
is retained for attribution and is not replayed against a different schema.
