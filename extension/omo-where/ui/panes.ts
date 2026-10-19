// Pure pane renderer for the /where overlay: header, category list, probe rows,
// a detail line and the footer. It only reads the shared contract (../model.ts)
// and the view state (./state.ts); the viewer body is injected by view.ts as the
// sixth parameter so this module never reaches into the viewer.
import {
	filterProblems,
	isSyntheticPath,
	LINK_LABEL,
	LIVE_LABEL,
	problemCount,
	STATUS_LABEL,
	summaryLine,
	type Category,
	type CategoryId,
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
// Narrower terminals drop the self-evident arrow hints first, so "q 닫기" stays visible.
const LIST_FOOTERS = [LIST_FOOTER, "Enter 열기 · w 이긴 쪽 · e 편집 · f 문제만 · r 다시 읽기 · q 닫기", "Enter 열기 · e 편집 · q 닫기"];

function listFooter(width: number): string {
	return LIST_FOOTERS.find((footer) => Bun.stringWidth(footer) <= width) ?? LIST_FOOTERS[LIST_FOOTERS.length - 1]!;
}
const VIEWER_FOOTER = "↑↓ PgUp/PgDn 스크롤 · e 편집 · Esc 뒤로";
const SKILL_SUFFIX = "/SKILL.md";
const SEPARATOR = "│";
const RULE = "─";

/** What each category is, in the user's terms; shown as the first right-pane line. */
const CATEGORY_ABOUT: Readonly<Record<CategoryId, string>> = {
	prompt: "모델이 이번 세션에 받은 프롬프트 전체와 그 조각 · 지침 파일과 스킬 목록도 여기 합쳐짐",
	context: "AGENTS.md·CLAUDE.md · 폴더마다 하나씩 시스템 프롬프트에 그대로 붙음",
	skills: "모델이 필요할 때 읽는 SKILL.md · 이름과 설명만 시스템 프롬프트에 들어감",
	extensions: "명령·도구·화면을 더하는 코드 · 세션 시작 때 불러옴",
	rules: "작업 중에 조건이 맞으면 더 붙는 지침 파일",
	templates: "/이름으로 불러 쓰는 프롬프트 파일",
	themes: "TUI 색 테마 파일",
	mcp: "모델이 도구로 쓰는 MCP 서버 설정",
	hooks: "정해진 때 자동으로 도는 명령(hooks.json)",
	memory: "세션이 끝나도 남는 메모리 파일",
	settings: "하네스 설정 파일과 지금 세션의 설정값",
};
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

function statusLabel(probe: Probe): string {
	return probe.status === "shadowed" && probe.linked ? LINK_LABEL : STATUS_LABEL[probe.status];
}

/** Rows in use carry no status word; every other row says its state. */
function flagged(probe: Probe): boolean {
	return probe.status !== "loaded" || probe.linked === true;
}

/** A reason ending in the status word ("폴더 없음") stands in for that word, so it is never said twice. */
function saysStatus(probe: Probe): boolean {
	return flagged(probe) && probe.reason.endsWith(statusLabel(probe));
}

type Seg = { readonly text: string; readonly color?: string };

/** Status word, reason and live mark that follow a row's name. */
function tailSegs(probe: Probe, showReason: boolean): Seg[] {
	const segs: Seg[] = [];
	const word = flagged(probe);
	const color = probe.linked ? "muted" : STATUS_COLOR[probe.status];
	if (showReason && saysStatus(probe)) segs.push({ text: `  ${probe.reason}`, color });
	else {
		if (word) segs.push({ text: `  ${statusLabel(probe)}`, color });
		if (showReason && probe.reason !== "") segs.push({ text: `${word ? " · " : "  "}${probe.reason}`, color: "muted" });
	}
	if (probe.live && probe.live !== "match") segs.push({ text: ` · ${LIVE_LABEL[probe.live]}`, color: "warning" });
	return segs;
}

/** The selected row spelled out: full path, status, reason, then problem, winner and live mark. */
function detailText(probe: Probe | undefined, report: Report): string {
	if (!probe) return "";
	const parts = [shortPath(probe.path, report)];
	if (flagged(probe) && !saysStatus(probe)) parts.push(statusLabel(probe));
	if (probe.reason !== "") parts.push(probe.reason);
	if (probe.problem) parts.push(`문제: ${probe.problem}`);
	if (probe.winner) parts.push(`이긴 쪽: ${shortPath(probe.winner, report)}`);
	if (probe.live && probe.live !== "match") parts.push(LIVE_LABEL[probe.live]);
	return parts.join(" · ");
}

type Entry = { readonly probe: Probe; readonly index: number; readonly display: string };
/** A folder line (unnumbered; `entry` is absent for a folder only implied by its rows) or a numbered row; `folder` is the line it sits under. */
type Folder = { readonly kind: "folder"; readonly display: string; readonly entry?: Entry; readonly scope?: string };
/** `depth` 1 sits under a folder or a virtual root (`system-prompt` -> `system-prompt:<piece>`); 2 sits under such a piece. */
type Item = { readonly kind: "item"; readonly entry: Entry; readonly name: string; readonly depth: number; readonly folder?: Folder };
type Block = Folder | Item;

const isChild = (block: Block | undefined): boolean => block?.kind === "item" && block.depth > 0;

function parentOf(display: string): string {
	const slash = display.lastIndexOf("/");
	return slash > 0 ? display.slice(0, slash) : "";
}

/**
 * Folder rows become folder lines and the rows inside them follow, named relative to the folder.
 * Two or more consecutive rows sharing a parent folder get an implied folder line the same way.
 * A virtual `<root>:<piece>` row sits under its `<root>` row, and the file rows right after a piece sit under that piece.
 */
function groupRows(probes: readonly Probe[], report: Report): Block[] {
	const entries: Entry[] = probes.map((probe, index) => ({ probe, index, display: shortPath(probe.path, report) }));
	const roots = new Set(entries.filter((entry) => entry.probe.kind === "virtual").map((entry) => entry.display));
	const under = (entry: Entry | undefined, folder: string): boolean => entry !== undefined && entry.probe.kind !== "virtual" && entry.display.startsWith(`${folder}/`);
	const blocks: Block[] = [];
	let folder: Folder | undefined;
	entries.forEach((entry, i) => {
		const prev = blocks[blocks.length - 1];
		if (folder !== undefined && under(entry, folder.display)) {
			blocks.push({ kind: "item", entry, name: entry.display.slice(folder.display.length + 1), depth: 1, folder });
			return;
		}
		if (entry.probe.kind === "dir") {
			const line: Folder = { kind: "folder", display: entry.display, entry };
			// A folder that is not there holds nothing; candidates below it get their own lines.
			folder = entry.probe.status === "missing" ? undefined : line;
			blocks.push(line);
			return;
		}
		folder = undefined;
		if (entry.probe.kind === "virtual") {
			const colon = entry.display.indexOf(":");
			const piece = colon > 0 && roots.has(entry.display.slice(0, colon));
			blocks.push({ kind: "item", entry, name: piece ? entry.display.slice(colon + 1) : entry.display, depth: piece ? 1 : 0 });
			return;
		}
		const parent = parentOf(entry.display);
		if (parent !== "" && under(entries[i + 1], parent)) {
			// The folder line just above names this folder already (it said what is missing); do not repeat it.
			if (prev?.kind === "folder" && prev.display === parent) folder = prev;
			else {
				folder = { kind: "folder", display: parent, ...(entry.probe.scope !== undefined ? { scope: entry.probe.scope } : {}) };
				blocks.push(folder);
			}
			blocks.push({ kind: "item", entry, name: entry.display.slice(parent.length + 1), depth: 1, folder });
			return;
		}
		const nested = prev?.kind === "item" && prev.folder === undefined && prev.depth > 0;
		blocks.push({ kind: "item", entry, name: entry.display, depth: nested ? 2 : 0 });
	});
	return blocks;
}

/** Keeps the focused index visible inside a window of `rows` entries. */
function windowStart(count: number, focus: number, rows: number): number {
	if (rows <= 0 || count <= rows) return 0;
	const top = Math.min(Math.max(focus, 0), count - 1);
	return Math.max(0, Math.min(top <= 0 ? 0 : top - rows + 1, count - rows));
}

/** One right-pane line: colored segments; a selected line is drawn whole in accent and bold. */
type RightRow = { readonly segs: readonly Seg[]; readonly bold?: boolean; readonly selected?: boolean };
const BLANK: RightRow = { segs: [] };

/** Display lines of one category plus, per probe index, the line that shows it. */
function rightRows(category: Category | undefined, state: ViewState, report: Report): { rows: RightRow[]; probes: readonly Probe[]; lineOf: number[] } {
	const probes = state.problemsOnly && category ? filterProblems(category).probes : category?.probes ?? [];
	const rows: RightRow[] = [];
	const lineOf: number[] = [];
	if (category) rows.push({ segs: [{ text: CATEGORY_ABOUT[category.id] ?? category.label }], bold: true });
	if (category?.note) rows.push({ segs: [{ text: category.note, color: "muted" }] });
	if (category?.error) rows.push({ segs: [{ text: category.error, color: "warning" }] });
	if (rows.length > 0) rows.push(BLANK);
	const blocks = groupRows(probes, report);
	const numberWidth = String(blocks.filter((block) => block.kind === "item").length).length;
	let number = 0;
	blocks.forEach((block, b) => {
		// A blank line before and after every group (a folder or root with rows under it).
		const opens = !isChild(block) && isChild(blocks[b + 1]);
		if (b > 0 && !isChild(block) && (opens || isChild(blocks[b - 1])) && rows[rows.length - 1] !== BLANK) rows.push(BLANK);
		const probe = block.entry?.probe;
		const selected = state.pane === "rows" && block.entry !== undefined && block.entry.index === state.row;
		if (block.entry !== undefined) lineOf[block.entry.index] = rows.length;
		if (block.kind === "folder") {
			const gone = probe !== undefined && probe.status === "missing";
			const scope = probe?.scope ?? block.scope;
			const tail = probe !== undefined && flagged(probe) ? tailSegs(probe, true) : scope !== undefined ? [{ text: `  ${scope}`, color: "muted" }] : [];
			rows.push({ segs: [{ text: block.display, ...(gone ? { color: "muted" } : {}) }, ...tail], bold: !gone, selected });
			return;
		}
		const item = block.entry.probe;
		number += 1;
		// Inside a folder the folder line already says where and why; repeat only what differs.
		const said = block.folder !== undefined && (item.status === "loaded" || item.reason === block.folder.entry?.probe.reason);
		const lead = `${"  ".repeat(block.depth)}${String(number).padStart(numberWidth)}. `;
		const name: Seg = { text: block.name, ...(item.status === "missing" ? { color: "muted" } : {}) };
		rows.push({ segs: [{ text: lead, color: "muted" }, name, ...tailSegs(item, !said)], selected });
	});
	return { rows, probes, lineOf };
}

function renderRow(row: RightRow, theme: PaneTheme, width: number): string {
	const plain = row.segs.map((seg) => seg.text).join("");
	const fitted = fit(plain, width);
	if (row.selected) return paint(theme, "accent", emphasize(theme, fitted));
	// fit() keeps a prefix of the text, then maybe an ellipsis and padding; color only that prefix.
	let keep = 0;
	while (keep < plain.length && fitted[keep] === plain[keep]) keep += 1;
	let out = "";
	let at = 0;
	for (const seg of row.segs) {
		const part = seg.text.slice(0, Math.max(0, keep - at));
		at += seg.text.length;
		if (part === "") continue;
		const styled = row.bold ? emphasize(theme, part) : part;
		out += seg.color ? paint(theme, seg.color, styled) : styled;
	}
	return out + fitted.slice(keep);
}

function headerLines(report: Report, theme: PaneTheme, width: number): string[] {
	const lines = [paint(theme, "accent", emphasize(theme, fit(`where · ${summaryLine(report)}`, width)))];
	for (const notice of report.notices.slice(0, 2)) lines.push(paint(theme, "warning", fit(notice, width)));
	lines.push(" ".repeat(width));
	return lines;
}

function listLines(report: Report, state: ViewState, width: number, height: number, theme: PaneTheme): string[] {
	const lines = headerLines(report, theme, width);
	const bodyRows = Math.max(0, height - lines.length - 3); // rule + detail line + footer
	const leftWidth = Math.min(24, Math.floor(width * 0.28));
	const rightWidth = Math.max(0, width - leftWidth - 2);
	const categories = report.categories;
	const category = categories[state.cat];

	const leftStart = windowStart(categories.length, state.cat, bodyRows);
	const right = rightRows(category, state, report);
	const countWidth = Math.max(1, ...categories.map((item) => String(problemCount(item)).length));
	const labelWidth = leftWidth - countWidth - 3; // a space before the label, before the count and before the separator
	const focusRow = state.pane === "rows" ? (right.lineOf[state.row] ?? 0) : 0;
	const rightStart = windowStart(right.rows.length, focusRow, bodyRows);

	for (let i = 0; i < bodyRows; i++) {
		const catIndex = leftStart + i;
		let left = "";
		if (catIndex < categories.length) {
			const item = categories[catIndex];
			const count = problemCount(item);
			if (cellWidth(item.label) <= labelWidth) {
				const label = catIndex === state.cat ? paint(theme, "accent", emphasize(theme, item.label)) : item.label;
				const digits = String(count);
				// Only categories with problems show a count; a column of zeros reads as noise.
				const tally = count > 0 ? paint(theme, "warning", digits) : " ".repeat(digits.length);
				left = ` ${label}${" ".repeat(labelWidth - cellWidth(item.label))} ${" ".repeat(countWidth - digits.length)}${tally} `;
			} else left = fit(` ${item.label} ${count}`, leftWidth);
		} else left = " ".repeat(leftWidth);

		const rowIndex = rightStart + i;
		const rightText = rowIndex < right.rows.length ? renderRow(right.rows[rowIndex], theme, rightWidth) : " ".repeat(rightWidth);
		lines.push(`${left}${paint(theme, "muted", SEPARATOR)} ${rightText}`);
	}
	lines.push(paint(theme, "muted", RULE.repeat(width)));

	const selected = right.probes[state.row];
	const detail = state.hint ?? detailText(selected, report);
	const detailColor = state.hint ? "accent" : selected?.problem ? "warning" : "muted";
	lines.push(paint(theme, detailColor, fit(detail, width)));
	lines.push(paint(theme, "muted", fit(listFooter(width), width)));
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
