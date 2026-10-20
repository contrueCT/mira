# Public upstream provenance

Source: https://github.com/vercel-labs/agent-browser/tree/1165952d74ceed98fdc2dd97190ad41f44dd0e24/skills/agent-browser

Tag: `v0.39.1`; commit: `1165952d74ceed98fdc2dd97190ad41f44dd0e24`. Apache-2.0, complete upstream license in `LICENSE`.

Mira changes (2026-10-14): remove foreign tool-allowlist/hidden metadata; replace global CLI plus automatic Chrome installation with pinned user-owned on-demand CLI setup with lifecycle scripts disabled and the official Node launcher (the pinned postinstall can rewrite a global symlink); add lightweight reading, task sessions, current refs, uncertain outcome handling and the existing runtime guidance. Core workflows remain served by the installed official CLI, not copied or reimplemented. README/package metadata were inspected but are not vendored.

Installation adaptation is based on the pinned official [postinstall hook](https://github.com/vercel-labs/agent-browser/blob/1165952d74ceed98fdc2dd97190ad41f44dd0e24/scripts/postinstall.js) and [Node launcher](https://github.com/vercel-labs/agent-browser/blob/1165952d74ceed98fdc2dd97190ad41f44dd0e24/bin/agent-browser.js). These are referenced, not copied; actual native CLI/browser startup remains unverified in this integration.

Mira changes (2026-10-15): managed browser tools take precedence over shell invocation when available. Web uses the pinned native daemon protocol and official stream; `BrowserPanel.tsx` adapts the upstream Dashboard viewport coordinate/modifier mappings without copying the Dashboard application. See [ADR 0034](../../docs/adr/0034-managed-browser-handoff.md). Native browser validation remains a separate real-chain gate.

Mira changes (2026-10-17): add Linux startup troubleshooting for downloaded Chrome with missing shared libraries, service-specific executable selection, privileged-install handoff, and real managed-browser verification. Package/version checks remain distinct from browser readiness; the instructions preserve managed control and existing installation authorization.

Mira changes (2026-10-18): explain managed Linux discovery of system-installed official Chrome on every new open, explicit startup override precedence, and the separate CLI configuration boundary.
