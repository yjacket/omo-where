import { expect, test } from "bun:test";
import { filterProblems, problemCount, samePath, summaryLine, builtinId, isSyntheticPath, type Category, type Report } from "../extension/omo-where/model.ts";

const cat = (id: Category["id"], probes: Category["probes"], error?: string): Category => ({ id, label: id, probes, ...(error ? { error } : {}) });

test("samePath treats separators, file URLs and drive case alike on win32", () => {
	if (process.platform !== "win32") return;
	expect(samePath("C:/x/y", "c:\\x\\y")).toBe(true);
	expect(samePath("file:///C:/x/y", "C:/x/y")).toBe(true);
	expect(samePath("C:/x/y", "C:/x/z")).toBe(false);
});

test("samePath matches identical posix-style paths", () => {
	expect(samePath("/tmp/a/../a/b", "/tmp/a/b")).toBe(true);
});

test("problem counting, filtering and the summary line", () => {
	const r: Report = {
		cwd: "c", agentDir: "a", notices: [],
		categories: [
			cat("context", [
				{ id: "1", rank: 1, path: "p1", kind: "file", status: "loaded", reason: "r" },
				{ id: "2", rank: 2, path: "p2", kind: "file", status: "shadowed", reason: "r", problem: "x" },
			]),
			cat("skills", [{ id: "3", rank: 1, path: "p3", kind: "dir", status: "missing", reason: "r" }], "boom"),
		],
	};
	expect(problemCount(r.categories[0]!)).toBe(1);
	expect(problemCount(r.categories[1]!)).toBe(1);
	expect(filterProblems(r.categories[0]!).probes.map((p) => p.id)).toEqual(["2"]);
	expect(summaryLine(r)).toBe("문제 2개 · 들어옴 1 · 없음 1 · 밀림 1 · 꺼짐 0");
});

test("builtin and synthetic extension paths", () => {
	expect(builtinId("<builtin:mcp>")).toBe("mcp");
	expect(builtinId("builtin:rules")).toBe("rules");
	expect(builtinId("<inline>")).toBeUndefined();
	expect(builtinId("C:/a.ts")).toBeUndefined();
	expect(isSyntheticPath("<inline>")).toBe(true);
	expect(isSyntheticPath("C:/a.ts")).toBe(false);
});
