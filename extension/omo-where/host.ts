// Host adapter: reads settings through a read-only storage and resolves the harness resource
// lists once per scan. Never writes: no fs write function is imported here.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve as resolvePath } from "node:path";
import type { HostData, ReadOnlySettingsStorage, Resolved, SenpiApi } from "./model.ts";

const CONFIG_DIR_NAME = ".omo";
const MAX_PARENT_CONFIG_SEARCH_DEPTH = 100;

type SettingsSource = { path: string; format: "json" | "jsonc"; reason: string; scope: "global" | "project" };
type SettingsHandle = ReturnType<NonNullable<SenpiApi["SettingsManager"]>["fromStorage"]>;

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Mirrors nearest-parent-config.js: nearest ancestor holding configDirName, home and the root excluded. */
function findNearestConfigDir(cwd: string, home: string): string | undefined {
	const normalizedHome = normalize(home);
	let current = normalize(cwd);
	for (let depth = 0; depth <= MAX_PARENT_CONFIG_SEARCH_DEPTH; depth += 1) {
		if (current === normalizedHome) return undefined;
		const configDir = join(current, CONFIG_DIR_NAME);
		if (isDirectory(configDir)) return configDir;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

/** Project dir is the nearest ancestor .omo; the walk stops with none at home or the root. */
function selectSource(cwd: string, agentDir: string, home: string, scope: "global" | "project"): SettingsSource | undefined {
	const directory = scope === "global" ? resolvePath(agentDir) : findNearestConfigDir(resolvePath(cwd), home);
	if (directory === undefined) return undefined;
	const jsoncPath = join(directory, "settings.jsonc");
	if (isDirectory(directory) && fileExists(jsoncPath)) return { path: jsoncPath, format: "jsonc", reason: "explicit-jsonc", scope };
	const jsonPath = join(directory, "settings.json");
	if (isDirectory(directory) && fileExists(jsonPath)) return { path: jsonPath, format: "json", reason: "json-only", scope };
	return undefined;
}

function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Settings storage whose writes are discarded: withLock passes the selected file text to fn and ignores the result. */
export function readOnlySettingsStorage(cwd: string, agentDir: string, home: string): ReadOnlySettingsStorage {
	return {
		selectSource: (scope) => selectSource(cwd, agentDir, home, scope),
		withLock: (scope, fn) => {
			const source = selectSource(cwd, agentDir, home, scope);
			let current: string | undefined;
			if (source) {
				try {
					current = readFileSync(source.path, "utf8");
				} catch {
					current = undefined;
				}
			}
			fn(current);
		},
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Reads settings and resolves every resource list once per scan. Every step fails soft with a Korean notice. */
export async function buildHostData(o: {
	cwd: string;
	agentDir: string;
	home: string;
	trusted: boolean;
	senpi: SenpiApi;
	builtinIds: string[];
}): Promise<{ host: HostData; notices: string[] }> {
	const notices: string[] = [];
	const missingMembers: string[] = [];
	const missingPackages: string[] = [];
	let resolved: Resolved | undefined;
	let globalSettings: Record<string, unknown> | undefined;
	let projectSettings: Record<string, unknown> | undefined;

	const SettingsManager = o.senpi?.SettingsManager;
	const DefaultPackageManager = o.senpi?.DefaultPackageManager;

	let settingsManager: SettingsHandle | undefined;
	if (SettingsManager?.fromStorage) {
		try {
			settingsManager = SettingsManager.fromStorage(readOnlySettingsStorage(o.cwd, o.agentDir, o.home), { projectTrusted: o.trusted });
		} catch (error) {
			notices.push(`설정을 읽지 못함: ${describe(error)}`);
		}
		if (settingsManager) {
			try {
				globalSettings = settingsManager.getGlobalSettings();
			} catch (error) {
				notices.push(`설정을 읽지 못함: ${describe(error)}`);
			}
			if (o.trusted) {
				try {
					projectSettings = settingsManager.getProjectSettings();
				} catch (error) {
					notices.push(`설정을 읽지 못함: ${describe(error)}`);
				}
			}
		}
	} else {
		missingMembers.push("SettingsManager");
	}

	if (DefaultPackageManager && settingsManager) {
		try {
			const manager = new DefaultPackageManager({ cwd: o.cwd, agentDir: o.agentDir, settingsManager, builtinExtensions: o.builtinIds });
			resolved = await manager.resolve((source: unknown) => {
				const named = source as { source?: unknown } | null | undefined;
				missingPackages.push(String(named?.source ?? source));
				return "skip";
			});
		} catch (error) {
			notices.push(`리소스 목록을 읽지 못함: ${describe(error)}`);
		}
	} else if (!DefaultPackageManager) {
		missingMembers.push("DefaultPackageManager");
	}

	if (missingMembers.length > 0) {
		notices.push(`일부 내부 기능 없음: ${missingMembers.join(", ")} - 세션 정보와 폴더 기준으로만 표시`);
	}

	const host: HostData = {
		...(resolved !== undefined ? { resolved } : {}),
		...(globalSettings !== undefined ? { globalSettings } : {}),
		...(projectSettings !== undefined ? { projectSettings } : {}),
		missingPackages,
	};
	return { host, notices };
}
