import { afterEach, describe, expect, test } from "bun:test";
import type { ViewerState } from "../../extension/omo-where/ui/state.ts";
import { clampOffset, loadViewerText, renderViewer, viewerFromText } from "../../extension/omo-where/ui/viewer.ts";
import { makeTree, type Tree } from "../helpers/tree.ts";

type BunTextApi = { readonly stringWidth: (text: string) => number };
/** Display-column width through the same Bun primitive the renderer uses (CJK = 2). */
const width = (text: string): number => (globalThis as unknown as { readonly Bun: BunTextApi }).Bun.stringWidth(text);

const trees: Tree[] = [];
afterEach(() => {
	while (trees.length > 0) {
		const fixture = trees.pop();
		if (fixture !== undefined) fixture.cleanup();
	}
});
function tree(spec: Record<string, string | null>): Tree {
	const fixture = makeTree(spec);
	trees.push(fixture);
	return fixture;
}
function linesText(fixture: { lines: readonly string[] }): string {
	return fixture.lines.join("\n");
}
function stateOf(fixture: { title: string; lines: readonly string[]; notice?: string }, offset: number): ViewerState {
	return { title: fixture.title, lines: fixture.lines, notice: fixture.notice, offset };
}

describe("loadViewerText", () => {
	test("acceptance: missing path -> 파일 없음 notice, no lines", () => {
		const fixture = tree({ "keep.txt": "x" });
		const loaded = loadViewerText(fixture.path("gone.txt"));

		expect(loaded.notice).toBe("파일 없음");
		expect(loaded.lines).toEqual([]);
		expect(loaded.title.endsWith("gone.txt")).toBe(true);
	});

	test("acceptance: directory listing -> sorted entries, dirs suffixed /", () => {
		const fixture = tree({ "dir/b.txt": "b", "dir/a.txt": "a", "dir/sub": null, "dir/.hidden": "h" });
		const loaded = loadViewerText(fixture.path("dir"));

		expect(loaded.lines).toEqual([".hidden", "a.txt", "b.txt", "sub/"]);
		expect(loaded.notice).toBeUndefined();
	});

	test("acceptance: truncation notice - file over 512KiB shows 앞 512KiB만 표시", () => {
		const fixture = tree({ "big.txt": "x".repeat(600 * 1024) });
		const loaded = loadViewerText(fixture.path("big.txt"));

		expect(loaded.notice).toBe("앞 512KiB만 표시");
		expect(loaded.lines).toHaveLength(1);
		expect(loaded.lines[0]?.length).toBe(512 * 1024);
	});

	test("acceptance: binary notice - NUL in first 8KiB yields no lines", () => {
		const fixture = tree({ "bin.dat": "abc\u0000def" });
		const loaded = loadViewerText(fixture.path("bin.dat"));

		expect(loaded.notice).toBe("이진 파일이라 표시 안 함");
		expect(loaded.lines).toEqual([]);
	});

	test("acceptance: binary notice - NUL past the first 8KiB is still text", () => {
		const fixture = tree({ "late.dat": `${"a".repeat(9000)}\u0000tail` });
		const loaded = loadViewerText(fixture.path("late.dat"));

		expect(loaded.notice).toBeUndefined();
		expect(loaded.lines).toHaveLength(1);
		expect(loaded.lines[0]?.length).toBe(9005);
	});

	test("acceptance: secret masking in json - SECRET_KEY strings become <가림> with notice", () => {
		const body = JSON.stringify(
			{ theme: "dark", apiKey: "sk-123", nested: { token: "t-9" }, servers: [{ secret: "s-1", name: "keep" }] },
			null,
			2,
		);
		const fixture = tree({ "settings.json": body });
		const loaded = loadViewerText(fixture.path("settings.json"));
		const rendered = linesText(loaded);

		expect(loaded.notice).toBe("비밀 값은 <가림>");
		expect(rendered).not.toContain("sk-123");
		expect(rendered).not.toContain("t-9");
		expect(rendered).not.toContain("s-1");
		expect(rendered).toContain('"apiKey": "<가림>"');
		expect(rendered).toContain('"token": "<가림>"');
		expect(rendered).toContain('"secret": "<가림>"');
		expect(rendered).toContain('"theme": "dark"');
		expect(rendered).toContain('"name": "keep"');
	});

	test("acceptance: secret masking in jsonc - comments and trailing commas parse before masking", () => {
		const body = '{\n\t// comment\n\t"apiKey": "sk-jsonc",\n\t"theme": "dark",\n}\n';
		const fixture = tree({ "settings.jsonc": body });
		const loaded = loadViewerText(fixture.path("settings.jsonc"));

		expect(loaded.notice).toBe("비밀 값은 <가림>");
		expect(linesText(loaded)).not.toContain("sk-jsonc");
		expect(linesText(loaded)).toContain('"apiKey": "<가림>"');
	});

	test("acceptance: non-json files are never masked", () => {
		const fixture = tree({ "notes.txt": "apiKey: sk-plain\n" });
		const loaded = loadViewerText(fixture.path("notes.txt"));

		expect(loaded.notice).toBeUndefined();
		expect(linesText(loaded)).toContain("sk-plain");
	});

	test("acceptance: viewerFromText splits text and masks json titles", () => {
		const plain = viewerFromText("system-prompt", "a\nb\n");
		expect(plain.lines).toEqual(["a", "b"]);
		expect(plain.notice).toBeUndefined();

		const masked = viewerFromText("/tmp/settings.json", '{\n  "apiKey": "sk-x"\n}\n');
		expect(masked.notice).toBe("비밀 값은 <가림>");
		expect(masked.lines.join("\n")).toContain('"apiKey": "<가림>"');
	});
});

describe("clampOffset", () => {
	test("acceptance: clampOffset keeps offset inside [0, total - height]", () => {
		expect(clampOffset(5, 100, 20)).toBe(5);
		expect(clampOffset(95, 100, 20)).toBe(80);
		expect(clampOffset(100, 100, 20)).toBe(80);
		expect(clampOffset(-3, 100, 20)).toBe(0);
		expect(clampOffset(10, 5, 20)).toBe(0);
		expect(clampOffset(0, 0, 20)).toBe(0);
		expect(clampOffset(3.9, 100, 20)).toBe(3);
	});
});

describe("renderViewer", () => {
	test("acceptance: happy - 300-line file at 80x20 renders exactly 20 lines, none wider than 80", () => {
		const fixture = tree({ "log.txt": `${Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n")}\n` });
		const loaded = loadViewerText(fixture.path("log.txt"));
		const out = renderViewer(stateOf(loaded, 0), 80, 20);

		expect(loaded.lines).toHaveLength(300);
		expect(out).toHaveLength(20);
		for (const line of out) expect(width(line)).toBeLessThanOrEqual(80);
		expect(out[0]).toBe(loaded.title);
		expect(out[1]).toContain("1|line 1");
		expect(out[19]).toContain("19|line 19");

		const scrolled = renderViewer(stateOf(loaded, 500), 80, 20);
		expect(scrolled).toHaveLength(20);
		// body height 19 -> clampOffset(500, 300, 19) = 281 -> first visible row is source line 282
		expect(scrolled[1]).toContain("282|line 282");
		expect(scrolled[19]).toContain("300|line 300");
	});

	test("acceptance: header left-truncates a long absolute path with …", () => {
		const fixture = tree({ "deep/nested/dir/structure/readme.txt": "hello\n" });
		const loaded = loadViewerText(fixture.path("deep/nested/dir/structure/readme.txt"));
		const out = renderViewer(stateOf(loaded, 0), 24, 4);

		expect(out[0]?.startsWith("…")).toBe(true);
		expect(out[0]?.endsWith("readme.txt")).toBe(true);
		for (const line of out) expect(width(line)).toBeLessThanOrEqual(24);
		expect(out).toHaveLength(4);
	});

	test("acceptance: binary -> notice shown and no content lines", () => {
		const fixture = tree({ "bin.dat": "abc\u0000def" });
		const loaded = loadViewerText(fixture.path("bin.dat"));
		const out = renderViewer(stateOf(loaded, 0), 40, 6);

		expect(out).toHaveLength(6);
		expect(out[1]).toBe("이진 파일이라 표시 안 함");
		for (const line of out) expect(width(line)).toBeLessThanOrEqual(40);
		expect(out.join("\n")).not.toContain("abc");
	});

	test("acceptance: CJK wrap - wide lines wrap by display columns (CJK = 2)", () => {
		const rendered = renderViewer({ title: "/tmp/cjk.txt", lines: ["가나다라마바사"], offset: 0 }, 12, 8);

		expect(rendered).toHaveLength(8);
		for (const line of rendered) expect(width(line)).toBeLessThanOrEqual(12);
		expect(rendered[1]).toBe("1|가나다라마");
		expect(rendered[2]).toBe("1|바사");
		expect(width(rendered[1] ?? "")).toBe(12);
	});

	test("acceptance: every rendered line is <= width - odd width, ANSI, wide and long words", () => {
		const lines = [
			"x".repeat(200),
			`\u001b[31m${"y".repeat(120)}\u001b[0m`,
			"가나다라마바사아자차카타파하".repeat(3),
			"short",
			"",
		];
		const rendered = renderViewer({ title: "/tmp/mixed.txt", lines, offset: 0 }, 41, 12);

		expect(rendered).toHaveLength(12);
		for (const line of rendered) expect(width(line)).toBeLessThanOrEqual(41);
	});

	test("acceptance: exactly height lines regardless of content and offset", () => {
		expect(renderViewer({ title: "t", lines: ["a", "b", "c"], offset: 0 }, 20, 0)).toEqual([]);
		expect(renderViewer({ title: "t", lines: [], offset: 0 }, 20, 3)).toHaveLength(3);
		expect(renderViewer({ title: "t", lines: ["a"], offset: 999 }, 20, 5)).toHaveLength(5);
		expect(renderViewer({ title: "t", lines: [], offset: 0, notice: "파일 없음" }, 20, 1)).toHaveLength(1);
	});

	test("acceptance: theme.bold styles the header only", () => {
		const rendered = renderViewer(
			{ title: "/tmp/a.txt", lines: ["body"], offset: 0 },
			40,
			4,
			{ bold: (text) => `*${text}*` },
		);

		expect(rendered[0]).toBe("*/tmp/a.txt*");
		expect(rendered[1]).toContain("1|body");
	});
});
