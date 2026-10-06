// Pure key reducer for the /where overlay. No I/O, no timers.
import { filterProblems, normPath, type Probe, type Report, samePath } from "../model.ts";
import type { ViewState } from "./state.ts";

export type KeyName =
	| "up"
	| "down"
	| "left"
	| "right"
	| "tab"
	| "enter"
	| "esc"
	| "pgup"
	| "pgdn"
	| "home"
	| "end"
	| "q"
	| "e"
	| "r"
	| "f"
	| "w"
	| "j"
	| "k"
	| "other";

export type KeyEffect =
	| { kind: "close" }
	| { kind: "open"; probe: Probe }
	| { kind: "edit"; path: string }
	| { kind: "rescan" };

export type ReduceResult = { state: ViewState; effect?: KeyEffect };

const SEQUENCES: Readonly<Record<string, KeyName>> = {
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[C": "right",
	"\x1b[D": "left",
	"\x1bOA": "up",
	"\x1bOB": "down",
	"\x1bOC": "right",
	"\x1bOD": "left",
	"\t": "tab",
	"\r": "enter",
	"\n": "enter",
	"\x1b": "esc",
	"\x1b[5~": "pgup",
	"\x1b[6~": "pgdn",
	"\x1b[H": "home",
	"\x1b[1~": "home",
	"\x1bOH": "home",
	"\x1b[7~": "home",
	"\x1b[F": "end",
	"\x1b[4~": "end",
	"\x1bOF": "end",
	"\x1b[8~": "end",
};

const LETTER_KEYS = new Set<KeyName>(["q", "e", "r", "f", "w", "j", "k"]);

/** Maps a raw terminal sequence or letter to a KeyName; anything else is "other". */
export function decodeKey(data: string): KeyName {
	const sequence = SEQUENCES[data];
	if (sequence !== undefined) return sequence;
	if (data.length === 1) {
		const lower = data.toLowerCase() as KeyName;
		if (LETTER_KEYS.has(lower)) return lower;
	}
	return "other";
}

const HINT_NO_WINNER = "이긴 파일이 목록에 없음";
const HINT_OVERWRITTEN = "업데이트 때 덮어써지는 파일이라 편집 안 함";
const HINT_FILE_ONLY = "파일만 열 수 있음";

const RUNTIME_MARKER = "/.omo/agent/runtime/";
const OMO_AI_MARKER = "/node_modules/omo-ai/";

function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	return Math.min(Math.max(value, min), max);
}

function visibleProbes(report: Report, cat: number, problemsOnly: boolean): readonly Probe[] {
	const category = report.categories[cat];
	if (!category) return [];
	return problemsOnly ? filterProblems(category).probes : category.probes;
}

function clampState(state: ViewState, report: Report): ViewState {
	const cat = clamp(state.cat, 0, Math.max(0, report.categories.length - 1));
	const probes = visibleProbes(report, cat, state.problemsOnly);
	const row = clamp(state.row, 0, Math.max(0, probes.length - 1));
	if (cat === state.cat && row === state.row) return state;
	return { ...state, cat, row };
}

function findProbe(report: Report, path: string | undefined): Probe | undefined {
	if (path === undefined) return undefined;
	for (const category of report.categories) {
		for (const probe of category.probes) {
			if (probe.path === path || samePath(probe.path, path)) return probe;
		}
	}
	return undefined;
}

function editResult(state: ViewState, probe: Probe | undefined): ReduceResult {
	if (!probe) return { state };
	if (probe.kind !== "file" || probe.status === "missing") return { state: { ...state, hint: HINT_FILE_ONLY } };
	const normalized = normPath(probe.path);
	if (normalized.includes(RUNTIME_MARKER) || normalized.includes(OMO_AI_MARKER)) {
		return { state: { ...state, hint: HINT_OVERWRITTEN } };
	}
	return { state: { ...state, hint: undefined }, effect: { kind: "edit", path: probe.path } };
}

function jumpToWinner(state: ViewState, report: Report, probes: readonly Probe[], probe: Probe | undefined): ReduceResult {
	if (!probe || probe.status !== "shadowed" || probe.winner === undefined) return { state };
	const index = probes.findIndex((p) => samePath(p.path, probe.winner as string));
	if (index < 0) return { state: { ...state, hint: HINT_NO_WINNER } };
	return { state: clampState({ ...state, row: index, hint: undefined }, report) };
}

function reduceViewer(state: ViewState, key: KeyName, report: Report, height: number): ReduceResult {
	const viewer = state.viewer;
	if (!viewer) return { state };
	const maxOffset = Math.max(0, viewer.lines.length - 1);
	const page = Math.max(1, height - 3);
	const scroll = (offset: number): ReduceResult => ({
		state: { ...state, hint: undefined, viewer: { ...viewer, offset: clamp(offset, 0, maxOffset) } },
	});
	switch (key) {
		case "up":
		case "k":
			return scroll(viewer.offset - 1);
		case "down":
		case "j":
			return scroll(viewer.offset + 1);
		case "pgup":
			return scroll(viewer.offset - page);
		case "pgdn":
			return scroll(viewer.offset + page);
		case "home":
			return scroll(0);
		case "end":
			return scroll(maxOffset);
		case "esc":
			return { state: clampState({ ...state, pane: "rows" }, report) };
		case "e":
			return editResult(state, findProbe(report, state.openedPath));
		default:
			return { state };
	}
}

/** Pure reducer; returns the (possibly clamped) state and at most one effect. */
export function reduce(state: ViewState, key: KeyName, report: Report, height: number): ReduceResult {
	if (key === "q") return { state, effect: { kind: "close" } };
	if (key === "r") return { state, effect: { kind: "rescan" } };
	if (state.pane === "viewer") return reduceViewer(state, key, report, height);
	const base: ViewState = { ...state, hint: undefined };
	switch (state.pane) {
		case "cats": {
			switch (key) {
				case "up":
				case "k":
					return { state: clampState({ ...base, cat: state.cat - 1 }, report) };
				case "down":
				case "j":
					return { state: clampState({ ...base, cat: state.cat + 1 }, report) };
				case "left":
				case "right":
				case "tab":
				case "enter":
					return { state: clampState({ ...base, pane: "rows" }, report) };
				case "esc":
					return { state, effect: { kind: "close" } };
				case "f":
					return { state: clampState({ ...base, problemsOnly: !state.problemsOnly }, report) };
				default:
					return { state };
			}
		}
		case "rows": {
			const probes = visibleProbes(report, state.cat, state.problemsOnly);
			const probe = probes[clamp(state.row, 0, Math.max(0, probes.length - 1))];
			switch (key) {
				case "up":
				case "k":
					return { state: clampState({ ...base, row: state.row - 1 }, report) };
				case "down":
				case "j":
					return { state: clampState({ ...base, row: state.row + 1 }, report) };
				case "left":
				case "right":
				case "tab":
					return { state: clampState({ ...base, pane: "cats" }, report) };
				case "enter":
					return probe ? { state: base, effect: { kind: "open", probe } } : { state };
				case "esc":
					return { state, effect: { kind: "close" } };
				case "f":
					return { state: clampState({ ...base, problemsOnly: !state.problemsOnly }, report) };
				case "w":
					return jumpToWinner(state, report, probes, probe);
				case "e":
					return editResult(state, probe);
				default:
					return { state };
			}
		}
		default:
			return { state };
	}
}
