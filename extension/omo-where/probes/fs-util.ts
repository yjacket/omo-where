// Filesystem helpers shared by the probes: path keys, stat results, dirent checks, the row collector
// and the row for a path that is missing, unreadable or of the wrong type.
import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Probe, Scope } from "../model.ts";

const MAX_ENTRIES = 2000;

export type Problem = { readonly path: string; readonly reason: string };
export type Row = Omit<Probe, "id" | "rank">;
/** Mutable intermediate row; Probe fields are readonly. */
export type MutableProbe = { -readonly [K in keyof Probe]: Probe[K] };
export type StatResult = { readonly kind: "dir" | "file" | "other" | "missing" } | { readonly kind: "error"; readonly message: string };

export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Path comparison key (slashes, no trailing slash, lower case on win32); never touches the disk. */
export function slashKey(path: string): string {
	const s = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? s.toLowerCase() : s;
}

/** True when child is parent or sits inside it (key-normalized). */
export function isUnder(child: string, parent: string): boolean {
	const c = slashKey(child);
	const p = slashKey(parent);
	return c === p || c.startsWith(`${p}/`);
}

export function statKind(path: string): StatResult {
	try {
		const stats = statSync(path);
		if (stats.isDirectory()) return { kind: "dir" };
		if (stats.isFile()) return { kind: "file" };
		return { kind: "other" };
	} catch (error) {
		return existsSync(path) ? { kind: "error", message: describe(error) } : { kind: "missing" };
	}
}

function entryIs(dir: string, entry: Dirent, check: (stats: ReturnType<typeof statSync>) => boolean, direct: boolean): boolean {
	if (direct) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return check(statSync(join(dir, entry.name)));
	} catch {
		return false;
	}
}

/** Regular file, or a link that resolves to one. */
export function entryIsFile(dir: string, entry: Dirent): boolean {
	return entryIs(dir, entry, (stats) => stats.isFile(), entry.isFile());
}

/** Directory, or a link that resolves to one. */
export function entryIsDir(dir: string, entry: Dirent): boolean {
	return entryIs(dir, entry, (stats) => stats.isDirectory(), entry.isDirectory());
}

/** Collects rows in order, giving each a unique id (kind:key, then #2, #3...) and a 1-based rank. */
export function makeCollector() {
	const rows: MutableProbe[] = [];
	const ids = new Set<string>();
	return {
		add(row: Row): MutableProbe {
			const base = `${row.kind}:${slashKey(row.path)}`;
			let id = base;
			for (let n = 2; ids.has(id); n += 1) id = `${base}#${n}`;
			ids.add(id);
			const probe: MutableProbe = { ...row, id, rank: rows.length + 1 };
			rows.push(probe);
			return probe;
		},
		rows,
		finish(): readonly Probe[] {
			return rows;
		},
	};
}

/** Row for a path that is not the expected kind (missing, unreadable, wrong type); undefined when it is. */
export function statProblem(path: string, kind: "file" | "dir", stat: StatResult, scope: Scope | undefined, missingReason?: string): Row | undefined {
	if (stat.kind === kind) return undefined;
	if (stat.kind === "missing") return { path, kind, status: "missing", reason: missingReason ?? (kind === "dir" ? "폴더 없음" : "파일 없음"), scope };
	if (stat.kind === "error") return { path, kind, status: "error", reason: `읽지 못함: ${stat.message}`, scope };
	return { path, kind, status: "error", reason: kind === "dir" ? "폴더가 아님" : "파일이 아님", scope };
}

/**
 * Iterative directory walk shared by the skills and rules scans. Skips already visited real paths,
 * caps a listing at 2000 entries ("목록 잘림") and reports unreadable dirs; visit() handles one dir's
 * entries and returns the child dirs to descend into.
 */
export function walkTree(root: string, visit: (dir: string, dirents: readonly Dirent[], depth: number) => readonly string[]): Problem[] {
	const problems: Problem[] = [];
	const visited = new Set<string>();
	const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
	while (stack.length > 0) {
		const current = stack.pop() as { dir: string; depth: number };
		try {
			const real = realpathSync.native(current.dir);
			if (visited.has(real)) continue;
			visited.add(real);
		} catch {
			// not resolvable: keep walking with the plain path
		}
		let dirents: Dirent[];
		try {
			dirents = readdirSync(current.dir, { withFileTypes: true });
		} catch (error) {
			problems.push({ path: current.dir, reason: `읽지 못함: ${describe(error)}` });
			continue;
		}
		if (dirents.length > MAX_ENTRIES) {
			dirents = dirents.slice(0, MAX_ENTRIES);
			problems.push({ path: current.dir, reason: "목록 잘림" });
		}
		for (const dir of visit(current.dir, dirents, current.depth)) stack.push({ dir, depth: current.depth + 1 });
	}
	return problems;
}
