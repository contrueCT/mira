# Manual trusted examples

These are ordinary local extension modules using only `@mira/extension-sdk`.
They do not use real models or network services. Configure absolute paths in a
private JSON file outside the repository, for example:

```json
{
  "hmr": true,
  "entries": [
    { "id": "greeting", "path": "/absolute/mira/examples/extensions/greeting.ts", "enabled": false },
    { "id": "clock", "path": "/absolute/mira/examples/extensions/clock-source.ts" },
    { "id": "clock-consumer", "path": "/absolute/mira/examples/extensions/clock-consumer.ts" }
  ]
}
```

`MIRA_DEMO_EXTENSIONS=/absolute/extensions.json node --expose-internals apps/server/src/cli.mts <input-id> <message>`
uses this configuration alongside the existing explicit demo database/spool variables.
The demo provider is synthetic and does not decide to invoke tools on its own;
recovery tests inject a deterministic model that enables and calls the new tool in
one Wake. A product provider/authorization interpreter is still out of scope.

No npm installation or package discovery occurs at runtime. `extension.manage`
can only address configured IDs. Enable/disable/configure changes are saved back to
this JSON before activation; inspect receipts for separate save/apply failures. Cordis tracks the clock dependency: removing the
source suspends the consumer and its listener/tool, then restoring it re-applies the
consumer. Timers/listeners are cleaned on disable, replacement, and host shutdown.
