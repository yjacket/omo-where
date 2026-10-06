import { afterEach, describe, expect, test } from "bun:test";
import {
	LIVE_PROBLEM,
	samePath,
	type Category,
	type HostData,
	type LiveState,
	type Probe,
	type ProbeEnv,
	type Resolved,
	type ResolvedEntry,
	type SenpiApi,
	type SkillInfo,
} from "../../extension/omo-where/model.ts";
import { probeSkills } from "../../extension/omo-where/probes/skills.ts";
import { makeTree, type Tree } from "../helpers/tree.ts";

let tree: Tree | undefined;

afterEach(() => {
	tree?.cleanup();
	tree = undefined;
});

type EnvOptions = { senpi?: SenpiApi; host?: HostData; live?: LiveState; trusted?: boolean };

function envFor(o: EnvOptions = {}): ProbeEnv {
	if (!tree) throw new Error("tree not built");
	return {
		cwd: tree.path("cwd"),
		agentDir: tree.path("agent"),
		home: tree.path("home"),
		env: {},
		trusted: o.trusted ?? true,
		senpi: o.senpi ?? {},
		host: o.host ?? { missingPackages: [] },
		live: o.live ?? {},
	};
}

function find(category: Category, path: string): Probe {
	const row = category.probes.find((probe) => samePath(probe.path, path));
	if (!row) throw new Error(`no row for ${path}; rows: ${category.probes.map((probe) => probe.path).join(" | ")}`);
	return row;
}

function resolvedSkills(skills: ResolvedEntry[]): Resolved {
	return { extensions: [], skills, prompts: [], themes: [], hooks: [] };
}

function loadSkillsReturning(skills: SkillInfo[], diagnostics: { type: string; message: string; path?: string; collision?: { name: string; winnerPath: string; loserPath: string } }[]) {
	return { skills, diagnostics };
}

const SKILL_MD = "---\nname: alpha\ndescription: a test skill\n---\nbody\n";

describe("probeSkills", () => {
	test("collision case: loser row is shadowed and carries the winner from fake loadSkills diagnostics", () => {
		tree = makeTree({
			".git": null,
			"cwd/.omo/skills/dup/SKILL.md": SKILL_MD,
			"agent/skills/dup/SKILL.md": SKILL_MD,
		});
		const winner = tree.path("cwd/.omo/skills/dup/SKILL.md");
		const loser = tree.path("agent/skills/dup/SKILL.md");
		const senpi: SenpiApi = {
			loadSkills: () =>
				loadSkillsReturning([{ name: "dup", filePath: winner }], [
					{ type: "collision", message: 'name "dup" collision', path: loser, collision: { name: "dup", winnerPath: winner, loserPath: loser } },
				]),
		};
		const category = probeSkills(envFor({ senpi }));

		expect(find(category, winner).status).toBe("loaded");
		const shadowed = find(category, loser);
		expect(shadowed.status).toBe("shadowed");
		expect(shadowed.winner).toBe(winner);
		expect(shadowed.problem).toContain("이름이 겹쳐");
		expect(shadowed.problem).toContain("dup");
	});

	test("warning case: warning row stays loaded (not disabled) with a Korean problem", () => {
		tree = makeTree({
			".git": null,
			"agent/skills/BadName/SKILL.md": SKILL_MD,
			"agent/skills/long/SKILL.md": SKILL_MD,
		});
		const badName = tree.path("agent/skills/BadName/SKILL.md");
		const longDescription = tree.path("agent/skills/long/SKILL.md");
		const senpi: SenpiApi = {
			loadSkills: () =>
				loadSkillsReturning(
					[
						{ name: "BadName", filePath: badName },
						{ name: "long", filePath: longDescription },
					],
					[
						{ type: "warning", message: "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)", path: badName },
						{ type: "warning", message: "description exceeds 1024 characters (1038)", path: longDescription },
					],
				),
		};
		const category = probeSkills(envFor({ senpi }));

		const nameRow = find(category, badName);
		expect(nameRow.status).toBe("loaded");
		expect(nameRow.problem).toBe("이름 규칙 경고");
		const longRow = find(category, longDescription);
		expect(longRow.status).toBe("loaded");
		expect(longRow.problem).toBe("설명이 1024자 초과(1038자) - 경고, 들어옴");
	});

	test("no description case: SKILL.md absent from the loadSkills result is disabled", () => {
		tree = makeTree({ ".git": null, "agent/skills/empty/SKILL.md": "---\nname: empty\n---\n" });
		const file = tree.path("agent/skills/empty/SKILL.md");
		const senpi: SenpiApi = {
			loadSkills: () => loadSkillsReturning([], [{ type: "warning", message: "description is required", path: file }]),
		};
		const category = probeSkills(envFor({ senpi }));

		const row = find(category, file);
		expect(row.status).toBe("disabled");
		expect(row.reason).toBe("설명 없음 등으로 안 읽힘");
		expect(row.problem).toBeUndefined();
	});

	test("untrusted case: project root row disabled with dir problem and its entries disabled", () => {
		tree = makeTree({ ".git": null, "cwd/.omo/skills/alpha/SKILL.md": SKILL_MD });
		const calls: { skillPaths: string[]; includeDefaults: boolean }[] = [];
		const senpi: SenpiApi = {
			loadSkills: (o) => {
				calls.push({ skillPaths: o.skillPaths, includeDefaults: o.includeDefaults });
				return loadSkillsReturning([], []);
			},
		};
		const category = probeSkills(envFor({ senpi, trusted: false }));

		const root = tree.path("cwd/.omo/skills");
		const rootRow = find(category, root);
		expect(rootRow.status).toBe("disabled");
		expect(rootRow.reason).toBe("프로젝트 신뢰 안 함");
		expect(rootRow.problem).toBe("신뢰 안 한 프로젝트에 리소스 있음");
		const skillRow = find(category, tree.path("cwd/.omo/skills/alpha/SKILL.md"));
		expect(skillRow.status).toBe("disabled");
		expect(skillRow.reason).toBe("프로젝트 신뢰 안 함");
		expect(calls).toHaveLength(1);
		expect(calls[0].skillPaths.some((path) => samePath(path, root))).toBe(false);
	});

	test("Claude Code case: ~/.claude/skills rows are disabled", () => {
		tree = makeTree({ ".git": null, "home/.claude/skills/cc/SKILL.md": SKILL_MD });
		const category = probeSkills(envFor());

		const row = find(category, tree.path("home/.claude/skills/cc/SKILL.md"));
		expect(row.status).toBe("disabled");
		expect(row.scope).toBe("Claude Code 폴더");
		expect(row.reason).toBe("Claude Code 폴더 - omo는 안 읽음");
	});

	test("live case: a live session skill missing from disk becomes a session-only row", () => {
		tree = makeTree({ ".git": null });
		const ghost = tree.path("elsewhere/ghost/SKILL.md");
		const pluginGhost = tree.path("prod/node_modules/omo-ai/skills/bundled/SKILL.md");
		const live: LiveState = {
			skills: [
				{ name: "ghost", filePath: ghost },
				{ name: "bundled", filePath: pluginGhost },
			],
		};
		const senpi: SenpiApi = { loadSkills: () => loadSkillsReturning([], []) };
		const category = probeSkills(envFor({ senpi, live }));

		const row = find(category, ghost);
		expect(row.status).toBe("loaded");
		expect(row.live).toBe("session-only");
		expect(row.problem).toBe(LIVE_PROBLEM["session-only"]);
		expect(row.scope).toBe("세션");
		expect(find(category, pluginGhost).scope).toBe("omo 플러그인");
	});

	test("fallback case: without loadSkills the loaded rows come from env.live and the note says 세션 기준", () => {
		tree = makeTree({ ".git": null, "agent/skills/liveonly/SKILL.md": SKILL_MD });
		const file = tree.path("agent/skills/liveonly/SKILL.md");
		const live: LiveState = { skills: [{ name: "liveonly", filePath: file }] };
		const category = probeSkills(envFor({ senpi: {}, live }));

		expect(category.note).toBe("세션 기준");
		expect(find(category, file).status).toBe("loaded");
	});

	test("candidate roots keep harness order and mark missing dirs", () => {
		tree = makeTree({ ".git": null, "cwd/.omo/skills/alpha/SKILL.md": SKILL_MD });
		const category = probeSkills(envFor());

		const order = category.probes.filter((probe) => probe.kind === "dir").map((probe) => probe.path);
		const indexOf = (path: string): number => order.findIndex((candidate) => samePath(candidate, path));
		expect(indexOf(tree.path("cwd/.omo/skills"))).toBeLessThan(indexOf(tree.path("agent/skills")));
		expect(indexOf(tree.path("agent/skills"))).toBeLessThan(indexOf(tree.path("home/.agents/skills")));
		expect(find(category, tree.path("cwd/.pi/skills")).status).toBe("missing");
		expect(find(category, tree.path("cwd/.pi/skills")).reason).toBe("폴더 없음");
		for (let i = 0; i < category.probes.length; i += 1) expect(category.probes[i].rank).toBe(i + 1);
	});

	test("loadSkills is called once with the existing loadable roots in order and includeDefaults false", () => {
		tree = makeTree({
			".git": null,
			"cwd/.omo/skills/a/SKILL.md": SKILL_MD,
			"cwd/.agents/skills/b/SKILL.md": SKILL_MD,
			"agent/skills/c/SKILL.md": SKILL_MD,
			"home/.agents/skills/d/SKILL.md": SKILL_MD,
		});
		const calls: { skillPaths: string[]; includeDefaults: boolean }[] = [];
		const senpi: SenpiApi = {
			loadSkills: (o) => {
				calls.push({ skillPaths: o.skillPaths, includeDefaults: o.includeDefaults });
				return loadSkillsReturning([], []);
			},
		};
		probeSkills(envFor({ senpi }));

		expect(calls).toHaveLength(1);
		expect(calls[0].includeDefaults).toBe(false);
		const expected = [
			tree.path("cwd/.omo/skills"),
			tree.path("cwd/.agents/skills"),
			tree.path("agent/skills"),
			tree.path("home/.agents/skills"),
		];
		expect(calls[0].skillPaths).toHaveLength(expected.length);
		for (let i = 0; i < expected.length; i += 1) expect(samePath(calls[0].skillPaths[i], expected[i])).toBe(true);
	});

	test("resolved omo-ai skill dir rows load with the omo 플러그인 scope", () => {
		tree = makeTree({ ".git": null, "prod/node_modules/omo-ai/skills/bundled/SKILL.md": SKILL_MD });
		const dir = tree.path("prod/node_modules/omo-ai/skills");
		const host: HostData = { missingPackages: [], resolved: resolvedSkills([{ path: dir, enabled: true, metadata: {} }]) };
		const category = probeSkills(envFor({ host }));

		expect(find(category, dir).status).toBe("loaded");
		expect(find(category, dir).scope).toBe("omo 플러그인");
		const skillRow = find(category, tree.path("prod/node_modules/omo-ai/skills/bundled/SKILL.md"));
		expect(skillRow.status).toBe("loaded");
		expect(skillRow.scope).toBe("omo 플러그인");
	});

	test("a loaded skill gone from the live session is marked disk-only", () => {
		tree = makeTree({ ".git": null, "agent/skills/lonely/SKILL.md": SKILL_MD });
		const file = tree.path("agent/skills/lonely/SKILL.md");
		const senpi: SenpiApi = { loadSkills: () => loadSkillsReturning([{ name: "lonely", filePath: file }], []) };
		const category = probeSkills(envFor({ senpi, live: { skills: [] } }));

		const row = find(category, file);
		expect(row.status).toBe("loaded");
		expect(row.live).toBe("disk-only");
		expect(row.problem).toBe(LIVE_PROBLEM["disk-only"]);
	});

	test("other-harness ~/.pi/agent skill rows are disabled", () => {
		tree = makeTree({ ".git": null, "home/.pi/agent/skills/orca/SKILL.md": SKILL_MD, "home/.senpi/agent/": null });
		const category = probeSkills(envFor());

		const row = find(category, tree.path("home/.pi/agent/skills/orca/SKILL.md"));
		expect(row.status).toBe("disabled");
		expect(row.scope).toBe("다른 에이전트 폴더");
		expect(row.reason).toBe("지금 세션은 이 폴더를 안 읽음");
		const emptyOtherHarness = find(category, tree.path("home/.senpi/agent/skills"));
		expect(emptyOtherHarness.status).toBe("disabled");
		expect(emptyOtherHarness.scope).toBe("다른 에이전트 폴더");
	});

	test("walk stops at a skill dir and skips dot dirs and node_modules", () => {
		tree = makeTree({
			".git": null,
			"cwd/.omo/skills/a/SKILL.md": SKILL_MD,
			"cwd/.omo/skills/a/inner/SKILL.md": SKILL_MD,
			"cwd/.omo/skills/.hidden/SKILL.md": SKILL_MD,
			"cwd/.omo/skills/node_modules/pkg/SKILL.md": SKILL_MD,
		});
		const category = probeSkills(envFor());

		expect(find(category, tree.path("cwd/.omo/skills/a/SKILL.md"))).toBeDefined();
		expect(category.probes.some((probe) => samePath(probe.path, tree.path("cwd/.omo/skills/a/inner/SKILL.md")))).toBe(false);
		expect(category.probes.some((probe) => samePath(probe.path, tree.path("cwd/.omo/skills/.hidden/SKILL.md")))).toBe(false);
		expect(category.probes.some((probe) => samePath(probe.path, tree.path("cwd/.omo/skills/node_modules/pkg/SKILL.md")))).toBe(false);
	});

	test("category id and label match the contract", () => {
		tree = makeTree({ ".git": null });
		const category = probeSkills(envFor());
		expect(category.id).toBe("skills");
		expect(category.label).toBe("스킬");
	});
});
