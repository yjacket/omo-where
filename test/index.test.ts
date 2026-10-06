import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { WhereView } from "../extension/omo-where/ui/view.ts";
import { makeTree, type Tree } from "./helpers/tree.ts";

let failImport = false;
let externalEditor: string | undefined;
const savedVisual = process.env.VISUAL;
const senpiMembers: Record<string, unknown> = {
	SettingsManager: { fromStorage: () => ({ getGlobalSettings: () => ({ externalEditor }), getProjectSettings: () => ({}) }) },
};
mock.module("@code-yeongyu/senpi", () => {
	if (failImport) throw new Error("senpi missing");
	return senpiMembers;
});

/** When true the mocked report builder rejects, standing in for a scan that fails mid-session. */
let reportThrows = false;
// ?real=1 keeps the real builder reachable; the mock delegates to it unless the flag is set, so other
// test files in this process that import report.ts still see real behavior.
const realReport = await import("../extension/omo-where/report.ts?real=1");
mock.module("../extension/omo-where/report.ts", () => ({
	...realReport,
	buildReport: async (...args: Parameters<typeof realReport.buildReport>) => {
		if (reportThrows) throw new Error("scan boom");
		return realReport.buildReport(...args);
	},
}));

let counter = 0;
async function loadIndex(): Promise<(pi: unknown) => void> {
	counter += 1;
	return ((await import(`../extension/omo-where/index.ts?case=${counter}`)) as { default: (pi: unknown) => void }).default;
}

type Handler = (args: string, ctx: Record<string, unknown>) => Promise<void>;
async function register(): Promise<{ names: string[]; options: { description: string; handler: Handler } }> {
	const names: string[] = [];
	let options: { description: string; handler: Handler } | undefined;
	const entry = await loadIndex();
	entry({
		registerCommand: (name: string, o: { description: string; handler: Handler }) => {
			names.push(name);
			options = o;
		},
	});
	if (!options) throw new Error("not registered");
	return { names, options };
}

type Harness = {
	ctx: Record<string, unknown>;
	notes: { message: string; level?: string }[];
	customCalls: unknown[][];
	tui: { stops: number; starts: number; renders: number; stop(): void; start(): void; requestRender(): void };
	view(): WhereView;
	done(): void;
};

function harness(tree: Tree, extra: Record<string, unknown> = {}): Harness {
	const notes: { message: string; level?: string }[] = [];
	const customCalls: unknown[][] = [];
	const tui = {
		stops: 0,
		starts: 0,
		renders: 0,
		stop() {
			this.stops += 1;
		},
		start() {
			this.starts += 1;
		},
		requestRender() {
			this.renders += 1;
		},
	};
	let view: WhereView | undefined;
	let finish: (() => void) | undefined;
	const ctx: Record<string, unknown> = {
		hasUI: true,
		mode: "tui",
		cwd: tree.path("proj"),
		agentDir: tree.path("agent"),
		ui: {
			notify: (message: string, level?: string) => notes.push({ message, level }),
			custom: (factory: (...a: unknown[]) => WhereView, ...rest: unknown[]) => {
				customCalls.push([factory, ...rest]);
				return new Promise<void>((resolve) => {
					finish = resolve;
					view = factory(tui, { fg: (_c: string, t: string) => t }, undefined, () => resolve());
				});
			},
		},
		...extra,
	};
	return {
		ctx,
		notes,
		customCalls,
		tui,
		view: () => {
			if (!view) throw new Error("overlay not opened");
			return view;
		},
		done: () => finish?.(),
	};
}

let tree: Tree;
beforeEach(() => {
	failImport = false;
	reportThrows = false;
	externalEditor = undefined;
	if (savedVisual === undefined) delete process.env.VISUAL;
	else process.env.VISUAL = savedVisual;
	tree = makeTree({ "proj/AGENTS.md": "rules", "agent": null });
});
afterEach(() => {
	// The report mock is process-wide; clearing the flag leaves it delegating to the real builder for other files.
	reportThrows = false;
	tree.cleanup();
});

/** Resolves with the next hint handed to the view; install it before the key that must set the hint. */
function nextHint(h: Harness): Promise<string> {
	return new Promise<string>((resolve) => {
		const view = h.view();
		const original = view.setHint.bind(view);
		view.setHint = (text: string) => {
			original(text);
			resolve(text);
		};
	});
}

/** Waits until the overlay factory ran (the handler is still pending on it). */
async function opened(h: Harness, run: Promise<void>): Promise<void> {
	for (let i = 0; i < 200 && h.customCalls.length === 0; i++) await Promise.race([run, Promise.resolve()]);
	expect(h.customCalls.length).toBe(1);
}

function renderText(h: Harness): string {
	return h.view().render(120).join("\n");
}

describe("/where entry", () => {
	// First on purpose: the module registry keeps a successful senpi import, so the failing import must happen first.
	test("senpi import failure shows a notice and still opens", async () => {
		failImport = true;
		const { options } = await register();
		const h = harness(tree);
		const run = options.handler("", h.ctx);
		await opened(h, run);
		expect(h.notes.filter((n) => n.level === "error")).toEqual([]);
		expect(renderText(h)).toContain("내부 기능을 불러오지 못함");
		h.done();
		await run;
	});

	test("registers only /where", async () => {
		const { names, options } = await register();
		expect(names).toEqual(["where"]);
		expect(options.description).toBe("세션에 들어간 지침·스킬·확장이 어디서 왔는지 보기");
	});

	test("non-TUI sessions get a notice and no overlay", async () => {
		const { options } = await register();
		const h = harness(tree, { mode: "print" });
		await options.handler("", h.ctx);
		expect(h.notes).toEqual([{ message: "where는 TUI에서만 열립니다", level: "info" }]);
		expect(h.customCalls.length).toBe(0);
	});

	test("overlay opened once with WhereView and overlay options", async () => {
		const { options } = await register();
		const h = harness(tree);
		const run = options.handler("", h.ctx);
		await opened(h, run);
		expect(h.view()).toBeInstanceOf(WhereView);
		expect(h.customCalls[0]?.[1]).toEqual({ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", minWidth: 60, margin: 0 } });
		h.done();
		await run;
		expect(h.customCalls.length).toBe(1);
	});

	test("handler promise resolves after done()", async () => {
		const { options } = await register();
		const h = harness(tree);
		let settled = false;
		const run = options.handler("", h.ctx).then(() => {
			settled = true;
		});
		await opened(h, run);
		await Promise.resolve();
		expect(settled).toBe(false);
		h.view().handleInput("q");
		await run;
		expect(settled).toBe(true);
	});

	test("throwing ctx getter still opens, other rows survive", async () => {
		const { options } = await register();
		const h = harness(tree, {
			getSystemPrompt: () => {
				throw new Error("boom");
			},
			getSystemPromptOptions: () => ({ contextFiles: [{ path: tree.path("proj/AGENTS.md"), content: "rules" }], skills: [] }),
			getRegisteredMcpServers: () => {
				throw new Error("boom");
			},
			isProjectTrusted: () => {
				throw new Error("boom");
			},
		});
		const run = options.handler("", h.ctx);
		await opened(h, run);
		expect(h.notes.filter((n) => n.level === "error")).toEqual([]);
		h.done();
		await run;
	});

	test("handler never throws: a failing overlay becomes an error notice", async () => {
		const { options } = await register();
		const h = harness(tree);
		(h.ctx.ui as Record<string, unknown>).custom = () => Promise.reject(new Error("tui gone"));
		await options.handler("", h.ctx);
		expect(h.notes).toEqual([{ message: "where 오류: tui gone", level: "error" }]);
	});

	/** Navigates to the context category rows and presses e on each row until the editor is invoked or the rows run out. */
	function pressEdit(h: Harness): void {
		const view = h.view();
		view.handleInput("j");
		view.handleInput("\t");
		for (let i = 0; i < 40 && h.tui.stops === 0; i++) {
			view.handleInput("e");
			if (h.tui.stops === 0) view.handleInput("j");
		}
	}

	const editCtx = (): Record<string, unknown> => ({
		getSystemPromptOptions: () => ({ contextFiles: [{ path: tree.path("proj/AGENTS.md"), content: "rules" }], skills: [] }),
	});

	test("edit is refused while the agent is busy", async () => {
		const { options } = await register();
		const h = harness(tree, { ...editCtx(), isIdle: () => false });
		const run = options.handler("", h.ctx);
		await opened(h, run);
		const view = h.view();
		view.handleInput("j");
		view.handleInput("\t");
		for (let i = 0; i < 40; i++) {
			view.handleInput("e");
			if (renderText(h).includes("에이전트가 일하는 중에는 편집 안 함")) break;
			view.handleInput("j");
		}
		expect(renderText(h)).toContain("에이전트가 일하는 중에는 편집 안 함");
		expect(h.tui.stops).toBe(0);
		expect(h.tui.starts).toBe(0);
		h.done();
		await run;
	});

	test("edit stops and restarts the tui, then rescans with a hint", async () => {
		process.env.VISUAL = "bun --version";
		const { options } = await register();
		const h = harness(tree, { ...editCtx(), isIdle: () => true });
		const run = options.handler("", h.ctx);
		await opened(h, run);
		const hinted = nextHint(h);
		pressEdit(h);
		expect(h.tui.stops).toBe(1);
		expect(h.tui.starts).toBe(1);
		const hint = await hinted;
		expect(hint).toBe("바뀐 내용은 /reload 후 적용");
		expect(h.tui.renders).toBeGreaterThanOrEqual(2);
		h.done();
		await run;
	});

	test("a throwing isIdle sets the editor hint and handleInput never throws", async () => {
		const { options } = await register();
		const h = harness(tree, {
			...editCtx(),
			isIdle: () => {
				throw new Error("idle boom");
			},
		});
		const run = options.handler("", h.ctx);
		await opened(h, run);
		const hinted = nextHint(h);
		expect(() => pressEdit(h)).not.toThrow();
		expect(await hinted).toBe("편집기를 열 수 없음: idle boom");
		expect(h.tui.stops).toBe(0);
		expect(h.tui.starts).toBe(0);
		h.done();
		await run;
	});

	test("a rescan whose scan throws sets the rescan hint without an unhandled rejection", async () => {
		const { options } = await register();
		const h = harness(tree, editCtx());
		const run = options.handler("", h.ctx);
		await opened(h, run);
		const hinted = nextHint(h);
		reportThrows = true;
		h.view().handleInput("r");
		expect(await hinted).toBe("다시 읽지 못함: scan boom");
		expect(h.notes).toEqual([]);
		h.done();
		await run;
	});
});
