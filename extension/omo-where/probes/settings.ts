// Probe: 설정. The host decides loaded/shadowed/disabled from its snapshot
// (env.host.globalSettings/projectSettings, env.trusted); this module only lists the
// candidate locations, the 없음 rows and the reason strings.
// No host function exposes the jsonc-before-json rule or the omo.jsonc/trust.json locations,
// so those harness rules are mirrored here and noted in Category.note.
import { dirname, join, resolve as resolvePath } from "node:path";
import { SECRET_KEY, samePath, type ProbeEnv, type ProbeFn, type Scope } from "../model.ts";
import { makeCollector, statKind, type Row } from "./fs-util.ts";

const UNTRUSTED_REASON = "프로젝트 신뢰 안 함";
const RESOURCE_PROBLEM = "신뢰 안 한 프로젝트에 리소스 있음";
const CONFIG_DIR_NAME = ".omo";
const MAX_PARENT_CONFIG_SEARCH_DEPTH = 100;
const UNKNOWN_TEXT = "알 수 없음(내부 기능 없음)";
const SETTINGS_NOTE = "settings.jsonc가 settings.json보다 먼저 · omo.jsonc는 omo 플러그인이 읽음 · 값은 세션 설정 스냅샷";

// --- value summaries ---------------------------------------------------------

function compact(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null) return "null";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Masks the value of any key matching SECRET_KEY so no secret ever reaches a row. */
function maskValue(key: string, value: unknown): string {
	return SECRET_KEY.test(key) ? "<가림>" : compact(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- rows --------------------------------------------------------------------

function findProjectConfigDir(cwd: string, home: string): string | undefined {
	let current = resolvePath(cwd);
	const stop = resolvePath(home);
	for (let depth = 0; depth <= MAX_PARENT_CONFIG_SEARCH_DEPTH; depth += 1) {
		if (samePath(current, stop)) return undefined;
		const configDir = join(current, CONFIG_DIR_NAME);
		if (statKind(configDir).kind === "dir") return configDir;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

function fileRow(file: string, scope: Scope, options: { readonly errorReason: string; readonly reason: string; readonly gated?: boolean; readonly shadow?: { readonly winner: string; readonly reason: string } }): Row {
	const stat = statKind(file);
	if (stat.kind === "error") return { path: file, kind: "file", status: "error", reason: `${options.errorReason}: ${stat.message}`, scope };
	if (stat.kind !== "file") return { path: file, kind: "file", status: "missing", reason: "파일 없음", scope };
	if (options.gated === true) return { path: file, kind: "file", status: "disabled", reason: UNTRUSTED_REASON, scope };
	if (options.shadow !== undefined) return { path: file, kind: "file", status: "shadowed", reason: options.shadow.reason, scope, winner: options.shadow.winner };
	return { path: file, kind: "file", status: "loaded", reason: options.reason, scope };
}

function presetSummary(env: ProbeEnv): { readonly text: string; readonly reason: string } {
	const global = env.host.globalSettings;
	const project = env.host.projectSettings;
	if (global === undefined && project === undefined) return { text: UNKNOWN_TEXT, reason: "내부 기능 없음" };
	if (project?.promptPreset !== undefined) return { text: maskValue("promptPreset", project.promptPreset), reason: "출처: 프로젝트 설정" };
	if (global?.promptPreset !== undefined) return { text: maskValue("promptPreset", global.promptPreset), reason: "출처: 설정" };
	return { text: "auto", reason: "출처: 기본값" };
}

const PROMPT_MODES = new Set(["full", "preset-append", "override"]);
function parsePromptMode(value: unknown): string | undefined {
	return typeof value === "string" && PROMPT_MODES.has(value) ? value : undefined;
}

/** Mirrors anthropic-subscription/settings.js: env mode > systemPromptMode (project > global) > legacy appendSystemPrompt > "full". */
function providerBlock(settings: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> | undefined {
	if (settings === undefined) return undefined;
	const raw = settings.anthropicSubscriptionProvider ?? settings.claudeSdkOauthProvider;
	return isRecord(raw) ? raw : undefined;
}

function laneSummary(env: ProbeEnv): { readonly text: string; readonly reason: string } {
	const global = env.host.globalSettings;
	const project = env.host.projectSettings;
	if (global === undefined && project === undefined) return { text: UNKNOWN_TEXT, reason: "내부 기능 없음" };
	const globalBlock = providerBlock(global);
	const projectBlock = providerBlock(project);
	const environmentMode = parsePromptMode(env.env.SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE);
	let mode: string;
	let source: string;
	if (environmentMode !== undefined) {
		mode = environmentMode;
		source = "환경변수";
	} else {
		const projectMode = parsePromptMode(projectBlock?.systemPromptMode);
		const globalMode = parsePromptMode(globalBlock?.systemPromptMode);
		const projectAppend = typeof projectBlock?.appendSystemPrompt === "boolean" ? projectBlock.appendSystemPrompt : undefined;
		const globalAppend = typeof globalBlock?.appendSystemPrompt === "boolean" ? globalBlock.appendSystemPrompt : undefined;
		if (projectMode !== undefined) {
			mode = projectMode;
			source = "프로젝트 설정";
		} else if (globalMode !== undefined) {
			mode = globalMode;
			source = "설정";
		} else if (projectAppend !== undefined || globalAppend !== undefined) {
			mode = (projectAppend ?? globalAppend) === true ? "full" : "preset-append";
			source = "옛 appendSystemPrompt";
		} else {
			mode = "full";
			source = "기본값";
		}
	}
	const block: Record<string, unknown> = { ...(globalBlock ?? {}), ...(projectBlock ?? {}) };
	const summary = Object.keys(block)
		.sort()
		.map((key) => `${key}=${maskValue(key, block[key])}`)
		.join(", ");
	return { text: summary === "" ? mode : `${mode} · ${summary}`, reason: `출처: ${source}` };
}

export const probeSettings: ProbeFn = (env) => {
	const col = makeCollector();

	const globalJsonc = join(env.agentDir, "settings.jsonc");
	const globalJson = join(env.agentDir, "settings.json");
	const globalJsoncExists = statKind(globalJsonc).kind === "file";
	col.add(fileRow(globalJsonc, "전역", { errorReason: "읽지 못함", reason: "전역 설정" }));
	col.add(fileRow(globalJson, "전역", globalJsoncExists ? { errorReason: "읽지 못함", reason: "전역 설정", shadow: { winner: globalJsonc, reason: "jsonc가 먼저" } } : { errorReason: "읽지 못함", reason: "전역 설정" }));

	const projectDir = findProjectConfigDir(env.cwd, env.home);
	if (projectDir !== undefined) {
		const gated = !env.trusted;
		const projectJsonc = join(projectDir, "settings.jsonc");
		const projectJson = join(projectDir, "settings.json");
		const projectJsoncExists = statKind(projectJsonc).kind === "file";
		const projectJsonExists = statKind(projectJson).kind === "file";
		const hasAny = projectJsoncExists || projectJsonExists;
		if (gated) {
			col.add({ path: projectDir, kind: "dir", status: "disabled", reason: UNTRUSTED_REASON, scope: "프로젝트", ...(hasAny ? { problem: RESOURCE_PROBLEM } : {}) });
		} else {
			col.add({ path: projectDir, kind: "dir", status: hasAny ? "loaded" : "missing", reason: hasAny ? "프로젝트 설정 폴더" : "설정 파일 없음", scope: "프로젝트" });
		}
		col.add(fileRow(projectJsonc, "프로젝트", { errorReason: "읽지 못함", reason: "프로젝트 설정", gated }));
		col.add(fileRow(projectJson, "프로젝트", projectJsoncExists ? { errorReason: "읽지 못함", reason: "프로젝트 설정", gated, shadow: { winner: projectJsonc, reason: "jsonc가 먼저" } } : { errorReason: "읽지 못함", reason: "프로젝트 설정", gated }));
	}

	col.add(fileRow(join(env.agentDir, "trust.json"), "전역", { errorReason: "읽지 못함", reason: "프로젝트 신뢰 기록" }));

	const homeOmoConfig = join(env.home, ".omo", "omo.jsonc");
	const cwdOmoConfig = join(env.cwd, ".omo", "omo.jsonc");
	col.add(fileRow(homeOmoConfig, "전역", { errorReason: "읽지 못함", reason: "omo 설정" }));
	if (!samePath(cwdOmoConfig, homeOmoConfig)) col.add(fileRow(cwdOmoConfig, "프로젝트", { errorReason: "읽지 못함", reason: "omo 프로젝트 설정", gated: !env.trusted }));

	const model = env.live.model;
	const modelKnown = model !== undefined && (model.provider !== undefined || model.id !== undefined);
	col.add({
		path: "setting:model",
		kind: "virtual",
		status: "loaded",
		scope: "세션",
		reason: modelKnown ? "세션 정보" : "내부 기능 없음",
		text: modelKnown ? [model?.provider, model?.id].filter((part) => part !== undefined && part !== "").join("/") : UNKNOWN_TEXT,
	});

	const preset = presetSummary(env);
	col.add({ path: "setting:prompt-preset", kind: "virtual", status: "loaded", scope: "설정", reason: preset.reason, text: preset.text });

	const lane = laneSummary(env);
	col.add({ path: "setting:claude-lane", kind: "virtual", status: "loaded", scope: "설정", reason: lane.reason, text: lane.text });

	col.add({ path: "setting:trust", kind: "virtual", status: "loaded", scope: "세션", reason: "세션 정보", text: env.trusted ? "신뢰함" : "신뢰 안 함" });

	return { id: "settings", label: "설정", probes: col.finish(), note: SETTINGS_NOTE };
};
