# omo-where

English | [한국어](README.ko.md)

An OMO/Senpi TUI extension. Type `/where` and an overlay lists every place the harness looked for prompt pieces, skills, extensions, rules, templates, themes, MCP servers, hooks, memory and settings. Each row says whether that place was loaded, missing, shadowed, disabled or broken, and whether the running session still matches the disk.

## What you see

Left column: categories. Right column: every candidate path in harness priority order. At about 100 columns it looks like this:

```
 omo-where  C:\dev\proj  (agentDir C:\Users\me\.omo\agent)
 ─────────────────────────────────────────────────────────────────────────────────────────────
 시스템 프롬프트 1 │ #  상태    범위      경로
 지침 파일      3  │ 1  들어옴  전역      C:\Users\me\.omo\agent\AGENTS.md
 스킬          12  │ 2  들어옴  상위 폴더 C:\dev\AGENTS.md
 확장           4  │ 3  없음    프로젝트  C:\dev\proj\AGENTS.md
 규칙           2  │ 4  밀림    프로젝트  C:\dev\proj\CLAUDE.md  (이긴 쪽: AGENTS.md)
 프롬프트 템플릿 0 │ 5  들어옴  세션에만  C:\dev\proj\.omo\notes.md
 테마           1  │
 MCP            3  │
 훅             0  │
 메모리         1  │
 설정           9  │
 ─────────────────────────────────────────────────────────────────────────────────────────────
 ↑↓ 이동 · ←→ 칸 · Enter 열기 · w 이긴 쪽 · e 편집 · f 문제만 · r 다시 읽기 · q 닫기
```

Enter opens a row in a read-only viewer. Its footer reads `↑↓ PgUp/PgDn 스크롤 · e 편집 · Esc 뒤로`.

## Install

From a clone:

```powershell
.\install.ps1
```

```sh
sh install.sh
```

Then type `/reload` in a running session. The scripts copy `extension/omo-where/` into `<agentDir>/extensions/omo-where`, where agentDir is the first set of `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR`, else `~/.omo/agent`. They copy to a `omo-where.tmp-<pid>` folder first, remove the old copy, then rename, so hot reload never sees half a tree. Nothing is downloaded.

## Keys

List mode footer:

```
↑↓ 이동 · ←→ 칸 · Enter 열기 · w 이긴 쪽 · e 편집 · f 문제만 · r 다시 읽기 · q 닫기
```

Viewer footer:

```
↑↓ PgUp/PgDn 스크롤 · e 편집 · Esc 뒤로
```

`w` jumps to the row that beat a shadowed row. `f` keeps only rows that need attention. `r` probes the disk again.

## Categories and statuses

Categories, in order: 시스템 프롬프트, 지침 파일, 스킬, 확장, 규칙, 프롬프트 템플릿, 테마, MCP, 훅, 메모리, 설정.

| Status | Label | Meaning |
|---|---|---|
| loaded | 들어옴 | Found and used by the harness |
| missing | 없음 | Searched, nothing there |
| shadowed | 밀림 | Found, but a higher-priority entry won |
| disabled | 꺼짐 | Found, turned off by settings |
| error | 오류 | Found, failed to load or parse |

| Live mark | Label | Problem text |
|---|---|---|
| session-only | 세션에만 | 세션에는 있지만 지금 디스크에 없음 - 지운 뒤 /reload 안 함? |
| disk-only | 디스크에만 | 세션 시작 뒤 생김 - /reload 해야 들어옴 |
| changed | 바뀜 | 세션 시작 뒤 내용이 바뀜 - /reload 해야 적용 |

## How it decides

omo-where asks the harness first. It calls the host's own functions (package resolution, skill loading, context file loading, frontmatter parsing) and compares their answer with the live session: loaded context files, skills, extension paths, system prompt, MCP servers and hook sources. Where the host has no function to call, it walks candidate tables that copy the harness search order. Rules and MCP shadowing are mirrored from the harness logic, so an update can move them out of step.

## Safety

- It never writes to your files and never triggers a reload.
- Settings are read through a read-only storage. `SettingsManager.create` is never called, since it can rewrite settings files.
- Package resolution always skips missing packages. Nothing gets installed.
- Editing goes through your external editor only. It's refused while the agent works (`에이전트가 일하는 중에는 편집 안 함`) and for runtime or omo-ai files that updates overwrite (`업데이트 때 덮어써지는 파일이라 편집 안 함`). Virtual rows show `파일만 열 수 있음`.
- Secrets in JSON views and settings rows show as `<가림>`.

## Limitations

Tested with @code-yeongyu/senpi 2026.10.10 and omo-ai 5.1.17 on Windows 11 with Bun 1.4.2. It reads harness internals, so an update may change what it sees. Missing internals degrade to fewer rows, not a crash.

## Development

```sh
bun test
```

The suite includes a parity test that checks the candidate tables against the installed harness. `qa/tui-qa.mjs` drives a live TUI smoke check. Requires Bun >= 1.4. No build step and no npm dependencies.
