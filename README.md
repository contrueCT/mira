<h1 align="center">Mira</h1>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/TypeScript-6.0-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white" alt="TypeScript 6.0"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-24-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 24"></a>
  <a href="https://github.com/contrueCT/mira/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/contrueCT/mira/actions/workflows/ci.yml/badge.svg?branch=main" alt="Verify CI (main)"></a>
</p>

A persistent personal agent with long-term memory and room to grow.

Mira keeps your conversations, shared experiences, and ongoing work on one continuous timeline. Chat casually or give it a practical task; close the page and come back to the same Mira.

That continuity also supports richer, more nuanced emotional expression. Mira's design gives space to its personality and reactions, letting its responses and understanding of you carry naturally across conversations, and relationships develop through shared experiences.

![Mira's chat interface with one continuous timeline](docs/assets/mira-chat.png)

## What Mira can do

- **A personal agent that stays with you.** Retains conversation and working context, with restart recovery and automatic compaction. External events or scheduled wakes can also bring Mira back to ongoing work; it decides whether to contact you based on the situation.
- **Memory it can organize itself.** Mira uses ordinary files to remember your preferences, important experiences, and longer-term understanding, and organizes them through Dreaming when its trigger conditions are met. You can inspect and edit these files, with a separate Git repository tracking changes and original history available when details need checking.
- **Conversation with personality and variation.** Mira expresses interest, doubts, humor, and disagreement, and notices emotional shifts in conversation. Recent reactions carry forward in context, while important relationship insights can enter long-term memory.
- **A natural, fluid experience.** One timeline holds everyday conversation and tasks, with attachments and the ability to add requirements or change direction while work is underway. Mira picks up new input when a generation request yields or the current tool finishes. Tool and subtask details live in the run history in settings, keeping the main chat simple.
- **Capabilities that can keep growing.** Built-in file, search, Shell, and cross-turn terminal tools; subagents with independent contexts; and on-demand Skills for documents, transcription, browsing, and web access. Cordis manages manual and generated extensions that add tools, event sources, and context. The External SDK connects local programs to the same timeline.
- **Your own models and data.** Choose a model, configure an API key or custom connection, manage Memory, extensions, and history, and optionally set a shared web password, all from web settings.

Terminal processes persist across conversation turns, but not service restarts. Skills provide instructions and necessary scripts; dependencies such as browsers and OCR are prepared on demand. Attachment handling depends on the model and tools. [On-demand tools →](docs/development/runtime-tools.md)

## Quick start

Requires Git, **Node.js 24.19.0–24.x**, **pnpm 11.28.4**, and local PostgreSQL. CI uses Node 24.21.0 and PostgreSQL 18.6. Building PTY support on Linux also requires Python 3, make, and a C++ compiler. Terminal support is available on Linux/macOS.

Before installing, make sure this is a trusted personal environment: Shell and extensions run with the host account's permissions, without a product-level sandbox.

Follow the [local installation guide](docs/development/local-web.md) to create a dedicated `mira` database and user and configure database authentication. Then run:

```sh
git clone https://github.com/contrueCT/mira.git
cd mira
pnpm install --frozen-lockfile --ignore-scripts
pnpm terminal:prepare

# Configure database authentication as documented; keep passwords out of the repository and connection URL
MIRA_DATABASE_URL=postgres://mira@127.0.0.1:5432/mira pnpm start
```

Open `http://127.0.0.1:3210`, choose a model and save your API key in the settings at the top right, then send a message. A new database starts with an empty timeline; it does not load the demo conversation shown in the screenshot.

- [Full installation, startup, and troubleshooting](docs/development/local-web.md)
- [Model catalog, custom connections, and reasoning levels](docs/development/models.md)
- [An isolated simulation environment with no model calls](docs/development/local-web.md#4-手动模拟与日常数据分开)

## Inside Mira

A TypeScript monorepo with React/Vite and Fastify for the web interface, Pi for the runtime, PostgreSQL for persistence, and Cordis for extension lifecycle management.

| Path | Responsibility |
| --- | --- |
| `apps/web`, `apps/server` | Chat UI, settings, API, and startup assembly |
| `packages/life`, `packages/context` | Events, wake queue, single main cognition loop, and continuous context |
| `packages/cognition`, `packages/runtime-pi` | Runtime contracts, model execution, and compaction |
| `packages/persistence`, `packages/workspace` | PostgreSQL history, ordinary memory files, and Memory Git |
| `packages/extension-sdk`, `packages/extension-host` | Extension contracts and lifecycle |
| `packages/external-sdk` | Integration with local external programs |
| `tests`, `docs` | Regression tests, designs, decisions, and acceptance records |

- [Architecture overview](docs/architecture.md) · [Full design v0.5](docs/design/architecture-v0.5.md) · [Actual System Prompt v0.2](packages/runtime-pi/prompts/mira-system-v0.2.md)
- [Extension development](packages/extension-host/README.md) · [External SDK](packages/external-sdk/README.md)
- [Toolchain and check commands](docs/development/toolchain.md) · [Testing guide](docs/development/local-web.md#5-自动化测试)
- [Development constraints](docs/development/rules.md) · [Contributor guidance](AGENTS.md) · [Decision records](docs/adr/README.md)

## License

Mira's original code is licensed under the [MIT License](LICENSE). Bundled third-party content retains its own licenses, unaffected by the root license: [OpenAI document](skills/doc/LICENSE.txt), [PDF](skills/pdf/LICENSE.txt), and [transcription Skills](skills/transcribe/LICENSE.txt), [agent-browser](skills/agent-browser/LICENSE), and [extension-authoring skill references](skills/mira-extension-authoring/LICENSE.deepseek). See the [upstream manifest](skills/upstream-sources.json) for sources and modifications. Dependencies remain under their respective licenses.

## Acknowledgments

- [Pi](https://github.com/earendil-works/pi) provides the model runtime, tools, and context-compaction foundations used by Mira.
- [OpenAI Codex](https://github.com/openai/codex), whose feature implementations Mira used as references.
