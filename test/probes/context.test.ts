import { afterEach, describe, expect, test } from "bun:test";
import { LIVE_PROBLEM, samePath, type Probe, type ProbeEnv } from "../../extension/omo-where/model.ts";
import { probeContext } from "../../extension/omo-where/probes/context.ts";
import { makeTree, type Tree } from "../helpers/tree.ts";

const trees: Tree[] = [];
afterEach(() => {
	while (trees.length > 0) trees.pop()!.cleanup();
});

type EnvOptions = { cwd: string; agentDir: string; home: string; senpi?: ProbeEnv["senpi"]; live?: ProbeEnv["live"]; trusted?: boolean };

function envOf(options: EnvOptions): ProbeEnv {
	return {
		cwd: options.cwd,
		agentDir: options.agentDir,
		home: options.home,
		env: {},
		trusted: options.trusted ?? true,
		senpi: options.senpi ?? {},
		host: { missingPackages: [] },
		live: options.live ?? {},
	};
}

function find(probes: readonly Probe[], path: string): Probe | undefined {
	return probes.find((probe) => samePath(probe.path, path));
}

describe("probeContext", () => {
	test("acceptance: global loaded rank 1 - agentDir row first, cwd file loaded", () => {
		const tree = makeTree({ "agent/AGENTS.md": "global", "proj/CLAUDE.md": "project" });
		trees.push(tree);
		const category = probeContext(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(category.id).toBe("context");
		expect(category.label).toBe("지침 파일");
		const global = find(category.probes, tree.path("agent/AGENTS.md"));
		expect(global?.status).toBe("loaded");
		expect(global?.rank).toBe(1);
		expect(global?.scope).toBe("전역");
		const project = find(category.probes, tree.path("proj/CLAUDE.md"));
		expect(project?.status).toBe("loaded");
		expect(project?.scope).toBe("프로젝트");
		expect(category.note).toContain("추정");
	});

	test("acceptance: empty ancestor collapsed - one dir row per empty directory", () => {
		const tree = makeTree({ "agent/AGENTS.md": "g", "proj/AGENTS.md": "x", "proj/deep": null });
		trees.push(tree);
		const category = probeContext(envOf({ cwd: tree.path("proj/deep"), agentDir: tree.path("agent"), home: tree.path("home") }));

		const rows = category.probes.filter((probe) => samePath(probe.path, tree.path("proj/deep")));
		expect(rows.length).toBe(1);
		expect(rows[0]?.kind).toBe("dir");
		expect(rows[0]?.status).toBe("missing");
		expect(rows[0]?.reason).toBe("후보 파일 없음");
		expect(find(category.probes, tree.path("proj/AGENTS.md"))?.status).toBe("loaded");
	});

	test("acceptance: AGENTS.override.md shadows AGENTS.md with problem", () => {
		const tree = makeTree({ "agent/AGENTS.override.md": "override", "agent/AGENTS.md": "plain" });
		trees.push(tree);
		const category = probeContext(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		const override = find(category.probes, tree.path("agent/AGENTS.override.md"));
		expect(override?.status).toBe("loaded");
		const shadowed = find(category.probes, tree.path("agent/AGENTS.md"));
		expect(shadowed?.status).toBe("shadowed");
		expect(shadowed?.reason).toBe("같은 폴더의 AGENTS.override.md이 먼저");
		expect(shadowed?.problem).toBe("AGENTS.override.md 때문에 안 읽힘");
		expect(samePath(shadowed?.winner ?? "", tree.path("agent/AGENTS.override.md"))).toBe(true);
	});

	test("acceptance: fake loadProjectContextFiles used when present", () => {
		const tree = makeTree({ "proj/AGENTS.md": "a", "proj/CLAUDE.md": "c" });
		trees.push(tree);
		let called: { cwd: string; agentDir: string } | undefined;
		const senpi: ProbeEnv["senpi"] = {
			loadProjectContextFiles: (options) => {
				called = options;
				return [{ path: tree.path("proj/CLAUDE.md"), content: "c" }];
			},
		};
		const category = probeContext(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), senpi }));

		expect(called?.cwd).toBe(tree.path("proj"));
		expect(called?.agentDir).toBe(tree.path("agent"));
		expect(find(category.probes, tree.path("proj/CLAUDE.md"))?.status).toBe("loaded");
		const skipped = find(category.probes, tree.path("proj/AGENTS.md"));
		expect(skipped?.status).toBe("shadowed");
		expect(skipped?.reason).toBe("하네스가 건너뜀(작업 트리 본 저장소 사본 등)");
		expect(category.note).not.toContain("추정");
	});

	test("acceptance: live changed - session content differs from disk", () => {
		const tree = makeTree({ "agent/AGENTS.md": "disk content" });
		trees.push(tree);
		const senpi: ProbeEnv["senpi"] = { loadProjectContextFiles: () => [{ path: tree.path("agent/AGENTS.md"), content: "disk content" }] };
		const category = probeContext(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				senpi,
				live: { contextFiles: [{ path: tree.path("agent/AGENTS.md"), content: "new content" }] },
			}),
		);
		const row = find(category.probes, tree.path("agent/AGENTS.md"));
		expect(row?.status).toBe("loaded");
		expect(row?.live).toBe("changed");
		expect(row?.problem).toBe(LIVE_PROBLEM.changed);
	});

	test("acceptance: live match - session content equals disk and disk-only for an absent entry", () => {
		const tree = makeTree({ "agent/AGENTS.md": "same", "proj/CLAUDE.md": "project" });
		trees.push(tree);
		const senpi: ProbeEnv["senpi"] = {
			loadProjectContextFiles: () => [
				{ path: tree.path("agent/AGENTS.md"), content: "same" },
				{ path: tree.path("proj/CLAUDE.md"), content: "project" },
			],
		};
		const category = probeContext(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				senpi,
				live: { contextFiles: [{ path: tree.path("agent/AGENTS.md"), content: "same" }] },
			}),
		);
		expect(find(category.probes, tree.path("agent/AGENTS.md"))?.live).toBe("match");
		const diskOnly = find(category.probes, tree.path("proj/CLAUDE.md"));
		expect(diskOnly?.live).toBe("disk-only");
		expect(diskOnly?.problem).toBe(LIVE_PROBLEM["disk-only"]);
	});

	test("acceptance: live session-only - live path missing on disk gets a missing row", () => {
		const tree = makeTree({ "agent/AGENTS.md": "g" });
		trees.push(tree);
		const ghost = tree.path("proj/CLAUDE.md");
		const senpi: ProbeEnv["senpi"] = { loadProjectContextFiles: () => [] };
		const category = probeContext(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				senpi,
				live: { contextFiles: [{ path: ghost, content: "z" }] },
			}),
		);
		const row = find(category.probes, ghost);
		expect(row?.status).toBe("missing");
		expect(row?.live).toBe("session-only");
		expect(row?.problem).toBe(LIVE_PROBLEM["session-only"]);
	});

	test("acceptance: ~/.pi/agent/AGENTS.md is a disabled other-harness row", () => {
		const tree = makeTree({ "home/.pi/agent/AGENTS.md": "pi", "agent/AGENTS.md": "ours" });
		trees.push(tree);
		const category = probeContext(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		const row = find(category.probes, tree.path("home/.pi/agent/AGENTS.md"));
		expect(row?.status).toBe("disabled");
		expect(row?.scope).toBe("다른 에이전트 폴더");
		expect(row?.reason).toBe("지금 세션은 이 폴더를 안 읽음");
	});

	test("dedupes case-insensitive duplicates (agentDir equals cwd, AGENTS.md and AGENTS.MD)", () => {
		const tree = makeTree({ "proj/AGENTS.md": "x" });
		trees.push(tree);
		const category = probeContext(envOf({ cwd: tree.path("proj"), agentDir: tree.path("proj"), home: tree.path("home") }));

		const rows = category.probes.filter((probe) => samePath(probe.path, tree.path("proj/AGENTS.md")));
		expect(rows.length).toBe(1);
		expect(rows[0]?.status).toBe("loaded");
		expect(rows[0]?.scope).toBe("전역");
	});
});
