// /where command entry. Registers the command only; everything else happens when it runs.
import { homedir } from "node:os";
import { openInEditor, resolveEditorCommand, type TuiControl } from "./editor.ts";
import { readOnlySettingsStorage } from "./host.ts";
import type { LiveState, Report, SenpiApi } from "./model.ts";
import { buildReport } from "./report.ts";
import { WhereView } from "./ui/view.ts";

type Notify = (message: string, level?: "info" | "warning" | "error") => void;
type Theme = ConstructorParameters<typeof WhereView>[0]["theme"];
type Done = (value: undefined) => void;
type CustomFactory = (tui: TuiControl, theme: Theme, keybindings: unknown, done: Done) => WhereView;
type Ctx = {
	hasUI?: boolean;
	mode?: string;
	cwd: string;
	agentDir: string;
	ui?: {
		notify?: Notify;
		custom?: (factory: CustomFactory, options?: unknown) => Promise<unknown>;
	};
	isProjectTrusted?: () => boolean;
	isIdle?: () => boolean;
	[key: string]: unknown;
};
type Pi = { registerCommand?: (name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }) => void };

const SENPI_MEMBERS = [
	"DefaultPackageManager",
	"SettingsManager",
	"loadSkills",
	"loadSkillsFromDir",
	"loadProjectContextFiles",
	"parseFrontmatter",
	"hasTrustRequiringProjectResources",
] as const;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function attempt<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

function asArray(value: unknown): readonly unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

/** Each live value is read in its own try, so one throwing getter drops only its own rows. */
function collectLive(ctx: Ctx): LiveState {
	const fn = (name: string): unknown => {
		const member = ctx[name];
		return typeof member === "function" ? (member as (...a: unknown[]) => unknown).call(ctx) : member;
	};
	const options = attempt(() => fn("getSystemPromptOptions")) as { contextFiles?: unknown; skills?: unknown } | undefined;
	const contextFiles = attempt(() =>
		asArray(options?.contextFiles)?.map((file) => {
			const f = file as { path: string; content: string };
			return { path: f.path, content: f.content };
		}),
	);
	const skills = attempt(() =>
		asArray(options?.skills)?.map((skill) => {
			const s = skill as { name: string; filePath: string };
			return { name: s.name, filePath: s.filePath };
		}),
	);
	const systemPrompt = attempt(() => {
		const value = fn("getSystemPrompt");
		return typeof value === "string" ? value : undefined;
	});
	const extensionPaths = attempt(() => asArray(fn("loadedExtensionPaths")) as readonly string[] | undefined);
	const mcpServers = attempt(() =>
		asArray(fn("getRegisteredMcpServers"))?.map((server) => {
			const s = server as { name: string; extensionPath?: string };
			return { name: s.name, ...(s.extensionPath !== undefined ? { extensionPath: s.extensionPath } : {}) };
		}),
	);
	const hookSources = attempt(() => fn("getLoadedHookSources") as LiveState["hookSources"]);
	const model = attempt(() => {
		const m = ctx.model as { provider?: string; id?: string } | undefined;
		return m ? { provider: m.provider, id: m.id } : undefined;
	});
	return {
		...(contextFiles ? { contextFiles } : {}),
		...(skills ? { skills } : {}),
		...(extensionPaths ? { extensionPaths } : {}),
		...(systemPrompt !== undefined ? { systemPrompt } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(hookSources ? { hookSources } : {}),
		...(model ? { model } : {}),
	};
}

/** Feature-detects the Senpi members the probes use; returns a notice when the import fails. */
async function loadSenpi(): Promise<{ senpi: SenpiApi; notice?: string }> {
	try {
		const mod = (await import("@code-yeongyu/senpi")) as Record<string, unknown>;
		const found: Record<string, unknown> = {};
		for (const name of SENPI_MEMBERS) if (mod[name] !== undefined) found[name] = mod[name];
		return { senpi: found as SenpiApi };
	} catch (error) {
		return { senpi: {}, notice: `내부 기능을 불러오지 못함: ${message(error)} - 세션 정보와 폴더 기준으로만 표시` };
	}
}

function readExternalEditor(senpi: SenpiApi, cwd: string, agentDir: string, home: string, trusted: boolean): string | undefined {
	return attempt(() => {
		const manager = senpi.SettingsManager?.fromStorage(readOnlySettingsStorage(cwd, agentDir, home), { projectTrusted: trusted });
		const value = manager?.getGlobalSettings().externalEditor;
		return typeof value === "string" ? value : undefined;
	});
}

async function whereHandler(_args: string, ctx: Ctx): Promise<void> {
	try {
		if (!ctx?.hasUI || ctx.mode !== "tui") {
			ctx?.ui?.notify?.("where는 TUI에서만 열립니다", "info");
			return;
		}
		const home = homedir();
		const trusted = attempt(() => ctx.isProjectTrusted?.() === true) === true;
		const { senpi, notice } = await loadSenpi();

		let externalEditor: string | undefined;
		const scan = async (): Promise<Report> => {
			const live = collectLive(ctx);
			externalEditor = readExternalEditor(senpi, ctx.cwd, ctx.agentDir, home, trusted);
			const built = await buildReport({ cwd: ctx.cwd, agentDir: ctx.agentDir, home, env: process.env, trusted, senpi, live });
			return notice ? { ...built, notices: [notice, ...built.notices] } : built;
		};
		const report = await scan();

		await ctx.ui?.custom?.(
			(tui, theme, _keybindings, done) => {
				const rescan = async (hint?: string): Promise<void> => {
					try {
						view.setReport(await scan());
					} catch (error) {
						view.setHint(`다시 읽기 실패: ${message(error)}`);
						tui.requestRender();
						return;
					}
					if (hint !== undefined) view.setHint(hint);
					tui.requestRender();
				};
				const view: WhereView = new WhereView({
					report,
					theme,
					height: () => Math.max(12, (process.stdout.rows ?? 40) - 1),
					onClose: () => done(undefined),
					onEdit: (path) => {
						if (ctx.isIdle?.() === false) {
							view.setHint("에이전트가 일하는 중에는 편집 안 함");
							return;
						}
						const result = openInEditor({
							tui,
							command: resolveEditorCommand({ ...(externalEditor !== undefined ? { setting: externalEditor } : {}), env: process.env, platform: process.platform }),
							path,
							platform: process.platform,
						});
						void rescan(result.ok ? "바뀐 내용은 /reload 후 적용" : result.message);
					},
					onRescan: () => void rescan(),
					requestRender: () => tui.requestRender(),
				});
				return view;
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", minWidth: 60, margin: 0 } },
		);
	} catch (error) {
		attempt(() => ctx?.ui?.notify?.(`where 오류: ${message(error)}`, "error"));
	}
}

export default function omoWhere(pi: Pi): void {
	pi.registerCommand?.("where", { description: "세션에 들어간 지침·스킬·확장이 어디서 왔는지 보기", handler: whereHandler });
}
