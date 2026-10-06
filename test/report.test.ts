import { afterEach, describe, expect, test } from "bun:test";
import { buildReport, CATEGORY_LABEL, CATEGORY_ORDER } from "../extension/omo-where/report.ts";
import type { Category, CategoryId, Probe, ProbeEnv, ProbeFn, Resolved } from "../extension/omo-where/model.ts";
import { makeTree, type Tree } from "./helpers/tree.ts";

const trees: Tree[] = [];
afterEach(() => {
	for (const t of trees.splice(0)) t.cleanup();
});

const EXPECTED_LABELS = ["시스템 프롬프트", "지침 파일", "스킬", "확장", "규칙", "프롬프트 템플릿", "테마", "MCP", "훅", "메모리", "설정"];
const fakeResolved: Resolved = { extensions: [], skills: [], prompts: [], themes: [], hooks: [] };

let pmCalls = 0;
let pmOptions: { cwd: string; agentDir: string; settingsManager: unknown; builtinExtensions?: string[] } | undefined;
class FakePackageManager {
	constructor(options: { cwd: string; agentDir: string; settingsManager: unknown; builtinExtensions?: string[] }) {
		pmCalls += 1;
		pmOptions = options;
	}
	async resolve(): Promise<Resolved> {
		return fakeResolved;
	}
}
const WorkingSettingsManager = { fromStorage: () => ({ getGlobalSettings: () => ({}), getProjectSettings: () => ({}) }) };
const ThrowingSettingsManager = {
	fromStorage: (): never => {
		throw new Error("boom");
	},
};

/** Env base on throwaway dirs, never a real home. Overrides narrow per scenario. */
function baseOf(over: Partial<Omit<ProbeEnv, "host">> = {}): Omit<ProbeEnv, "host"> {
	const tree = makeTree({ agent: null, proj: null, home: null });
	trees.push(tree);
	return {
		cwd: tree.path("proj"),
		agentDir: tree.path("agent"),
		home: tree.path("home"),
		env: {},
		trusted: true,
		senpi: {},
		live: {},
		...over,
	};
}

function markerProbe(id: CategoryId): Probe {
	return { id: `${id}-marker`, rank: 1, path: `C:/x/${id}`, kind: "file", status: "loaded", reason: "marker" };
}

function marker(id: CategoryId): ProbeFn {
	return (): Category => ({ id, label: CATEGORY_LABEL[id], probes: [markerProbe(id)] });
}

function allFakeProbes(): Partial<Record<CategoryId, ProbeFn>> {
	const probes: Partial<Record<CategoryId, ProbeFn>> = {};
	for (const id of CATEGORY_ORDER) probes[id] = marker(id);
	return probes;
}

describe("report builder", () => {
	test("acceptance: CATEGORY_ORDER and CATEGORY_LABEL cover the 11 categories", () => {
		expect(CATEGORY_ORDER).toEqual(["prompt", "context", "skills", "extensions", "rules", "templates", "themes", "mcp", "hooks", "memory", "settings"]);
		expect(CATEGORY_ORDER.map((id) => CATEGORY_LABEL[id])).toEqual(EXPECTED_LABELS);
	});

	test("acceptance: 11 categories in order with labels", async () => {
		const report = await buildReport(baseOf());
		expect(report.categories.map((c) => c.id)).toEqual([...CATEGORY_ORDER]);
		expect(report.categories.map((c) => c.label)).toEqual(EXPECTED_LABELS);
		expect(report.categories.every((c) => c.error === undefined)).toBe(true);
	});

	test("happy: fake probes build the report in order", async () => {
		const report = await buildReport(baseOf(), allFakeProbes());
		expect(report.categories.map((c) => c.id)).toEqual([...CATEGORY_ORDER]);
		for (const category of report.categories) expect(category.probes[0]?.id).toBe(`${category.id}-marker`);
	});

	test("failure: a throwing probe becomes an error category and others stay intact", async () => {
		const report = await buildReport(baseOf(), {
			mcp: () => {
				throw new Error("mcp boom");
			},
			skills: marker("skills"),
		});
		expect(report.categories.map((c) => c.id)).toEqual([...CATEGORY_ORDER]);
		const mcp = report.categories.find((c) => c.id === "mcp");
		expect(mcp?.error).toBe("mcp boom");
		expect(mcp?.label).toBe("MCP");
		expect(mcp?.probes).toEqual([]);
		const skills = report.categories.find((c) => c.id === "skills");
		expect(skills?.error).toBeUndefined();
		expect(skills?.probes.map((p) => p.id)).toEqual(["skills-marker"]);
	});

	test("acceptance: host notices are passed through", async () => {
		const report = await buildReport(baseOf({ senpi: { SettingsManager: ThrowingSettingsManager, DefaultPackageManager: FakePackageManager } }));
		expect(report.notices).toEqual(["설정을 읽지 못함: boom"]);
	});

	test("acceptance: buildHostData runs once with builtinIds for live extension paths", async () => {
		pmCalls = 0;
		pmOptions = undefined;
		await buildReport(
			baseOf({
				senpi: { SettingsManager: WorkingSettingsManager, DefaultPackageManager: FakePackageManager },
				live: { extensionPaths: ["<builtin:mcp>", "builtin:rules", "C:/x/a.ts", "<builtin:mcp>"] },
			}),
		);
		expect(pmCalls).toBe(1);
		expect(pmOptions?.builtinExtensions).toEqual(["mcp", "rules"]);
	});
});
