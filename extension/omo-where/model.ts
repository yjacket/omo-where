// Shared contract for omo-where modules. Changes here need a lead decision.
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
export type Status = "loaded" | "missing" | "shadowed" | "disabled" | "error";
export type CategoryId = "prompt" | "context" | "skills" | "extensions" | "rules" | "templates" | "themes" | "mcp" | "hooks" | "memory" | "settings";
export type Live = "match" | "session-only" | "disk-only" | "changed";
export type Scope = "전역" | "프로젝트" | "상위 폴더" | "omo 플러그인" | "내장" | "설정" | "세션" | "다른 에이전트 폴더" | "Claude Code 폴더";
export type Probe = {
	readonly id: string; // stable key, unique within the category
	readonly rank: number; // 1-based harness priority within the category
	readonly path: string; // absolute path (node:path form) or virtual id ("builtin:mcp", "system-prompt", "setting:theme")
	readonly kind: "file" | "dir" | "virtual";
	readonly status: Status;
	readonly reason: string; // Korean, label level
	readonly scope?: Scope;
	readonly winner?: string; // path that won, when status is "shadowed"
	readonly problem?: string; // Korean problem text when the row needs attention
	readonly live?: Live;
	readonly text?: string; // virtual content for the viewer
};
export type Category = { readonly id: CategoryId; readonly label: string; readonly probes: readonly Probe[]; readonly note?: string; readonly error?: string };
export type Report = { readonly cwd: string; readonly agentDir: string; readonly categories: readonly Category[]; readonly notices: readonly string[] };
export type ResolvedEntry = { readonly path: string; readonly enabled: boolean; readonly metadata: Readonly<Record<string, unknown>> };
export type Resolved = Readonly<Record<"extensions" | "skills" | "prompts" | "themes" | "hooks", readonly ResolvedEntry[]>>;
export type HookSources = { readonly agentDir?: string; readonly cwd?: string; readonly globalHooksPath?: string; readonly projectHooksPath?: string; readonly globalHookSourcePaths?: readonly string[]; readonly projectHookSourcePaths?: readonly string[]; readonly preSessionHookSourcePaths?: readonly string[] };
export type LiveState = {
	readonly contextFiles?: readonly { readonly path: string; readonly content?: string }[];
	readonly skills?: readonly { readonly name: string; readonly filePath: string }[];
	readonly extensionPaths?: readonly string[]; // ctx.loadedExtensionPaths; builtins appear as "<builtin:<id>>" (also accept "builtin:<id>"), other "<...>" entries are synthetic
	readonly systemPrompt?: string;
	readonly mcpServers?: readonly { readonly name: string; readonly extensionPath?: string }[];
	readonly hookSources?: HookSources;
	readonly model?: { readonly provider?: string; readonly id?: string };
};
export type SenpiApi = {
	readonly DefaultPackageManager?: new (o: { cwd: string; agentDir: string; settingsManager: unknown; builtinExtensions?: string[] }) => { resolve(onMissing: (source: unknown) => "skip" | "error" | Promise<"skip" | "error">): Promise<Resolved> };
	readonly SettingsManager?: { fromStorage(storage: ReadOnlySettingsStorage, o?: { projectTrusted?: boolean }): { getGlobalSettings(): Record<string, unknown>; getProjectSettings(): Record<string, unknown> } }; // NEVER create(): it can rewrite settings files
	readonly loadSkills?: (o: { cwd: string; agentDir: string; skillPaths: string[]; includeDefaults: boolean }) => { skills: { name: string; filePath: string }[]; diagnostics: { type: string; message: string; path?: string; collision?: { name: string; winnerPath: string; loserPath: string } }[] };
	readonly loadSkillsFromDir?: (o: { dir: string; source: string }) => { skills: { name: string; filePath: string; description?: string }[]; diagnostics: { type: string; message: string; path?: string }[] };
	readonly loadProjectContextFiles?: (o: { cwd: string; agentDir: string }) => { path: string; content: string }[];
	readonly parseFrontmatter?: (text: string) => { frontmatter: Record<string, unknown>; body: string };
	readonly hasTrustRequiringProjectResources?: (cwd: string) => boolean;
};
/** Settings storage whose writes are discarded: withLock passes the current file text to fn and ignores the return value. */
export type ReadOnlySettingsStorage = { withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void; selectSource(scope: "global" | "project"): { path: string; format: "json" | "jsonc"; reason: string; scope: "global" | "project" } | undefined };
export type HostData = { readonly resolved?: Resolved; readonly globalSettings?: Readonly<Record<string, unknown>>; readonly projectSettings?: Readonly<Record<string, unknown>>; readonly missingPackages: readonly string[] };
export type ProbeEnv = {
	readonly cwd: string;
	readonly agentDir: string;
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly trusted: boolean;
	readonly senpi: SenpiApi; // every member may be undefined (feature-detected)
	readonly host: HostData; // computed once per scan by host.ts
	readonly live: LiveState; // every member may be undefined
};
export type ProbeFn = (env: ProbeEnv) => Category | Promise<Category>;
export const STATUS_LABEL: Readonly<Record<Status, string>> = { loaded: "들어옴", missing: "없음", shadowed: "밀림", disabled: "꺼짐", error: "오류" };
export const LIVE_LABEL: Readonly<Record<Exclude<Live, "match">, string>> = { "session-only": "세션에만", "disk-only": "디스크에만", changed: "바뀜" };
export const LIVE_PROBLEM: Readonly<Record<Exclude<Live, "match">, string>> = {
	"session-only": "세션에는 있지만 지금 디스크에 없음 - 지운 뒤 /reload 안 함?",
	"disk-only": "세션 시작 뒤 생김 - /reload 해야 들어옴",
	changed: "세션 시작 뒤 내용이 바뀜 - /reload 해야 적용",
};
export const SECRET_KEY = /key|token|secret|pass|auth|cookie|cred/i;
/** Path equality across "/", "\", file:// and drive-letter case; realpath when the path exists. */
export function samePath(a: string, b: string): boolean { return normPath(a) === normPath(b); }
export function normPath(p: string): string {
	let s = p.startsWith("file://") ? decodeURIComponent(p.replace(/^file:\/\/\/?/, "")) : p;
	s = resolvePath(s);
	try { s = realpathSync.native(s); } catch { /* not on disk: compare the resolved form */ }
	s = s.replace(/\\/g, "/");
	return process.platform === "win32" ? s.toLowerCase() : s;
}
/** Synthetic extension paths are never looked up on disk. */
export function isSyntheticPath(p: string): boolean { return p.startsWith("builtin:") || p.startsWith("<"); }
/** "<builtin:mcp>" or "builtin:mcp" -> "mcp"; anything else -> undefined. */
export function builtinId(p: string): string | undefined { return /^<builtin:([^>]+)>$/.exec(p)?.[1] ?? /^builtin:(.+)$/.exec(p)?.[1]; }
export function problemCount(c: Category): number { return c.probes.filter((p) => p.problem !== undefined || p.status === "error").length + (c.error ? 1 : 0); }
export function filterProblems(c: Category): Category { return { ...c, probes: c.probes.filter((p) => p.problem !== undefined || p.status === "error") }; }
export function summaryLine(r: Report): string {
	const all = r.categories.flatMap((c) => c.probes);
	const n = (s: Status) => all.filter((p) => p.status === s).length;
	const problems = r.categories.reduce((t, c) => t + problemCount(c), 0);
	return `문제 ${problems}개 · 들어옴 ${n("loaded")} · 없음 ${n("missing")} · 밀림 ${n("shadowed")} · 꺼짐 ${n("disabled")}`;
}
