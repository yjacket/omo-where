// View component glue for the /where overlay (plan todo 16, GAP-5).
// Owns the overlay state and wires the pure reducer (keys.ts), renderer
// (panes.ts) and viewer (viewer.ts) to the pi-tui Component surface. It never
// touches the filesystem itself, except through viewer.ts, and never writes.
import { filterProblems, type Probe, type Report, samePath } from "../model.ts";
import { decodeKey, reduce } from "./keys.ts";
import { type PaneTheme, renderPanes } from "./panes.ts";
import type { ViewerState, ViewState } from "./state.ts";
import { loadViewerText, renderViewer, viewerFromText } from "./viewer.ts";

export type WhereViewOptions = {
	readonly report: Report;
	readonly theme: PaneTheme;
	readonly height: () => number;
	readonly onClose: () => void;
	readonly onEdit: (path: string) => void;
	readonly onRescan: () => void;
	/** Asks the TUI to redraw; pi-tui does not redraw an overlay after input on its own. */
	readonly requestRender?: () => void;
};

/** Initial focus is the category column: ↓ picks a category, ⇥ moves to its rows. */
function initialState(): ViewState {
	return { cat: 0, row: 0, pane: "cats", problemsOnly: false };
}

function clamp(value: number, min: number, max: number): number {
	return max < min ? min : Math.min(Math.max(value, min), max);
}

/** The probes a pane actually shows: the problems-only filter mirrors keys.ts. */
function visibleProbes(report: Report, cat: number, problemsOnly: boolean): readonly Probe[] {
	const category = report.categories[cat];
	if (!category) return [];
	return problemsOnly ? filterProblems(category).probes : category.probes;
}

function indexOfPath(probes: readonly Probe[], path: string | undefined): number {
	if (path === undefined) return -1;
	return probes.findIndex((probe) => probe.path === path || samePath(probe.path, path));
}

/** Virtual probes read their in-memory text; file/dir probes read the disk. */
function openViewer(probe: Probe): { openedPath: string; viewer: ViewerState } {
	const loaded = probe.kind === "virtual" ? viewerFromText(probe.path, probe.text ?? "") : loadViewerText(probe.path);
	return { openedPath: probe.path, viewer: { ...loaded, offset: 0 } };
}

export class WhereView {
	private report: Report;
	private readonly theme: PaneTheme;
	private readonly height: () => number;
	private readonly onClose: () => void;
	private readonly onEdit: (path: string) => void;
	private readonly onRescan: () => void;
	private readonly requestRender: (() => void) | undefined;
	private state: ViewState = initialState();
	/** True after an edit or rescan request; further e/r keys are ignored until setReport(). */
	private busy = false;

	constructor(options: WhereViewOptions) {
		this.report = options.report;
		this.theme = options.theme;
		this.height = options.height;
		this.onClose = options.onClose;
		this.onEdit = options.onEdit;
		this.onRescan = options.onRescan;
		this.requestRender = options.requestRender;
	}

	render(width: number): string[] {
		return renderPanes(this.report, this.state, width, this.height(), this.theme, (viewer, w, h) => renderViewer(viewer, w, h, this.theme));
	}

	handleInput(data: string): void {
		this.applyInput(data);
		this.requestRender?.();
	}

	private applyInput(data: string): void {
		const key = decodeKey(data);
		if (this.busy && (key === "e" || key === "r")) return;
		const result = reduce(this.state, key, this.report, this.height());
		this.state = result.state;
		const effect = result.effect;
		if (!effect) return;
		switch (effect.kind) {
			case "close":
				this.onClose();
				return;
			case "open":
				this.state = { ...this.state, pane: "viewer", ...openViewer(effect.probe) };
				return;
			case "edit":
				this.busy = true;
				this.onEdit(effect.path);
				return;
			case "rescan":
				this.busy = true;
				this.onRescan();
				return;
		}
	}

	/** A fresh scan: clears the busy flag and keeps the selection by category id and row path. */
	setReport(report: Report): void {
		const previousId = this.report.categories[this.state.cat]?.id;
		const previousPath = visibleProbes(this.report, this.state.cat, this.state.problemsOnly)[this.state.row]?.path;
		this.report = report;
		this.busy = false;
		const byId = previousId === undefined ? -1 : report.categories.findIndex((category) => category.id === previousId);
		const cat = byId >= 0 ? byId : clamp(this.state.cat, 0, Math.max(0, report.categories.length - 1));
		const probes = visibleProbes(report, cat, this.state.problemsOnly);
		const found = indexOfPath(probes, previousPath);
		const row = found >= 0 ? found : clamp(this.state.row, 0, Math.max(0, probes.length - 1));
		this.state = { ...this.state, cat, row };
	}

	/** Shows a transient message in the detail line (e.g. an editor failure); the next key clears it. */
	setHint(text: string): void {
		this.state = { ...this.state, hint: text };
	}

	invalidate(): void {
		// Rendering is stateless; only the viewer offset can go stale after a resize.
		const viewer = this.state.viewer;
		if (this.state.pane === "viewer" && viewer && viewer.offset > Math.max(0, viewer.lines.length - 1)) {
			this.state = { ...this.state, viewer: { ...viewer, offset: Math.max(0, viewer.lines.length - 1) } };
		}
	}
}
