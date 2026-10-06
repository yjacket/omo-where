// Rules probe: mirrors the builtin "rules" extension's location tables.
// There is no host function for rules, so this module re-implements that harness rule and
// says so in Category.note; disk statuses are computed here, not handed down by the host.
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { samePath, type ProbeEnv, type ProbeFn, type Scope, type Status } from "../model.ts";
import { entryIsDir, entryIsFile, makeCollector, statKind, statProblem, walkTree, type Problem } from "./fs-util.ts";

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
const MAX_DEPTH = 6;
const NOTE = "규칙 확장 규칙을 따라 계산 · 읽기·수정 때 그 파일 위쪽 규칙이 더 붙을 수 있음";
const CONTEXT_REASON = "지침 파일로 이미 들어감";
const DIR_REASON = "폴더 검색";
const FILE_REASON = "규칙 파일";
const UNTRUSTED_REASON = "프로젝트 신뢰 안 함";
const RESOURCE_PROBLEM = "신뢰 안 한 프로젝트에 리소스 있음";

type WalkResult = { readonly entries: readonly string[]; readonly problems: readonly Problem[] };

/** Recursive *.md/*.mdc scan of one rule dir, honoring the harness' excluded dirs and bounds. */
function walkRules(root: string): WalkResult {
	const entries: string[] = [];
	const problems = walkTree(root, (dir, dirents, depth) => {
		const children: string[] = [];
		for (const entry of dirents) {
			const full = join(dir, entry.name);
			if (entryIsDir(dir, entry)) {
				if (!EXCLUDED_DIRS.has(entry.name) && depth < MAX_DEPTH) children.push(full);
				continue;
			}
			if (entryIsFile(dir, entry) && RULE_EXTENSIONS.includes(extname(entry.name).toLowerCase())) entries.push(full);
		}
		return children;
	});
	entries.sort((x, y) => x.localeCompare(y));
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
			col.add({ path: file, kind: "file", status: "shadowed", reason: CONTEXT_REASON, scope, ...(samePath(context, file) ? {} : { winner: context }) });
			return;
		}
		if (gated) {
			col.add({ path: file, kind: "file", status: "disabled", reason: UNTRUSTED_REASON, scope });
			return;
		}
		col.add({ path: file, kind: "file", status: "loaded", reason: FILE_REASON, scope });
	};

	const emitRuleDir = (dir: string, scope: Scope, gated: boolean): void => {
		const problem = statProblem(dir, "dir", statKind(dir), scope);
		if (problem !== undefined) {
			col.add(problem);
			return;
		}
		const walk = walkRules(dir);
		const status: Status = gated ? "disabled" : "loaded";
		col.add({
			path: dir,
			kind: "dir",
			status,
			reason: gated ? UNTRUSTED_REASON : DIR_REASON,
			scope,
			...(gated && walk.entries.length > 0 ? { problem: RESOURCE_PROBLEM } : {}),
		});
		for (const item of walk.problems) col.add({ path: item.path, kind: "dir", status: "error", reason: item.reason, scope });
		for (const file of walk.entries) emitFile(file, scope, gated);
	};

	const emitSingleFile = (file: string, scope: Scope, gated: boolean): void => {
		const problem = statProblem(file, "file", statKind(file), scope);
		if (problem !== undefined) col.add(problem);
		else emitFile(file, scope, gated);
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
		const problem = statProblem(file, "file", statKind(file), "전역");
		if (problem !== undefined) {
			col.add(problem);
			continue;
		}
		const context = contextOf(file);
		if (context !== undefined) {
			col.add({ path: file, kind: "file", status: "shadowed", reason: CONTEXT_REASON, scope: "전역", ...(samePath(context, file) ? {} : { winner: context }) });
			continue;
		}
		if (winner === undefined) {
			winner = file;
			col.add({ path: file, kind: "file", status: "loaded", reason: FILE_REASON, scope: "전역" });
			continue;
		}
		col.add({ path: file, kind: "file", status: "shadowed", reason: "앞의 파일이 먼저", scope: "전역", winner });
	}

	const note = projectRoot === undefined ? `${NOTE} · 프로젝트 루트 못 찾아 cwd 기준` : NOTE;
	return { id: "rules", label: "규칙", probes: col.finish(), note };
};
