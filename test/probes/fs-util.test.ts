import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { entryIsDir, entryIsFile, isUnder, makeCollector, slashKey, statKind, statProblem } from "../../extension/omo-where/probes/fs-util.ts";
import { makeTree, type Tree } from "../helpers/tree.ts";

let tree: Tree | undefined;
afterEach(() => {
	tree?.cleanup();
	tree = undefined;
});

describe("fs-util", () => {
	test("isUnder takes (child, parent) and matches only whole path segments", () => {
		expect(isUnder("/a/b/c", "/a/b")).toBe(true);
		expect(isUnder("/a/b", "/a/b/")).toBe(true);
		expect(isUnder("/a/b", "/a/b/c")).toBe(false);
		expect(isUnder("/a/bc", "/a/b")).toBe(false);
		expect(slashKey("C:\\X\\y\\")).toBe(process.platform === "win32" ? "c:/x/y" : "C:/X/y");
	});

	test("statKind tells dir, file and missing apart", () => {
		tree = makeTree({ "d/f.txt": "x" });
		expect(statKind(tree.path("d")).kind).toBe("dir");
		expect(statKind(tree.path("d/f.txt")).kind).toBe("file");
		expect(statKind(tree.path("nope")).kind).toBe("missing");
	});

	test("entryIsFile and entryIsDir classify dirents", () => {
		tree = makeTree({ "d/f.txt": "x", "d/sub/g.txt": "y" });
		const dir = tree.path("d");
		const entries = readdirSync(dir, { withFileTypes: true });
		const file = entries.find((entry) => entry.name === "f.txt");
		const sub = entries.find((entry) => entry.name === "sub");
		expect(file && entryIsFile(dir, file)).toBe(true);
		expect(file && entryIsDir(dir, file)).toBe(false);
		expect(sub && entryIsDir(dir, sub)).toBe(true);
		expect(sub && entryIsFile(dir, sub)).toBe(false);
	});

	test("makeCollector ranks rows and suffixes duplicate ids", () => {
		const col = makeCollector();
		col.add({ path: "/a", kind: "file", status: "loaded", reason: "r" });
		col.add({ path: "/a", kind: "file", status: "loaded", reason: "r" });
		const rows = col.finish();
		expect(rows.map((row) => row.id)).toEqual([`file:${slashKey("/a")}`, `file:${slashKey("/a")}#2`]);
		expect(rows.map((row) => row.rank)).toEqual([1, 2]);
	});

	test("statProblem returns undefined for the expected kind and a row otherwise", () => {
		expect(statProblem("/p", "dir", { kind: "dir" }, "전역")).toBeUndefined();
		expect(statProblem("/p", "dir", { kind: "missing" }, "전역")?.reason).toBe("폴더 없음");
		expect(statProblem("/p", "file", { kind: "missing" }, "전역")?.reason).toBe("파일 없음");
		expect(statProblem("/p", "file", { kind: "missing" }, "전역", "경로 없음")?.reason).toBe("경로 없음");
		expect(statProblem("/p", "file", { kind: "dir" }, "전역")?.reason).toBe("파일이 아님");
		expect(statProblem("/p", "dir", { kind: "file" }, "전역")?.reason).toBe("폴더가 아님");
		expect(statProblem("/p", "dir", { kind: "error", message: "denied" }, "전역")).toMatchObject({ status: "error", reason: "읽지 못함: denied" });
	});
});
