import { afterEach, describe, expect, test } from "bun:test";
import { probeHooks, probeMcp } from "../../extension/omo-where/probes/mcp-hooks.ts";
import type { Category, HostData, LiveState, Probe, ProbeEnv } from "../../extension/omo-where/model.ts";
import { makeTree } from "../helpers/tree.ts";
import type { Tree } from "../helpers/tree.ts";

let trees: Tree[] = [];

function tree(spec: Record<string, string | null>): Tree {
	const t = makeTree(spec);
	trees.push(t);
	return t;
}

afterEach(() => {
	for (const t of trees) t.cleanup();
	trees = [];
});

type EnvOpts = { trusted?: boolean; live?: LiveState; host?: Partial<HostData> };

function envOf(t: Tree, o: EnvOpts = {}): ProbeEnv {
	return {
		cwd: t.path("proj"),
		agentDir: t.path("agent"),
		home: t.path("home"),
		env: {},
		trusted: o.trusted ?? true,
		senpi: {},
		host: { missingPackages: [], ...o.host },
		live: o.live ?? {},
	};
}

function find(cat: Category, pred: (p: Probe) => boolean): Probe {
	const hit = cat.probes.find(pred);
	if (hit === undefined) throw new Error(`row not found; rows: ${cat.probes.map((p) => p.path).join(", ")}`);
	return hit;
}

function findAll(cat: Category, pred: (p: Probe) => boolean): Probe[] {
	return cat.probes.filter(pred);
}

describe("probeMcp", () => {
	test("global servers from agentDir/mcp.json are loaded rows", async () => {
		const t = tree({ proj: null, "agent/mcp.json": JSON.stringify({ mcpServers: { a: {} } }) });
		const cat = await probeMcp(envOf(t));
		const fileRow = find(cat, (p) => p.path === t.path("agent/mcp.json"));
		expect(fileRow.status).toBe("loaded");
		expect(fileRow.scope).toBe("전역");
		const server = find(cat, (p) => p.path === "mcp:a");
		expect(server.status).toBe("loaded");
		expect(server.kind).toBe("virtual");
		expect(server.scope).toBe("전역");
		expect(server.reason).toBe("mcp.json");
	});

	test("invalid JSON in agentDir/mcp.json is an error row with the message", async () => {
		const t = tree({ proj: null, "agent/mcp.json": "{" });
		const cat = await probeMcp(envOf(t));
		const row = find(cat, (p) => p.path === t.path("agent/mcp.json"));
		expect(row.status).toBe("error");
		expect(row.reason.length).toBeGreaterThan(0);
		expect(cat.probes.some((p) => p.path.startsWith("mcp:"))).toBe(false);
	});

	test("cwd/.omo/mcp.json overrides the global server with the same name", async () => {
		const t = tree({
			proj: null,
			"agent/mcp.json": JSON.stringify({ mcpServers: { a: { command: "global" } } }),
			"proj/.omo/mcp.json": JSON.stringify({ mcpServers: { a: { command: "project" } } }),
		});
		const cat = await probeMcp(envOf(t));
		const servers = findAll(cat, (p) => p.path === "mcp:a");
		expect(servers.length).toBe(2);
		const loser = servers[0];
		const winner = servers[1];
		expect(loser?.status).toBe("shadowed");
		expect(loser?.winner).toBe(t.path("proj/.omo/mcp.json"));
		expect(loser?.scope).toBe("전역");
		expect(winner?.status).toBe("loaded");
		expect(winner?.scope).toBe("프로젝트");
	});

	test('importConfigs "claude" enables cwd/.mcp.json', async () => {
		const t = tree({
			proj: null,
			"agent/mcp.json": JSON.stringify({ settings: { importConfigs: ["claude"] }, mcpServers: {} }),
			"proj/.mcp.json": JSON.stringify({ mcpServers: { b: {} } }),
		});
		const cat = await probeMcp(envOf(t));
		const fileRow = find(cat, (p) => p.path === t.path("proj/.mcp.json"));
		expect(fileRow.status).toBe("loaded");
		const server = find(cat, (p) => p.path === "mcp:b");
		expect(server.status).toBe("loaded");
		expect(server.scope).toBe("프로젝트");
	});

	test("cwd/.mcp.json is disabled when importConfigs does not include claude", async () => {
		const t = tree({
			proj: null,
			"agent/mcp.json": JSON.stringify({ settings: { importConfigs: [] }, mcpServers: {} }),
			"proj/.mcp.json": JSON.stringify({ mcpServers: { b: {} } }),
		});
		const cat = await probeMcp(envOf(t));
		const fileRow = find(cat, (p) => p.path === t.path("proj/.mcp.json"));
		expect(fileRow.status).toBe("disabled");
		expect(fileRow.reason).toBe("Claude 설정 가져오기 꺼짐");
		expect(cat.probes.some((p) => p.path === "mcp:b")).toBe(false);
	});

	test("untrusted project disables cwd/.omo/mcp.json and cwd/.mcp.json", async () => {
		const t = tree({
			proj: null,
			"agent/mcp.json": JSON.stringify({ settings: { importConfigs: ["claude"] }, mcpServers: {} }),
			"proj/.omo/mcp.json": JSON.stringify({ mcpServers: { p: {} } }),
			"proj/.mcp.json": JSON.stringify({ mcpServers: { c: {} } }),
		});
		const cat = await probeMcp(envOf(t, { trusted: false }));
		const project = find(cat, (p) => p.path === t.path("proj/.omo/mcp.json"));
		expect(project.status).toBe("disabled");
		expect(project.reason).toBe("프로젝트 신뢰 안 함");
		expect(project.problem).toBe("신뢰 안 한 프로젝트에 리소스 있음");
		const claude = find(cat, (p) => p.path === t.path("proj/.mcp.json"));
		expect(claude.status).toBe("disabled");
		expect(claude.reason).toBe("프로젝트 신뢰 안 함");
		expect(cat.probes.some((p) => p.path === "mcp:p" || p.path === "mcp:c")).toBe(false);
	});

	test("extension-declared omo-ai server is a loaded omo 플러그인 row", async () => {
		const t = tree({ proj: null });
		const extensionPath = t.path("node_modules/omo-ai/plugin/extensions/omo.js");
		const cat = await probeMcp(envOf(t, { live: { mcpServers: [{ name: "context7", extensionPath }] } }));
		const row = find(cat, (p) => p.path === "mcp:context7");
		expect(row.status).toBe("loaded");
		expect(row.kind).toBe("virtual");
		expect(row.scope).toBe("omo 플러그인");
		expect(row.reason).toBe("확장이 선언");
	});

	test("extension-declared server without omo-ai path is a session row", async () => {
		const t = tree({ proj: null, "elsewhere/custom.ts": "" });
		const cat = await probeMcp(envOf(t, { live: { mcpServers: [{ name: "custom", extensionPath: t.path("elsewhere/custom.ts") }] } }));
		const row = find(cat, (p) => p.path === "mcp:custom");
		expect(row.status).toBe("loaded");
		expect(row.scope).toBe("세션");
	});

	test("a file-defined server shadows a declared server of the same name", async () => {
		const t = tree({ proj: null, "agent/mcp.json": JSON.stringify({ mcpServers: { a: {} } }) });
		const cat = await probeMcp(envOf(t, {
			live: { mcpServers: [{ name: "a", extensionPath: t.path("node_modules/omo-ai/x.js") }] },
		}));
		const servers = findAll(cat, (p) => p.path === "mcp:a");
		expect(servers.length).toBe(2);
		expect(servers[0]?.status).toBe("loaded");
		expect(servers[1]?.status).toBe("shadowed");
		expect(servers[1]?.winner).toBe(t.path("agent/mcp.json"));
		expect(servers[1]?.scope).toBe("omo 플러그인");
	});

	test("cache row carries the 연결 정보 캐시 reason", async () => {
		const t = tree({ proj: null, "agent/cache/mcp-cache.json": "{}" });
		const cat = await probeMcp(envOf(t));
		const row = find(cat, (p) => p.path === t.path("agent/cache/mcp-cache.json"));
		expect(row.status).toBe("loaded");
		expect(row.reason).toBe("연결 정보 캐시");
	});
});

describe("probeHooks", () => {
	test("global hooks.json present on disk is a loaded row", async () => {
		const t = tree({ proj: null, "agent/hooks.json": "{}" });
		const cat = await probeHooks(envOf(t));
		const row = find(cat, (p) => p.path === t.path("agent/hooks.json"));
		expect(row.status).toBe("loaded");
		expect(row.scope).toBe("전역");
		expect(row.reason).toBe("전역 훅 파일");
	});

	test("global inline hooks setting shows a loaded row", async () => {
		const t = tree({ proj: null });
		const cat = await probeHooks(envOf(t, { host: { globalSettings: { hooks: [{ command: "x" }] } } }));
		const row = find(cat, (p) => p.path === "hook:global-settings");
		expect(row.status).toBe("loaded");
		expect(row.kind).toBe("virtual");
		expect(row.scope).toBe("설정");
		expect(row.reason).toBe("설정에 hooks 있음");
	});

	test('global inline hooks setting absent is a missing row with "설정에 hooks 없음"', async () => {
		const t = tree({ proj: null });
		const cat = await probeHooks(envOf(t, { host: { globalSettings: {} } }));
		const row = find(cat, (p) => p.path === "hook:global-settings");
		expect(row.status).toBe("missing");
		expect(row.reason).toBe("설정에 hooks 없음");
	});

	test("hook source dirs from live are loaded rows", async () => {
		const t = tree({ proj: null, "hooksdir": null });
		const cat = await probeHooks(envOf(t, { live: { hookSources: { globalHookSourcePaths: [t.path("hooksdir")] } } }));
		const row = find(cat, (p) => p.path === t.path("hooksdir"));
		expect(row.status).toBe("loaded");
		expect(row.kind).toBe("dir");
		expect(row.scope).toBe("전역");
		expect(row.reason).toBe("전역 훅 폴더");
	});

	test("live hookSources paths replace the default global and project files", async () => {
		const t = tree({
			proj: null,
			"custom/global-hooks.json": "{}",
			"proj/.omo/project-hooks.json": "{}",
			"hooks/plugin-hooks.json": "{}",
		});
		const cat = await probeHooks(envOf(t, {
			live: {
				hookSources: {
					globalHooksPath: t.path("custom/global-hooks.json"),
					projectHooksPath: t.path("proj/.omo/project-hooks.json"),
					preSessionHookSourcePaths: [t.path("hooks/plugin-hooks.json")],
				},
			},
		}));
		const global = find(cat, (p) => p.path === t.path("custom/global-hooks.json"));
		expect(global.status).toBe("loaded");
		expect(global.scope).toBe("전역");
		const project = find(cat, (p) => p.path === t.path("proj/.omo/project-hooks.json"));
		expect(project.status).toBe("loaded");
		expect(project.scope).toBe("프로젝트");
		const preSession = find(cat, (p) => p.path === t.path("hooks/plugin-hooks.json"));
		expect(preSession.status).toBe("loaded");
		expect(preSession.scope).toBe("세션");
		expect(cat.probes.some((p) => p.path === t.path("agent/hooks.json"))).toBe(false);
	});

	test("untrusted project disables the project hooks file and inline hooks", async () => {
		const t = tree({ proj: null, "proj/.omo/hooks.json": "{}" });
		const cat = await probeHooks(envOf(t, { trusted: false, host: { projectSettings: { hooks: [] } } }));
		const file = find(cat, (p) => p.path === t.path("proj/.omo/hooks.json"));
		expect(file.status).toBe("disabled");
		expect(file.reason).toBe("프로젝트 신뢰 안 함");
		expect(file.problem).toBe("신뢰 안 한 프로젝트에 리소스 있음");
		const inline = find(cat, (p) => p.path === "hook:project-settings");
		expect(inline.status).toBe("disabled");
		expect(inline.reason).toBe("프로젝트 신뢰 안 함");
	});

	test("trusted project inline hooks setting shows a loaded row", async () => {
		const t = tree({ proj: null });
		const cat = await probeHooks(envOf(t, { host: { projectSettings: { hooks: [] } } }));
		const row = find(cat, (p) => p.path === "hook:project-settings");
		expect(row.status).toBe("loaded");
		expect(row.reason).toBe("설정에 hooks 있음");
	});

	test("missing project hooks.json is a missing row", async () => {
		const t = tree({ proj: null });
		const cat = await probeHooks(envOf(t));
		const row = find(cat, (p) => p.path === t.path("proj/.omo/hooks.json"));
		expect(row.status).toBe("missing");
		expect(row.reason).toBe("파일 없음");
	});
});
