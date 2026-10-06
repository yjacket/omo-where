import { afterEach, describe, expect, test } from "bun:test";
import { samePath, type Probe, type ProbeEnv } from "../../extension/omo-where/model.ts";
import { probeRules } from "../../extension/omo-where/probes/rules.ts";
import { makeTree, type Tree } from "../helpers/tree.ts";

const trees: Tree[] = [];
afterEach(() => {
	for (const tree of trees.splice(0)) tree.cleanup();
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

describe("probeRules", () => {
	test("acceptance: user rules file loaded - home/.claude/rules/x.md is a loaded 전역 row", () => {
		const tree = makeTree({ "proj/package.json": "{}", "home/.claude/rules/x.md": "rule" });
		trees.push(tree);
		const category = probeRules(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(category.id).toBe("rules");
		expect(category.label).toBe("규칙");
		const dir = find(category.probes, tree.path("home/.claude/rules"));
		expect(dir?.kind).toBe("dir");
		expect(dir?.status).toBe("loaded");
		expect(dir?.scope).toBe("전역");
		const file = find(category.probes, tree.path("home/.claude/rules/x.md"));
		expect(file?.kind).toBe("file");
		expect(file?.status).toBe("loaded");
		expect(file?.scope).toBe("전역");
	});

	test("acceptance: missing dirs - absent project and user rule dirs are missing rows", () => {
		const tree = makeTree({ "proj/package.json": "{}", "proj/sub": null });
		trees.push(tree);
		const category = probeRules(envOf({ cwd: tree.path("proj/sub"), agentDir: tree.path("agent"), home: tree.path("home") }));

		for (const rel of [".pi/rules", ".omo/rules", ".claude/rules", ".cursor/rules", ".github/instructions"]) {
			const row = find(category.probes, tree.path(`proj/${rel}`));
			expect(row?.kind).toBe("dir");
			expect(row?.status).toBe("missing");
			expect(row?.reason).toBe("폴더 없음");
			expect(row?.scope).toBe("프로젝트");
		}
		const user = find(category.probes, tree.path("home/.opencode/rules"));
		expect(user?.status).toBe("missing");
		expect(user?.scope).toBe("전역");
	});

	test("acceptance: project CLAUDE.md shadowed as context - live contextFiles wins", () => {
		const tree = makeTree({ "proj/package.json": "{}", "proj/CLAUDE.md": "project instructions" });
		trees.push(tree);
		const category = probeRules(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				live: { contextFiles: [{ path: tree.path("proj/CLAUDE.md"), content: "project instructions" }] },
			}),
		);

		const row = find(category.probes, tree.path("proj/CLAUDE.md"));
		expect(row?.kind).toBe("file");
		expect(row?.status).toBe("shadowed");
		expect(row?.reason).toBe("지침 파일로 이미 들어감");
		expect(row?.scope).toBe("프로젝트");
		expect(row?.winner).toBeUndefined();
	});

	test("context file does not name itself as its own winner", () => {
		const tree = makeTree({ "proj/package.json": "{}", "proj/AGENTS.md": "a", "home/.config/opencode/AGENTS.md": "u" });
		trees.push(tree);
		const category = probeRules(
			envOf({
				cwd: tree.path("proj"),
				agentDir: tree.path("agent"),
				home: tree.path("home"),
				live: {
					contextFiles: [
						{ path: tree.path("proj/AGENTS.md"), content: "a" },
						{ path: tree.path("home/.config/opencode/AGENTS.md"), content: "u" },
					],
				},
			}),
		);

		const project = find(category.probes, tree.path("proj/AGENTS.md"));
		expect(project?.status).toBe("shadowed");
		expect(project?.reason).toBe("지침 파일로 이미 들어감");
		expect(project?.winner).toBeUndefined();

		const user = find(category.probes, tree.path("home/.config/opencode/AGENTS.md"));
		expect(user?.status).toBe("shadowed");
		expect(user?.reason).toBe("지침 파일로 이미 들어감");
		expect(user?.winner).toBeUndefined();
	});

	test("winner still names another file when one file shadows another", () => {
		const tree = makeTree({ "proj/package.json": "{}", "home/.config/opencode/AGENTS.md": "first", "home/.claude/CLAUDE.md": "second" });
		trees.push(tree);
		const category = probeRules(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		const second = find(category.probes, tree.path("home/.claude/CLAUDE.md"));
		expect(second?.status).toBe("shadowed");
		expect(samePath(second?.winner ?? "", tree.path("home/.config/opencode/AGENTS.md"))).toBe(true);
	});

	test("every loaded row carries a non-empty reason", () => {
		const tree = makeTree({ "proj/package.json": "{}", "proj/.omo/rules/keep.md": "k", "home/.claude/rules/x.md": "x", "home/.claude/CLAUDE.md": "c" });
		trees.push(tree);
		const category = probeRules(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		for (const probe of category.probes) {
			if (probe.status === "loaded") expect(probe.reason.length).toBeGreaterThan(0);
		}
		const projectDir = find(category.probes, tree.path("proj/.omo/rules"));
		expect(projectDir?.status).toBe("loaded");
		expect(projectDir?.reason).toBe("폴더 검색");
		const projectFile = find(category.probes, tree.path("proj/.omo/rules/keep.md"));
		expect(projectFile?.status).toBe("loaded");
		expect(projectFile?.reason).toBe("규칙 파일");
		const userDir = find(category.probes, tree.path("home/.claude/rules"));
		expect(userDir?.status).toBe("loaded");
		expect(userDir?.reason).toBe("폴더 검색");
		const userFile = find(category.probes, tree.path("home/.claude/rules/x.md"));
		expect(userFile?.status).toBe("loaded");
		expect(userFile?.reason).toBe("규칙 파일");
		const userSingle = find(category.probes, tree.path("home/.claude/CLAUDE.md"));
		expect(userSingle?.status).toBe("loaded");
		expect(userSingle?.reason).toBe("규칙 파일");
	});

	test("acceptance: project CLAUDE.md shadowed as context - host loader result when live is absent", () => {
		const tree = makeTree({ "proj/package.json": "{}", "proj/CLAUDE.md": "c" });
		trees.push(tree);
		const senpi: ProbeEnv["senpi"] = { loadProjectContextFiles: () => [{ path: tree.path("proj/CLAUDE.md"), content: "c" }] };
		const category = probeRules(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), senpi }));

		const row = find(category.probes, tree.path("proj/CLAUDE.md"));
		expect(row?.status).toBe("shadowed");
		expect(row?.reason).toBe("지침 파일로 이미 들어감");
	});

	test("acceptance: user single-file first-match - first existing loaded, later existing shadowed", () => {
		const tree = makeTree({ "proj/package.json": "{}", "home/.config/opencode/AGENTS.md": "first", "home/.claude/CLAUDE.md": "second" });
		trees.push(tree);
		const category = probeRules(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		const first = find(category.probes, tree.path("home/.config/opencode/AGENTS.md"));
		expect(first?.status).toBe("loaded");
		expect(first?.scope).toBe("전역");
		const second = find(category.probes, tree.path("home/.claude/CLAUDE.md"));
		expect(second?.status).toBe("shadowed");
		expect(samePath(second?.winner ?? "", tree.path("home/.config/opencode/AGENTS.md"))).toBe(true);

		const onlyTree = makeTree({ "proj/package.json": "{}", "home/.claude/CLAUDE.md": "second" });
		trees.push(onlyTree);
		const onlyCategory = probeRules(envOf({ cwd: onlyTree.path("proj"), agentDir: onlyTree.path("agent"), home: onlyTree.path("home") }));
		expect(find(onlyCategory.probes, onlyTree.path("home/.config/opencode/AGENTS.md"))?.status).toBe("missing");
		expect(find(onlyCategory.probes, onlyTree.path("home/.claude/CLAUDE.md"))?.status).toBe("loaded");
	});

	test("acceptance: excluded dirs skipped - node_modules rules are not listed, nested md/mdc are", () => {
		const tree = makeTree({
			"proj/package.json": "{}",
			"proj/.omo/rules/keep.md": "k",
			"proj/.omo/rules/sub/deep.mdc": "d",
			"proj/.omo/rules/node_modules/skip.md": "s",
			"proj/.omo/rules/dist/skip2.md": "s",
		});
		trees.push(tree);
		const category = probeRules(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(find(category.probes, tree.path("proj/.omo/rules"))?.status).toBe("loaded");
		expect(find(category.probes, tree.path("proj/.omo/rules/keep.md"))?.status).toBe("loaded");
		expect(find(category.probes, tree.path("proj/.omo/rules/sub/deep.mdc"))?.status).toBe("loaded");
		expect(find(category.probes, tree.path("proj/.omo/rules/node_modules/skip.md"))).toBeUndefined();
		expect(find(category.probes, tree.path("proj/.omo/rules/dist/skip2.md"))).toBeUndefined();
	});

	test("untrusted project: rule files disabled, dir row keeps the resource problem", () => {
		const tree = makeTree({ "proj/package.json": "{}", "proj/.omo/rules/x.md": "x" });
		trees.push(tree);
		const category = probeRules(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home"), trusted: false }));

		const file = find(category.probes, tree.path("proj/.omo/rules/x.md"));
		expect(file?.status).toBe("disabled");
		expect(file?.reason).toBe("프로젝트 신뢰 안 함");
		const dir = find(category.probes, tree.path("proj/.omo/rules"));
		expect(dir?.status).toBe("disabled");
		expect(dir?.problem).toBe("신뢰 안 한 프로젝트에 리소스 있음");
	});

	test("project root: rule dirs resolve against the nearest ancestor marker, not cwd", () => {
		const tree = makeTree({ "proj/package.json": "{}", "proj/sub": null, "proj/.claude/rules/a.md": "a" });
		trees.push(tree);
		const category = probeRules(envOf({ cwd: tree.path("proj/sub"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(find(category.probes, tree.path("proj/.claude/rules/a.md"))?.status).toBe("loaded");
		expect(find(category.probes, tree.path("proj/sub/.claude/rules"))).toBeUndefined();
	});

	test("rows keep the harness order: project dirs, project files, user dirs, user files", () => {
		const tree = makeTree({ "proj/package.json": "{}", "proj/AGENTS.md": "a", "home/.claude/rules/x.md": "x", "home/.claude/CLAUDE.md": "c" });
		trees.push(tree);
		const category = probeRules(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		const indexOf = (path: string): number => category.probes.findIndex((probe) => samePath(probe.path, path));
		expect(indexOf(tree.path("proj/.pi/rules"))).toBeLessThan(indexOf(tree.path("proj/AGENTS.md")));
		expect(indexOf(tree.path("proj/AGENTS.md"))).toBeLessThan(indexOf(tree.path("home/.pi/rules")));
		expect(indexOf(tree.path("home/.pi/rules"))).toBeLessThan(indexOf(tree.path("home/.config/opencode/AGENTS.md")));
		expect(indexOf(tree.path("home/.opencode/rules"))).toBeLessThan(indexOf(tree.path("home/.config/opencode/AGENTS.md")));
		expect(indexOf(tree.path("home/.config/opencode/AGENTS.md"))).toBeLessThan(indexOf(tree.path("home/.claude/CLAUDE.md")));

		expect(find(category.probes, tree.path("proj/AGENTS.md"))?.status).toBe("loaded");
	});

	test("note states the mirrored harness rule and the extra warning line", () => {
		const tree = makeTree({ "proj/package.json": "{}" });
		trees.push(tree);
		const category = probeRules(envOf({ cwd: tree.path("proj"), agentDir: tree.path("agent"), home: tree.path("home") }));

		expect(category.note).toContain("규칙 확장 규칙을 따라 계산");
		expect(category.note).toContain("읽기·수정 때 그 파일 위쪽 규칙이 더 붙을 수 있음");
	});
});
