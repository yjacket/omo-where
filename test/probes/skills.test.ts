import { afterEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { resolve } from "node:path";
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

/** Literal-path lookup: samePath would collapse a link and its target onto the first row. */
function literal(path: string): string {
	const s = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? s.toLowerCase() : s;
}

function findLiteral(category: Category, path: string): Probe {
	const key = literal(path);
	const row = category.probes.find((probe) => literal(probe.path) === key);
	if (!row) throw new Error(`no literal row for ${path}; rows: ${category.probes.map((probe) => probe.path).join(" | ")}`);
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

	test("Claude Code case: the folder is one disabled row and its skills get no rows", () => {
		tree = makeTree({ ".git": null, "home/.claude/skills/cc/SKILL.md": SKILL_MD });
		const category = probeSkills(envFor());

		const dir = tree.path("home/.claude/skills");
		const row = find(category, dir);
		expect(row.kind).toBe("dir");
		expect(row.status).toBe("disabled");
		expect(row.scope).toBe("Claude Code 폴더");
		expect(row.reason).toBe("Claude Code 폴더 - omo는 안 읽음 · 스킬 1개");
		expect(category.probes.some((probe) => literal(probe.path).startsWith(`${literal(dir)}/`))).toBe(false);
	});

	test("Claude Code folder counts recursively found skills in one row", () => {
		tree = makeTree({
			".git": null,
			"home/.claude/skills/a/SKILL.md": SKILL_MD,
			"home/.claude/skills/b/SKILL.md": SKILL_MD,
			"home/.claude/skills/nest/deep/c/SKILL.md": SKILL_MD,
		});
		const category = probeSkills(envFor());

		const dir = tree.path("home/.claude/skills");
		const rows = category.probes.filter((probe) => literal(probe.path) === literal(dir));
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe("dir");
		expect(rows[0].status).toBe("disabled");
		expect(rows[0].scope).toBe("Claude Code 폴더");
		expect(rows[0].reason.endsWith("스킬 3개")).toBe(true);
		expect(category.probes.some((probe) => literal(probe.path).startsWith(`${literal(dir)}/`))).toBe(false);
	});

	test("live case: live session skills missing from disk become session-only rows", () => {
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
		expect(row.status).toBe("missing");
		expect(row.live).toBe("session-only");
		expect(row.problem).toBe(LIVE_PROBLEM["session-only"]);
		expect(row.scope).toBe("세션");
		expect(find(category, pluginGhost).scope).toBe("omo 플러그인");
	});

	test("live case: an existing plugin skill outside every root is loaded with no live mark", () => {
		tree = makeTree({ ".git": null, "prod/node_modules/omo-ai/plugin/skills/x/SKILL.md": SKILL_MD });
		const file = tree.path("prod/node_modules/omo-ai/plugin/skills/x/SKILL.md");
		const live: LiveState = { skills: [{ name: "x", filePath: file }] };
		const senpi: SenpiApi = { loadSkills: () => loadSkillsReturning([], []) };
		const category = probeSkills(envFor({ senpi, live }));

		const row = find(category, file);
		expect(row.status).toBe("loaded");
		expect(row.scope).toBe("omo 플러그인");
		expect(row.reason).toBe("omo 플러그인 스킬");
		expect(row.live).toBeUndefined();
		expect(row.problem).toBeUndefined();
	});

	test("live case: an existing memory skill is loaded with the 메모리 스킬 reason", () => {
		tree = makeTree({ ".git": null, "home/.omo/memory/agents/abc/repo/skills/y/SKILL.md": SKILL_MD });
		const file = tree.path("home/.omo/memory/agents/abc/repo/skills/y/SKILL.md");
		const live: LiveState = { skills: [{ name: "y", filePath: file }] };
		const senpi: SenpiApi = { loadSkills: () => loadSkillsReturning([], []) };
		const category = probeSkills(envFor({ senpi, live }));

		const row = find(category, file);
		expect(row.status).toBe("loaded");
		expect(row.scope).toBe("세션");
		expect(row.reason).toBe("메모리 스킬");
		expect(row.live).toBeUndefined();
	});

	test("live case: an existing builtin runtime skill is loaded with the 내장 스킬 reason", () => {
		tree = makeTree({ ".git": null, "home/.omo/agent/runtime/hash/node_modules/pkg/src/skill/z/SKILL.md": SKILL_MD });
		const file = tree.path("home/.omo/agent/runtime/hash/node_modules/pkg/src/skill/z/SKILL.md");
		const live: LiveState = { skills: [{ name: "z", filePath: file }] };
		const senpi: SenpiApi = { loadSkills: () => loadSkillsReturning([], []) };
		const category = probeSkills(envFor({ senpi, live }));

		const row = find(category, file);
		expect(row.status).toBe("loaded");
		expect(row.scope).toBe("내장");
		expect(row.reason).toBe("내장 스킬");
		expect(row.live).toBeUndefined();
	});

	test("live case: a live skill file that is gone is missing with the session-only mark", () => {
		tree = makeTree({ ".git": null });
		const gone = tree.path("elsewhere/gone/SKILL.md");
		const live: LiveState = { skills: [{ name: "gone", filePath: gone }] };
		const senpi: SenpiApi = { loadSkills: () => loadSkillsReturning([], []) };
		const category = probeSkills(envFor({ senpi, live }));

		const row = find(category, gone);
		expect(row.status).toBe("missing");
		expect(row.live).toBe("session-only");
		expect(row.problem).toBe(LIVE_PROBLEM["session-only"]);
		expect(row.scope).toBe("세션");
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

	test("link case: a SKILL.md reached by a directory link is shadowed by the literally loaded file", () => {
		tree = makeTree({
			".git": null,
			"home/.agents/skills/x/SKILL.md": "---\nname: x\ndescription: d\n---\nbody\n",
			"agent/skills": null,
		});
		const winner = tree.path("home/.agents/skills/x/SKILL.md");
		symlinkSync(tree.path("home/.agents/skills/x"), tree.path("agent/skills/x"), process.platform === "win32" ? "junction" : "dir");
		const senpi: SenpiApi = { loadSkills: () => loadSkillsReturning([{ name: "x", filePath: winner }], []) };
		const category = probeSkills(envFor({ senpi }));

		expect(findLiteral(category, winner).status).toBe("loaded");
		expect(findLiteral(category, winner).reason).toBe("스킬");
		const linked = findLiteral(category, tree.path("agent/skills/x/SKILL.md"));
		expect(linked.status).toBe("shadowed");
		expect(linked.reason).toBe("같은 파일(링크)로 이미 들어옴");
		expect(linked.winner).toBe(winner);
		expect(linked.linked).toBe(true);
		expect(linked.problem).toBeUndefined();
	});

	test("every loaded row carries a non-empty reason", () => {
		tree = makeTree({
			".git": null,
			"cwd/.omo/skills/alpha/SKILL.md": SKILL_MD,
			"agent/skills/beta/SKILL.md": SKILL_MD,
		});
		const t = tree;
		const senpi: SenpiApi = {
			loadSkills: () =>
				loadSkillsReturning(
					[
						{ name: "alpha", filePath: t.path("cwd/.omo/skills/alpha/SKILL.md") },
						{ name: "beta", filePath: t.path("agent/skills/beta/SKILL.md") },
					],
					[],
				),
		};
		const category = probeSkills(envFor({ senpi }));

		const loaded = category.probes.filter((probe) => probe.status === "loaded");
		expect(loaded.length).toBeGreaterThan(0);
		for (const row of loaded) expect(row.reason.length).toBeGreaterThan(0);
		expect(findLiteral(category, t.path("cwd/.omo/skills")).reason).toBe("폴더 검색");
	});

	test("a throwing loadSkills falls back to env.live.skills and the note carries the failure", () => {
		tree = makeTree({ ".git": null, "agent/skills/liveonly/SKILL.md": SKILL_MD });
		const file = tree.path("agent/skills/liveonly/SKILL.md");
		const senpi: SenpiApi = {
			loadSkills: () => {
				throw new Error("boom");
			},
		};
		const category = probeSkills(envFor({ senpi, live: { skills: [{ name: "liveonly", filePath: file }] } }));

		expect(category.note).toBe("세션 기준 · 스킬 읽기 실패: boom");
		expect(find(category, file).status).toBe("loaded");
	});

	test("rows for folders omo does not read come after the live skill rows", () => {
		tree = makeTree({ ".git": null, "home/.claude/skills/cc/SKILL.md": SKILL_MD, "home/.pi/agent/skills/orca/SKILL.md": SKILL_MD });
		const ghost = tree.path("elsewhere/ghost/SKILL.md");
		const senpi: SenpiApi = { loadSkills: () => loadSkillsReturning([], []) };
		const category = probeSkills(envFor({ senpi, live: { skills: [{ name: "ghost", filePath: ghost }] } }));

		const rank = (path: string): number => find(category, path).rank;
		const claude = rank(tree.path("home/.claude/skills"));
		const pi = rank(tree.path("home/.pi/agent/skills"));
		const piEntry = rank(tree.path("home/.pi/agent/skills/orca/SKILL.md"));
		expect(rank(ghost)).toBeLessThan(claude);
		expect(claude).toBeLessThan(pi);
		expect(pi).toBeLessThan(piEntry);
		expect(piEntry).toBe(category.probes.length);
		const foreign = category.probes.filter((probe) => probe.scope === "Claude Code 폴더" || probe.scope === "다른 에이전트 폴더");
		expect(foreign.every((probe) => probe.rank > rank(ghost))).toBe(true);
	});

	test("category id and label match the contract", () => {
		tree = makeTree({ ".git": null });
		const category = probeSkills(envFor());
		expect(category.id).toBe("skills");
		expect(category.label).toBe("스킬");
	});
});
