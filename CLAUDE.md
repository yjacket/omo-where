# CLAUDE.md

This file guides Claude Code (claude.ai/code) in this repository.

## What this is

omo-where is an OMO/Senpi TUI extension. `/where` opens an overlay that lists every place the harness searched for prompt pieces, skills, extensions, rules, templates, themes, MCP servers, hooks, memory and settings, with a status and a live-vs-disk mark per row. README.md is the authoritative user-facing spec; README.ko.md mirrors it with the same headings in the same order.

## Modules

- `extension/omo-where/model.ts`: shared contract. Types (Probe, Category, Report, LiveState, SenpiApi, HostData, ProbeEnv), STATUS_LABEL, LIVE_LABEL, LIVE_PROBLEM, SECRET_KEY. Changes need a lead decision.
- `extension/omo-where/host.ts`: feature-detects Senpi functions, builds the read-only settings storage, resolves packages with missing ones skipped.
- `extension/omo-where/probes/`: one prober per category, using host functions first and candidate tables where the host has none.
- `extension/omo-where/ui/`: overlay list and viewer, footers, filtering, secret masking.
- `extension/omo-where/editor.ts`: opens a file in the external editor, with the edit refusals.
- `extension/omo-where/index.ts`: registers `/where` and collects the live session state.

## Invariants

- Never write user files, never trigger a reload.
- Never call `SettingsManager.create`; read settings via `SettingsManager.fromStorage` with a storage whose writes are discarded.
- Package resolution always answers "skip" for missing packages. No installs, no network.
- Feature-detect every Senpi internal; a missing one degrades to fewer rows, never a crash.
- Edit refusals: "에이전트가 일하는 중에는 편집 안 함", "업데이트 때 덮어써지는 파일이라 편집 안 함", "파일만 열 수 있음".
- Mask values whose key matches SECRET_KEY as `<가림>`.
- Category order: 시스템 프롬프트, 지침 파일, 스킬, 확장, 규칙, 프롬프트 템플릿, 테마, MCP, 훅, 메모리, 설정.

## Commands

```sh
bun test
bun test -t "<name substring>"
sh install.sh   |   .\install.ps1
```

Install scripts are local-copy only: agentDir = OMO_CODING_AGENT_DIR > SENPI_CODING_AGENT_DIR > PI_CODING_AGENT_DIR > ~/.omo/agent; copy to `extensions/omo-where.tmp-<pid>`, remove the old folder, rename into place, print `installed -> <dst>`.

## Testing

`bun test` runs unit tests with fakes plus a parity test that compares candidate tables with the installed harness. Tests must not use sleeps. Cover fallbacks for missing internals and unexpected data.

## Live TUI check

Run `node qa/tui-qa.mjs`. It starts omo in a pseudo-terminal, types `/where`, checks both footers, opens a row, and confirms no `TypeError` appears.

## Commits

Prefix every commit with `where:`.

## After an OMO update

Run `bun test` (including the parity test) and the `qa/tui-qa.mjs` smoke. Fix the candidate tables or rules/MCP mirroring where parity fails, then update the tested versions in both READMEs.
