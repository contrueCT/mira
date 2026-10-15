# Delegation-first prompt acceptance

Scope: ADR 0038, main v0.2 delegation guidance and safe published-template upgrade.
No production model/API credentials or paid provider calls are used.

## Deterministic verification

The normal runtime suite checks the actual provider-facing prompt, published
hashes, separate child contract, frozen Memory, compaction, recovery, CAS and lost
commit responses. Native model-effect results below are a separate kind of
evidence; a deterministic fake-provider test does not establish model judgment.

Local `pnpm check` passed 951 foundation/offline tests and 62 web-state tests,
all type/boundary checks and production build. `pnpm terminal:prepare` built the
pinned native PTY dependency with lifecycle scripts disabled. The final wording
revision additionally passed all 30 focused source/prompt/Memory-checkpoint tests.
The initial aggregate run exposed five current-template test fixtures lacking the
new template identity; those fixtures were corrected and the aggregate rerun
passed. No production code validation was loosened to accommodate them.

PostgreSQL/recovery and browser suites are not locally claimed as passed; exact
PR-head CI remains separate evidence. No browser/layout change is included, so
screenshots are not an acceptance requirement.

## Native model-effect probes

The input was captured through `PiDurableRuntime` using its real
`getCurrentSystemPrompt` and `getCurrentTools` projection. It includes the whole
current prompt, synthetic frozen Memory/environment/authorization context and
18 production tool schemas: file/search/shell, persistent terminals, History,
and all five subagent tools. No abbreviated instruction replacement was used.

- Template SHA-256: `a3ea5a98735089138296892ee0c30f47439c044b44a6e9bde0409724cbf22fe1`
- Captured prompt/schema JSON: 53,100 bytes
- Capture SHA-256: `caa9e099352a08030d6b9d5d68d5fc5154a9ed7862d481fe98db3b74bd04571a`

Each scenario is evaluated by a fresh isolated native agent. It reads the complete
capture and produces proposed calls/visible responses only; scenario actions are
not executed. Followup steps in the same scenario receive explicitly synthetic
tool outcomes. These are proxy-model prompt-effect observations, not a test of
the user's configured production model, real external task completion, latency,
or the runtime's concurrent transaction behavior.

### Observed final-revision responses

- Long research: a fresh worker received the complete 12-document comparison,
  evidence/verification requirements, precise output path, scope and main-Memory
  restriction. Exact proposed tool: `subagent_spawn`, `fork: "none"`, title
  `比较向量数据库评测`. Visible text began “可以，我们边做边聊。” It did not
  execute the research itself or repeatedly wait, and said it would review the
  conclusions and sources after the worker returned.
- Mid-task user addition: after a synthetic running-child result, Mira explained
  incomparable measurement conditions immediately and proposed `subagent_send`
  to the same `11111111-1111-4111-8111-111111111111` child. The assignment said
  “请在现有任务和已读 5 份材料的基础上继续，不要重启”, restricted candidates to offline
  deployment and preserved the source/verification requirements. It distinguished
  explanatory examples from actual conflicts not yet established in the files.
- Simple greeting: “早啊。今天的开机重任交给这杯咖啡了。” No tool call or delegation.

- Implementation/dependencies: one `subagent_spawn` with title
  `修复 CSV 重复列名覆盖`, `fork: "none"`, assigned reproduction, diagnosis, minimal
  fix and regression checks in that order. It preserved existing work and the
  user's explicit no-commit/no-push/no-deploy restriction; it did not launch
  dependent phases in parallel.
- Failure: after a synthetic failed completion event, Mira proposed
  `subagent_status` for the exact existing child. After the supplied status
  identified preserved edits and an unknown test outcome, it proposed
  `subagent_send` to that same child with “先检查 git diff、保留的工具证据和现有进程状态”
  and “不要盲目重跑未知结果的命令，也不要猜测句柄”. It did not claim the fix was done
  or restart the whole task.
- Cancellation: the user then requested stopping the repair. Mira proposed
  `subagent_cancel` for the same child. After an explicitly synthetic cancelled
  result, its final response was “已取消后续修复，不再继续改。取消前已启动的操作可能已经完成，
  已有改动未回退。” It made no claim that an in-flight effect was killed or undone.

These three independent scenarios contain eight observed response/tool-decision
steps, including followups within their own scenario. All three final-revision
agents confirmed complete untruncated reading of the prompt and schemas. Earlier
exploratory probes used the superseded wording; their outputs are not counted as
final-revision evidence. No scenario tool was actually executed and no synthetic
result is presented as a completed real research or engineering deliverable.

The captured tool manifest reflects this branch's existing runtime; separate
child/main live-delivery work is outside this acceptance record. Its future
single-tool-boundary delivery must be verified by that change's own runtime tests.

Fresh independent `gpt-6.1-sol` / `max` review completed with no findings. The
reviewer separately passed 61/61 source/prompt/Memory/subagent focused tests and
`git diff --check`. PostgreSQL, browser and production-provider validation were
not performed by that review.

