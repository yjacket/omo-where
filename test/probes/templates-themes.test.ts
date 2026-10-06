import { afterEach, describe, expect, test } from "bun:test";
import { type HostData, type Probe, type ProbeEnv, type Resolved, type ResolvedEntry, samePath } from "../../extension/omo-where/model.ts";
import { probeTemplates, probeThemes } from "../../extension/omo-where/probes/templates-themes.ts";
import { makeTree, type Tree } from "../helpers/tree.ts";

const trees: Tree[] = [];
afterEach(() => {
	while (trees.length > 0) trees.pop()?.cleanup();
});

type ResolvedParts = { prompts?: readonly ResolvedEntry[]; themes?: readonly ResolvedEntry[] };

function resolvedOf(parts: ResolvedParts = {}): Resolved {
	return { extensions: [], skills: [], prompts: parts.prompts ?? [], themes: parts.themes ?? [], hooks: [] };
}

function entry(path: string, enabled = true): ResolvedEntry {
	return { path, enabled, metadata: {} };
}

function envOf(options: { cwd: string; agentDir: string; home: string; trusted?: boolean; host?: Partial<HostData> }): ProbeEnv {
	return {
		cwd: options.cwd,
		agentDir: options.agentDir,
		home: options.home,
		env: {},
		trusted: options.trusted ?? true,
		senpi: {},
		host: { missingPackages: [], ...options.host },
		live: {},
	};
}

function find(probes: readonly Probe[], path: string): Probe | undefined {
	return probes.find((probe) => samePath(probe.path, path));
}

describe("probeTemplates", () => {
	test("acceptance: template collision - first dir wins, later file shadowed with winner", () => {
		const tree = makeTree({ "agent/prompts/x.md": "global", "proj/.omo/prompts/x.md": "project" });
		trees.push(tree);
		const category = probeTemplates(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(category.id).toBe("templates");
		expect(category.label).toBe("프롬프트 템플릿");
		const winner = find(category.probes, tree.path("agent/prompts/x.md"));
		expect(winner?.status).toBe("loaded");
		expect(winner?.scope).toBe("전역");
		const loser = find(category.probes, tree.path("proj/.omo/prompts/x.md"));
		expect(loser?.status).toBe("shadowed");
		expect(loser?.reason).toBe("같은 이름이 먼저 들어옴");
		expect(samePath(loser?.winner ?? "", tree.path("agent/prompts/x.md"))).toBe(true);
		expect(category.note).toContain("추정");
	});

	test("acceptance: template collision with resolved - the non-resolved loser is shadowed", () => {
		const tree = makeTree({ "agent/prompts/x.md": "global", "proj/.omo/prompts/x.md": "project" });
		trees.push(tree);
		const host: Partial<HostData> = { resolved: resolvedOf({ prompts: [entry(tree.path("agent/prompts/x.md"))] }) };
		const category = probeTemplates(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), host }));

		expect(find(category.probes, tree.path("agent/prompts/x.md"))?.status).toBe("loaded");
		const loser = find(category.probes, tree.path("proj/.omo/prompts/x.md"));
		expect(loser?.status).toBe("shadowed");
		expect(samePath(loser?.winner ?? "", tree.path("agent/prompts/x.md"))).toBe(true);
		expect(category.note).not.toContain("추정");
	});

	test("acceptance: untrusted project - project dir and entry are disabled with the problem", () => {
		const tree = makeTree({ "proj/.omo/prompts/a.md": "x" });
		trees.push(tree);
		const category = probeTemplates(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), trusted: false }));

		const dir = find(category.probes, tree.path("proj/.omo/prompts"));
		expect(dir?.status).toBe("disabled");
		expect(dir?.reason).toBe("프로젝트 신뢰 안 함");
		expect(dir?.problem).toBe("신뢰 안 한 프로젝트에 리소스 있음");
		const file = find(category.probes, tree.path("proj/.omo/prompts/a.md"));
		expect(file?.status).toBe("disabled");
		expect(file?.reason).toBe("프로젝트 신뢰 안 함");
		expect(file?.scope).toBe("프로젝트");
	});

	test("acceptance: resolved disabled - enabled false row is 꺼짐", () => {
		const tree = makeTree({ "proj/.omo/prompts/off.md": "x" });
		trees.push(tree);
		const host: Partial<HostData> = { resolved: resolvedOf({ prompts: [entry(tree.path("proj/.omo/prompts/off.md"), false)] }) };
		const category = probeTemplates(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), host }));

		const row = find(category.probes, tree.path("proj/.omo/prompts/off.md"));
		expect(row?.status).toBe("disabled");
		expect(row?.reason).toBe("설정에서 끔");
	});

	test("resolved entry outside the candidate dirs is an extra loaded row with settings scope", () => {
		const tree = makeTree({ "plug/node_modules/omo-ai/prompts/sys.md": "s", "cfg/prompts/z.md": "z" });
		trees.push(tree);
		const host: Partial<HostData> = {
			resolved: resolvedOf({ prompts: [entry(tree.path("plug/node_modules/omo-ai/prompts/sys.md")), entry(tree.path("cfg/prompts/z.md"))] }),
		};
		const category = probeTemplates(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), host }));

		const plugin = find(category.probes, tree.path("plug/node_modules/omo-ai/prompts/sys.md"));
		expect(plugin?.status).toBe("loaded");
		expect(plugin?.scope).toBe("omo 플러그인");
		const settings = find(category.probes, tree.path("cfg/prompts/z.md"));
		expect(settings?.status).toBe("loaded");
		expect(settings?.scope).toBe("설정");
	});

	test("only non-recursive .md files are listed as template candidates", () => {
		const tree = makeTree({ "proj/.omo/prompts/a.md": "a", "proj/.omo/prompts/b.txt": "b", "proj/.omo/prompts/sub/c.md": "c" });
		trees.push(tree);
		const category = probeTemplates(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(find(category.probes, tree.path("proj/.omo/prompts/a.md"))?.status).toBe("loaded");
		expect(find(category.probes, tree.path("proj/.omo/prompts/b.txt"))).toBeUndefined();
		expect(find(category.probes, tree.path("proj/.omo/prompts/sub/c.md"))).toBeUndefined();
	});

	test("missing candidate dirs get one 없음 row each", () => {
		const tree = makeTree({ "agent/.keep": "" });
		trees.push(tree);
		const category = probeTemplates(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(find(category.probes, tree.path("agent/prompts"))?.status).toBe("missing");
		expect(find(category.probes, tree.path("proj/.omo/prompts"))?.status).toBe("missing");
		expect(find(category.probes, tree.path("proj/.pi/prompts"))?.status).toBe("missing");
	});
});

describe("probeThemes", () => {
	test("acceptance: active theme marked - settings theme row gets 사용 중", () => {
		const tree = makeTree({ "agent/themes/x.json": "{}" });
		trees.push(tree);
		const host: Partial<HostData> = { globalSettings: { theme: "x" } };
		const category = probeThemes(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), host }));

		expect(category.id).toBe("themes");
		expect(category.label).toBe("테마");
		const row = find(category.probes, tree.path("agent/themes/x.json"));
		expect(row?.status).toBe("loaded");
		expect(row?.reason).toBe("사용 중");
	});

	test("acceptance: builtin theme fallback - theme y nowhere gets a builtin:y row", () => {
		const tree = makeTree({ "agent/themes/x.json": "{}" });
		trees.push(tree);
		const host: Partial<HostData> = { globalSettings: { theme: "y" } };
		const category = probeThemes(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), host }));

		const row = find(category.probes, "builtin:y");
		expect(row?.kind).toBe("virtual");
		expect(row?.status).toBe("loaded");
		expect(row?.reason).toBe("내장 테마");
		expect(row?.scope).toBe("내장");
		expect(find(category.probes, tree.path("agent/themes/x.json"))?.reason).not.toBe("사용 중");
	});

	test("project theme setting wins over global when trusted", () => {
		const tree = makeTree({ "agent/themes/g.json": "{}", "proj/.omo/themes/p.json": "{}" });
		trees.push(tree);
		const host: Partial<HostData> = { globalSettings: { theme: "g" }, projectSettings: { theme: "p" } };
		const category = probeThemes(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), host }));

		expect(find(category.probes, tree.path("proj/.omo/themes/p.json"))?.reason).toBe("사용 중");
		expect(find(category.probes, tree.path("agent/themes/g.json"))?.reason).not.toBe("사용 중");
	});

	test("untrusted project ignores the project theme setting", () => {
		const tree = makeTree({ "agent/themes/g.json": "{}", "proj/.omo/themes/p.json": "{}" });
		trees.push(tree);
		const host: Partial<HostData> = { globalSettings: { theme: "g" }, projectSettings: { theme: "p" } };
		const category = probeThemes(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), trusted: false, host }));

		expect(find(category.probes, tree.path("agent/themes/g.json"))?.reason).toBe("사용 중");
	});

	test("only .json files are theme candidates and a resolved-disabled theme is 꺼짐", () => {
		const tree = makeTree({ "proj/.omo/themes/a.json": "{}", "proj/.omo/themes/b.txt": "b", "proj/.omo/themes/off.json": "{}" });
		trees.push(tree);
		const host: Partial<HostData> = {
			resolved: resolvedOf({ themes: [entry(tree.path("proj/.omo/themes/a.json")), entry(tree.path("proj/.omo/themes/off.json"), false)] }),
		};
		const category = probeThemes(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), host }));

		expect(find(category.probes, tree.path("proj/.omo/themes/a.json"))?.status).toBe("loaded");
		expect(find(category.probes, tree.path("proj/.omo/themes/b.txt"))).toBeUndefined();
		const off = find(category.probes, tree.path("proj/.omo/themes/off.json"));
		expect(off?.status).toBe("disabled");
		expect(off?.reason).toBe("설정에서 끔");
	});
});
