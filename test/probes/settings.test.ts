import { afterEach, describe, expect, test } from "bun:test";
import { samePath, type Probe, type ProbeEnv } from "../../extension/omo-where/model.ts";
import { probeSettings } from "../../extension/omo-where/probes/settings.ts";
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
