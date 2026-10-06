// MCP and hook probes: which server configs and hook sources the harness read.
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { normPath } from "../model.ts";
import type { Probe, ProbeFn, Scope } from "../model.ts";

type Row = Omit<Probe, "rank">;
type Stat = "file" | "dir" | "other" | { error: string } | undefined;
type ReadResult = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };
type ServerEntry = { name: string; enabled: boolean };

function statOf(path: string): Stat {
	try {
		const s = statSync(path);
		if (s.isDirectory()) return "dir";
		if (s.isFile()) return "file";
		return "other";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function readConfig(path: string): ReadResult {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, message: "MCP 설정이 JSON 객체가 아님" };
		return { ok: true, value: parsed as Record<string, unknown> };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

/** settings.importConfigs from a parsed config; undefined when the key is absent. */
function importConfigsOf(read: ReadResult | undefined): readonly string[] | undefined {
	if (read === undefined || !read.ok) return undefined;
	const settings = read.value.settings;
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return undefined;
	const list = (settings as Record<string, unknown>).importConfigs;
	if (!Array.isArray(list)) return undefined;
	return list.filter((x): x is string => typeof x === "string");
}

function serverEntries(value: Record<string, unknown> | undefined): ServerEntry[] {
	const servers = value?.mcpServers;
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
	const out: ServerEntry[] = [];
	for (const [name, raw] of Object.entries(servers)) {
		const enabled = typeof raw !== "object" || raw === null || (raw as Record<string, unknown>).enabled !== false;
		out.push({ name, enabled });
	}
	return out;
}

export const probeMcp: ProbeFn = (env) => {
	const rows: Row[] = [];
	const push = (row: Row): void => {
		rows.push(row);
	};

	const globalPath = join(env.agentDir, "mcp.json");
	const claudePath = join(env.cwd, ".mcp.json");
	const projectPath = join(env.cwd, ".omo", "mcp.json");
	const cachePath = join(env.agentDir, "cache", "mcp-cache.json");

	const globalRead = readConfig(globalPath);
	const projectRead = env.trusted ? readConfig(projectPath) : undefined;
	const importConfigs = importConfigsOf(projectRead) ?? importConfigsOf(globalRead);
	const importClaude = importConfigs?.includes("claude") === true;

	// Per server name: the index of the row that currently wins and the file path that defined it.
	const winners = new Map<string, number>();
	const winnerPaths = new Map<string, string>();

	const emitFile = (o: { path: string; scope: Scope; enabled: boolean; disabledReason: string; problem?: string; read: () => ReadResult }): void => {
		const st = statOf(o.path);
		if (st === undefined) {
			push({ path: o.path, kind: "file", status: "missing", scope: o.scope, reason: "파일 없음" });
			return;
		}
		if (typeof st === "object") {
			push({ path: o.path, kind: "file", status: "error", scope: o.scope, reason: st.error });
			return;
		}
		if (st !== "file") {
			push({ path: o.path, kind: st === "dir" ? "dir" : "file", status: "error", scope: o.scope, reason: "설정 파일이 아님" });
			return;
		}
		if (!o.enabled) {
			push({ path: o.path, kind: "file", status: "disabled", scope: o.scope, reason: o.disabledReason, ...(o.problem !== undefined ? { problem: o.problem } : {}) });
			return;
		}
		const read = o.read();
		if (!read.ok) {
			push({ path: o.path, kind: "file", status: "error", scope: o.scope, reason: read.message });
			return;
		}
		push({ path: o.path, kind: "file", status: "loaded", scope: o.scope, reason: "MCP 설정 파일" });
		for (const server of serverEntries(read.value)) {
			const prev = winners.get(server.name);
			if (prev !== undefined) rows[prev] = { ...rows[prev], status: "shadowed", winner: o.path };
			push({
				path: `mcp:${server.name}`,
				kind: "virtual",
				status: server.enabled ? "loaded" : "disabled",
				scope: o.scope,
				reason: server.enabled ? basename(o.path) : "설정에서 끔",
			});
			winners.set(server.name, rows.length - 1);
			winnerPaths.set(server.name, o.path);
		}
	};

	emitFile({ path: globalPath, scope: "전역", enabled: true, disabledReason: "", read: () => globalRead });
	emitFile({
		path: claudePath,
		scope: "프로젝트",
		enabled: env.trusted && importClaude,
		disabledReason: env.trusted ? "Claude 설정 가져오기 꺼짐" : "프로젝트 신뢰 안 함",
		problem: "신뢰 안 한 프로젝트에 리소스 있음",
		read: () => readConfig(claudePath),
	});
	emitFile({
		path: projectPath,
		scope: "프로젝트",
		enabled: env.trusted,
		disabledReason: "프로젝트 신뢰 안 함",
		problem: "신뢰 안 한 프로젝트에 리소스 있음",
		read: () => projectRead ?? readConfig(projectPath),
	});

	const cacheStat = statOf(cachePath);
	if (cacheStat === undefined) push({ path: cachePath, kind: "file", status: "missing", scope: "전역", reason: "연결 정보 캐시" });
	else if (typeof cacheStat === "object") push({ path: cachePath, kind: "file", status: "error", scope: "전역", reason: cacheStat.error });
	else if (cacheStat !== "file") push({ path: cachePath, kind: cacheStat === "dir" ? "dir" : "file", status: "error", scope: "전역", reason: "캐시 파일이 아님" });
	else push({ path: cachePath, kind: "file", status: "loaded", scope: "전역", reason: "연결 정보 캐시" });

	// Extension-declared servers; a trusted file source with the same name wins (harness rule, no host function).
	const declared = new Set<string>();
	for (const item of env.live.mcpServers ?? []) {
		const name = item?.name;
		if (typeof name !== "string" || name.length === 0 || declared.has(name)) continue;
		declared.add(name);
		const extensionPath = item?.extensionPath;
		const scope: Scope = extensionPath !== undefined && normPath(extensionPath).includes("omo-ai") ? "omo 플러그인" : "세션";
		const winnerIndex = winners.get(name);
		if (winnerIndex !== undefined) {
			push({ path: `mcp:${name}`, kind: "virtual", status: "shadowed", scope, reason: "확장이 선언", winner: winnerPaths.get(name) ?? "" });
		} else {
			push({ path: `mcp:${name}`, kind: "virtual", status: "loaded", scope, reason: "확장이 선언" });
		}
	}

	const probes: Probe[] = rows.map((r, i) => ({ rank: i + 1, ...r }));
	return {
		id: "mcp",
		label: "MCP",
		note: "MCP 파일 병합 순서, 서버별 밀림, enabled 판정은 하네스 공개 함수가 없어 직접 판정함",
		probes,
	};
};

function hasKey(o: Record<string, unknown> | undefined, key: string): boolean {
	return o !== undefined && Object.keys(o).includes(key);
}

export const probeHooks: ProbeFn = (env) => {
	const rows: Row[] = [];
	const push = (row: Row): void => {
		rows.push(row);
	};
	const hooks = env.live.hookSources;

	const addSource = (path: string, scope: Scope, untrusted: boolean, reasonFile: string, reasonDir: string): void => {
		const st = statOf(path);
		if (st === undefined) {
			push({ path, kind: "file", status: "missing", scope, reason: "파일 없음" });
			return;
		}
		if (typeof st === "object") {
			push({ path, kind: "file", status: "error", scope, reason: st.error });
			return;
		}
		const kind: Probe["kind"] = st === "dir" ? "dir" : "file";
		if (untrusted) {
			push({ path, kind, status: "disabled", scope, reason: "프로젝트 신뢰 안 함", problem: "신뢰 안 한 프로젝트에 리소스 있음" });
			return;
		}
		push({ path, kind, status: "loaded", scope, reason: st === "dir" ? reasonDir : reasonFile });
	};

	// 1. Global settings inline hooks.
	push(hasKey(env.host.globalSettings, "hooks")
		? { path: "hook:global-settings", kind: "virtual", status: "loaded", scope: "설정", reason: "설정에 hooks 있음" }
		: { path: "hook:global-settings", kind: "virtual", status: "missing", scope: "설정", reason: "설정에 hooks 없음" });

	// 2. Global hooks file.
	addSource(hooks?.globalHooksPath ?? join(env.agentDir, "hooks.json"), "전역", false, "전역 훅 파일", "전역 훅 폴더");
	// 3. Global hook source dirs.
	for (const p of hooks?.globalHookSourcePaths ?? []) addSource(p, "전역", false, "전역 훅 파일", "전역 훅 폴더");

	// 4. Project settings inline hooks.
	if (!env.trusted) push({ path: "hook:project-settings", kind: "virtual", status: "disabled", scope: "설정", reason: "프로젝트 신뢰 안 함" });
	else if (hasKey(env.host.projectSettings, "hooks")) push({ path: "hook:project-settings", kind: "virtual", status: "loaded", scope: "설정", reason: "설정에 hooks 있음" });
	else push({ path: "hook:project-settings", kind: "virtual", status: "missing", scope: "설정", reason: "설정에 hooks 없음" });

	// 5. Project hooks file.
	addSource(hooks?.projectHooksPath ?? join(env.cwd, ".omo", "hooks.json"), "프로젝트", !env.trusted, "프로젝트 훅 파일", "프로젝트 훅 폴더");
	// 6. Project hook source dirs.
	for (const p of hooks?.projectHookSourcePaths ?? []) addSource(p, "프로젝트", !env.trusted, "프로젝트 훅 파일", "프로젝트 훅 폴더");
	// 7. Pre-session (plugin) hook source dirs.
	for (const p of hooks?.preSessionHookSourcePaths ?? []) addSource(p, "세션", false, "세션 전 훅 파일", "세션 전 훅 폴더");

	const probes: Probe[] = rows.map((r, i) => ({ rank: i + 1, ...r }));
	return {
		id: "hooks",
		label: "훅",
		note: "훅 소스 순서와 전역/프로젝트 기본 경로는 하네스 공개 함수가 없어 직접 판정함",
		probes,
	};
};
