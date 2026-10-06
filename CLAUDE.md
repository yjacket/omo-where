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

`bun qa/tui-qa.mjs --cwd <dir> --cols 150 --rows 45 --steps <steps.json> --out .omo/evidence/<name>` starts omo in a pseudo-terminal with this extension and `qa/dump-ctx.ts` (`/where-dump` writes the live ctx to `<out>/ctx.json`), runs the steps and saves `.png`/`.ansi`/`.txt` per `shot` through xterm.js in headless Chrome. It kills omo and Chrome and removes the Chrome profile on exit.

- Type a slash command, `waitNew` for its autocomplete description, then send `\r`. An early Enter can go to the agent as a prompt.
- After each key use `{"idle": 350}`; idle counts from the keypress.
- Check: `/where` opens, ↑↓←→ Enter Esc q work, every category renders, `w` jumps to the winner, `e` with `--editor "bun qa/fake-editor.mjs"` logs the path and leaves the file unchanged, no `TypeError`/`stale extension generation` text in any `.ansi`.
- omo itself rewrites `tipsHistory` in settings.json on every start; compare settings hashes around the /where code path, not around a whole omo session.
- Deleting resource files mid-session triggers omo's own reload, which closes the overlay.

## Commits

Prefix every commit with `where:`.

## After an OMO update

Run `bun test` (including the parity test) and the `qa/tui-qa.mjs` smoke (`qa/steps/smoke.json`), then open `/where` in a live session. Fix the candidate tables or rules/MCP mirroring where parity fails, then update the tested versions in both READMEs.
