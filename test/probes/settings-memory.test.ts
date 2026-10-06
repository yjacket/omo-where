import { afterEach, describe, expect, test } from "bun:test";
import { samePath, type Probe, type ProbeEnv } from "../../extension/omo-where/model.ts";
import { probeMemory, probeSettings } from "../../extension/omo-where/probes/settings-memory.ts";
import { makeTree, type Tree } from "../helpers/tree.ts";

const trees: Tree[] = [];
afterEach(() => {
	while (trees.length > 0) trees.pop()!.cleanup();
});

type EnvOptions = {
	cwd: string;
	agentDir: string;
	home: string;
	trusted?: boolean;
	env?: Record<string, string | undefined>;
	globalSettings?: Record<string, unknown>;
	projectSettings?: Record<string, unknown>;
	systemPrompt?: string;
	skills?: readonly { readonly name: string; readonly filePath: string }[];
	model?: { provider?: string; id?: string };
};

function envOf(options: EnvOptions): ProbeEnv {
	return {
		cwd: options.cwd,
		agentDir: options.agentDir,
		home: options.home,
		env: options.env ?? {},
		trusted: options.trusted ?? true,
		senpi: {},
		host: {
			...(options.globalSettings !== undefined ? { globalSettings: options.globalSettings } : {}),
			...(options.projectSettings !== undefined ? { projectSettings: options.projectSettings } : {}),
			missingPackages: [],
		},
		live: {
			...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
			...(options.skills !== undefined ? { skills: options.skills } : {}),
			...(options.model !== undefined ? { model: options.model } : {}),
		},
	};
}

function byPath(probes: readonly Probe[], path: string): Probe | undefined {
	return probes.find((probe) => samePath(probe.path, path));
}

function byVirtual(probes: readonly Probe[], path: string): Probe | undefined {
	return probes.find((probe) => probe.path === path);
}

const MEMORY_PROMPT = "<!-- senpi-memory:omo-tool-fold-6bb00c96:begin -->\n<memory_metadata>\n- AGENT_ID: omo-tool-fold-6bb00c96\n</memory_metadata>";

describe("probeSettings", () => {
	test("acceptance: jsonc preferred - settings.jsonc loaded and settings.json shadowed (jsonc가 먼저)", () => {
		const tree = makeTree({ "agent/settings.jsonc": "{}", "agent/settings.json": "{}" });
		trees.push(tree);
		const category = probeSettings(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(category.id).toBe("settings");
		expect(category.label).toBe("설정");
		const jsonc = byPath(category.probes, tree.path("agent/settings.jsonc"));
		expect(jsonc?.status).toBe("loaded");
		const json = byPath(category.probes, tree.path("agent/settings.json"));
		expect(json?.status).toBe("shadowed");
		expect(json?.reason).toBe("jsonc가 먼저");
		expect(samePath(json?.winner ?? "", tree.path("agent/settings.jsonc"))).toBe(true);
	});

	test("acceptance: jsonc preferred - json-only global settings still load", () => {
		const tree = makeTree({ "agent/settings.json": "{}" });
		trees.push(tree);
		const category = probeSettings(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(byPath(category.probes, tree.path("agent/settings.json"))?.status).toBe("loaded");
		expect(byPath(category.probes, tree.path("agent/settings.jsonc"))?.status).toBe("missing");
	});

	test("acceptance: untrusted project disabled - project settings row 꺼짐 and dir carries the problem", () => {
		const tree = makeTree({ "proj/.omo/settings.jsonc": "{}" });
		trees.push(tree);
		const category = probeSettings(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), trusted: false }));

		const file = byPath(category.probes, tree.path("proj/.omo/settings.jsonc"));
		expect(file?.status).toBe("disabled");
		expect(file?.reason).toBe("프로젝트 신뢰 안 함");
		const dir = byPath(category.probes, tree.path("proj/.omo"));
		expect(dir?.status).toBe("disabled");
		expect(dir?.problem).toBe("신뢰 안 한 프로젝트에 리소스 있음");
	});

	test("acceptance: secret value never in any row text/reason (tokenInjection masked)", () => {
		const tree = makeTree({ "agent/settings.json": "{}" });
		trees.push(tree);
		const category = probeSettings(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				globalSettings: { anthropicSubscriptionProvider: { tokenInjection: "abc", systemPromptMode: "full" } },
			}),
		);

		for (const probe of category.probes) {
			expect(probe.text ?? "").not.toContain("abc");
			expect(probe.reason).not.toContain("abc");
		}
		expect(byVirtual(category.probes, "setting:claude-lane")?.text).toContain("<가림>");
	});

	test("acceptance: Claude lane alias - claudeSdkOauthProvider is read", () => {
		const tree = makeTree({ "agent/settings.json": "{}" });
		trees.push(tree);
		const category = probeSettings(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				globalSettings: { claudeSdkOauthProvider: { systemPromptMode: "preset-append" } },
			}),
		);

		const lane = byVirtual(category.probes, "setting:claude-lane");
		expect(lane?.reason).toBe("출처: 설정");
		expect(lane?.text).toContain("preset-append");
	});

	test("acceptance: Claude lane project override - project setting beats global", () => {
		const tree = makeTree({ "agent/settings.json": "{}" });
		trees.push(tree);
		const category = probeSettings(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				globalSettings: { anthropicSubscriptionProvider: { systemPromptMode: "full" } },
				projectSettings: { anthropicSubscriptionProvider: { systemPromptMode: "override" } },
			}),
		);

		const lane = byVirtual(category.probes, "setting:claude-lane");
		expect(lane?.reason).toBe("출처: 프로젝트 설정");
		expect(lane?.text).toContain("override");
	});

	test("acceptance: Claude lane env override - SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE beats settings", () => {
		const tree = makeTree({ "agent/settings.json": "{}" });
		trees.push(tree);
		const category = probeSettings(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				env: { SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE: "preset-append" },
				globalSettings: { anthropicSubscriptionProvider: { systemPromptMode: "full" } },
			}),
		);

		const lane = byVirtual(category.probes, "setting:claude-lane");
		expect(lane?.reason).toBe("출처: 환경변수");
		expect(lane?.text).toContain("preset-append");
	});

	test("acceptance: Claude lane legacy mapping - appendSystemPrompt true->full, false->preset-append", () => {
		const tree = makeTree({ "agent/settings.json": "{}" });
		trees.push(tree);
		const base = { cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") };

		const full = probeSettings(envOf({ ...base, globalSettings: { anthropicSubscriptionProvider: { appendSystemPrompt: true } } }));
		const fullLane = byVirtual(full.probes, "setting:claude-lane");
		expect(fullLane?.reason).toBe("출처: 옛 appendSystemPrompt");
		expect(fullLane?.text).toContain("full");

		const append = probeSettings(envOf({ ...base, globalSettings: { anthropicSubscriptionProvider: { appendSystemPrompt: false } } }));
		const appendLane = byVirtual(append.probes, "setting:claude-lane");
		expect(appendLane?.reason).toBe("출처: 옛 appendSystemPrompt");
		expect(appendLane?.text).toContain("preset-append");
	});

	test("acceptance: Claude lane default - no block in settings means full/default", () => {
		const tree = makeTree({ "agent/settings.json": "{}" });
		trees.push(tree);
		const category = probeSettings(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), globalSettings: { theme: "x" } }));

		const lane = byVirtual(category.probes, "setting:claude-lane");
		expect(lane?.reason).toBe("출처: 기본값");
		expect(lane?.text).toBe("full");
	});

	test("happy: host globalSettings {theme} -> settings.json loaded and prompt preset row auto", () => {
		const tree = makeTree({ "agent/settings.json": "{}" });
		trees.push(tree);
		const category = probeSettings(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), globalSettings: { theme: "x" } }));

		expect(byPath(category.probes, tree.path("agent/settings.json"))?.status).toBe("loaded");
		const preset = byVirtual(category.probes, "setting:prompt-preset");
		expect(preset?.text).toBe("auto");
		expect(preset?.reason).toBe("출처: 기본값");
	});

	test("acceptance: prompt preset from project setting overrides global", () => {
		const tree = makeTree({ "agent/settings.json": "{}" });
		trees.push(tree);
		const category = probeSettings(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				globalSettings: { promptPreset: "a" },
				projectSettings: { promptPreset: "b" },
			}),
		);

		const preset = byVirtual(category.probes, "setting:prompt-preset");
		expect(preset?.text).toBe("b");
		expect(preset?.reason).toBe("출처: 프로젝트 설정");
	});

	test("acceptance: model row from env.live.model, trust row from env.trusted", () => {
		const tree = makeTree({});
		trees.push(tree);
		const category = probeSettings(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), model: { provider: "anthropic", id: "claude" }, trusted: false }));

		expect(byVirtual(category.probes, "setting:model")?.text).toBe("anthropic/claude");
		expect(byVirtual(category.probes, "setting:trust")?.text).toBe("신뢰 안 함");
	});

	test("acceptance: unknown virtual rows say 알 수 없음(내부 기능 없음) without host settings", () => {
		const tree = makeTree({});
		trees.push(tree);
		const category = probeSettings(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(byVirtual(category.probes, "setting:model")?.text).toBe("알 수 없음(내부 기능 없음)");
		expect(byVirtual(category.probes, "setting:prompt-preset")?.text).toBe("알 수 없음(내부 기능 없음)");
		expect(byVirtual(category.probes, "setting:claude-lane")?.text).toBe("알 수 없음(내부 기능 없음)");
	});
});

describe("probeMemory", () => {
	test("acceptance: memory rows from sentinel - repo, system files 세션에 투영, skills 스킬로 쓰임", () => {
		const tree = makeTree({
			"home/.omo/memory/agents/omo-tool-fold-6bb00c96/repo/system/persona.md": "p",
			"home/.omo/memory/agents/omo-tool-fold-6bb00c96/repo/system/boundaries.md": "b",
			"home/.omo/memory/agents/omo-tool-fold-6bb00c96/repo/skills/memory-discipline/SKILL.md": "s",
		});
		trees.push(tree);
		const category = probeMemory(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), systemPrompt: MEMORY_PROMPT }));

		expect(category.id).toBe("memory");
		expect(category.label).toBe("메모리");
		const repo = tree.path("home/.omo/memory/agents/omo-tool-fold-6bb00c96/repo");
		expect(byPath(category.probes, repo)?.status).toBe("loaded");
		expect(byPath(category.probes, repo)?.reason).toBe("메모리 저장소");
		const persona = byPath(category.probes, tree.path("home/.omo/memory/agents/omo-tool-fold-6bb00c96/repo/system/persona.md"));
		expect(persona?.status).toBe("loaded");
		expect(persona?.reason).toBe("세션에 투영");
		const skill = byPath(category.probes, tree.path("home/.omo/memory/agents/omo-tool-fold-6bb00c96/repo/skills/memory-discipline/SKILL.md"));
		expect(skill?.status).toBe("loaded");
		expect(skill?.reason).toBe("스킬로 쓰임");
	});

	test("acceptance: memory missing - no sentinel means one missing row", () => {
		const tree = makeTree({});
		trees.push(tree);
		const category = probeMemory(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(category.probes.length).toBe(1);
		expect(category.probes[0]?.kind).toBe("virtual");
		expect(category.probes[0]?.status).toBe("missing");
		expect(category.probes[0]?.reason).toBe("메모리 꺼짐 또는 정보 없음");
	});

	test("acceptance: memory id fallback to AGENT_ID metadata line", () => {
		const tree = makeTree({ "home/.omo/memory/agents/tool-fold/repo/system/self-aware.md": "x" });
		trees.push(tree);
		const prompt = "<memory_metadata>\n- AGENT_ID: tool-fold\n</memory_metadata>";
		const category = probeMemory(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), systemPrompt: prompt }));

		const row = byPath(category.probes, tree.path("home/.omo/memory/agents/tool-fold/repo/system/self-aware.md"));
		expect(row?.status).toBe("loaded");
		expect(row?.reason).toBe("세션에 투영");
	});

	test("acceptance: OMO_MEMORY_HOME is resolved against cwd", () => {
		const tree = makeTree({ "proj/mem/agents/x/repo/system/self.md": "x" });
		trees.push(tree);
		const category = probeMemory(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				env: { OMO_MEMORY_HOME: "mem" },
				systemPrompt: "<!-- senpi-memory:x:begin -->",
			}),
		);

		expect(byPath(category.probes, tree.path("proj/mem/agents/x/repo/system/self.md"))?.status).toBe("loaded");
	});

	test("acceptance: sentinel but no repo directory -> missing repo row", () => {
		const tree = makeTree({ "home/.omo/memory/agents": null });
		trees.push(tree);
		const category = probeMemory(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), systemPrompt: MEMORY_PROMPT }));

		const row = byPath(category.probes, tree.path("home/.omo/memory/agents/omo-tool-fold-6bb00c96/repo"));
		expect(row?.status).toBe("missing");
		expect(row?.reason).toBe("폴더 없음");
	});

	test("fallback: live skill path under memory home finds the id (세션 스킬 경로로 찾음)", () => {
		const id = "omo-tool-fold-6bb00c96";
		const tree = makeTree({
			[`home/.omo/memory/agents/${id}/repo/system/persona.md`]: "p",
			[`home/.omo/memory/agents/${id}/repo/skills/memory-discipline/SKILL.md`]: "s",
		});
		trees.push(tree);
		const category = probeMemory(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				skills: [{ name: "memory-discipline", filePath: tree.path(`home/.omo/memory/agents/${id}/repo/skills/memory-discipline/SKILL.md`) }],
			}),
		);

		const repo = byPath(category.probes, tree.path(`home/.omo/memory/agents/${id}/repo`));
		expect(repo?.status).toBe("loaded");
		expect(repo?.reason).toBe("세션 스킬 경로로 찾음");
		expect(byPath(category.probes, tree.path(`home/.omo/memory/agents/${id}/repo/system/persona.md`))?.reason).toBe("세션에 투영");
		expect(category.note ?? "").toContain("세션 스킬 경로");
	});

	test("fallback: skill path outside the memory home is ignored (none -> missing row)", () => {
		const tree = makeTree({ "other/agents/agent-x/repo/skills/s/SKILL.md": "s" });
		trees.push(tree);
		const category = probeMemory(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				skills: [{ name: "s", filePath: tree.path("other/agents/agent-x/repo/skills/s/SKILL.md") }],
			}),
		);

		expect(category.probes.length).toBe(1);
		expect(category.probes[0]?.reason).toBe("메모리 꺼짐 또는 정보 없음");
	});

	test("fallback: single folder named <basename(cwd)>- estimates the id (폴더 이름으로 추정)", () => {
		const tree = makeTree({ "home/.omo/memory/agents/proj-abc123/repo/system/self.md": "x" });
		trees.push(tree);
		const category = probeMemory(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		const repo = byPath(category.probes, tree.path("home/.omo/memory/agents/proj-abc123/repo"));
		expect(repo?.status).toBe("loaded");
		expect(repo?.reason).toBe("폴더 이름으로 추정");
		expect(byPath(category.probes, tree.path("home/.omo/memory/agents/proj-abc123/repo/system/self.md"))?.reason).toBe("세션에 투영");
		expect(category.note ?? "").toContain("폴더 이름 추정");
	});

	test("fallback: folder candidates need a repo dir and the <basename(cwd)>- prefix", () => {
		const tree = makeTree({ "home/.omo/memory/agents/proj-norepo/system/self.md": "x", "home/.omo/memory/agents/other-abc/repo/system/self.md": "x" });
		trees.push(tree);
		const category = probeMemory(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(category.probes.length).toBe(1);
		expect(category.probes[0]?.status).toBe("missing");
		expect(category.probes[0]?.reason).toBe("메모리 꺼짐 또는 정보 없음");
	});

	test("fallback: multiple folder candidates -> one missing row per candidate, no id guess", () => {
		const tree = makeTree({ "home/.omo/memory/agents/proj-one/repo/system/a.md": "a", "home/.omo/memory/agents/proj-two/repo/system/b.md": "b" });
		trees.push(tree);
		const category = probeMemory(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(category.probes.length).toBe(2);
		for (const row of category.probes) {
			expect(row.status).toBe("missing");
			expect(row.reason).toBe("여러 후보 - 세션 정보 없음");
		}
		expect(byPath(category.probes, tree.path("home/.omo/memory/agents/proj-one/repo"))).toBeDefined();
		expect(byPath(category.probes, tree.path("home/.omo/memory/agents/proj-two/repo"))).toBeDefined();
	});

	test("fallback order: prompt sentinel beats skill paths and folder names", () => {
		const tree = makeTree({ "home/.omo/memory/agents/prompt-id/repo/system/a.md": "a", "home/.omo/memory/agents/proj-zzz/repo/system/b.md": "b" });
		trees.push(tree);
		const category = probeMemory(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				systemPrompt: "<!-- senpi-memory:prompt-id:begin -->",
				skills: [{ name: "s", filePath: tree.path("home/.omo/memory/agents/skill-id/repo/skills/s/SKILL.md") }],
			}),
		);

		expect(byPath(category.probes, tree.path("home/.omo/memory/agents/prompt-id/repo"))?.reason).toBe("메모리 저장소");
	});
});
