// Report builder: runs every probe once and assembles the /where report.
// buildHostData runs exactly once per report; a probe that throws degrades to an
// error category instead of failing the whole scan.
import { buildHostData } from "./host.ts";
import { builtinId, type Category, type CategoryId, type ProbeEnv, type ProbeFn, type Report } from "./model.ts";
import { probeContext } from "./probes/context.ts";
import { probeExtensions } from "./probes/extensions.ts";
import { probeHooks, probeMcp } from "./probes/mcp-hooks.ts";
import { probeRules } from "./probes/rules.ts";
import { probeMemory, probeSettings } from "./probes/settings-memory.ts";
import { probeSkills } from "./probes/skills.ts";
import { probeSystemPrompt } from "./probes/system-prompt.ts";
import { probeTemplates, probeThemes } from "./probes/templates-themes.ts";

export { filterProblems, problemCount, summaryLine } from "./model.ts";

/** Display order of the categories in the /where overlay. */
export const CATEGORY_ORDER: readonly CategoryId[] = [
	"prompt",
	"context",
	"skills",
	"extensions",
	"rules",
	"templates",
	"themes",
	"mcp",
	"hooks",
	"memory",
	"settings",
];

export const CATEGORY_LABEL: Readonly<Record<CategoryId, string>> = {
	prompt: "시스템 프롬프트",
	context: "지침 파일",
	skills: "스킬",
	extensions: "확장",
	rules: "규칙",
	templates: "프롬프트 템플릿",
	themes: "테마",
	mcp: "MCP",
	hooks: "훅",
	memory: "메모리",
	settings: "설정",
};

const DEFAULT_PROBES: Readonly<Record<CategoryId, ProbeFn>> = {
	prompt: probeSystemPrompt,
	context: probeContext,
	skills: probeSkills,
	extensions: probeExtensions,
	rules: probeRules,
	templates: probeTemplates,
	themes: probeThemes,
	mcp: probeMcp,
	hooks: probeHooks,
	memory: probeMemory,
	settings: probeSettings,
};

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Builtin ids from live extension paths: "<builtin:id>" and "builtin:id" both count, undefined dropped, first-seen order. */
function builtinIdsOf(paths: readonly string[] | undefined): string[] {
	const ids: string[] = [];
	for (const path of paths ?? []) {
		const id = builtinId(path);
		if (id !== undefined && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** Builds the whole report: host data once, then every probe (override wins), each failing soft. */
export async function buildReport(base: Omit<ProbeEnv, "host">, probes: Partial<Record<CategoryId, ProbeFn>> = {}): Promise<Report> {
	const builtinIds = builtinIdsOf(base.live.extensionPaths);
	const { host, notices } = await buildHostData({
		cwd: base.cwd,
		agentDir: base.agentDir,
		home: base.home,
		trusted: base.trusted,
		senpi: base.senpi,
		builtinIds,
	});
	const env: ProbeEnv = { ...base, host };
	const categories: Category[] = [];
	for (const id of CATEGORY_ORDER) {
		const label = CATEGORY_LABEL[id];
		const probe = probes[id] ?? DEFAULT_PROBES[id];
		try {
			categories.push(await probe(env));
		} catch (error) {
			categories.push({ id, label, probes: [], error: describe(error) });
		}
	}
	return { cwd: base.cwd, agentDir: base.agentDir, categories, notices };
}
