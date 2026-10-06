import { afterEach, describe, expect, test } from "bun:test";
import { probeExtensions } from "../../extension/omo-where/probes/extensions.ts";
import { LIVE_PROBLEM } from "../../extension/omo-where/model.ts";
import type { Category, HostData, LiveState, Probe, ProbeEnv, Resolved } from "../../extension/omo-where/model.ts";
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

function resolvedOf(extensions: Resolved["extensions"]): Resolved {
	return { extensions, skills: [], prompts: [], themes: [], hooks: [] };
}

function find(cat: Category, pred: (p: Probe) => boolean): Probe {
	const hit = cat.probes.find(pred);
	if (hit === undefined) throw new Error(`row not found; rows: ${cat.probes.map((p) => p.path).join(", ")}`);
	return hit;
}

describe("probeExtensions", () => {
	test("file and dir entries loaded via live", async () => {
		const t = tree({ proj: null, "agent/extensions/a.ts": "", "agent/extensions/b/index.ts": "" });
		const env = envOf(t, {
			live: { extensionPaths: [t.path("agent/extensions/a.ts"), t.path("agent/extensions/b/index.ts")] },
		});
		const cat = await probeExtensions(env);
		const file = find(cat, (p) => p.path === t.path("agent/extensions/a.ts"));
		expect(file.status).toBe("loaded");
		expect(file.live).toBe("match");
		const dir = find(cat, (p) => p.path === t.path("agent/extensions/b"));
		expect(dir.status).toBe("loaded");
		expect(dir.kind).toBe("dir");
	});

	test(".bak leftover is disabled with a leftover problem", async () => {
		const t = tree({ proj: null, "agent/extensions/old.ts.bak": "" });
		const cat = await probeExtensions(envOf(t, { live: { extensionPaths: [] } }));
		const row = find(cat, (p) => p.path === t.path("agent/extensions/old.ts.bak"));
		expect(row.status).toBe("disabled");
		expect(row.problem).toBe("확장으로 안 읽힘(old.ts.bak) - 남은 파일?");
	});

	test("directory without an entry file is disabled", async () => {
		const t = tree({ proj: null, "agent/extensions/nope/readme.md": "" });
		const cat = await probeExtensions(envOf(t, { live: { extensionPaths: [] } }));
		const row = find(cat, (p) => p.path === t.path("agent/extensions/nope"));
		expect(row.status).toBe("disabled");
		expect(row.reason).toBe("진입 파일 없음");
	});

	test("duplicate basename across dirs gets the duplicate problem", async () => {
		const t = tree({ proj: null, "agent/extensions/dup.ts": "", "proj/.omo/extensions/dup.ts": "" });
		const env = envOf(t, {
			live: { extensionPaths: [t.path("agent/extensions/dup.ts"), t.path("proj/.omo/extensions/dup.ts")] },
		});
		const cat = await probeExtensions(env);
		const agent = find(cat, (p) => p.path === t.path("agent/extensions/dup.ts"));
		const project = find(cat, (p) => p.path === t.path("proj/.omo/extensions/dup.ts"));
		expect(agent.problem).toContain("같은 이름 확장이 여러 곳");
		expect(project.problem).toContain("같은 이름 확장이 여러 곳");
	});

	test("untrusted project dir rows are disabled with a problem", async () => {
		const t = tree({ proj: null, "proj/.omo/extensions/a.ts": "" });
		const cat = await probeExtensions(envOf(t, { trusted: false, live: { extensionPaths: [] } }));
		const dir = find(cat, (p) => p.path === t.path("proj/.omo/extensions"));
		expect(dir.status).toBe("disabled");
		expect(dir.reason).toBe("프로젝트 신뢰 안 함");
		expect(dir.problem).toBe("신뢰 안 한 프로젝트에 리소스 있음");
		const entry = find(cat, (p) => p.path === t.path("proj/.omo/extensions/a.ts"));
		expect(entry.status).toBe("disabled");
		expect(entry.reason).toBe("프로젝트 신뢰 안 함");
	});

	test("candidate on disk but not in live is disk-only", async () => {
		const t = tree({ proj: null, "agent/extensions/a.ts": "" });
		const cat = await probeExtensions(envOf(t, { live: { extensionPaths: [] } }));
		const row = find(cat, (p) => p.path === t.path("agent/extensions/a.ts"));
		expect(row.live).toBe("disk-only");
		expect(row.problem).toBe(LIVE_PROBLEM["disk-only"]);
	});

	test("live path missing from disk is missing and session-only", async () => {
		const t = tree({ proj: null });
		const ghost = t.path("agent/extensions/ghost.ts");
		const cat = await probeExtensions(envOf(t, { live: { extensionPaths: [ghost] } }));
		const row = find(cat, (p) => p.path === ghost);
		expect(row.status).toBe("missing");
		expect(row.live).toBe("session-only");
		expect(row.problem).toBe(LIVE_PROBLEM["session-only"]);
	});

	test("live builtin paths become virtual loaded rows without a live mark", async () => {
		const t = tree({ proj: null });
		const cat = await probeExtensions(envOf(t, { live: { extensionPaths: ["<builtin:mcp>", "builtin:rules"] } }));
		const mcp = find(cat, (p) => p.path === "builtin:mcp");
		expect(mcp.status).toBe("loaded");
		expect(mcp.kind).toBe("virtual");
		expect(mcp.scope).toBe("내장");
		expect(mcp.reason).toBe("내장 확장");
		expect(mcp.live).toBeUndefined();
		const rules = find(cat, (p) => p.path === "builtin:rules");
		expect(rules.status).toBe("loaded");
		expect(rules.kind).toBe("virtual");
		expect(cat.probes.some((p) => p.path === "builtin:mcp" && p.status === "missing")).toBe(false);
	});

	test('live "<inline>" becomes a virtual session row', async () => {
		const t = tree({ proj: null });
		const cat = await probeExtensions(envOf(t, { live: { extensionPaths: ["<inline>"] } }));
		const row = find(cat, (p) => p.path === "<inline>");
		expect(row.status).toBe("loaded");
		expect(row.kind).toBe("virtual");
		expect(row.scope).toBe("세션");
		expect(row.reason).toBe("임시 확장");
		expect(row.live).toBeUndefined();
	});

	test("live path under the runtime dir is a bundled builtin", async () => {
		const t = tree({ proj: null, ".omo/agent/runtime/plugin.js": "" });
		const cat = await probeExtensions(envOf(t, { live: { extensionPaths: [t.path(".omo/agent/runtime/plugin.js")] } }));
		const row = find(cat, (p) => p.path === t.path(".omo/agent/runtime/plugin.js"));
		expect(row.status).toBe("loaded");
		expect(row.scope).toBe("내장");
		expect(row.reason).toBe("내장 확장(번들)");
	});

	test("live path outside every dir is a session row", async () => {
		const t = tree({ proj: null, "elsewhere/custom.ts": "" });
		const cat = await probeExtensions(envOf(t, { live: { extensionPaths: [t.path("elsewhere/custom.ts")] } }));
		const row = find(cat, (p) => p.path === t.path("elsewhere/custom.ts"));
		expect(row.status).toBe("loaded");
		expect(row.scope).toBe("세션");
		expect(row.reason).toBe("-e 또는 플러그인으로 들어옴");
	});

	test("-builtin setting entry is a virtual disabled row", async () => {
		const t = tree({ proj: null });
		const cat = await probeExtensions(envOf(t, { host: { globalSettings: { extensions: ["-builtin:help"] } } }));
		const row = find(cat, (p) => p.path === "builtin:help");
		expect(row.status).toBe("disabled");
		expect(row.scope).toBe("설정");
		expect(row.reason).toBe("설정에서 끔");
	});

	test("missingPackages produces missing rows with a problem", async () => {
		const t = tree({ proj: null });
		const cat = await probeExtensions(envOf(t, { host: { missingPackages: ["some-pkg"] } }));
		const row = find(cat, (p) => p.path === "some-pkg");
		expect(row.status).toBe("missing");
		expect(row.problem).toBe("설정의 패키지가 없음");
	});

	test("resolved entry with enabled false disables the candidate", async () => {
		const t = tree({ proj: null, "agent/extensions/a.ts": "" });
		const cat = await probeExtensions(envOf(t, {
			host: { resolved: resolvedOf([{ path: t.path("agent/extensions/a.ts"), enabled: false, metadata: {} }]) },
		}));
		const row = find(cat, (p) => p.path === t.path("agent/extensions/a.ts"));
		expect(row.status).toBe("disabled");
		expect(row.reason).toBe("설정에서 끔");
	});

	test("other-harness agent folder extensions are disabled", async () => {
		const t = tree({ proj: null, "home/.pi/agent/extensions/x.ts": "" });
		const cat = await probeExtensions(envOf(t, { live: { extensionPaths: [] } }));
		const row = find(cat, (p) => p.path === t.path("home/.pi/agent/extensions/x.ts"));
		expect(row.status).toBe("disabled");
		expect(row.scope).toBe("다른 에이전트 폴더");
		expect(row.reason).toBe("지금 세션은 이 폴더를 안 읽음");
	});
});
