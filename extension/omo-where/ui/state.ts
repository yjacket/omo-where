/** Overlay view state shared by panes.ts (render) and keys.ts (reducer). */
export type ViewerState = { readonly title: string; readonly lines: readonly string[]; readonly offset: number; readonly notice?: string };
export type ViewState = {
	readonly cat: number; // index into report.categories
	readonly row: number; // index into the (possibly filtered) probes of the current category
	readonly pane: "cats" | "rows" | "viewer";
	readonly problemsOnly: boolean;
	readonly hint?: string;
	readonly viewer?: ViewerState;
	readonly openedPath?: string; // probe path shown in the viewer (for e in viewer mode)
};
