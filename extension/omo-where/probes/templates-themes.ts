// Probe: 프롬프트 템플릿과 테마. The host decides statuses via env.host.resolved;
// without host data the probe falls back to the harness rule "first name wins".
// Its own tables only decide the candidate dirs, the 없음 rows and the reason strings.
import { type Dirent, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Category, CategoryId, Probe, ProbeEnv, ProbeFn, Scope } from "../model.ts";
import { samePath } from "../model.ts";

const MAX_ENTRIES = 2000;
const NOTE = "같은 이름이면 먼저 찾은 쪽이 이김";
const DIR_NAME: Readonly<Record<Kind, string>> = { templates: "prompts", themes: "themes" };
const RESOLVED_KEY: Readonly<Record<Kind, "prompts" | "themes">> = { templates: "prompts", themes: "themes" };
const FILE_EXT: Readonly<Record<Kind, RegExp>> = { templates: /\.md$/i, themes: /\.json$/i };
const LABEL: Readonly<Record<Kind, string>> = { templates: "프롬프트 템플릿", themes: "테마" };

type Kind = "templates" | "themes";

/** Mutable intermediate row; Probe fields are readonly. */
type MutableProbe = { -readonly [K in keyof Probe]: Probe[K] };
type Row = Omit<Probe, "id" | "rank">;
type DirSpec = { readonly path: string; readonly scope: Scope; readonly project: boolean };
type StatKind = { readonly kind: "dir" | "file" | "other" | "missing" } | { readonly kind: "error"; readonly message: string };
type Listed = { readonly ok: true; readonly paths: readonly string[]; readonly truncated: boolean } | { readonly ok: false; readonly message: string };

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

function statKind(path: string): StatKind {
	try {
		const stats = statSync(path);
		if (stats.isDirectory()) return { kind: "dir" };
		if (stats.isFile()) return { kind: "file" };
		return { kind: "other" };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
		return { kind: "error", message: describe(error) };
	}
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

/** Non-recursive listing of matching files, capped at MAX_ENTRIES. */
function listFiles(dir: string, ext: RegExp): Listed {
	let dirents: Dirent[];
	try {
		dirents = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		return { ok: false, message: describe(error) };
	}
	const truncated = dirents.length > MAX_ENTRIES;
	const paths: string[] = [];
	for (const entry of truncated ? dirents.slice(0, MAX_ENTRIES) : dirents) {
		if (!ext.test(entry.name)) continue;
		if (!entryIsFile(dir, entry)) continue;
		paths.push(join(dir, entry.name));
	}
	paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return { ok: true, paths, truncated };
}

function makeCollector() {
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
	};
}

/** agentDir first, then cwd/.omo, then cwd/.pi - the harness auto-dir order. */
function dirSpecs(env: ProbeEnv, kind: Kind): DirSpec[] {
	const name = DIR_NAME[kind];
	const specs: DirSpec[] = [
		{ path: join(env.agentDir, name), scope: "전역", project: false },
		{ path: join(env.cwd, ".omo", name), scope: "프로젝트", project: true },
		{ path: join(env.cwd, ".pi", name), scope: "프로젝트", project: true },
	];
	const out: DirSpec[] = [];
	for (const spec of specs) if (!out.some((seen) => samePath(seen.path, spec.path))) out.push(spec);
	return out;
}

function nameOf(path: string): string {
	return basename(path, extname(path)).toLowerCase();
}

function themeSetting(env: ProbeEnv): string | undefined {
	const project = env.trusted ? env.host.projectSettings?.theme : undefined;
	const value = project ?? env.host.globalSettings?.theme;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function build(env: ProbeEnv, kind: Kind): Category {
	const col = makeCollector();
	const dirs = dirSpecs(env, kind);
	const ext = FILE_EXT[kind];
	const resolvedList = env.host.resolved?.[RESOLVED_KEY[kind]];
	const enabledPaths = (resolvedList ?? []).filter((entry) => entry.enabled).map((entry) => entry.path);
	const disabledPaths = (resolvedList ?? []).filter((entry) => !entry.enabled).map((entry) => entry.path);
	const winner = new Map<string, string>();
	const dirEntryPaths: string[] = [];

	for (const dir of dirs) {
		const untrusted = dir.project && !env.trusted;
		const stat = statKind(dir.path);
		if (stat.kind === "missing") {
			col.add({ path: dir.path, kind: "dir", status: "missing", reason: "폴더 없음", scope: dir.scope });
			continue;
		}
		if (stat.kind === "error") {
			col.add({ path: dir.path, kind: "dir", status: "error", reason: `읽지 못함: ${stat.message}`, scope: dir.scope });
			continue;
		}
		if (stat.kind !== "dir") {
			col.add({ path: dir.path, kind: "dir", status: "error", reason: "폴더가 아님", scope: dir.scope });
			continue;
		}
		const listed = listFiles(dir.path, ext);
		if (!listed.ok) {
			col.add({ path: dir.path, kind: "dir", status: "error", reason: `읽지 못함: ${listed.message}`, scope: dir.scope });
			continue;
		}
		col.add(untrusted
			? { path: dir.path, kind: "dir", status: "disabled", reason: "프로젝트 신뢰 안 함", scope: dir.scope, ...(listed.paths.length > 0 || listed.truncated ? { problem: "신뢰 안 한 프로젝트에 리소스 있음" } : {}) }
			: { path: dir.path, kind: "dir", status: "loaded", reason: "", scope: dir.scope });
		if (listed.truncated) col.add({ path: dir.path, kind: "dir", status: "error", reason: "목록 잘림", scope: dir.scope });

		for (const path of listed.paths) {
			dirEntryPaths.push(path);
			const name = nameOf(path);
			if (untrusted) {
				col.add({ path, kind: "file", status: "disabled", reason: "프로젝트 신뢰 안 함", scope: dir.scope });
				continue;
			}
			if (resolvedList !== undefined) {
				if (disabledPaths.some((entry) => samePath(entry, path))) {
					col.add({ path, kind: "file", status: "disabled", reason: "설정에서 끔", scope: dir.scope });
					continue;
				}
				if (!enabledPaths.some((entry) => samePath(entry, path))) {
					const won = winner.get(name);
					col.add(won !== undefined
						? { path, kind: "file", status: "shadowed", reason: "같은 이름이 먼저 들어옴", winner: won, scope: dir.scope }
						: { path, kind: "file", status: "shadowed", reason: "하네스가 건너뜀", scope: dir.scope });
					continue;
				}
			}
			const won = winner.get(name);
			if (won !== undefined) {
				col.add({ path, kind: "file", status: "shadowed", reason: "같은 이름이 먼저 들어옴", winner: won, scope: dir.scope });
				continue;
			}
			winner.set(name, path);
			col.add({ path, kind: "file", status: "loaded", reason: "", scope: dir.scope });
		}
	}

	// Resolved entries outside the candidate dirs (settings / omo plugin).
	for (const entry of resolvedList ?? []) {
		if (dirs.some((dir) => isUnder(entry.path, dir.path))) continue;
		const scope: Scope = omoAiPath(entry.path) ? "omo 플러그인" : "설정";
		if (!entry.enabled) {
			col.add({ path: entry.path, kind: "file", status: "disabled", reason: "설정에서 끔", scope });
			continue;
		}
		const stat = statKind(entry.path);
		if (stat.kind === "missing") {
			col.add({ path: entry.path, kind: "file", status: "missing", reason: "경로 없음", scope });
			continue;
		}
		if (stat.kind === "error") {
			col.add({ path: entry.path, kind: "file", status: "error", reason: `읽지 못함: ${stat.message}`, scope });
			continue;
		}
		col.add({ path: entry.path, kind: stat.kind === "dir" ? "dir" : "file", status: "loaded", reason: "", scope });
	}

	if (kind === "themes") {
		const active = themeSetting(env);
		if (active !== undefined) {
			const key = active.toLowerCase();
			const row = col.rows.find((probe) => probe.kind === "file" && probe.status === "loaded" && dirEntryPaths.some((path) => nameOf(path) === key && samePath(path, probe.path)));
			if (row !== undefined) row.reason = "사용 중";
			else col.add({ path: `builtin:${active}`, kind: "virtual", status: "loaded", reason: "내장 테마", scope: "내장" });
		}
	}

	return { id: kind as CategoryId, label: LABEL[kind], probes: col.rows, note: resolvedList !== undefined ? NOTE : `${NOTE} · 추정` };
}

export const probeTemplates: ProbeFn = (env) => build(env, "templates");
export const probeThemes: ProbeFn = (env) => build(env, "themes");
