# omo-where

English | [한국어](README.ko.md)

An OMO/Senpi TUI extension. Type `/where` and an overlay lists every place the harness looked for prompt pieces, skills, extensions, rules, templates, themes, MCP servers, hooks, memory and settings. Each row says whether that place was loaded, missing, shadowed, disabled or broken, and whether the running session still matches the disk.

## What you see

Left column: categories with their problem count. Right column: every candidate path in harness priority order, with its status and reason. The line above the footer explains the selected row. A real capture at 80 columns (skills, middle rows cut):

```
where · 문제 2개 · 들어옴 134 · 없음 39 · 밀림 2 · 꺼짐 20
시스템 프롬프트 0     │같은 이름이면 먼저 찾은 쪽이 이김
지침 파일 0           │1. 없음 ./.omo/skills · 폴더 없음
스킬 2                │2. 없음 ./.agents/skills · 폴더 없음
확장 0                │3. 없음 ./.pi/skills · 폴더 없음
규칙 0                │4. 들어옴 ~/.omo/agent/skills · 폴더 검색
프롬프트 템플릿 0     │5. 들어옴 ~/.omo/agent/skills/orca-cli · 스킬
테마 0                │6. 들어옴 ~/.omo/agent/skills/omomeow · 스킬
MCP 0                 │7. 들어옴 ~/.agents/skills · 폴더 검색
훅 0                  │8. 들어옴 ~/.agents/skills/visual-board · 스킬
메모리 0              │9. 들어옴 ~/.agents/skills/orchestration · 스킬
설정 0                │10. 밀림 ~/.agents/skills/orca-cli · 같은 파일(링크)로 …
                      │11. 들어옴 ~/.agents/skills/find-skills · 스킬
                      │12. 들어옴 ~/.agents/skills/computer-use · 스킬
                      │13. 꺼짐 ~/.claude/skills · Claude Code 폴더 - omo는 안 …
                      │14. 꺼짐 ~/.pi/agent/skills · 지금 세션은 이 폴더를 안 …

Enter 열기 · w 이긴 쪽 · e 편집 · f 문제만 · r 다시 읽기 · q 닫기
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

`j`/`k` work like ↓/↑. Enter on a category moves to its rows; Esc or `q` closes the overlay, and Esc in the viewer goes back to the list. `w` jumps to the row that beat a shadowed row. `f` keeps only rows that need attention. `r` probes the disk again. In the viewer, Home/End jump to the start or end. On narrow terminals the footer drops the arrow hints first, so `q 닫기` stays visible.

## Categories and statuses

Categories, in order: 시스템 프롬프트, 지침 파일, 스킬, 확장, 규칙, 프롬프트 템플릿, 테마, MCP, 훅, 메모리, 설정.

| Status | Label | Meaning |
|---|---|---|
| loaded | 들어옴 | Found and used by the harness |
| missing | 없음 | Searched, nothing there |
| shadowed | 밀림 | Found, but a higher-priority entry won |
| disabled | 꺼짐 | Found but not read: turned off in settings, an untrusted project, a folder omo does not read (Claude Code, `~/.pi`, `~/.senpi`), or a file that is not an extension entry |
| error | 오류 | Found, failed to load or parse |

| Live mark | Label | Problem text |
|---|---|---|
| session-only | 세션에만 | 세션에는 있지만 지금 디스크에 없음 - 지운 뒤 /reload 안 함? |
| disk-only | 디스크에만 | 세션 시작 뒤 생김 - /reload 해야 들어옴 |
| changed | 바뀜 | 세션 시작 뒤 내용이 바뀜 - /reload 해야 적용 |

## When files change

Adding or deleting a skill, extension or context file makes omo reload by itself a moment later, which closes the overlay. Open `/where` again to see the new state. Until that reload, rows the session still holds show `세션에만` and new files show `디스크에만`.

## How it decides

omo-where asks the harness first. It calls the host's own functions (package resolution, skill loading, context file loading, frontmatter parsing) and compares their answer with the live session: loaded context files, skills, extension paths, system prompt, MCP servers and hook sources. Where the host has no function to call, it walks candidate tables that copy the harness search order. Rules and MCP shadowing are mirrored from the harness logic, so an update can move them out of step.

## Safety

- It never writes to your files and never triggers a reload.
- Settings are read through a read-only storage. `SettingsManager.create` is never called, since it can rewrite settings files.
- Package resolution always skips missing packages. Nothing gets installed.
- Editing goes through your external editor only. It's refused while the agent works (`에이전트가 일하는 중에는 편집 안 함`) and for runtime or omo-ai files that updates overwrite (`업데이트 때 덮어써지는 파일이라 편집 안 함`). Virtual rows show `파일만 열 수 있음`.
- Secrets in JSON views and settings rows show as `<가림>`.

## Limitations

Tested with @code-yeongyu/senpi 2026.10.10 and omo-ai 5.1.19 on Windows 11 with Bun 1.4.2. It reads harness internals, so an update may change what it sees. A missing internal shows a notice and falls back to the live session and folder checks instead of crashing.

The 시스템 프롬프트 category shows the session's base prompt. Text that omo adds on each turn (memory, rule notices) may not be in it, so the memory category finds the memory folder from the session's skill paths or the folder name.

## Development

```sh
bun test
```

The suite includes parity tests that run the installed harness functions on fixture folders and check the rows against them. Requires Bun >= 1.4. No build step and no npm dependencies.

`qa/tui-qa.mjs` runs omo in a pseudo-terminal with this extension and `qa/dump-ctx.ts`, follows a JSON step list and saves `.png`, `.ansi` and `.txt` captures through xterm.js in headless Chrome:

```sh
bun qa/tui-qa.mjs --cwd <dir> --cols 150 --rows 45 --steps qa/steps/smoke.json --out .omo/evidence/smoke
```

Steps: `wait`, `waitNew` (only output after the last keypress), `idle`, `send`, `shot`, `mark`, `rm`. Type a slash command, `waitNew` for its autocomplete line, then send Enter; an early Enter can reach the agent as a prompt.

## License

MIT. See [LICENSE](LICENSE).
