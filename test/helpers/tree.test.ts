import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { makeTree } from "./tree.ts";

test("creates files and directories, then cleans up", () => {
	const t = makeTree({ "a/b.txt": "hi", "empty": null });
	expect(readFileSync(t.path("a/b.txt"), "utf8")).toBe("hi");
	expect(statSync(t.path("empty")).isDirectory()).toBe(true);
	t.cleanup();
	expect(existsSync(t.root)).toBe(false);
});

test("rejects paths escaping the root", () => {
	expect(() => makeTree({ "../x": "a" })).toThrow("escapes");
	const t = makeTree({});
	expect(() => t.path("../../y")).toThrow("escapes");
	t.cleanup();
});
