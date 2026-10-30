# omo-where

English | [한국어](README.ko.md)

An OMO/Senpi TUI extension. Type `/where` and an overlay lists every place the harness looked for prompt pieces, skills, extensions, rules, templates, themes, MCP servers, hooks, memory and settings. Each row says whether that place was loaded, missing, shadowed, disabled or broken, and whether the running session still matches the disk.

## What you see

Left column: categories; a number appears only when some rows need attention. At the top of the right column, the bold line says what the category is and the dim line how it is judged. Below them every candidate follows in harness priority order. A folder the harness searched is an unnumbered line, what it found inside follows by name, and each group has a blank line before and after it. Numbers count only the entries themselves. Rows in use show just their name; every other row gets its status word (table below) after the name, or only its reason when the reason already says the status, like `폴더 없음`. The line under the rule spells out the selected row's full path and reason. A real capture at 80 columns (skills, middle rows cut):

```
where · 문제 4개 · 사용 136 · 없음 38 · 밀림 3 · 꺼짐 20

 시스템 프롬프트      │ 모델이 필요할 때 읽는 SKILL.md · 이름과 설명만 시스템 …
 지침 파일            │ 같은 이름이면 먼저 찾은 쪽이 이김
 스킬               1 │
 확장               3 │ ./.omo/skills  폴더 없음
 규칙                 │ ./.agents/skills  폴더 없음
 프롬프트 템플릿      │ ./.pi/skills  폴더 없음
 테마                 │
 MCP                  │ ~/.omo/agent/skills  전역
 훅                   │    1. orca-cli
 메모리               │    2. omomeow
 설정                 │
                      │ ~/.agents/skills  전역
                      │    3. visual-board
                      │    4. orchestration
                      │    5. orca-cli  링크 · 같은 파일(링크)로 이미 들어옴
                      │    6. find-skills
                      │    7. dori-mode
────────────────────────────────────────────────────────────────────────────────
./.omo/skills · 폴더 없음
Enter 열기 · w 이긴 쪽 · e 편집 · f 문제만 · r 다시 읽기 · q 닫기
```

Enter opens a row in a read-only viewer. Its footer reads `↑↓ PgUp/PgDn 스크롤 · e 편집 · Esc 뒤로`.

## Install

```sh
omo install git:github.com/yjacket/omo-where
```

Update every git-installed extension with `omo update --extensions`, or just this one with `omo update --extension git:github.com/yjacket/omo-where`. Running sessions pick up the change after `/reload` or in a new session.

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

Categories, in this order:

| Category | Meaning |
|---|---|
| 시스템 프롬프트 | The whole prompt the model got this session, and its pieces; context files and the skill list are merged into it |
| 지침 파일 | AGENTS.md / CLAUDE.md, one per folder, pasted into the system prompt as is |
| 스킬 | SKILL.md files the model reads when needed; only name and description go into the system prompt |
| 확장 | Code that adds commands, tools and UI; loaded at session start |
| 규칙 | Instruction files added during work when their condition matches |
| 프롬프트 템플릿 | Prompt files invoked as /name |
| 테마 | TUI color theme files |
| MCP | MCP server configs the model uses as tools |
| 훅 | Commands that run automatically at set points (hooks.json) |
| 메모리 | Memory files that outlive the session |
| 설정 | Harness settings files and this session's setting values |

| Status | Label | Meaning |
|---|---|---|
| loaded | 사용 | Found and used by the harness |
| missing | 없음 | Searched, nothing there |
| shadowed | 밀림 | Found, but a higher-priority entry won |
| shadowed (link) | 링크 | The same file again through a link; by design, not counted as a problem |
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

Work in a git worktree on a branch and open a pull request against `master`. The default branch only takes changes through a PR whose `test` check passes; direct pushes, force pushes and branch deletion are blocked. The `test` workflow runs on windows-latest, installs omo-ai so the parity tests run against the real engine, and runs `bun run test`.

Run the tests locally:

```sh
bun test
bun test -t "<name substring>"
```

The suite includes parity tests that run the installed harness functions on fixture folders and check the rows against them. Requires Bun >= 1.4. No build step and no npm dependencies.

To try a working copy in omo, install it from its path (`omo install <path-to-clone>`) or run `.\install.ps1` / `sh install.sh`, which copy `extension/omo-where/` into `<agentDir>/extensions/omo-where`. Both are for development checks only. Switch back to the git install afterwards.

Keep live tests away from your real setup. omo hot-reloads settings in every running session, so point `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and `OMO_CODING_AGENT_DIR` (or `SENPI_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR`) at a temporary folder before starting omo for a test.

`qa/tui-qa.mjs` runs omo in a pseudo-terminal with this extension and `qa/dump-ctx.ts`, follows a JSON step list and saves `.png`, `.ansi` and `.txt` captures through xterm.js in headless Chrome:

```sh
bun qa/tui-qa.mjs --cwd <dir> --cols 150 --rows 45 --steps qa/steps/smoke.json --out .omo/evidence/smoke
```

Steps: `wait`, `waitNew` (only output after the last keypress), `idle`, `send`, `shot`, `mark`, `rm`. Type a slash command, `waitNew` for its autocomplete line, then send Enter; an early Enter can reach the agent as a prompt. Captures under `.omo/` are scratch and don't get committed.

## License

MIT. See [LICENSE](LICENSE).
