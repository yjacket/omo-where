// Extensions probe: where the harness looked for extensions and what it actually loaded.
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { builtinId, isSyntheticPath, LIVE_PROBLEM, normPath, samePath } from "../model.ts";
import type { Probe, Scope } from "../model.ts";

type Row = Omit<Probe, "rank">;
type Stat = "file" | "dir" | "other" | { error: string } | undefined;
type Cand = {
	path: string;
	kind: "file" | "dir";
	loadable: boolean;
	scope: Scope;
	reason: string;
	problem?: string;
	error?: string;
	untrusted: boolean;
};

const LOADABLE_EXT = /\.(ts|js)$/i;
const ENTRY_FILES = ["index.ts", "index.js", "package.json"];
const RUNTIME_MARK = "/.omo/agent/runtime/";
const OMO_AI_MARK = "/node_modules/omo-ai/";
const MAX_ENTRIES = 2000;

function statOf(p: string): Stat {
	try {
		const s = statSync(p);
		if (s.isDirectory()) return "dir";
		if (s.isFile()) return "file";
		return "other";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function namesOf(dir: string): { names: string[]; truncated: boolean } | { error: string } {
	try {
		const names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		if (names.length > MAX_ENTRIES) return { names: names.slice(0, MAX_ENTRIES), truncated: true };
		return { names, truncated: false };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Extension basename: strips .ts/.js and turns "index" into the folder name. */
function extName(p: string): string {
	let name = basename(p).replace(LOADABLE_EXT, "");
	if (name === "index") name = basename(dirname(p));
	return name;
}

function virtualLoaded(p: string): Row {
	const id = builtinId(p);
	if (id !== undefined) return { path: `builtin:${id}`, kind: "virtual", status: "loaded", scope: "내장", reason: "내장 확장" };
	return { path: p, kind: "virtual", status: "loaded", scope: "세션", reason: "임시 확장" };
}

function realLoadedRow(p: string, stat: "file" | "dir" | "other"): Row {
	const kind: Probe["kind"] = stat === "dir" ? "dir" : "file";
	const n = normPath(p);
	if (n.includes(RUNTIME_MARK)) return { path: p, kind, status: "loaded", scope: "내장", reason: "내장 확장(번들)" };
	const scope: Scope = n.includes(OMO_AI_MARK) ? "omo 플러그인" : "세션";
	return { path: p, kind, status: "loaded", scope, reason: "-e 또는 플러그인으로 들어옴" };
}

function collectCands(dir: string, scope: Scope, names: readonly string[], untrusted: boolean): Cand[] {
	const out: Cand[] = [];
	for (const name of names) {
		const full = join(dir, name);
		const st = statOf(full);
		if (st === undefined) {
			out.push({ path: full, kind: "file", loadable: false, scope, reason: "지금 디스크에 없음", untrusted });
			continue;
		}
		if (typeof st === "object") {
			out.push({ path: full, kind: "file", loadable: false, scope, reason: st.error, error: st.error, untrusted });
			continue;
		}
		if (st === "dir") {
			const hasEntry = ENTRY_FILES.some((f) => statOf(join(full, f)) === "file");
			out.push(hasEntry
				? { path: full, kind: "dir", loadable: true, scope, reason: "확장 폴더", untrusted }
				: { path: full, kind: "dir", loadable: false, scope, reason: "진입 파일 없음", problem: "진입 파일 없음 - 남은 폴더?", untrusted });
			continue;
		}
		if (st === "file" && LOADABLE_EXT.test(name)) {
			out.push({ path: full, kind: "file", loadable: true, scope, reason: "확장 파일", untrusted });
			continue;
		}
		out.push({ path: full, kind: "file", loadable: false, scope, reason: "확장 아님", problem: `확장으로 안 읽힘(${name}) - 남은 파일?`, untrusted });
	}
	return out;
}

function stringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export const probeExtensions: ProbeFn = (env) => {
	const rows: Row[] = [];
	const dups: { index: number; name: string }[] = [];
	const push = (row: Row, dupName?: string): void => {
		if (dupName !== undefined) dups.push({ index: rows.length, name: dupName });
		rows.push(row);
	};

	const livePaths = env.live.extensionPaths;
	const liveDefined = livePaths !== undefined;
	const resolved = env.host.resolved?.extensions;
	const sourcePaths: readonly string[] = liveDefined ? (livePaths ?? []) : (resolved ?? []).filter((e) => e.enabled).map((e) => e.path);

	const loadedSet = new Set<string>();
	const virtualRows: Row[] = [];
	for (const p of sourcePaths) {
		if (isSyntheticPath(p)) virtualRows.push(virtualLoaded(p));
		else loadedSet.add(normPath(p));
	}

	const candidates: Cand[] = [];
	const isLoadedCand = (c: Cand): boolean => {
		if (loadedSet.has(normPath(c.path))) return true;
		if (c.kind !== "dir") return false;
		return loadedSet.has(normPath(join(c.path, "index.ts"))) || loadedSet.has(normPath(join(c.path, "index.js")));
	};
	const isResolvedDisabled = (c: Cand): boolean => (resolved ?? []).some((e) => !e.enabled
		&& (samePath(e.path, c.path)
			|| (c.kind === "dir" && (samePath(e.path, join(c.path, "index.ts")) || samePath(e.path, join(c.path, "index.js"))))));

	const dirSpecs: { path: string; scope: Scope; projectGated: boolean }[] = [
		{ path: join(env.cwd, ".omo", "extensions"), scope: "프로젝트", projectGated: true },
		{ path: join(env.cwd, ".pi", "extensions"), scope: "프로젝트", projectGated: true },
		{ path: join(env.agentDir, "extensions"), scope: "전역", projectGated: false },
	];

	for (const spec of dirSpecs) {
		const st = statOf(spec.path);
		if (st === undefined) {
			push({ path: spec.path, kind: "dir", status: "missing", scope: spec.scope, reason: "폴더 없음" });
			continue;
		}
		if (typeof st === "object") {
			push({ path: spec.path, kind: "dir", status: "error", scope: spec.scope, reason: st.error });
			continue;
		}
		if (st !== "dir") {
			push({ path: spec.path, kind: "file", status: "error", scope: spec.scope, reason: "폴더가 아님" });
			continue;
		}
		const listed = namesOf(spec.path);
		if ("error" in listed) {
			push({ path: spec.path, kind: "dir", status: "error", scope: spec.scope, reason: listed.error });
			continue;
		}
		const untrusted = spec.projectGated && !env.trusted;
		const dirRow: Row = untrusted
			? { path: spec.path, kind: "dir", status: "disabled", scope: spec.scope, reason: "프로젝트 신뢰 안 함", ...(listed.names.length > 0 || listed.truncated ? { problem: "신뢰 안 한 프로젝트에 리소스 있음" } : {}) }
			: { path: spec.path, kind: "dir", status: "loaded", scope: spec.scope, reason: "폴더 검색" };
		push(dirRow);
		const cands = collectCands(spec.path, spec.scope, listed.names, untrusted);
		candidates.push(...cands);
		for (const c of cands) emitCand(c, push, liveDefined, isLoadedCand, isResolvedDisabled);
		if (listed.truncated) push({ path: spec.path, kind: "dir", status: "error", scope: spec.scope, reason: "목록 잘림" });
	}

	// Other-harness agent folders are never read by this session.
	for (const other of [join(env.home, ".pi", "agent"), join(env.home, ".senpi", "agent")]) {
		if (samePath(other, env.agentDir)) continue;
		if (statOf(other) !== "dir") continue;
		const ext = join(other, "extensions");
		if (statOf(ext) !== "dir") continue;
		push({ path: ext, kind: "dir", status: "disabled", scope: "다른 에이전트 폴더", reason: "지금 세션은 이 폴더를 안 읽음" });
		const listed = namesOf(ext);
		if ("error" in listed) {
			push({ path: ext, kind: "dir", status: "error", scope: "다른 에이전트 폴더", reason: listed.error });
			continue;
		}
		for (const c of collectCands(ext, "다른 에이전트 폴더", listed.names, false)) {
			push({ path: c.path, kind: c.kind, status: "disabled", scope: "다른 에이전트 폴더", reason: "지금 세션은 이 폴더를 안 읽음", ...(c.problem !== undefined ? { problem: c.problem } : {}) });
		}
	}

	for (const r of virtualRows) push(r);

	const covered = (p: string): boolean => candidates.some((c) => samePath(c.path, p)
		|| (c.kind === "dir" && (samePath(join(c.path, "index.ts"), p) || samePath(join(c.path, "index.js"), p))));

	// Live paths the session actually loaded; skipped when a scanned candidate row covers the same file.
	for (const p of sourcePaths) {
		if (isSyntheticPath(p)) continue;
		if (covered(p)) continue;
		const st = statOf(p);
		if (st === undefined) {
			push({ path: p, kind: "file", status: "missing", scope: "세션", reason: "지금 디스크에 없음", live: "session-only", problem: LIVE_PROBLEM["session-only"] });
			continue;
		}
		if (typeof st === "object") {
			push({ path: p, kind: "file", status: "error", scope: "세션", reason: st.error });
			continue;
		}
		push(realLoadedRow(p, st), extName(p));
	}

	// Settings entries like "-builtin:mcp" / "!builtin:mcp" turn a builtin off.
	const settingRows = new Map<string, Row>();
	for (const settings of [env.host.globalSettings, env.host.projectSettings]) {
		for (const s of stringArray(settings?.extensions)) {
			const m = /^[-!]builtin:(.+)$/.exec(s);
			const id = m?.[1];
			if (id === undefined) continue;
			settingRows.set(id, { path: `builtin:${id}`, kind: "virtual", status: "disabled", scope: "설정", reason: "설정에서 끔" });
		}
	}
	for (const r of settingRows.values()) push(r);

	for (const pkg of env.host.missingPackages) {
		push({ path: pkg, kind: "virtual", status: "missing", scope: "설정", reason: "설정 패키지", problem: "설정의 패키지가 없음" });
	}

	// Duplicate extension names across loaded/loadable candidates.
	const byName = new Map<string, number[]>();
	for (const d of dups) {
		const arr = byName.get(d.name) ?? [];
		arr.push(d.index);
		byName.set(d.name, arr);
	}
	for (const idxs of byName.values()) {
		if (idxs.length < 2) continue;
		for (const i of idxs) {
			const cur = rows[i];
			if (cur === undefined) continue;
			rows[i] = { ...cur, problem: cur.problem === undefined ? "같은 이름 확장이 여러 곳" : `${cur.problem} · 같은 이름 확장이 여러 곳` };
		}
	}

	const probes: Probe[] = rows.map((r, i) => ({ rank: i + 1, ...r }));
	return {
		id: "extensions",
		label: "확장",
		note: "확장 자동 탐색 규칙(진입 파일 이름, 내장 설정)은 하네스 공개 함수가 없어 직접 판정함",
		probes,
	};
};

function emitCand(c: Cand, push: (row: Row, dupName?: string) => void, liveDefined: boolean, isLoaded: (c: Cand) => boolean, isResolvedDisabled: (c: Cand) => boolean): void {
	if (c.error !== undefined) {
		push({ path: c.path, kind: c.kind, status: "error", scope: c.scope, reason: c.reason });
		return;
	}
	const dupName = c.loadable ? extName(c.path) : undefined;
	if (c.untrusted) {
		push({ path: c.path, kind: c.kind, status: "disabled", scope: c.scope, reason: "프로젝트 신뢰 안 함", ...(c.problem !== undefined ? { problem: c.problem } : {}) }, dupName);
		return;
	}
	if (!c.loadable) {
		push({ path: c.path, kind: c.kind, status: "disabled", scope: c.scope, reason: c.reason, ...(c.problem !== undefined ? { problem: c.problem } : {}) });
		return;
	}
	if (isLoaded(c)) {
		push({ path: c.path, kind: c.kind, status: "loaded", scope: c.scope, reason: c.reason, ...(liveDefined ? { live: "match" as const } : {}) }, dupName);
		return;
	}
	if (isResolvedDisabled(c)) {
		push({ path: c.path, kind: c.kind, status: "disabled", scope: c.scope, reason: "설정에서 끔" }, dupName);
		return;
	}
	push({ path: c.path, kind: c.kind, status: "loaded", scope: c.scope, reason: c.reason, live: "disk-only", problem: LIVE_PROBLEM["disk-only"] }, dupName);
}
