// Probe: 지침 파일 (context files). The host decides statuses; this module only
// lists candidate locations and falls back to a local estimate when no host data exists.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIVE_PROBLEM, normPath, samePath, type Probe, type ProbeEnv, type ProbeFn, type Scope } from "../model.ts";

// Harness order (RT/dist/core/resource-loader.js loadContextFileFromDir).
const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const NOTE = "폴더마다 첫 번째 파일 하나만 · 깊은 폴더가 뒤에 와서 우선";
const MAX_ANCESTORS = 64;
const OTHER_REASON = "지금 세션은 이 폴더를 안 읽음";

/** Mutable intermediate row; Probe fields are readonly. */
type MutableProbe = { -readonly [K in keyof Probe]: Probe[K] };

type DirInfo = { readonly dir: string; readonly names: readonly string[]; readonly errors: readonly { readonly path: string; readonly message: string }[] };

function ancestorsFarthestFirst(cwd: string): string[] {
	const dirs: string[] = [];
	let dir = cwd;
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		dirs.push(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs.reverse();
}

function uniqueDirs(dirs: readonly string[]): string[] {
	const out: string[] = [];
	for (const dir of dirs) if (!out.some((seen) => samePath(seen, dir))) out.push(dir);
	return out;
}

function readDirCandidates(dir: string): DirInfo {
	const names: string[] = [];
	const errors: { path: string; message: string }[] = [];
	for (const name of CANDIDATES) {
		const file = join(dir, name);
		try {
			// A case-insensitive filesystem resolves AGENTS.md and AGENTS.MD to one file.
			if (statSync(file).isFile() && !names.some((seen) => samePath(join(dir, seen), file))) names.push(name);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") errors.push({ path: file, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { dir, names, errors };
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readDiskContent(file: string): string | undefined {
	try {
		return readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
}

function normalizeContent(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/** Loaded paths from the host function, else live, else the first-match rule computed locally. */
function resolveLoaded(env: ProbeEnv, dirs: readonly DirInfo[]): { readonly paths: readonly string[]; readonly estimated: boolean } {
	if (typeof env.senpi.loadProjectContextFiles === "function") {
		const files = env.senpi.loadProjectContextFiles({ cwd: env.cwd, agentDir: env.agentDir });
		return { paths: files.map((file) => file.path), estimated: false };
	}
	if (env.live.contextFiles !== undefined) return { paths: env.live.contextFiles.map((file) => file.path), estimated: false };
	const paths: string[] = [];
	for (const info of dirs) {
		const name = info.names[0];
		if (name === undefined) continue;
		const file = join(info.dir, name);
		if (!paths.some((path) => samePath(path, file))) paths.push(file);
	}
	return { paths, estimated: true };
}

export const probeContext: ProbeFn = (env) => {
	const dirs = uniqueDirs([env.agentDir, ...ancestorsFarthestFirst(env.cwd)]);
	const infos = dirs.map(readDirCandidates);
	const loaded = resolveLoaded(env, infos);
	const isLoaded = (path: string): boolean => loaded.paths.some((entry) => samePath(entry, path));
	const scopeOf = (dir: string): Scope => (samePath(dir, env.agentDir) ? "전역" : samePath(dir, env.cwd) ? "프로젝트" : "상위 폴더");
	const rows: MutableProbe[] = [];
	const push = (row: Omit<Probe, "rank">): void => {
		rows.push({ ...row, rank: rows.length + 1 });
	};

	for (const info of infos) {
		const scope = scopeOf(info.dir);
		for (const error of info.errors) {
			push({ id: `ctx:${normPath(error.path)}`, path: error.path, kind: "file", status: "error", reason: error.message, scope });
		}
		if (info.names.length === 0) {
			if (info.errors.length === 0) push({ id: `ctx:${normPath(info.dir)}`, path: info.dir, kind: "dir", status: "missing", reason: "후보 파일 없음", scope });
			continue;
		}
		for (let index = 0; index < info.names.length; index++) {
			const name = info.names[index];
			if (name === undefined) continue;
			const file = join(info.dir, name);
			if (isLoaded(file)) {
				push({ id: `ctx:${normPath(file)}`, path: file, kind: "file", status: "loaded", reason: "지침 파일로 들어옴", scope });
				continue;
			}
			const winnerIndex = info.names.findIndex((other, otherIndex) => otherIndex < index && isLoaded(join(info.dir, other)));
			const winnerName = winnerIndex >= 0 ? info.names[winnerIndex] : undefined;
			if (winnerName !== undefined) {
				push({
					id: `ctx:${normPath(file)}`,
					path: file,
					kind: "file",
					status: "shadowed",
					reason: `같은 폴더의 ${winnerName}이 먼저`,
					scope,
					winner: join(info.dir, winnerName),
					...(winnerName === "AGENTS.override.md" ? { problem: "AGENTS.override.md 때문에 안 읽힘" } : {}),
				});
			} else {
				push({ id: `ctx:${normPath(file)}`, path: file, kind: "file", status: "shadowed", reason: "하네스가 건너뜀(작업 트리 본 저장소 사본 등)", scope });
			}
		}
	}

	const live = env.live.contextFiles;
	if (live !== undefined) {
		for (const row of rows) {
			if (row.kind !== "file" || row.status !== "loaded") continue;
			const entry = live.find((item) => samePath(item.path, row.path));
			if (entry === undefined) {
				row.live = "disk-only";
				row.problem = LIVE_PROBLEM["disk-only"];
				continue;
			}
			const disk = readDiskContent(row.path);
			const changed = typeof entry.content === "string" && disk !== undefined && normalizeContent(entry.content) !== normalizeContent(disk);
			if (changed) {
				row.live = "changed";
				row.problem = LIVE_PROBLEM.changed;
			} else {
				row.live = "match";
			}
		}
		for (const entry of live) {
			if (rows.some((row) => row.kind === "file" && samePath(row.path, entry.path))) continue;
			if (readDiskContent(entry.path) !== undefined) continue;
			push({ id: `ctx:live:${normPath(entry.path)}`, path: entry.path, kind: "file", status: "missing", reason: "디스크에 없음", scope: "세션", live: "session-only", problem: LIVE_PROBLEM["session-only"] });
		}
	}

	const otherRoots = uniqueDirs([join(env.home, ".pi", "agent"), join(env.home, ".senpi", "agent")]).filter((root) => !samePath(root, env.agentDir));
	for (const root of otherRoots) {
		if (!isDirectory(root)) continue;
		const info = readDirCandidates(root);
		if (info.names.length === 0) {
			push({ id: `ctx:other:${normPath(root)}`, path: root, kind: "dir", status: "disabled", reason: OTHER_REASON, scope: "다른 에이전트 폴더" });
			continue;
		}
		for (const name of info.names) {
			const file = join(root, name);
			push({ id: `ctx:other:${normPath(file)}`, path: file, kind: "file", status: "disabled", reason: OTHER_REASON, scope: "다른 에이전트 폴더" });
		}
	}

	return { id: "context", label: "지침 파일", probes: rows, note: loaded.estimated ? `${NOTE} · 추정` : NOTE };
};
