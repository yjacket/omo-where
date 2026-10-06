// Skills probe: lists every candidate skill root and SKILL.md in harness priority order.
// Statuses come from env.senpi.loadSkills (host) when present, else from env.live.skills.
// The probe's own tables only decide the candidate locations, the 없음 rows and the reason strings.
import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Category, Probe, ProbeEnv, Scope, Status } from "../model.ts";
import { LIVE_PROBLEM, samePath } from "../model.ts";

const CONFIG_DIR_NAME = ".omo";
const MAX_ANCESTORS = 64;
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 6;
const NOTE = "같은 이름이면 먼저 찾은 쪽이 이김";
const NOTE_SESSION = "세션 기준";

type Row = Omit<Probe, "id" | "rank">;
type StatKind = "dir" | "file" | "other" | "missing" | "error";
type SkillInfo = { readonly name: string; readonly filePath: string };

/** Resolves a path to its comparison key without touching a possibly missing file. */
function slashKey(path: string): string {
	const s = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? s.toLowerCase() : s;
}

function isUnder(child: string, parent: string): boolean {
	const c = slashKey(child);
	const p = slashKey(parent);
	return c === p || c.startsWith(`${p}/`);
}

function omoAiPath(path: string): boolean {
	return slashKey(path).includes("/node_modules/omo-ai/");
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

type WalkResult = { readonly entries: readonly string[]; readonly problems: readonly { path: string; reason: string }[] };

/** Finds <dir>/SKILL.md roots below dir; recursion stops at a skill dir, skips dot dirs and node_modules. */
function walkSkills(root: string): WalkResult {
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
		if (dirents.some((entry) => entry.name === "SKILL.md" && entryIsFile(current.dir, entry))) {
			entries.push(join(current.dir, "SKILL.md"));
			continue;
		}
		if (current.depth >= MAX_DEPTH) continue;
		for (const entry of dirents) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			if (entryIsDir(current.dir, entry)) stack.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
		}
	}
	return { entries, problems };
}

type RootSpec = { readonly path: string; readonly scope?: Scope; readonly project: boolean; readonly loadable: boolean };

/** cwd/.agents/skills then each ancestor's, up to and including the nearest git root (or the drive root). */
function ancestorAgentsSkillDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let dir = cwd;
	for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
		dirs.push(join(dir, ".agents", "skills"));
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

function candidateRoots(env: ProbeEnv): RootSpec[] {
	const roots: RootSpec[] = [];
	const seen = new Set<string>();
	const push = (spec: RootSpec): void => {
		const key = slashKey(spec.path);
		if (seen.has(key)) return;
		seen.add(key);
		roots.push(spec);
	};
	push({ path: join(env.cwd, CONFIG_DIR_NAME, "skills"), scope: "프로젝트", project: true, loadable: true });
	for (const dir of ancestorAgentsSkillDirs(env.cwd)) {
		const owner = dirname(dirname(dir));
		push({ path: dir, scope: samePath(owner, env.cwd) ? "프로젝트" : "상위 폴더", project: true, loadable: true });
	}
	push({ path: join(env.cwd, ".pi", "skills"), scope: "프로젝트", project: true, loadable: true });
	push({ path: join(env.agentDir, "skills"), scope: "전역", project: false, loadable: true });
	push({ path: join(env.home, ".agents", "skills"), scope: "전역", project: false, loadable: true });
	return roots;
}

function summarizeWarning(message: string): string {
	const over = /^description exceeds \d+ characters \((\d+)\)/.exec(message);
	if (over) return `설명이 1024자 초과(${over[1]}자) - 경고, 들어옴`;
	if (message.startsWith("name")) return "이름 규칙 경고";
	return `경고: ${message}`;
}

function winnerLabel(loser: { winnerPath: string; name: string }, loadedFiles: readonly SkillInfo[]): string {
	const winner = loadedFiles.find((skill) => samePath(skill.filePath, loser.winnerPath));
	return winner?.name ?? loser.name;
}

export function probeSkills(env: ProbeEnv): Category {
	const roots = candidateRoots(env);
	const col = makeCollector();
	const loadSkills = env.senpi.loadSkills;
	const liveSkills = env.live.skills;

	const skillPaths = roots
		.filter((root) => root.loadable && !(root.project && !env.trusted))
		.filter((root) => statKind(root.path).kind === "dir")
		.map((root) => root.path);
	const result = loadSkills ? loadSkills({ cwd: env.cwd, agentDir: env.agentDir, skillPaths, includeDefaults: false }) : undefined;
	const loadedFiles: readonly SkillInfo[] = result?.skills ?? [];

	const losers = new Map<string, { winnerPath: string; name: string }>();
	const warned = new Map<string, string>();
	for (const diagnostic of result?.diagnostics ?? []) {
		if (diagnostic.type === "collision" && diagnostic.collision) {
			losers.set(slashKey(diagnostic.collision.loserPath), diagnostic.collision);
		} else if (diagnostic.type === "warning" && diagnostic.path) {
			warned.set(slashKey(diagnostic.path), summarizeWarning(diagnostic.message));
		}
	}
	const isLoaded = (file: string): boolean => loadedFiles.some((skill) => samePath(skill.filePath, file));
	const isLive = (file: string): boolean => (liveSkills ?? []).some((skill) => samePath(skill.filePath, file));
	const diskSkills: string[] = [];

	const emitSkill = (file: string, scope: Scope | undefined, gated: boolean): void => {
		diskSkills.push(file);
		const key = slashKey(file);
		if (gated) {
			const problem = warned.get(key);
			col.add({ path: file, kind: "file", status: "disabled", reason: "프로젝트 신뢰 안 함", scope, ...(problem !== undefined ? { problem } : {}) });
			return;
		}
		const loser = losers.get(key);
		if (loser !== undefined) {
			col.add({ path: file, kind: "file", status: "shadowed", reason: "같은 이름이 먼저 들어옴", scope, winner: loser.winnerPath, problem: `이름이 겹쳐 ${winnerLabel(loser, loadedFiles)}가 이김` });
			return;
		}
		if (result !== undefined ? isLoaded(file) : isLive(file)) {
			const warning = warned.get(key);
			const stale = liveSkills !== undefined && !isLive(file);
			col.add({
				path: file,
				kind: "file",
				status: "loaded",
				reason: "",
				scope,
				...(stale ? { live: "disk-only" } : {}),
				...(warning !== undefined ? { problem: warning } : stale ? { problem: LIVE_PROBLEM["disk-only"] } : {}),
			});
			return;
		}
		col.add({ path: file, kind: "file", status: "disabled", reason: "설명 없음 등으로 안 읽힘", scope });
	};

	for (const root of roots) {
		const stat = statKind(root.path);
		if (stat.kind === "missing") {
			col.add({ path: root.path, kind: "dir", status: "missing", reason: "폴더 없음", scope: root.scope });
			continue;
		}
		if (stat.kind === "error") {
			col.add({ path: root.path, kind: "dir", status: "error", reason: `읽지 못함: ${stat.message}`, scope: root.scope });
			continue;
		}
		if (stat.kind !== "dir") {
			col.add({ path: root.path, kind: "dir", status: "error", reason: "폴더가 아님", scope: root.scope });
			continue;
		}
		const gated = root.project && !env.trusted;
		const walk = walkSkills(root.path);
		col.add({
			path: root.path,
			kind: "dir",
			status: gated ? "disabled" : "loaded",
			reason: gated ? "프로젝트 신뢰 안 함" : "",
			scope: root.scope,
			...(gated && walk.entries.length > 0 ? { problem: "신뢰 안 한 프로젝트에 리소스 있음" } : {}),
		});
		for (const problem of walk.problems) col.add({ path: problem.path, kind: "dir", status: "error", reason: problem.reason, scope: root.scope });
		for (const file of walk.entries) emitSkill(file, root.scope, gated);
	}

	for (const entry of env.host.resolved?.skills ?? []) {
		if (roots.some((root) => isUnder(entry.path, root.path))) continue;
		const scope: Scope = omoAiPath(entry.path) ? "omo 플러그인" : "설정";
		const reason = entry.enabled ? "" : "설정에서 꺼짐";
		const status: Status = entry.enabled ? "loaded" : "disabled";
		const stat = statKind(entry.path);
		if (stat.kind === "missing") {
			col.add({ path: entry.path, kind: "file", status: "missing", reason: "경로 없음", scope });
			continue;
		}
		if (stat.kind === "error") {
			col.add({ path: entry.path, kind: "file", status: "error", reason: `읽지 못함: ${stat.message}`, scope });
			continue;
		}
		if (stat.kind === "file") {
			diskSkills.push(entry.path);
			col.add({ path: entry.path, kind: "file", status, reason, scope });
			continue;
		}
		if (stat.kind !== "dir") {
			col.add({ path: entry.path, kind: "file", status: "error", reason: "파일이 아님", scope });
			continue;
		}
		col.add({ path: entry.path, kind: "dir", status, reason, scope });
		const walk = walkSkills(entry.path);
		for (const problem of walk.problems) col.add({ path: problem.path, kind: "dir", status: "error", reason: problem.reason, scope });
		for (const file of walk.entries) {
			diskSkills.push(file);
			col.add({ path: file, kind: "file", status, reason, scope });
		}
	}

	const emitForeign = (dir: string, scope: Scope, reason: string): void => {
		if (statKind(dir).kind !== "dir") return;
		col.add({ path: dir, kind: "dir", status: "disabled", reason, scope });
		const walk = walkSkills(dir);
		for (const problem of walk.problems) col.add({ path: problem.path, kind: "dir", status: "error", reason: problem.reason, scope });
		for (const file of walk.entries) {
			diskSkills.push(file);
			col.add({ path: file, kind: "file", status: "disabled", reason, scope });
		}
	};
	emitForeign(join(env.home, ".claude", "skills"), "Claude Code 폴더", "Claude Code 폴더 - omo는 안 읽음");
	for (const agentRoot of [join(env.home, ".pi", "agent"), join(env.home, ".senpi", "agent")]) {
		if (samePath(agentRoot, env.agentDir) || statKind(agentRoot).kind !== "dir") continue;
		const foreignScope: Scope = "다른 에이전트 폴더";
		const foreignReason = "지금 세션은 이 폴더를 안 읽음";
		const dir = join(agentRoot, "skills");
		col.add({ path: dir, kind: "dir", status: "disabled", reason: foreignReason, scope: foreignScope });
		if (statKind(dir).kind !== "dir") continue;
		const walk = walkSkills(dir);
		for (const problem of walk.problems) col.add({ path: problem.path, kind: "dir", status: "error", reason: problem.reason, scope: foreignScope });
		for (const file of walk.entries) {
			diskSkills.push(file);
			col.add({ path: file, kind: "file", status: "disabled", reason: foreignReason, scope: foreignScope });
		}
	}

	if (liveSkills !== undefined) {
		for (const skill of liveSkills) {
			if (diskSkills.some((path) => samePath(path, skill.filePath))) continue;
			const outside = !roots.some((root) => isUnder(skill.filePath, root.path));
			const scope: Scope | undefined = outside ? (omoAiPath(skill.filePath) ? "omo 플러그인" : "세션") : undefined;
			col.add({ path: skill.filePath, kind: "file", status: "loaded", reason: "", scope, live: "session-only", problem: LIVE_PROBLEM["session-only"] });
		}
	}

	return { id: "skills", label: "스킬", probes: col.finish(), note: result !== undefined ? NOTE : NOTE_SESSION };
}
