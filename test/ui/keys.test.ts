import { describe, expect, test } from "bun:test";
import type { Category, CategoryId, Probe, Report } from "../../extension/omo-where/model.ts";
import { decodeKey, type KeyName, reduce } from "../../extension/omo-where/ui/keys.ts";
import type { ViewState } from "../../extension/omo-where/ui/state.ts";

function probe(over: Partial<Probe> & { id: string; path: string; kind: Probe["kind"] }): Probe {
	return { rank: 1, status: "loaded", reason: "reason", ...over };
}

const CATEGORY_PROBES: readonly Probe[] = [
	probe({ id: "a", path: "C:/x/a.md", kind: "file" }),
	probe({ id: "b", path: "C:/x/b.md", kind: "file", status: "shadowed", winner: "C:/x/winner.md" }),
	probe({ id: "winner", path: "C:/x/winner.md", kind: "file" }),
	probe({ id: "gone", path: "C:/x/gone.md", kind: "file", status: "missing" }),
	probe({ id: "dir", path: "C:/x/somedir", kind: "dir" }),
	probe({ id: "virt", path: "system-prompt", kind: "virtual" }),
	probe({ id: "runtime", path: "C:/Users/me/.omo/agent/runtime/ext/x.ts", kind: "file" }),
	probe({ id: "omoai", path: "C:/Users/me/proj/node_modules/omo-ai/dist/x.js", kind: "file" }),
	probe({ id: "boom", path: "C:/x/boom.md", kind: "file", status: "error" }),
	probe({ id: "warn", path: "C:/x/warn.md", kind: "file", problem: "문제 있음" }),
];

function category(id: CategoryId, probes: readonly Probe[]): Category {
	return { id, label: id, probes };
}

function report(categories: readonly Category[] = [category("prompt", CATEGORY_PROBES), category("skills", [probe({ id: "s", path: "C:/x/s.md", kind: "file" })])]): Report {
	return { cwd: "C:/x", agentDir: "C:/x/agent", categories, notices: [] };
}

function rows(): ViewState {
	return { cat: 0, row: 0, pane: "rows", problemsOnly: false };
}

function viewer(over: Partial<ViewState> = {}): ViewState {
	return {
		cat: 0,
		row: 1,
		pane: "viewer",
		problemsOnly: false,
		openedPath: "C:/x/a.md",
		viewer: { title: "a.md", lines: ["one", "two", "three", "four", "five"], offset: 0 },
		...over,
	};
}

describe("decodeKey", () => {
	test("decode: each raw sequence maps to its KeyName", () => {
		const table: readonly (readonly [string, KeyName])[] = [
			["\x1b[A", "up"],
			["\x1b[B", "down"],
			["\x1b[C", "right"],
			["\x1b[D", "left"],
			["\x1bOA", "up"],
			["\x1bOB", "down"],
			["\x1bOC", "right"],
			["\x1bOD", "left"],
			["\t", "tab"],
			["\r", "enter"],
			["\n", "enter"],
			["\x1b", "esc"],
			["\x1b[5~", "pgup"],
			["\x1b[6~", "pgdn"],
			["\x1b[H", "home"],
			["\x1b[1~", "home"],
			["\x1b[F", "end"],
			["\x1b[4~", "end"],
		];
		for (const [raw, expected] of table) expect({ raw, key: decodeKey(raw) }).toEqual({ raw, key: expected });
	});

	test("decode: each letter key maps and unknown input is other", () => {
		for (const letter of ["q", "e", "r", "f", "w", "j", "k"] as const) expect(decodeKey(letter)).toBe(letter);
		expect(decodeKey("z")).toBe("other");
		expect(decodeKey("\x1b[200~")).toBe("other");
	});
});

describe("reduce list panes", () => {
	test("move clamp: up/down stop at the ends of cats and rows", () => {
		const r = report();
		expect(reduce({ ...rows(), row: 0 }, "up", r, 20).state.row).toBe(0);
		expect(reduce({ ...rows(), row: 0 }, "k", r, 20).state.row).toBe(0);
		const last = CATEGORY_PROBES.length - 1;
		expect(reduce({ ...rows(), row: last }, "down", r, 20).state.row).toBe(last);
		expect(reduce({ ...rows(), row: last }, "j", r, 20).state.row).toBe(last);
		expect(reduce({ cat: 0, row: 0, pane: "cats", problemsOnly: false }, "up", r, 20).state.cat).toBe(0);
		expect(reduce({ cat: 1, row: 0, pane: "cats", problemsOnly: false }, "down", r, 20).state.cat).toBe(1);
	});

	test("move clamp: down then enter opens the second probe (happy path)", () => {
		const r = report();
		const moved = reduce(rows(), "down", r, 20);
		expect(moved.state.row).toBe(1);
		const opened = reduce(moved.state, "enter", r, 20);
		expect(opened.effect).toEqual({ kind: "open", probe: CATEGORY_PROBES[1] });
	});

	test("tab switch: left/right/tab move between cats and rows, enter on cats goes to rows", () => {
		const r = report();
		expect(reduce(rows(), "tab", r, 20).state.pane).toBe("cats");
		expect(reduce(rows(), "left", r, 20).state.pane).toBe("cats");
		expect(reduce({ ...rows(), pane: "cats" }, "tab", r, 20).state.pane).toBe("rows");
		expect(reduce({ ...rows(), pane: "cats" }, "right", r, 20).state.pane).toBe("rows");
		expect(reduce({ ...rows(), pane: "cats" }, "enter", r, 20).state.pane).toBe("rows");
	});

	test("enter open effect: open carries file/dir/virtual probe unchanged", () => {
		const r = report();
		for (const index of [0, 4, 5]) {
			const result = reduce({ ...rows(), row: index }, "enter", r, 20);
			expect(result.effect).toEqual({ kind: "open", probe: CATEGORY_PROBES[index] });
		}
	});

	test("esc back then close: esc leaves the viewer for rows, the next esc closes", () => {
		const r = report();
		const back = reduce(viewer(), "esc", r, 20);
		expect(back.state.pane).toBe("rows");
		expect(back.effect).toBeUndefined();
		const closed = reduce(back.state, "esc", r, 20);
		expect(closed.effect).toEqual({ kind: "close" });
		expect(reduce(rows(), "esc", r, 20).effect).toEqual({ kind: "close" });
	});

	test("q close: q closes from cats, rows and viewer", () => {
		const r = report();
		for (const pane of ["cats", "rows", "viewer"] as const) {
			const state = pane === "viewer" ? viewer() : { ...rows(), pane };
			expect(reduce(state, "q", r, 20).effect).toEqual({ kind: "close" });
		}
	});

	test("f filter clamp: toggle keeps only problems and clamps the row", () => {
		const r = report();
		const result = reduce({ ...rows(), row: 5 }, "f", r, 20);
		expect(result.state.problemsOnly).toBe(true);
		expect(result.state.row).toBe(1); // only "boom" (error) and "warn" (problem) remain
		const back = reduce(result.state, "f", r, 20);
		expect(back.state.problemsOnly).toBe(false);
		expect(back.state.row).toBe(1);
	});

	test("w jumps to winner: shadowed row selects the same-category winner", () => {
		const r = report();
		const result = reduce({ ...rows(), row: 1 }, "w", r, 20);
		expect(result.state.row).toBe(2);
		expect(result.state.hint).toBeUndefined();
	});

	test("w jumps to winner: missing winner sets the not-in-list hint", () => {
		const r = report([category("prompt", [probe({ id: "b", path: "C:/x/b.md", kind: "file", status: "shadowed", winner: "C:/x/winner.md" })])]);
		const result = reduce(rows(), "w", r, 20);
		expect(result.state.row).toBe(0);
		expect(result.state.hint).toBe("이긴 파일이 목록에 없음");
	});

	test("e refused for missing/dir/runtime/omo-ai paths with hints", () => {
		const r = report();
		const missing = reduce({ ...rows(), row: 3 }, "e", r, 20);
		expect(missing.effect).toBeUndefined();
		expect(missing.state.hint).toBe("파일만 열 수 있음");
		const dir = reduce({ ...rows(), row: 4 }, "e", r, 20);
		expect(dir.effect).toBeUndefined();
		expect(dir.state.hint).toBe("파일만 열 수 있음");
		const virt = reduce({ ...rows(), row: 5 }, "e", r, 20);
		expect(virt.effect).toBeUndefined();
		expect(virt.state.hint).toBe("파일만 열 수 있음");
		const runtime = reduce({ ...rows(), row: 6 }, "e", r, 20);
		expect(runtime.effect).toBeUndefined();
		expect(runtime.state.hint).toBe("업데이트 때 덮어써지는 파일이라 편집 안 함");
		const omoai = reduce({ ...rows(), row: 7 }, "e", r, 20);
		expect(omoai.effect).toBeUndefined();
		expect(omoai.state.hint).toBe("업데이트 때 덮어써지는 파일이라 편집 안 함");
		const allowed = reduce({ ...rows(), row: 0 }, "e", r, 20);
		expect(allowed.effect).toEqual({ kind: "edit", path: "C:/x/a.md" });
		expect(allowed.state.hint).toBeUndefined();
	});

	test("r rescan: r requests a rescan from list panes and the viewer", () => {
		const r = report();
		expect(reduce(rows(), "r", r, 20).effect).toEqual({ kind: "rescan" });
		expect(reduce({ ...rows(), pane: "cats" }, "r", r, 20).effect).toEqual({ kind: "rescan" });
		expect(reduce(viewer(), "r", r, 20).effect).toEqual({ kind: "rescan" });
	});
});

describe("reduce viewer pane", () => {
	test("viewer scroll bounds: up/down/pgup/pgdn/home/end stay inside the lines", () => {
		const r = report();
		const atTop = reduce(viewer({ viewer: { title: "a.md", lines: ["one", "two", "three", "four", "five"], offset: 0 } }), "up", r, 20);
		expect(atTop.state.viewer?.offset).toBe(0);
		let down = viewer();
		for (let i = 0; i < 7; i += 1) down = reduce(down, "down", r, 20).state;
		expect(down.viewer?.offset).toBe(4);
		expect(reduce(down, "j", r, 20).state.viewer?.offset).toBe(4);
		const paged = reduce(viewer(), "pgdn", r, 6);
		expect(paged.state.viewer?.offset).toBe(3);
		expect(reduce(viewer(), "end", r, 20).state.viewer?.offset).toBe(4);
		expect(reduce(viewer({ viewer: { title: "a.md", lines: ["one", "two", "three", "four", "five"], offset: 3 } }), "home", r, 20).state.viewer?.offset).toBe(0);
		expect(reduce(viewer({ viewer: { title: "a.md", lines: ["one", "two", "three", "four", "five"], offset: 0 } }), "pgup", r, 6).state.viewer?.offset).toBe(0);
	});

	test("viewer edit: e edits the opened file and refuses runtime paths", () => {
		const r = report();
		const allowed = reduce(viewer({ openedPath: "C:/x/a.md" }), "e", r, 20);
		expect(allowed.effect).toEqual({ kind: "edit", path: "C:/x/a.md" });
		const runtime = reduce(viewer({ openedPath: "C:/Users/me/.omo/agent/runtime/ext/x.ts" }), "e", r, 20);
		expect(runtime.effect).toBeUndefined();
		expect(runtime.state.hint).toBe("업데이트 때 덮어써지는 파일이라 편집 안 함");
		const virtual = reduce(viewer({ openedPath: "system-prompt" }), "e", r, 20);
		expect(virtual.effect).toBeUndefined();
		expect(virtual.state.hint).toBe("파일만 열 수 있음");
	});
});
