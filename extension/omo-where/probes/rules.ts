// Rules probe: mirrors the builtin "rules" extension's location tables.
// There is no host function for rules, so this module re-implements that harness rule and
// says so in Category.note; disk statuses are computed here, not handed down by the host.
import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { dirname, extname, join } from "node:path";
import { samePath, type Probe, type ProbeEnv, type Scope, type Status } from "../model.ts";

// RT/dist/core/extensions/builtin/rules/rules/constants.js
const PROJECT_MARKERS = [".git", "pnpm-workspace.yaml", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", ".venv"];
const PROJECT_RULE_SUBDIRS: readonly (readonly [string, string])[] = [
	[".pi", "rules"],
	[".omo", "rules"],
	[".claude", "rules"],
	[".cursor", "rules"],
	[".github", "instructions"],
];
const PROJECT_SINGLE_FILES = [".github/copilot-instructions.md", "AGENTS.md", "CLAUDE.md", "CONTEXT.md"];
const USER_HOME_RULE_SUBDIRS = [".pi/rules", ".omo/rules", ".opencode/rules", ".claude/rules"];
const USER_HOME_SINGLE_FILES = [".config/opencode/AGENTS.md", ".claude/CLAUDE.md"];
const RULE_EXTENSIONS = [".md", ".mdc"];
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next", "coverage"]);

const MAX_ANCESTORS = 64;
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 6;
const NOTE = "규칙 확장 규칙을 따라 계산 · 읽기·수정 때 그 파일 위쪽 규칙이 더 붙을 수 있음";
const CONTEXT_REASON = "지침 파일로 이미 들어감";
const UNTRUSTED_REASON = "프로젝트 신뢰 안 함";
const RESOURCE_PROBLEM = "신뢰 안 한 프로젝트에 리소스 있음";

type Row = Omit<Probe, "id" | "rank">;
type StatKind = "dir" | "file" | "other" | "missing" | "error";

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Path comparison key; used only to dedupe probe ids, never for status decisions. */
function slashKey(path: string): string {
	const s = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? s.toLowerCase() : s;
}

function statKind(path: string): { kind: StatKind; message?: string } {
	try {
		const stats = statSync(path);
		if (stats.isDirectory()) return { kind: "dir" };
		if (stats.isFile()) return { kind: "file" };
		return { kind: "other" };
	} catch (error) {
		const message = describe(error);
		return existsSync(path) ? { kind: "error", message } : { kind: "missing" };
	}
}

function makeCollector() {
	const probes: Probe[] = [];
	const ids = new Set<string>();
	return {
		add(row: Row): Probe {
			const base = `${row.kind}:${slashKey(row.path)}`;
			let id = base;
			for (let n = 2; ids.has(id); n += 1) id = `${base}#${n}`;
			ids.add(id);
			const probe: Probe = { ...row, id, rank: probes.length + 1 };
			probes.push(probe);
			return probe;
		},
		finish(): readonly Probe[] {
			return probes;
		},
	};
}

function entryIsFile(dir: string, entry: Dirent): boolean {
	if (entry.isFile()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return statSync(join(dir, entry.name)).isFile();
	} catch {
		return false;
	}
}

function entryIsDir(dir: string, entry: Dirent): boolean {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return statSync(join(dir, entry.name)).isDirectory();
	} catch {
		return false;
	}
}

type WalkResult = { readonly entries: readonly string[]; readonly problems: readonly { readonly path: string; readonly reason: string }[] };

/** Recursive *.md/*.mdc scan of one rule dir, honoring the harness' excluded dirs and bounds. */
function walkRules(root: string): WalkResult {
	const entries: string[] = [];
	const problems: { path: string; reason: string }[] = [];
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
		for (const entry of dirents) {
			const full = join(current.dir, entry.name);
			if (entryIsDir(current.dir, entry)) {
				if (!EXCLUDED_DIRS.has(entry.name) && current.depth < MAX_DEPTH) stack.push({ dir: full, depth: current.depth + 1 });
				continue;
			}
			if (entryIsFile(current.dir, entry) && RULE_EXTENSIONS.includes(extname(entry.name).toLowerCase())) entries.push(full);
		}
	}
	entries.sort((a, b) => a.localeCompare(b));
	return { entries, problems };
}

/** Nearest ancestor of cwd (inclusive) holding a project marker; undefined when none is found. */
function findProjectRoot(cwd: string): string | undefined {
	let dir = cwd;
	for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
		if (PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/** Paths already loaded as context files: env.live first, else the host loader, else none. */
function contextPaths(env: ProbeEnv): readonly string[] {
	if (env.live.contextFiles !== undefined) return env.live.contextFiles.map((file) => file.path);
	const loader = env.senpi.loadProjectContextFiles;
	if (typeof loader === "function") return loader({ cwd: env.cwd, agentDir: env.agentDir }).map((file) => file.path);
	return [];
}

export const probeRules: ProbeFn = (env) => {
	const projectRoot = findProjectRoot(env.cwd);
	const base = projectRoot ?? env.cwd;
	const contexts = contextPaths(env);
	const contextOf = (file: string): string | undefined => contexts.find((path) => samePath(path, file));
	const col = makeCollector();

	const emitFile = (file: string, scope: Scope, gated: boolean): void => {
		const context = contextOf(file);
		if (context !== undefined) {
			col.add({ path: file, kind: "file", status: "shadowed", reason: CONTEXT_REASON, scope, winner: context });
			return;
		}
		if (gated) {
			col.add({ path: file, kind: "file", status: "disabled", reason: UNTRUSTED_REASON, scope });
			return;
		}
		col.add({ path: file, kind: "file", status: "loaded", reason: "", scope });
	};

	const emitRuleDir = (dir: string, scope: Scope, gated: boolean): void => {
		const stat = statKind(dir);
		if (stat.kind === "missing") {
			col.add({ path: dir, kind: "dir", status: "missing", reason: "폴더 없음", scope });
			return;
		}
		if (stat.kind === "error") {
			col.add({ path: dir, kind: "dir", status: "error", reason: `읽지 못함: ${stat.message}`, scope });
			return;
		}
		if (stat.kind !== "dir") {
			col.add({ path: dir, kind: "dir", status: "error", reason: "폴더가 아님", scope });
			return;
		}
		const walk = walkRules(dir);
		const status: Status = gated ? "disabled" : "loaded";
		col.add({
			path: dir,
			kind: "dir",
			status,
			reason: gated ? UNTRUSTED_REASON : "",
			scope,
			...(gated && walk.entries.length > 0 ? { problem: RESOURCE_PROBLEM } : {}),
		});
		for (const problem of walk.problems) col.add({ path: problem.path, kind: "dir", status: "error", reason: problem.reason, scope });
		for (const file of walk.entries) emitFile(file, scope, gated);
	};

	const emitSingleFile = (file: string, scope: Scope, gated: boolean): void => {
		const stat = statKind(file);
		if (stat.kind === "missing") {
			col.add({ path: file, kind: "file", status: "missing", reason: "파일 없음", scope });
			return;
		}
		if (stat.kind === "error") {
			col.add({ path: file, kind: "file", status: "error", reason: `읽지 못함: ${stat.message}`, scope });
			return;
		}
		if (stat.kind !== "file") {
			col.add({ path: file, kind: "file", status: "error", reason: "파일이 아님", scope });
			return;
		}
		emitFile(file, scope, gated);
	};

	// Project dirs, then project single files.
	const gated = !env.trusted;
	for (const [parent, sub] of PROJECT_RULE_SUBDIRS) emitRuleDir(join(base, parent, sub), "프로젝트", gated);
	for (const rel of PROJECT_SINGLE_FILES) emitSingleFile(join(base, rel), "프로젝트", gated);

	// User-home dirs, then user-home single files (first existing wins per name).
	for (const rel of USER_HOME_RULE_SUBDIRS) emitRuleDir(join(env.home, rel), "전역", false);
	let winner: string | undefined;
	for (const rel of USER_HOME_SINGLE_FILES) {
		const file = join(env.home, rel);
		const stat = statKind(file);
		if (stat.kind === "missing") {
			col.add({ path: file, kind: "file", status: "missing", reason: "파일 없음", scope: "전역" });
			continue;
		}
		if (stat.kind === "error") {
			col.add({ path: file, kind: "file", status: "error", reason: `읽지 못함: ${stat.message}`, scope: "전역" });
			continue;
		}
		if (stat.kind !== "file") {
			col.add({ path: file, kind: "file", status: "error", reason: "파일이 아님", scope: "전역" });
			continue;
		}
		const context = contextOf(file);
		if (context !== undefined) {
			col.add({ path: file, kind: "file", status: "shadowed", reason: CONTEXT_REASON, scope: "전역", winner: context });
			continue;
		}
		if (winner === undefined) {
			winner = file;
			col.add({ path: file, kind: "file", status: "loaded", reason: "", scope: "전역" });
			continue;
		}
		col.add({ path: file, kind: "file", status: "shadowed", reason: "앞의 파일이 먼저", scope: "전역", winner });
	}

	const note = projectRoot === undefined ? `${NOTE} · 프로젝트 루트 못 찾아 cwd 기준` : NOTE;
	return { id: "rules", label: "규칙", probes: col.finish(), note };
};
