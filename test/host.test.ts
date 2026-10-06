import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildHostData, readOnlySettingsStorage } from "../extension/omo-where/host.ts";
import type { ReadOnlySettingsStorage, Resolved, SenpiApi } from "../extension/omo-where/model.ts";
import { makeTree, type Tree } from "./helpers/tree.ts";

const trees: Tree[] = [];
afterEach(() => {
	pmResolve = undefined;
	lastPmOptions = undefined;
	for (const t of trees.splice(0)) t.cleanup();
});
function tree(spec: Record<string, string | null>): Tree {
	const t = makeTree(spec);
	trees.push(t);
	return t;
}

const fakeResolved: Resolved = { extensions: [], skills: [], prompts: [], themes: [], hooks: [] };
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

let pmResolve: ((onMissing: (source: unknown) => "skip" | "error" | Promise<"skip" | "error">) => Promise<Resolved>) | undefined;
let lastPmOptions: { cwd: string; agentDir: string; settingsManager: unknown; builtinExtensions?: string[] } | undefined;
class FakePackageManager {
	constructor(o: { cwd: string; agentDir: string; settingsManager: unknown; builtinExtensions?: string[] }) {
		lastPmOptions = o;
	}
	resolve(onMissing: (source: unknown) => "skip" | "error" | Promise<"skip" | "error">): Promise<Resolved> {
		return pmResolve ? pmResolve(onMissing) : Promise.resolve(fakeResolved);
	}
}

type SettingsOptions = { projectTrusted?: boolean };

describe("readOnlySettingsStorage", () => {
	test("global selectSource prefers settings.jsonc over settings.json", () => {
		const t = tree({
			"agent/settings.jsonc": "{ \"theme\": \"jsonc\" }\n",
			"agent/settings.json": "{ \"theme\": \"json\" }\n",
		});
		const storage = readOnlySettingsStorage(t.path("proj"), t.path("agent"), t.path("home"));
		const source = storage.selectSource("global");
		expect(source?.path).toBe(t.path("agent/settings.jsonc"));
		expect(source?.format).toBe("jsonc");
		expect(source?.reason).toBe("explicit-jsonc");
		expect(source?.scope).toBe("global");
	});

	test("global selectSource falls back to settings.json and returns undefined when absent", () => {
		const t = tree({ "agent/settings.json": "{}\n", "home/.keep": "" });
		const storage = readOnlySettingsStorage(t.path("proj"), t.path("agent"), t.path("home"));
		expect(storage.selectSource("global")?.format).toBe("json");
		expect(storage.selectSource("global")?.reason).toBe("json-only");
		const empty = readOnlySettingsStorage(t.path("proj"), t.path("agent2"), t.path("home"));
		expect(empty.selectSource("global")).toBeUndefined();
	});

	test("project selectSource finds the nearest ancestor .omo", () => {
		const t = tree({
			"home/proj/.omo/settings.json": "{ \"a\": 1 }\n",
			"home/proj/sub/deep/.keep": "",
			"home/.keep": "",
		});
		const storage = readOnlySettingsStorage(t.path("home/proj/sub/deep"), t.path("agent"), t.path("home"));
		const source = storage.selectSource("project");
		expect(source?.path).toBe(t.path("home/proj/.omo/settings.json"));
		expect(source?.format).toBe("json");
		expect(source?.scope).toBe("project");
	});

	test("project selectSource returns undefined at the home dir", () => {
		const t = tree({ "home/.omo/settings.json": "{}\n" });
		const storage = readOnlySettingsStorage(t.path("home"), t.path("agent"), t.path("home"));
		expect(storage.selectSource("project")).toBeUndefined();
	});

	test("withLock passes file text and a fn returning \"changed\" leaves the bytes identical", () => {
		const t = tree({ "agent/settings.json": "{ \"theme\": \"dark\" }\n" });
		const storage = readOnlySettingsStorage(t.path("proj"), t.path("agent"), t.path("home"));
		const file = t.path("agent/settings.json");
		const before = sha256(file);
		let seen: string | undefined;
		let calls = 0;
		storage.withLock("global", (current) => {
			calls += 1;
			seen = current;
			return "changed";
		});
		expect(calls).toBe(1);
		expect(seen).toBe("{ \"theme\": \"dark\" }\n");
		expect(sha256(file)).toBe(before);
	});

	test("withLock passes undefined when the selected file is absent", () => {
		const t = tree({ "home/.keep": "" });
		const storage = readOnlySettingsStorage(t.path("proj"), t.path("agent"), t.path("home"));
		let seen: string | undefined = "unset";
		let calls = 0;
		storage.withLock("global", (current) => {
			calls += 1;
			seen = current;
			return undefined;
		});
		expect(calls).toBe(1);
		expect(seen).toBeUndefined();
	});
});

describe("buildHostData", () => {
	test("fromStorage receives projectTrusted:false and a storage object; untrusted leaves projectSettings undefined", async () => {
		const t = tree({ "home/.keep": "" });
		let storageArg: ReadOnlySettingsStorage | undefined;
		let optionsArg: SettingsOptions | undefined;
		const senpi: SenpiApi = {
			SettingsManager: {
				fromStorage(storage, o) {
					storageArg = storage;
					optionsArg = o;
					return {
						getGlobalSettings: () => ({ theme: "dark" }),
						getProjectSettings: () => {
							throw new Error("project settings must not be read when untrusted");
						},
					};
				},
			},
		};
		const { host, notices } = await buildHostData({ cwd: t.path("proj"), agentDir: t.path("agent"), home: t.path("home"), trusted: false, senpi: { ...senpi, DefaultPackageManager: FakePackageManager }, builtinIds: [] });
		expect(optionsArg).toEqual({ projectTrusted: false });
		expect(typeof storageArg?.selectSource).toBe("function");
		expect(typeof storageArg?.withLock).toBe("function");
		expect(host.globalSettings).toEqual({ theme: "dark" });
		expect(host.projectSettings).toBeUndefined();
		expect(notices).toEqual([]);
	});

	test("trusted reads project settings", async () => {
		const t = tree({ "home/.keep": "" });
		const senpi: SenpiApi = {
			SettingsManager: {
				fromStorage: () => ({ getGlobalSettings: () => ({ g: 1 }), getProjectSettings: () => ({ p: 2 }) }),
			},
			DefaultPackageManager: FakePackageManager,
		};
		const { host, notices } = await buildHostData({ cwd: t.path("proj"), agentDir: t.path("agent"), home: t.path("home"), trusted: true, senpi, builtinIds: [] });
		expect(host.globalSettings).toEqual({ g: 1 });
		expect(host.projectSettings).toEqual({ p: 2 });
		expect(notices).toEqual([]);
	});

	test("resolve receives a callback; callback(\"x\") is \"skip\" and missingPackages contains \"x\"", async () => {
		const t = tree({ "home/.keep": "" });
		let cbResult: unknown;
		pmResolve = async (onMissing) => {
			cbResult = onMissing("x");
			return fakeResolved;
		};
		const senpi: SenpiApi = {
			SettingsManager: { fromStorage: () => ({ getGlobalSettings: () => ({}), getProjectSettings: () => ({}) }) },
			DefaultPackageManager: FakePackageManager,
		};
		const { host, notices } = await buildHostData({ cwd: t.path("proj"), agentDir: t.path("agent"), home: t.path("home"), trusted: true, senpi, builtinIds: ["mcp"] });
		expect(cbResult).toBe("skip");
		expect(host.missingPackages).toContain("x");
		expect(host.resolved).toEqual(fakeResolved);
		expect(lastPmOptions?.settingsManager).toBeDefined();
		expect(lastPmOptions?.builtinExtensions).toEqual(["mcp"]);
		expect(notices).toEqual([]);
	});

	test("throwing resolve adds a Korean notice and leaves resolved undefined", async () => {
		const t = tree({ "home/.keep": "" });
		pmResolve = async () => {
			throw new Error("boom");
		};
		const senpi: SenpiApi = {
			SettingsManager: { fromStorage: () => ({ getGlobalSettings: () => ({}), getProjectSettings: () => ({}) }) },
			DefaultPackageManager: FakePackageManager,
		};
		const { host, notices } = await buildHostData({ cwd: t.path("proj"), agentDir: t.path("agent"), home: t.path("home"), trusted: true, senpi, builtinIds: [] });
		expect(host.resolved).toBeUndefined();
		expect(notices.some((n) => n.startsWith("리소스 목록을 읽지 못함"))).toBe(true);
		expect(notices.some((n) => n.includes("boom"))).toBe(true);
	});

	test("missing SettingsManager adds an internal-features notice", async () => {
		const t = tree({ "home/.keep": "" });
		const senpi: SenpiApi = {};
		const { host, notices } = await buildHostData({ cwd: t.path("proj"), agentDir: t.path("agent"), home: t.path("home"), trusted: true, senpi, builtinIds: [] });
		expect(host.globalSettings).toBeUndefined();
		expect(host.projectSettings).toBeUndefined();
		expect(host.resolved).toBeUndefined();
		expect(notices).toContain("일부 내부 기능 없음: SettingsManager, DefaultPackageManager - 세션 정보와 폴더 기준으로만 표시");
	});

	test("missing DefaultPackageManager adds an internal-features notice", async () => {
		const t = tree({ "home/.keep": "" });
		const senpi: SenpiApi = {
			SettingsManager: { fromStorage: () => ({ getGlobalSettings: () => ({}), getProjectSettings: () => ({}) }) },
		};
		const { host, notices } = await buildHostData({ cwd: t.path("proj"), agentDir: t.path("agent"), home: t.path("home"), trusted: true, senpi, builtinIds: [] });
		expect(host.resolved).toBeUndefined();
		expect(notices).toContain("일부 내부 기능 없음: DefaultPackageManager - 세션 정보와 폴더 기준으로만 표시");
	});

	test("throwing fromStorage adds a settings notice and leaves settings undefined", async () => {
		const t = tree({ "home/.keep": "" });
		const senpi: SenpiApi = {
			SettingsManager: {
				fromStorage: () => {
					throw new Error("bad settings");
				},
			},
		};
		const { host, notices } = await buildHostData({ cwd: t.path("proj"), agentDir: t.path("agent"), home: t.path("home"), trusted: true, senpi, builtinIds: [] });
		expect(host.globalSettings).toBeUndefined();
		expect(host.projectSettings).toBeUndefined();
		expect(notices).toContain("설정을 읽지 못함: bad settings");
	});

	test("throwing getGlobalSettings adds a settings notice and leaves settings undefined", async () => {
		const t = tree({ "home/.keep": "" });
		const senpi: SenpiApi = {
			SettingsManager: {
				fromStorage: () => ({
					getGlobalSettings: () => {
						throw new Error("no global");
					},
					getProjectSettings: () => ({ p: 1 }),
				}),
			},
		};
		const { host, notices } = await buildHostData({ cwd: t.path("proj"), agentDir: t.path("agent"), home: t.path("home"), trusted: true, senpi, builtinIds: [] });
		expect(host.globalSettings).toBeUndefined();
		expect(host.projectSettings).toEqual({ p: 1 });
		expect(notices).toContain("설정을 읽지 못함: no global");
	});
});
