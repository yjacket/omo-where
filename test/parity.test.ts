// Todo 19 - coverage tests against the real runtime.
//
// The runtime entry is process.env.OMO_WHERE_RUNTIME, else the newest
// ~/.omo/agent/runtime/*/dist/index.js. When neither exists every test here is skipped
// with a reason instead of failing.
//
// These tests use the runtime's own loadProjectContextFiles / loadSkills /
// DefaultPackageManager / SettingsManager (via the read-only storage from host.ts) and
// assert that what the runtime reports really shows up in the probe rows.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildHostData, readOnlySettingsStorage } from "../extension/omo-where/host.ts";
import { type Category, type LiveState, type Probe, type ProbeEnv, type Resolved, samePath } from "../extension/omo-where/model.ts";
import { probeContext } from "../extension/omo-where/probes/context.ts";
import { probeExtensions } from "../extension/omo-where/probes/extensions.ts";
import { probeSkills } from "../extension/omo-where/probes/skills.ts";
import { makeTree, type Tree } from "./helpers/tree.ts";

type RuntimeModule = {
	loadProjectContextFiles(options: { cwd: string; agentDir: string }): { path: string; content: string }[];
	loadSkills(options: { cwd: string; agentDir: string; skillPaths: string[]; includeDefaults: boolean }): {
		skills: { name: string; filePath: string }[];
		diagnostics: { type: string; message: string; path?: string; collision?: { name: string; winnerPath: string; loserPath: string } }[];
	};
	DefaultPackageManager: new (options: { cwd: string; agentDir: string; settingsManager: unknown; builtinExtensions?: string[] }) => {
		resolve(onMissing: (source: unknown) => "skip" | "error" | Promise<"skip" | "error">): Promise<Resolved>;
	};
	SettingsManager: {
		fromStorage(storage: unknown, options?: { projectTrusted?: boolean }): { getGlobalSettings(): Record<string, unknown>; getProjectSettings(): Record<string, unknown> };
		create(cwd: string, agentDir?: string, options?: Record<string, unknown>): unknown;
	};
};

/** Newest runtime build; OMO_WHERE_RUNTIME wins when it names an existing file. */
function findRuntimePath(): string | undefined {
	const explicit = process.env.OMO_WHERE_RUNTIME;
	if (explicit !== undefined && explicit !== "" && existsSync(explicit)) return explicit;
	const base = join(homedir(), ".omo", "agent", "runtime");
	if (!existsSync(base)) return undefined;
	let best: { path: string; mtime: number } | undefined;
	for (const name of readdirSync(base)) {
		const candidate = join(base, name, "dist", "index.js");
		if (!existsSync(candidate)) continue;
		try {
			const mtime = statSync(candidate).mtimeMs;
			if (best === undefined || mtime > best.mtime) best = { path: candidate, mtime };
		} catch {
			// unreadable candidate: skip it
		}
	}
	return best?.path;
}

const runtimePath = findRuntimePath();
const runtime: RuntimeModule | undefined =
	runtimePath === undefined ? undefined : ((await import(pathToFileURL(runtimePath).href)) as unknown as RuntimeModule);

const RETIRED_KEY_TEXT = '// keep me\n{"experimental": {"sharedHost": true}, "theme": "x"}\n';
const NO_REWRITE_REASON = "runtime no longer rewrites retired keys";
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Proves the (d) byte-identity assertion can fail: real create() rewrites a disposable copy. */
function detectRetiredRewrite(rt: RuntimeModule): boolean {
	const tree = makeTree({
		"agent/settings.jsonc": RETIRED_KEY_TEXT,
		"proj/.omo/settings.json": "{\n  \"theme\": \"proj\"\n}\n",
	});
	try {
		const file = tree.path("agent/settings.jsonc");
		const before = sha256(file);
		try {
			rt.SettingsManager.create(tree.path("proj"), tree.path("agent"));
		} catch {
			return false;
		}
		return sha256(file) !== before;
	} finally {
		tree.cleanup();
	}
}

const rewritesRetired = runtime !== undefined && detectRetiredRewrite(runtime);
if (!rewritesRetired && runtime !== undefined) console.log(`parity: ${NO_REWRITE_REASON}`);

const suite = runtime === undefined ? describe.skip : describe;
const negTest = rewritesRetired ? test : test.skip;

function envOf(tree: Tree, overrides: Partial<ProbeEnv> & { live?: LiveState }): ProbeEnv {
	return {
		cwd: tree.path("cwd"),
		agentDir: tree.path("agent"),
		home: tree.path("home"),
		env: {},
		trusted: true,
		senpi: {},
		host: { missingPackages: [] },
		live: {},
		...overrides,
	};
}

function findRow(category: Category, path: string): Probe {
	const row = category.probes.find((probe) => samePath(probe.path, path));
	if (row === undefined) throw new Error(`no row for ${path}; rows: ${category.probes.map((probe) => probe.path).join(" | ")}`);
	return row;
}

/** Literal-path key: samePath would collapse a link and its target onto one row. */
function literalKey(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function findLiteralRow(category: Category, path: string): Probe {
	const key = literalKey(path);
	const row = category.probes.find((probe) => literalKey(probe.path) === key);
	if (row === undefined) throw new Error(`no literal row for ${path}; rows: ${category.probes.map((probe) => probe.path).join(" | ")}`);
	return row;
}

suite("real-runtime parity", () => {
	test("(a) every real loadProjectContextFiles path is a loaded probeContext row in the same order", async () => {
		const rt = runtime as RuntimeModule;
		const tree = makeTree({ "agent/AGENTS.md": "global", "proj/AGENTS.md": "project", "proj/deep/CLAUDE.md": "deep" });
		try {
			const cwd = tree.path("proj/deep");
			const agentDir = tree.path("agent");
			const expected = rt.loadProjectContextFiles({ cwd, agentDir }).map((file) => file.path);
			expect(expected.length).toBeGreaterThanOrEqual(3);

			const category = probeContext(envOf(tree, { cwd, agentDir, senpi: { loadProjectContextFiles: rt.loadProjectContextFiles } }));
			const loaded = category.probes.filter((probe) => probe.kind === "file" && probe.status === "loaded").map((probe) => probe.path);

			for (const path of expected) expect(loaded.some((row) => samePath(row, path))).toBe(true);
			const indexes = expected.map((path) => loaded.findIndex((row) => samePath(row, path)));
			for (let i = 1; i < indexes.length; i += 1) expect(indexes[i]).toBeGreaterThan(indexes[i - 1]);
		} finally {
			tree.cleanup();
		}
	});

	test("(b) real loadSkills results map to loaded, warned and shadowed probeSkills rows", async () => {
		const rt = runtime as RuntimeModule;
		const duplicate = "---\nname: dup\ndescription: a duplicate skill\n---\nbody\n";
		const longDescription = `---\nname: longone\ndescription: ${"D".repeat(1100)}\n---\nbody\n`;
		const tree = makeTree({
			".git": null,
			"cwd/.omo/skills/dup/SKILL.md": duplicate,
			"agent/skills/dup/SKILL.md": duplicate,
			"agent/skills/long/SKILL.md": longDescription,
		});
		try {
			const cwd = tree.path("cwd");
			const agentDir = tree.path("agent");
			const winner = tree.path("cwd/.omo/skills/dup/SKILL.md");
			const loser = tree.path("agent/skills/dup/SKILL.md");
			const longSkill = tree.path("agent/skills/long/SKILL.md");
			const skillPaths = [tree.path("cwd/.omo/skills"), tree.path("agent/skills")];

			const result = rt.loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false });
			expect(result.skills.length).toBe(2);

			const category = probeSkills(envOf(tree, { cwd, agentDir, senpi: { loadSkills: rt.loadSkills } }));
			for (const skill of result.skills) expect(findRow(category, skill.filePath).status).toBe("loaded");

			const longRow = findRow(category, longSkill);
			expect(longRow.status).toBe("loaded");
			expect(longRow.problem).toBe("설명이 1024자 초과(1100자) - 경고, 들어옴");

			const loserRow = findRow(category, loser);
			expect(loserRow.status).toBe("shadowed");
			expect(loserRow.winner).toBeDefined();
			expect(samePath(loserRow.winner ?? "", winner)).toBe(true);
		} finally {
			tree.cleanup();
		}
	});

	test("(c) real DefaultPackageManager entries are loaded probeExtensions rows", async () => {
		const rt = runtime as RuntimeModule;
		const tree = makeTree({
			"cwd/.keep": "",
			"agent/extensions/a.ts": "export default {};\n",
			"agent/extensions/c.ts.bak": "junk\n",
		});
		try {
			const cwd = tree.path("cwd");
			const agentDir = tree.path("agent");
			const home = tree.path("home");
			const settingsManager = rt.SettingsManager.fromStorage(readOnlySettingsStorage(cwd, agentDir, home), { projectTrusted: false });
			const manager = new rt.DefaultPackageManager({ cwd, agentDir, settingsManager, builtinExtensions: [] });
			const resolved = await manager.resolve(() => "skip");
			const enabled = resolved.extensions.filter((entry) => entry.enabled).map((entry) => entry.path);
			expect(enabled.length).toBeGreaterThan(0);

			const category = probeExtensions(envOf(tree, { cwd, agentDir, home, live: { extensionPaths: [...enabled, "<builtin:rules>"] } }));
			for (const path of enabled) expect(findRow(category, path).status).toBe("loaded");

			const leftover = findRow(category, tree.path("agent/extensions/c.ts.bak"));
			expect(leftover.status).toBe("disabled");
			expect(leftover.problem).toBe("확장으로 안 읽힘(c.ts.bak) - 남은 파일?");

			const builtin = category.probes.find((probe) => probe.path === "builtin:rules");
			expect(builtin?.status).toBe("loaded");
			expect(builtin?.kind).toBe("virtual");
			expect(builtin?.scope).toBe("내장");
			expect(category.probes.some((probe) => probe.status === "missing" && probe.live === "session-only")).toBe(false);
		} finally {
			tree.cleanup();
		}
	});

	test("(d) real SettingsManager writes are discarded and the global theme reads through", async () => {
		const rt = runtime as RuntimeModule;
		const tree = makeTree({
			"agent/settings.jsonc": RETIRED_KEY_TEXT,
			"proj/.omo/settings.json": "{\n  \"theme\": \"proj\"\n}\n",
		});
		try {
			const cwd = tree.path("proj");
			const agentDir = tree.path("agent");
			const globalFile = tree.path("agent/settings.jsonc");
			const projectFile = tree.path("proj/.omo/settings.json");
			const beforeGlobal = sha256(globalFile);
			const beforeProject = sha256(projectFile);

			const { host } = await buildHostData({
				cwd,
				agentDir,
				home: tree.path("home"),
				trusted: true,
				senpi: { SettingsManager: rt.SettingsManager, DefaultPackageManager: rt.DefaultPackageManager },
				builtinIds: [],
			});

			expect(host.globalSettings?.theme).toBe("x");
			expect(sha256(globalFile)).toBe(beforeGlobal);
			expect(sha256(projectFile)).toBe(beforeProject);
		} finally {
			tree.cleanup();
		}
	});

	negTest("(d-neg) real SettingsManager.create rewrites a disposable copy (proves the identity check can fail)", () => {
		const rt = runtime as RuntimeModule;
		const tree = makeTree({
			"agent/settings.jsonc": RETIRED_KEY_TEXT,
			"proj/.omo/settings.json": "{\n  \"theme\": \"proj\"\n}\n",
		});
		try {
			const file = tree.path("agent/settings.jsonc");
			const before = sha256(file);
			rt.SettingsManager.create(tree.path("proj"), tree.path("agent"));
			expect(sha256(file)).not.toBe(before);
		} finally {
			tree.cleanup();
		}
	});

	test("(e) a directory-link duplicate is loaded once and shadowed on the other literal path", async () => {
		const rt = runtime as RuntimeModule;
		const skill = "---\nname: x\ndescription: linked skill\n---\nbody\n";
		const tree = makeTree({ ".git": null, "cwd/.omo/skills/x/SKILL.md": skill, "agent/skills": null });
		try {
			const cwd = tree.path("cwd");
			const agentDir = tree.path("agent");
			const winner = tree.path("cwd/.omo/skills/x/SKILL.md");
			const linked = tree.path("agent/skills/x/SKILL.md");
			symlinkSync(tree.path("cwd/.omo/skills/x"), tree.path("agent/skills/x"), process.platform === "win32" ? "junction" : "dir");

			const result = rt.loadSkills({
				cwd,
				agentDir,
				skillPaths: [tree.path("cwd/.omo/skills"), tree.path("agent/skills")],
				includeDefaults: false,
			});
			expect(result.skills.length).toBe(1);
			const returned = result.skills[0]?.filePath ?? "";

			const category = probeSkills(envOf(tree, { cwd, agentDir, senpi: { loadSkills: rt.loadSkills } }));
			const returnedRow = findLiteralRow(category, returned);
			expect(returnedRow.status).toBe("loaded");

			const other = literalKey(returned) === literalKey(winner) ? linked : winner;
			const shadowed = findLiteralRow(category, other);
			expect(shadowed.status).toBe("shadowed");
			expect(shadowed.reason).toBe("같은 파일(링크)로 이미 들어옴");
		} finally {
			tree.cleanup();
		}
	});
});
