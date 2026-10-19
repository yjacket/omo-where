import { afterEach, describe, expect, test } from "bun:test";
import { LINK_LABEL, LIVE_LABEL, STATUS_LABEL, summaryLine, type Category, type Probe, type Report } from "../../extension/omo-where/model.ts";
import { renderPanes, type PaneTheme, type ViewerLines } from "../../extension/omo-where/ui/panes.ts";
import type { ViewerState, ViewState } from "../../extension/omo-where/ui/state.ts";
import { makeTree, type Tree } from "../helpers/tree.ts";

let tree: Tree | undefined;

afterEach(() => {
	tree?.cleanup();
	tree = undefined;
});

const widthOf = (text: string): number => (globalThis as { Bun: { stringWidth(s: string): number } }).Bun.stringWidth(text);

/** ANSI themes keep the visible width intact, like the real TUI theme does. */
const ANSI: Readonly<Record<string, string>> = { success: "32", warning: "33", error: "31", muted: "90", accent: "36" };

type Spy = { theme: PaneTheme; fgCalls: { color: string; text: string }[]; boldCalls: string[] };

function spyTheme(): Spy {
	const fgCalls: { color: string; text: string }[] = [];
	const boldCalls: string[] = [];
	return {
		fgCalls,
		boldCalls,
		theme: {
			fg(color, text) {
				fgCalls.push({ color, text });
				return `\x1b[${ANSI[color] ?? "0"}m${text}\x1b[0m`;
			},
			bold(text) {
				boldCalls.push(text);
				return `\x1b[1m${text}\x1b[0m`;
			},
		},
	};
}

const plainTheme: PaneTheme = { fg: (_color, text) => text, bold: (text) => text };

type Fixture = {
	report: Report;
	categories: Category[];
	paths: { loaded: string; shadowed: string; disabled: string; error: string; changed: string; cjk: string; skillMd: string };
};

/** Filesystem-backed fixture: paths, cwd and agentDir all come from the tree. */
function buildFixture(): Fixture {
	tree = makeTree({
		"home/.omo/agent": null,
		"home/.claude/skills/claude-skill/SKILL.md": "x",
		"cwd/project/.omo/skills/alpha/SKILL.md": "x",
		"cwd/project/.omo/규칙/한국어 긴 이름 파일.md": "x",
	});
	const root = tree;
	const agentDir = root.path("home/.omo/agent");
	const cwd = root.path("cwd/project");
	const paths = {
		loaded: root.path("cwd/project/.omo/skills/alpha/SKILL.md"),
		shadowed: root.path("home/.claude/skills/claude-skill/SKILL.md"),
		disabled: root.path("cwd/project/.omo/rules/ah.md"),
		error: root.path("cwd/project/.omo/hooks/hook.ts"),
		changed: root.path("cwd/project/.omo/extensions/x.ts"),
		cjk: root.path("cwd/project/.omo/규칙/한국어 긴 이름 파일.md"),
		skillMd: root.path("cwd/project/.omo/skills/alpha/SKILL.md"),
	};
	const skillProbes: Probe[] = [
		{ id: "a", rank: 1, path: paths.loaded, kind: "file", status: "loaded", reason: "찾음", scope: "프로젝트" },
		{ id: "b", rank: 2, path: paths.shadowed, kind: "file", status: "shadowed", reason: "프로젝트가 이김", winner: paths.loaded, problem: "이름이 겹쳐 밀림" },
		{ id: "c", rank: 3, path: paths.disabled, kind: "file", status: "disabled", reason: "설정에서 끔" },
		{ id: "d", rank: 4, path: paths.error, kind: "file", status: "error", reason: "읽기 실패", problem: "권한 없음" },
		{ id: "e", rank: 5, path: paths.cjk, kind: "file", status: "loaded", reason: "아주 긴 한국어 이유 텍스트가 계속 이어져서 폭을 넘어가는지 확인하는 문장입니다 계속 계속" },
	];
	const categories: Category[] = [
		{ id: "skills", label: "스킬", probes: skillProbes, note: "이름이 겹치면 먼저 온 곳이 이깁니다" },
		{ id: "rules", label: "규칙", probes: [{ id: "r1", rank: 1, path: paths.changed, kind: "file", status: "loaded", reason: "찾음", live: "changed" }], error: "규칙 후보를 읽지 못했습니다" },
		{ id: "extensions", label: "확장", probes: [] },
	];
	const report: Report = { cwd, agentDir, categories, notices: [] };
	return { report, categories, paths };
}

function view(overrides: Partial<ViewState> = {}): ViewState {
	return { cat: 0, row: 0, pane: "rows", problemsOnly: false, ...overrides };
}

function expectShape(lines: string[], width: number, height: number): void {
	expect(lines.length).toBe(height);
	for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(width);
}

describe("renderPanes", () => {
	test("width 80 case: exactly height lines and every line fits 80 cells", () => {
		const { report } = buildFixture();
		expectShape(renderPanes(report, view(), 80, 24, plainTheme), 80, 24);
	});

	test("width 150 case: exactly height lines and every line fits 150 cells", () => {
		const { report } = buildFixture();
		expectShape(renderPanes(report, view(), 150, 40, plainTheme), 150, 40);
	});

	test("header case: line 1 is where · summaryLine(report)", () => {
		const { report } = buildFixture();
		const lines = renderPanes(report, view(), 120, 20, plainTheme);
		expect(lines[0]).toContain("where · ");
		expect(lines[0]).toContain(summaryLine(report));
	});

	test("theme colors case: rows in use carry no status word, 밀림 and 꺼짐 use warning, 오류 uses error", () => {
		const { report } = buildFixture();
		const spy = spyTheme();
		const lines = renderPanes(report, view({ pane: "cats" }), 120, 24, plainTheme);
		renderPanes(report, view({ pane: "cats" }), 120, 24, spy.theme);
		const has = (color: string, needle: string): boolean => spy.fgCalls.some((call) => call.color === color && call.text.includes(needle));
		expect(lines.map(rightOf).find((line) => line.includes("alpha"))).toBe("1. ./.omo/skills/alpha  찾음");
		expect(has("warning", STATUS_LABEL.shadowed)).toBe(true);
		expect(has("warning", STATUS_LABEL.disabled)).toBe(true);
		expect(has("error", STATUS_LABEL.error)).toBe(true);
	});

	test("selected row case: the selected pane row is bold and accent", () => {
		const { report } = buildFixture();
		const spy = spyTheme();
		renderPanes(report, view({ pane: "rows", row: 1 }), 120, 24, spy.theme);
		expect(spy.boldCalls.some((text) => text.includes("claude-skill"))).toBe(true);
		expect(spy.fgCalls.some((call) => call.color === "accent" && call.text.includes("claude-skill"))).toBe(true);
	});

	test("live mark case: a non-match live row shows the live label", () => {
		const { report } = buildFixture();
		const lines = renderPanes(report, view({ cat: 1 }), 120, 24, plainTheme);
		expect(lines.join("\n")).toContain(LIVE_LABEL.changed);
	});

	test("notices case: at most two notices are shown under the title line", () => {
		const { report } = buildFixture();
		const withNotices: Report = { ...report, notices: ["첫 알림", "둘째 알림", "셋째 알림"] };
		const lines = renderPanes(withNotices, view(), 120, 24, plainTheme);
		const text = lines.join("\n");
		expect(lines[1]).toContain("첫 알림");
		expect(lines[2]).toContain("둘째 알림");
		expect(text).not.toContain("셋째 알림");
	});

	test("hint case: state.hint replaces the detail line above the footer", () => {
		const { report } = buildFixture();
		const lines = renderPanes(report, view({ hint: "힌트: 저장하지 못했습니다" }), 120, 24, plainTheme);
		expect(lines[22]).toContain("힌트: 저장하지 못했습니다");
	});

	test("detail case: the detail line shows the selected row's problem and winner", () => {
		const { report } = buildFixture();
		const lines = renderPanes(report, view({ row: 1 }), 200, 24, plainTheme);
		expect(lines[22]).toContain("~/.claude/skills/claude-skill · 밀림 · 프로젝트가 이김");
		expect(lines[22]).toContain("문제: 이름이 겹쳐 밀림");
		expect(lines[22]).toContain("이긴 쪽:");
	});

	test("problemsOnly case: the right pane filters but the left counts stay", () => {
		const { report } = buildFixture();
		const all = renderPanes(report, view(), 120, 24, plainTheme);
		const filtered = renderPanes(report, view({ problemsOnly: true }), 120, 24, plainTheme);
		const rightPane = (lines: string[]): string => lines.slice(1, -2).map((line) => line.split("│")[1] ?? "").join("\n");
		expect(rightPane(filtered)).toContain(STATUS_LABEL.shadowed);
		expect(rightPane(filtered)).toContain(STATUS_LABEL.error);
		expect(rightPane(filtered)).not.toContain("alpha");
		expect(rightPane(all)).toContain("alpha");
		expect(all[2]).toMatch(/스킬 +2 │/);
		expect(filtered[2]).toMatch(/스킬 +2 │/);
	});

	test("category about, note and error case: what the category is comes first, then its note or error, then a blank line", () => {
		const { report } = buildFixture();
		const skills = renderPanes(report, view({ cat: 0 }), 140, 24, plainTheme);
		const rules = renderPanes(report, view({ cat: 1 }), 140, 24, plainTheme);
		expect(rightOf(skills[2])).toBe("모델이 필요할 때 읽는 SKILL.md · 이름과 설명만 시스템 프롬프트에 들어감");
		expect(rightOf(skills[3])).toBe("이름이 겹치면 먼저 온 곳이 이깁니다");
		expect(rightOf(skills[4])).toBe("");
		expect(rightOf(rules[3])).toBe("규칙 후보를 읽지 못했습니다");
	});

	test("CJK path case: wide paths with long Korean reasons stay within width 60", () => {
		const { report } = buildFixture();
		expectShape(renderPanes(report, view(), 60, 20, plainTheme), 60, 20);
	});

	test("skill suffix case: a SKILL.md path drops the /SKILL.md suffix", () => {
		const { report, paths } = buildFixture();
		const text = renderPanes(report, view(), 200, 24, plainTheme).join("\n");
		expect(text).not.toContain("/SKILL.md");
		expect(text).toContain("alpha");
		expect(paths.skillMd).toContain("SKILL.md");
	});

	test("viewer case: renderViewerLines is called with (viewer, width, height - 2) and lines fill the height", () => {
		const { report } = buildFixture();
		const viewer: ViewerState = { title: "보기", lines: ["하나", "둘"], offset: 0 };
		const calls: { viewer: ViewerState; width: number; height: number }[] = [];
		const stub: ViewerLines = (v, w, h) => {
			calls.push({ viewer: v, width: w, height: h });
			return Array.from({ length: h }, (_unused, i) => `보기 줄 ${i}`);
		};
		const lines = renderPanes(report, view({ pane: "viewer", viewer }), 100, 12, plainTheme, stub);
		expect(calls.length).toBe(1);
		expect(calls[0]).toEqual({ viewer, width: 100, height: 10 });
		expectShape(lines, 100, 12);
		expect(lines[11]).toContain("Esc 뒤로");
	});

	test("footer case: viewer mode and list mode use their own footers", () => {
		const { report } = buildFixture();
		const list = renderPanes(report, view(), 120, 24, plainTheme);
		expect(list[23]).toContain("q 닫기");
		const viewer: ViewerState = { title: "보기", lines: [], offset: 0 };
		const lines = renderPanes(report, view({ pane: "viewer", viewer }), 120, 24, plainTheme, () => []);
		expect(lines[23]).toContain("Esc 뒤로");
	});
});

/** A skills-like category: a folder with rows, a missing folder, rows sharing a parent, a virtual row. */
function groupedReport(report: Report): Report {
	const cwd = report.cwd;
	const home = report.agentDir.replace(/[\\/]\.omo[\\/]agent$/, "");
	const probes: Probe[] = [
		{ id: "d", rank: 1, path: `${cwd}/.omo/skills`, kind: "dir", status: "loaded", reason: "폴더 검색", scope: "프로젝트" },
		{ id: "a", rank: 2, path: `${cwd}/.omo/skills/alpha/SKILL.md`, kind: "file", status: "loaded", reason: "스킬" },
		{ id: "b", rank: 3, path: `${cwd}/.omo/skills/beta/SKILL.md`, kind: "file", status: "shadowed", reason: "같은 파일(링크)로 이미 들어옴", linked: true },
		{ id: "m", rank: 4, path: `${cwd}/.pi/skills`, kind: "dir", status: "missing", reason: "폴더 없음" },
		{ id: "p", rank: 5, path: `${home}/.bun/x/skills/one/SKILL.md`, kind: "file", status: "loaded", reason: "스킬", scope: "omo 플러그인" },
		{ id: "q", rank: 6, path: `${home}/.bun/x/skills/two/SKILL.md`, kind: "file", status: "shadowed", reason: "같은 이름이 먼저 들어옴", scope: "omo 플러그인" },
		{ id: "v", rank: 7, path: "builtin:mcp", kind: "virtual", status: "loaded", reason: "내장 확장" },
	];
	const categories: Category[] = [
		{ id: "skills", label: "스킬", probes },
		{ id: "rules", label: "규칙", probes: [{ id: "e", rank: 1, path: "builtin:x", kind: "virtual", status: "error", reason: "읽지 못함" }] },
	];
	return { ...report, categories };
}

const rightOf = (line: string | undefined): string => (line?.split("│")[1] ?? "").replace(/^ /, "").trimEnd();
const leftOf = (line: string | undefined): string => (line?.split("│")[0] ?? "").trim();

test("folder rows: unnumbered folder lines, rows named inside them, implied folder for shared parents, blank lines around groups, no repeated status words", () => {
	const { report } = buildFixture();
	const lines = renderPanes(groupedReport(report), view({ pane: "cats" }), 120, 20, plainTheme);
	expect(lines.slice(4, 15).map(rightOf)).toEqual([
		"./.omo/skills  프로젝트",
		"  1. alpha",
		`  2. beta  ${LINK_LABEL} · 같은 파일(링크)로 이미 들어옴`,
		"",
		"./.pi/skills  폴더 없음",
		"",
		"~/.bun/x/skills  omo 플러그인",
		"  3. one",
		`  4. two  ${STATUS_LABEL.shadowed} · 같은 이름이 먼저 들어옴`,
		"",
		"5. builtin:mcp  내장 확장",
	]);
});

test("missing folders: a missing ancestor holds nothing, and a missing folder line is reused for the rows inside it", () => {
	const { report } = buildFixture();
	const cwd = report.cwd;
	const probes: Probe[] = [
		{ id: "up", rank: 1, path: `${cwd}/a`, kind: "dir", status: "missing", reason: "후보 파일 없음" },
		{ id: "down", rank: 2, path: `${cwd}/a/b`, kind: "dir", status: "missing", reason: "후보 파일 없음" },
		{ id: "cfg", rank: 3, path: `${cwd}/.omo`, kind: "dir", status: "missing", reason: "설정 파일 없음" },
		{ id: "x", rank: 4, path: `${cwd}/.omo/settings.jsonc`, kind: "file", status: "missing", reason: "파일 없음" },
		{ id: "y", rank: 5, path: `${cwd}/.omo/settings.json`, kind: "file", status: "missing", reason: "파일 없음" },
	];
	const settings: Report = { ...report, categories: [{ id: "settings", label: "설정", probes }] };
	const lines = renderPanes(settings, view({ pane: "cats" }), 120, 16, plainTheme);
	expect(lines.slice(4, 10).map(rightOf)).toEqual(["./a  후보 파일 없음", "./a/b  후보 파일 없음", "", "./.omo  설정 파일 없음", "  1. settings.jsonc  파일 없음", "  2. settings.json  파일 없음"]);
});

test("virtual pieces: <root>:<piece> rows sit under their root, file rows after a piece sit under that piece", () => {
	const { report } = buildFixture();
	const probes: Probe[] = [
		{ id: "all", rank: 1, path: "system-prompt", kind: "virtual", status: "loaded", reason: "전체" },
		{ id: "ctx", rank: 2, path: "system-prompt:지침 파일 묶음", kind: "virtual", status: "loaded", reason: "10자" },
		{ id: "f1", rank: 3, path: `${report.cwd}/AGENTS.md`, kind: "file", status: "loaded", reason: "지침 파일" },
		{ id: "sk", rank: 4, path: "system-prompt:스킬 목록", kind: "virtual", status: "loaded", reason: "20자" },
	];
	const prompt: Report = { ...report, categories: [{ id: "prompt", label: "시스템 프롬프트", probes }] };
	const lines = renderPanes(prompt, view({ pane: "cats" }), 120, 14, plainTheme);
	expect(lines.slice(4, 8).map(rightOf)).toEqual(["1. system-prompt  전체", "  2. 지침 파일 묶음  10자", "    3. ./AGENTS.md  지침 파일", "  4. 스킬 목록  20자"]);
});

test("folder rows: the selected probe is highlighted on its own line, folder lines included", () => {
	const { report } = buildFixture();
	const grouped = groupedReport(report);
	const onRow = (row: number): string[] => {
		const spy = spyTheme();
		renderPanes(grouped, view({ pane: "rows", row }), 120, 14, spy.theme);
		return spy.fgCalls.filter((call) => call.color === "accent").map((call) => call.text);
	};
	expect(onRow(4).some((text) => text.includes("3. one"))).toBe(true);
	expect(onRow(3).some((text) => text.includes("./.pi/skills"))).toBe(true);
});

test("left counts: only categories with problems show a number", () => {
	const { report } = buildFixture();
	const lines = renderPanes(groupedReport(report), view({ pane: "cats" }), 120, 14, plainTheme);
	expect(leftOf(lines[2])).toBe("스킬");
	expect(leftOf(lines[3])).toMatch(/^규칙 +1$/);
});

test("narrow widths keep q 닫기 visible in the list footer", () => {
	const { report } = buildFixture();
	for (const width of [80, 60, 40]) {
		const lines = renderPanes(report, view(), width, 24, plainTheme);
		expect(lines[23]).toContain("q 닫기");
		expect(widthOf(lines[23]!)).toBeLessThanOrEqual(width);
	}
});
