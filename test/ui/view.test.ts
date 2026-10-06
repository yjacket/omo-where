import { afterEach, describe, expect, test } from "bun:test";
import type { Category, CategoryId, Probe, Report } from "../../extension/omo-where/model.ts";
import { WhereView } from "../../extension/omo-where/ui/view.ts";
import { makeTree, type Tree } from "../helpers/tree.ts";

let tree: Tree | undefined;

afterEach(() => {
	tree?.cleanup();
	tree = undefined;
});

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const displayWidth = (text: string): number => (globalThis as unknown as { Bun: { stringWidth(s: string): number } }).Bun.stringWidth(text);

function probe(over: Partial<Probe> & { id: string; path: string; kind: Probe["kind"] }): Probe {
	return { rank: 1, status: "loaded", reason: "찾음", ...over };
}

function category(id: CategoryId, probes: readonly Probe[]): Category {
	return { id, label: id, probes };
}

type Fixture = { report: Report; file: string; missing: string };

/** A real temp tree: category 1 holds an existing file probe and a missing one. */
function fixture(): Fixture {
	tree = makeTree({ "home/.omo/agent": null, "cwd/project/notes.md": "첫 줄\n둘째 줄\n" });
	const root = tree;
	const file = root.path("cwd/project/notes.md");
	const missing = root.path("cwd/project/missing.md");
	const report: Report = {
		cwd: root.path("cwd/project"),
		agentDir: root.path("home/.omo/agent"),
		categories: [
			category("prompt", [probe({ id: "sys", path: "system-prompt", kind: "virtual", text: "# 시스템\n본문\n" })]),
			category("context", [
				probe({ id: "notes", path: file, kind: "file" }),
				probe({ id: "gone", path: missing, kind: "file", status: "missing" }),
			]),
		],
		notices: [],
	};
	return { report, file, missing };
}

type Calls = { close: number; edited: string[]; rescans: number };

function makeView(report: Report, height = 20): { view: WhereView; calls: Calls } {
	const calls: Calls = { close: 0, edited: [], rescans: 0 };
	const view = new WhereView({
		report,
		theme: plainTheme,
		height: () => height,
		onClose: () => {
			calls.close += 1;
		},
		onEdit: (path) => {
			calls.edited.push(path);
		},
		onRescan: () => {
			calls.rescans += 1;
		},
	});
	return { view, calls };
}

/** Down to the context category, tab into its rows, Enter on its first row. */
function openNotes(view: WhereView): void {
	view.handleInput("\x1b[B");
	view.handleInput("\t");
	view.handleInput("\r");
}

describe("WhereView", () => {
	test('acceptance: "\\x1b[B\\t\\r" opens the viewer of a fixture file', () => {
		const { report, file } = fixture();
		const { view } = makeView(report);
		openNotes(view);

		const lines = view.render(200);
		const text = lines.join("\n");
		expect(lines.length).toBe(20);
		expect(text).toContain("Esc 뒤로");
		expect(text).toContain(file);
		expect(text).toContain("첫 줄");
		expect(text).toContain("둘째 줄");
	});

	test("acceptance: Esc returns from the viewer to the row list", () => {
		const { report } = fixture();
		const { view, calls } = makeView(report);
		openNotes(view);
		view.handleInput("\x1b");

		const text = view.render(120).join("\n");
		expect(text).toContain("q 닫기");
		expect(text).not.toContain("Esc 뒤로");
		expect(calls.close).toBe(0);
	});

	test("acceptance: q calls onClose from the list and the viewer", () => {
		const { report } = fixture();
		const list = makeView(report);
		list.view.handleInput("q");
		expect(list.calls.close).toBe(1);

		const viewer = makeView(report);
		openNotes(viewer.view);
		viewer.view.handleInput("q");
		expect(viewer.calls.close).toBe(1);
	});

	test("acceptance: e edits once and a second e is ignored until setReport", () => {
		const { report, file } = fixture();
		const { view, calls } = makeView(report);
		view.handleInput("\x1b[B");
		view.handleInput("\t");
		view.handleInput("e");
		expect(calls.edited).toEqual([file]);

		view.handleInput("e");
		expect(calls.edited).toEqual([file]);

		view.setReport(report);
		view.handleInput("e");
		expect(calls.edited).toEqual([file, file]);
	});

	test("acceptance: r rescans once while busy", () => {
		const { report } = fixture();
		const { view, calls } = makeView(report);
		view.handleInput("r");
		expect(calls.rescans).toBe(1);

		view.handleInput("r");
		expect(calls.rescans).toBe(1);

		view.setReport(report);
		view.handleInput("r");
		expect(calls.rescans).toBe(2);
	});

	test("acceptance: selection is kept by category id and row path after setReport", () => {
		const { report, file, missing } = fixture();
		const { view, calls } = makeView(report);
		view.handleInput("\x1b[B"); // context category
		view.handleInput("\t"); // rows pane, row 0 = notes

		// Same category id, different index; same path, different row.
		const moved: Report = {
			...report,
			categories: [
				category("context", [
					probe({ id: "gone", path: missing, kind: "file", status: "missing" }),
					probe({ id: "notes", path: file, kind: "file" }),
				]),
				category("prompt", [probe({ id: "sys", path: "system-prompt", kind: "virtual" })]),
			],
		};
		view.setReport(moved);

		// If the selection followed the path, e edits the notes file; a stale row 0 would be the missing one.
		view.handleInput("e");
		expect(calls.edited).toEqual([file]);
	});

	test("viewer: a virtual probe opens its in-memory text", () => {
		const { report } = fixture();
		const { view } = makeView(report);
		view.handleInput("\t");
		view.handleInput("\r");

		const text = view.render(120).join("\n");
		expect(text).toContain("system-prompt");
		expect(text).toContain("# 시스템");
		expect(text).toContain("Esc 뒤로");
	});

	test("render: always exactly height lines, never wider than the requested width", () => {
		const { report } = fixture();
		const { view } = makeView(report, 12);
		const lines = view.render(60);
		expect(lines.length).toBe(12);
		for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(60);
	});

	test("setHint: shows the message until the next key clears it", () => {
		const { report } = fixture();
		const { view } = makeView(report);
		view.setHint("편집기를 열 수 없음: notepad");
		expect(view.render(120).join("\n")).toContain("편집기를 열 수 없음: notepad");

		view.handleInput("\x1b[B");
		expect(view.render(120).join("\n")).not.toContain("편집기를 열 수 없음: notepad");
	});

	test("invalidate: leaves a valid, full-height render after scrolling and a resize", () => {
		const { report } = fixture();
		const { view } = makeView(report, 6);
		view.handleInput("\x1b[B");
		view.handleInput("\t");
		view.handleInput("\r");
		view.handleInput("\x1b[6~"); // pgdn
		view.invalidate();

		const lines = view.render(120);
		expect(lines.length).toBe(6);
		expect(lines.join("\n")).toContain("Esc 뒤로");
	});
});
