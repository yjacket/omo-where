// Pure pane renderer for the /where overlay: header, category list, probe rows,
// a detail line and the footer. It only reads the shared contract (../model.ts)
// and the view state (./state.ts); the viewer body is injected by view.ts as the
// sixth parameter so this module never reaches into the viewer.
import {
	filterProblems,
	isSyntheticPath,
	LIVE_LABEL,
	problemCount,
	STATUS_LABEL,
	summaryLine,
	type Category,
	type Probe,
	type Report,
	type Status,
} from "../model.ts";
import type { ViewerState, ViewState } from "./state.ts";

export type PaneTheme = { fg(color: string, text: string): string; bold?(t: string): string };
/** Injected by view.ts (tests pass a stub). Must return exactly `height` lines. */
export type ViewerLines = (viewer: ViewerState, width: number, height: number) => string[];

const STATUS_COLOR: Readonly<Record<Status, string>> = { loaded: "success", missing: "muted", shadowed: "warning", disabled: "warning", error: "error" };
const LIST_FOOTER = "↑↓ 이동 · ←→ 칸 · Enter 열기 · w 이긴 쪽 · e 편집 · f 문제만 · r 다시 읽기 · q 닫기";
const VIEWER_FOOTER = "↑↓ PgUp/PgDn 스크롤 · e 편집 · Esc 뒤로";
const SKILL_SUFFIX = "/SKILL.md";
const SEPARATOR = "│";
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/;

/** Bun.stringWidth when present so CJK/emoji count as the cells the TUI draws. */
function cellWidth(text: string): number {
	const bun = (globalThis as { Bun?: { stringWidth?(s: string): number } }).Bun;
	if (typeof bun?.stringWidth === "function") return bun.stringWidth(text);
	let w = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		w += code > 0x1100 && WIDE_CHAR.test(ch) ? 2 : 1;
	}
	return w;
}

/** Fits `text` to exactly `width` cells, truncating with an ellipsis when long. */
function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const w = cellWidth(text);
	if (w <= width) return text + " ".repeat(width - w);
	let out = "";
	let used = 0;
	for (const ch of text) {
		const cw = cellWidth(ch);
		if (used + cw > width - 1) break;
		out += ch;
		used += cw;
	}
	return `${out}…${" ".repeat(Math.max(0, width - used - 1))}`;
}

function paint(theme: PaneTheme, color: string, text: string): string {
	try {
		return typeof theme.fg === "function" ? theme.fg(color, text) : text;
	} catch {
		return text;
	}
}

function emphasize(theme: PaneTheme, text: string): string {
	try {
		return typeof theme.bold === "function" ? theme.bold(text) : text;
	} catch {
		return text;
	}
}

/** `<home>/.omo/agent` -> `<home>`; anything else -> undefined. */
function deriveHome(agentDir: string): string | undefined {
	const norm = agentDir.replace(/\\/g, "/").replace(/\/+$/, "");
	const home = /^(.*)\/\.omo\/agent$/.exec(norm)?.[1];
	return home ? home : undefined;
}

/** `~`/`.`-shortened path; skill rows drop the trailing /SKILL.md. */
function shortPath(path: string, report: Report): string {
	const clean = path.replace(/\\/g, "/");
	const slash = /\/SKILL\.md$/i.test(clean) ? clean.slice(0, -SKILL_SUFFIX.length) : clean;
	if (isSyntheticPath(slash)) return slash;
	const roots: [string, string][] = [];
	const home = deriveHome(report.agentDir);
	if (home) roots.push([home.replace(/\\/g, "/").replace(/\/+$/, ""), "~"]);
	roots.push([report.cwd.replace(/\\/g, "/").replace(/\/+$/, ""), "."]);
	for (const [root, mark] of roots) {
		if (!root) continue;
		if (slash === root) return mark;
		if (slash.startsWith(`${root}/`)) return mark + slash.slice(root.length);
	}
	return slash;
}

function liveSuffix(probe: Probe): string {
	return probe.live && probe.live !== "match" ? ` · ${LIVE_LABEL[probe.live]}` : "";
}

function probeLine(probe: Probe, report: Report): string {
	return `${probe.rank}. ${STATUS_LABEL[probe.status]} ${shortPath(probe.path, report)} · ${probe.reason}${liveSuffix(probe)}`;
}

function detailText(probe: Probe | undefined, report: Report): string {
	if (!probe) return "";
	const parts: string[] = [];
	if (probe.problem) parts.push(`문제: ${probe.problem}`);
	if (probe.winner) parts.push(`이긴 쪽: ${shortPath(probe.winner, report)}`);
	if (!parts.length && probe.live && probe.live !== "match") return LIVE_LABEL[probe.live];
	return parts.join(" · ");
}

/** Keeps the focused index visible inside a window of `rows` entries. */
function windowStart(count: number, focus: number, rows: number): number {
	if (rows <= 0 || count <= rows) return 0;
	const top = Math.min(Math.max(focus, 0), count - 1);
	return Math.max(0, Math.min(top <= 0 ? 0 : top - rows + 1, count - rows));
}

type RightRow = { text: string; color?: string; bold?: boolean };

function rightRows(category: Category | undefined, state: ViewState, report: Report): { rows: RightRow[]; probes: readonly Probe[] } {
	const probes = state.problemsOnly && category ? filterProblems(category).probes : category?.probes ?? [];
	const rows: RightRow[] = [];
	if (category?.note) rows.push({ text: category.note, color: "muted" });
	if (category?.error) rows.push({ text: category.error, color: "warning" });
	probes.forEach((probe, index) => {
		const selected = state.pane === "rows" && index === state.row;
		rows.push({ text: probeLine(probe, report), color: selected ? "accent" : STATUS_COLOR[probe.status], bold: selected });
	});
	return { rows, probes };
}

function renderRow(row: RightRow, theme: PaneTheme, width: number): string {
	const fitted = fit(row.text, width);
	const styled = row.bold ? emphasize(theme, fitted) : fitted;
	return row.color ? paint(theme, row.color, styled) : styled;
}

function headerLines(report: Report, theme: PaneTheme, width: number): string[] {
	const lines = [paint(theme, "accent", emphasize(theme, fit(`where · ${summaryLine(report)}`, width)))];
	for (const notice of report.notices.slice(0, 2)) lines.push(paint(theme, "warning", fit(notice, width)));
	return lines;
}

function listLines(report: Report, state: ViewState, width: number, height: number, theme: PaneTheme): string[] {
	const lines = headerLines(report, theme, width);
	const bodyRows = Math.max(0, height - lines.length - 2); // detail line + footer
	const leftWidth = Math.min(24, Math.floor(width * 0.28));
	const rightWidth = Math.max(0, width - leftWidth - 1);
	const categories = report.categories;
	const category = categories[state.cat];

	const leftStart = windowStart(categories.length, state.cat, bodyRows);
	const right = rightRows(category, state, report);
	const focusRow = state.pane === "rows" ? (category?.note ? 1 : 0) + (category?.error ? 1 : 0) + state.row : 0;
	const rightStart = windowStart(right.rows.length, focusRow, bodyRows);

	for (let i = 0; i < bodyRows; i++) {
		const catIndex = leftStart + i;
		let left = "";
		if (catIndex < categories.length) {
			const item = categories[catIndex];
			const count = problemCount(item);
			const plain = `${item.label} ${count}`;
			if (cellWidth(plain) <= leftWidth) {
				const label = catIndex === state.cat ? paint(theme, "accent", item.label) : item.label;
				const tally = count > 0 ? paint(theme, "warning", String(count)) : String(count);
				left = `${label} ${tally}${" ".repeat(leftWidth - cellWidth(plain))}`;
			} else left = fit(plain, leftWidth);
		} else left = " ".repeat(leftWidth);

		const rowIndex = rightStart + i;
		const rightText = rowIndex < right.rows.length ? renderRow(right.rows[rowIndex], theme, rightWidth) : " ".repeat(rightWidth);
		lines.push(`${left}${SEPARATOR}${rightText}`);
	}

	const selected = right.probes[state.row];
	const detail = state.hint ?? detailText(selected, report);
	const detailColor = state.hint ? "accent" : selected?.problem ? "warning" : "muted";
	lines.push(paint(theme, detailColor, fit(detail, width)));
	lines.push(paint(theme, "muted", fit(LIST_FOOTER, width)));
	return lines;
}

function fallbackViewer(viewer: ViewerState, width: number, height: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < height; i++) {
		const source = viewer.lines[viewer.offset + i] ?? viewer.title ?? "";
		out.push(fit(source, width));
	}
	return out;
}

function viewerLines(report: Report, state: ViewState, width: number, height: number, theme: PaneTheme, render: ViewerLines | undefined): string[] {
	const lines = [paint(theme, "accent", emphasize(theme, fit(`where · ${summaryLine(report)}`, width)))];
	const bodyHeight = Math.max(0, height - 2);
	const viewer = state.viewer as ViewerState;
	let body: string[];
	try {
		body = render ? render(viewer, width, bodyHeight) : fallbackViewer(viewer, width, bodyHeight);
	} catch {
		body = fallbackViewer(viewer, width, bodyHeight);
	}
	for (let i = 0; i < bodyHeight; i++) lines.push(fit(body[i] ?? (i === 0 ? viewer.title : ""), width));
	lines.push(paint(theme, "muted", fit(VIEWER_FOOTER, width)));
	return lines;
}

/**
 * Renders the /where overlay as exactly `height` lines, each at most `width`
 * display cells. Pure: it never touches the filesystem or the terminal.
 */
export function renderPanes(
	report: Report,
	state: ViewState,
	width: number,
	height: number,
	theme: PaneTheme,
	renderViewerLines?: ViewerLines,
): string[] {
	const columns = Math.max(0, Math.floor(width));
	const rows = Math.max(0, Math.floor(height));
	const built = state.pane === "viewer" && state.viewer
		? viewerLines(report, state, columns, rows, theme, renderViewerLines)
		: listLines(report, state, columns, rows, theme);
	const out = built.slice(0, rows).map((line) => fit(line, columns));
	while (out.length < rows) out.push(" ".repeat(columns));
	return out;
}
