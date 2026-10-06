import { afterEach, describe, expect, test } from "bun:test";
import { LIVE_LABEL, STATUS_LABEL, summaryLine, type Category, type Probe, type Report } from "../../extension/omo-where/model.ts";
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

	test("theme colors case: 들어옴 uses success, 밀림 and 꺼짐 use warning, 오류 uses error", () => {
		const { report } = buildFixture();
		const spy = spyTheme();
		renderPanes(report, view(), 120, 24, spy.theme);
		const has = (color: string, needle: string): boolean => spy.fgCalls.some((call) => call.color === color && call.text.includes(needle));
		expect(has("success", STATUS_LABEL.loaded)).toBe(true);
		expect(has("warning", STATUS_LABEL.shadowed)).toBe(true);
		expect(has("warning", STATUS_LABEL.disabled)).toBe(true);
		expect(has("error", STATUS_LABEL.error)).toBe(true);
	});

	test("selected row case: the selected pane row is bold and accent", () => {
		const { report } = buildFixture();
		const spy = spyTheme();
		renderPanes(report, view({ pane: "rows", row: 1 }), 120, 24, spy.theme);
		expect(spy.boldCalls.some((text) => text.includes(STATUS_LABEL.shadowed))).toBe(true);
		expect(spy.fgCalls.some((call) => call.color === "accent" && call.text.includes("claude-skill"))).toBe(true);
		expect(spy.fgCalls.some((call) => call.color === "warning" && call.text.includes(STATUS_LABEL.shadowed))).toBe(true);
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
		expect(lines[22]).toContain("문제: 이름이 겹쳐 밀림");
		expect(lines[22]).toContain("이긴 쪽:");
	});

	test("problemsOnly case: the right pane filters but the left counts stay", () => {
		const { report } = buildFixture();
		const all = renderPanes(report, view(), 120, 24, plainTheme);
		const filtered = renderPanes(report, view({ problemsOnly: true }), 120, 24, plainTheme);
		expect(filtered.join("\n")).toContain(STATUS_LABEL.shadowed);
		expect(filtered.join("\n")).toContain(STATUS_LABEL.error);
		expect(filtered.join("\n")).not.toContain(`1. ${STATUS_LABEL.loaded}`);
		expect(all[1]).toContain("스킬 2");
		expect(filtered[1]).toContain("스킬 2");
	});

	test("category note and error case: shown as the first right-pane line", () => {
		const { report } = buildFixture();
		const skills = renderPanes(report, view({ cat: 0 }), 140, 24, plainTheme);
		const rules = renderPanes(report, view({ cat: 1 }), 140, 24, plainTheme);
		expect(skills[1]).toContain("이름이 겹치면 먼저 온 곳이 이깁니다");
		expect(rules[1]).toContain("규칙 후보를 읽지 못했습니다");
	});

	test("CJK path case: wide paths with long Korean reasons stay within width 60", () => {
		const { report } = buildFixture();
		expectShape(renderPanes(report, view(), 60, 20, plainTheme), 60, 20);
	});

	test("skill suffix case: a SKILL.md path drops the /SKILL.md suffix", () => {
		const { report, paths } = buildFixture();
		const text = renderPanes(report, view(), 200, 24, plainTheme).join("\n");
		expect(text).not.toContain("SKILL.md");
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

test("narrow widths keep q 닫기 visible in the list footer", () => {
	const { report } = buildFixture();
	for (const width of [80, 60, 40]) {
		const lines = renderPanes(report, view(), width, 24, plainTheme);
		expect(lines[23]).toContain("q 닫기");
		expect(widthOf(lines[23]!)).toBeLessThanOrEqual(width);
	}
});
