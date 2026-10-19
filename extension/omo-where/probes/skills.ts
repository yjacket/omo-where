// Skills probe: lists every candidate skill root and SKILL.md in harness priority order.
// Statuses come from env.senpi.loadSkills (host) when present, else from env.live.skills.
// The probe's own tables only decide the candidate locations, the 없음 rows and the reason strings.
// Folders omo does not read (~/.claude, other agents' dirs) are listed last so numbered rows read as priority.
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { Category, Probe, ProbeEnv, Scope, Status } from "../model.ts";
import { LIVE_PROBLEM, normPath, samePath } from "../model.ts";
import { describe, entryIsDir, entryIsFile, isUnder, makeCollector, slashKey, statKind, statProblem, walkTree, type Problem, type Row } from "./fs-util.ts";

const CONFIG_DIR_NAME = ".omo";
const MAX_ANCESTORS = 64;
const MAX_DEPTH = 6;
const NOTE = "같은 이름이면 먼저 찾은 쪽이 이김";
const NOTE_SESSION = "세션 기준";

type SkillInfo = { readonly name: string; readonly filePath: string };

/** Literal comparison key: path.resolve, slashes, drive-letter case; never follows links. */
function literalKey(path: string): string {
	const s = resolvePath(path).replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? s.toLowerCase() : s;
}

function omoAiPath(path: string): boolean {
	return slashKey(path).includes("/node_modules/omo-ai/");
}

/** Scope and reason for a live skill by where its file lives (already slash-normalized, case-insensitive on win32). */
function liveSkillLabel(path: string): { scope: Scope; reason: string } {
	const p = slashKey(path);
	if (p.includes("/node_modules/omo-ai/")) return { scope: "omo 플러그인", reason: "omo 플러그인 스킬" };
	if (p.includes("/.omo/agent/runtime/")) return { scope: "내장", reason: "내장 스킬" };
	if (/\/agents\/[^/]+\/repo\/skills\//.test(p)) return { scope: "세션", reason: "메모리 스킬" };
	return { scope: "세션", reason: "확장이 넣은 스킬" };
}

type WalkResult = { readonly entries: readonly string[]; readonly problems: readonly Problem[] };

/** Finds <dir>/SKILL.md roots below dir; recursion stops at a skill dir, skips dot dirs and node_modules. */
function walkSkills(root: string): WalkResult {
	const entries: string[] = [];
	const problems = walkTree(root, (dir, dirents, depth) => {
		if (dirents.some((entry) => entry.name === "SKILL.md" && entryIsFile(dir, entry))) {
			entries.push(join(dir, "SKILL.md"));
			return [];
		}
		if (depth >= MAX_DEPTH) return [];
		return dirents.filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules" && entryIsDir(dir, entry)).map((entry) => join(dir, entry.name));
	});
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

/** Rows for folders omo does not read: the ~/.claude/skills summary and other agents' skill dirs with their entries. */
function foreignRows(env: ProbeEnv, diskSkills: string[]): Row[] {
	const rows: Row[] = [];
	const claudeSkills = join(env.home, ".claude", "skills");
	if (statKind(claudeSkills).kind === "dir") {
		const walk = walkSkills(claudeSkills);
		rows.push({ path: claudeSkills, kind: "dir", status: "disabled", scope: "Claude Code 폴더", reason: `Claude Code 폴더 - omo는 안 읽음 · 스킬 ${walk.entries.length}개` });
	}
	for (const agentRoot of [join(env.home, ".pi", "agent"), join(env.home, ".senpi", "agent")]) {
		if (samePath(agentRoot, env.agentDir) || statKind(agentRoot).kind !== "dir") continue;
		const scope: Scope = "다른 에이전트 폴더";
		const reason = "지금 세션은 이 폴더를 안 읽음";
		const dir = join(agentRoot, "skills");
		rows.push({ path: dir, kind: "dir", status: "disabled", reason, scope });
		if (statKind(dir).kind !== "dir") continue;
		const walk = walkSkills(dir);
		for (const problem of walk.problems) rows.push({ path: problem.path, kind: "dir", status: "error", reason: problem.reason, scope });
		for (const file of walk.entries) {
			diskSkills.push(file);
			rows.push({ path: file, kind: "file", status: "disabled", reason, scope });
		}
	}
	return rows;
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
	let result: ReturnType<NonNullable<typeof loadSkills>> | undefined;
	let loadError: string | undefined;
	if (loadSkills) {
		try {
			result = loadSkills({ cwd: env.cwd, agentDir: env.agentDir, skillPaths, includeDefaults: false });
		} catch (error) {
			loadError = describe(error);
		}
	}
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
	// Loaded/live marks use the literal path: the harness keeps the first literal path even for a link.
	const isLoaded = (file: string): boolean => loadedFiles.some((skill) => literalKey(skill.filePath) === literalKey(file));
	const isLive = (file: string): boolean => (liveSkills ?? []).some((skill) => literalKey(skill.filePath) === literalKey(file));
	const loadedByReal = new Map<string, SkillInfo>();
	for (const skill of loadedFiles) {
		const real = normPath(skill.filePath);
		if (!loadedByReal.has(real)) loadedByReal.set(real, skill);
	}
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
				reason: "스킬",
				scope,
				...(stale ? { live: "disk-only" } : {}),
				...(warning !== undefined ? { problem: warning } : stale ? { problem: LIVE_PROBLEM["disk-only"] } : {}),
			});
			return;
		}
		const loadedReal = loadedByReal.get(normPath(file));
		if (loadedReal !== undefined && literalKey(loadedReal.filePath) !== literalKey(file)) {
			col.add({
				path: file,
				kind: "file",
				status: "shadowed",
				reason: "같은 파일(링크)로 이미 들어옴",
				scope,
				winner: loadedReal.filePath,
				// By design, not a problem: the same skill reached twice through a link.
				linked: true,
			});
			return;
		}
		col.add({ path: file, kind: "file", status: "disabled", reason: "설명 없음 등으로 안 읽힘", scope });
	};

	for (const root of roots) {
		const problem = statProblem(root.path, "dir", statKind(root.path), root.scope);
		if (problem !== undefined) {
			col.add(problem);
			continue;
		}
		const gated = root.project && !env.trusted;
		const walk = walkSkills(root.path);
		col.add({
			path: root.path,
			kind: "dir",
			status: gated ? "disabled" : "loaded",
			reason: gated ? "프로젝트 신뢰 안 함" : "폴더 검색",
			scope: root.scope,
			...(gated && walk.entries.length > 0 ? { problem: "신뢰 안 한 프로젝트에 리소스 있음" } : {}),
		});
		for (const item of walk.problems) col.add({ path: item.path, kind: "dir", status: "error", reason: item.reason, scope: root.scope });
		for (const file of walk.entries) emitSkill(file, root.scope, gated);
	}

	for (const entry of env.host.resolved?.skills ?? []) {
		if (roots.some((root) => isUnder(entry.path, root.path))) continue;
		const scope: Scope = omoAiPath(entry.path) ? "omo 플러그인" : "설정";
		const reason = entry.enabled ? "스킬" : "설정에서 꺼짐";
		const status: Status = entry.enabled ? "loaded" : "disabled";
		const stat = statKind(entry.path);
		if (stat.kind !== "dir") {
			const problem = statProblem(entry.path, "file", stat, scope, "경로 없음");
			if (problem !== undefined) {
				col.add(problem);
				continue;
			}
			diskSkills.push(entry.path);
			col.add({ path: entry.path, kind: "file", status, reason, scope });
			continue;
		}
		col.add({ path: entry.path, kind: "dir", status, reason: entry.enabled ? "폴더 검색" : "설정에서 꺼짐", scope });
		const walk = walkSkills(entry.path);
		for (const item of walk.problems) col.add({ path: item.path, kind: "dir", status: "error", reason: item.reason, scope });
		for (const file of walk.entries) {
			diskSkills.push(file);
			col.add({ path: file, kind: "file", status, reason, scope });
		}
	}

	// Foreign files are known before the live rows so a live skill from there is not listed twice.
	const foreign = foreignRows(env, diskSkills);
	for (const skill of liveSkills ?? []) {
		if (diskSkills.some((path) => literalKey(path) === literalKey(skill.filePath))) continue;
		const { scope, reason } = liveSkillLabel(skill.filePath);
		if (existsSync(skill.filePath)) {
			col.add({ path: skill.filePath, kind: "file", status: "loaded", reason, scope });
			continue;
		}
		col.add({ path: skill.filePath, kind: "file", status: "missing", reason: "스킬", scope, live: "session-only", problem: LIVE_PROBLEM["session-only"] });
	}
	for (const row of foreign) col.add(row);

	const base = result !== undefined ? NOTE : NOTE_SESSION;
	return { id: "skills", label: "스킬", probes: col.finish(), note: loadError !== undefined ? `${base} · 스킬 읽기 실패: ${loadError}` : base };
}
