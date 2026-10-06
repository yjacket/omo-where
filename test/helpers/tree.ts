import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

export type Tree = { root: string; path(rel: string): string; cleanup(): void };

/** Builds a temp directory tree. A null value makes a directory, a string makes a file with that content. */
export function makeTree(spec: Record<string, string | null>): Tree {
	const root = mkdtempSync(join(tmpdir(), "omo-where-"));
	const path = (rel: string): string => {
		const full = resolve(root, rel);
		const back = relative(root, full);
		if (back.startsWith("..") || isAbsolute(back)) throw new Error(`path escapes tree root: ${rel}`);
		return full;
	};
	try {
		for (const [rel, content] of Object.entries(spec)) {
			const full = path(rel);
			if (content === null) mkdirSync(full, { recursive: true });
			else {
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, content);
			}
		}
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
	return { root, path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
