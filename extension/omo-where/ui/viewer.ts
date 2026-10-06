// Viewer model: loads a file (or directory listing) into lines and renders the overlay body.
// Pure text/inspection only: never writes. Every rendered line stays within the requested width.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SECRET_KEY } from "../model.ts";
import type { ViewerState } from "./state.ts";

export type ViewerText = { readonly title: string; readonly lines: readonly string[]; readonly notice?: string };
/** Minimal theme surface the viewer needs; both members optional so callers may pass nothing. */
export type ViewerTheme = { readonly bold?: (text: string) => string };
/** Bun text utilities, reached through a narrowed global so this module needs no bundler/type setup. */
type BunTextApi = {
	readonly stringWidth: (text: string) => number;
	readonly sliceAnsi: (text: string, start: number, end?: number) => string;
	readonly JSONC?: { readonly parse: (text: string) => unknown };
};
const bunText = (globalThis as unknown as { readonly Bun: BunTextApi }).Bun;

const CAP_BYTES = 512 * 1024;
const SAMPLE_BYTES = 8 * 1024;
const TRUNCATED_NOTICE = "앞 512KiB만 표시";
const BINARY_NOTICE = "이진 파일이라 표시 안 함";
const MISSING_NOTICE = "파일 없음";
const MASK_NOTICE = "비밀 값은 <가림>";
const MASK_TEXT = "<가림>";

function digits(value: number): number {
	return String(Math.max(0, Math.floor(value))).length;
}

function isJsonTitle(title: string): boolean {
	return /\.jsonc?$/i.test(title);
}

/** Splits text into lines; CRLF/CR normalised and a single trailing newline dropped. */
function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Replaces string values of keys matching SECRET_KEY with "<가림>"; masked is true when it did. */
function maskSecrets(text: string): { text: string; masked: boolean } {
	let data: unknown;
	try {
		data = bunText.JSONC ? bunText.JSONC.parse(text) : JSON.parse(text);
	} catch {
		return { text, masked: false };
	}
	let masked = false;
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map((item) => walk(item));
		if (typeof value === "object" && value !== null) {
			const out: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
				if (typeof item === "string" && SECRET_KEY.test(key)) {
					out[key] = MASK_TEXT;
					masked = true;
				} else {
					out[key] = walk(item);
				}
			}
			return out;
		}
		return value;
	};
	return { text: `${JSON.stringify(walk(data), null, 2)}\n`, masked };
}

/** Largest column-prefix of text whose display width fits in cols (wide chars are never split). */
function prefixFit(text: string, cols: number): string {
	if (cols <= 0) return "";
	if (bunText.stringWidth(text) <= cols) return text;
	let low = 0;
	let high = cols;
	let best = "";
	while (low <= high) {
		const mid = (low + high) >> 1;
		const piece = bunText.sliceAnsi(text, 0, mid);
		if (bunText.stringWidth(piece) <= cols) {
			best = piece;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best;
}

/** Hard-wraps one logical line into rows of at most avail display columns (CJK counts 2). */
function hardWrap(text: string, avail: number): string[] {
	if (avail <= 0 || text === "") return [""];
	const rows: string[] = [];
	let rest = text;
	while (rest !== "") {
		if (bunText.stringWidth(rest) <= avail) {
			rows.push(rest);
			break;
		}
		let head = prefixFit(rest, avail);
		if (head === "") {
			// A single grapheme wider than avail: take one code point; renderViewer clamps the row.
			head = Array.from(rest)[0] ?? "";
			if (head === "") break;
		}
		rows.push(head);
		const next = bunText.sliceAnsi(rest, Math.max(1, bunText.stringWidth(head)));
		if (next === rest || next === "") break;
		rest = next;
	}
	return rows.length > 0 ? rows : [""];
}

/** Clamps a rendered line to at most width columns, dropping anything that cannot fit. */
function fit(text: string, width: number): string {
	if (width <= 0) return "";
	if (bunText.stringWidth(text) <= width) return text;
	return prefixFit(text, width);
}

/** Keeps the tail of text (absolute path) visible, prefixing "…" when it does not fit. */
function leftTruncate(text: string, width: number): string {
	const total = bunText.stringWidth(text);
	if (total <= width) return text;
	if (width <= 1) return "…";
	const budget = width - 1;
	for (let start = Math.max(0, total - budget); start <= total; start += 1) {
		const tail = bunText.sliceAnsi(text, start);
		if (bunText.stringWidth(tail) <= budget) return `…${tail}`;
	}
	return "…";
}

/** Loads a path into viewer text: directory listing, text file (cap 512KiB, binary NUL check) or a notice. */
export function loadViewerText(path: string): ViewerText {
	const title = resolve(path);
	let size: number;
	try {
		const stat = statSync(path);
		if (stat.isDirectory()) {
			const lines = readdirSync(path, { withFileTypes: true })
				.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
				.sort();
			return { title, lines };
		}
		size = stat.size;
	} catch {
		return { title, lines: [], notice: MISSING_NOTICE };
	}

	const readLength = Math.min(size, CAP_BYTES);
	const buffer = Buffer.alloc(readLength);
	const fd = openSync(path, "r");
	let filled = 0;
	try {
		while (filled < readLength) {
			const read = readSync(fd, buffer, filled, readLength - filled, filled);
			if (read <= 0) break;
			filled += read;
		}
	} finally {
		closeSync(fd);
	}

	const head = buffer.subarray(0, filled);
	if (head.subarray(0, SAMPLE_BYTES).indexOf(0) !== -1) {
		return { title, lines: [], notice: BINARY_NOTICE };
	}

	const truncated = size > CAP_BYTES;
	let text = head.toString("utf8");
	let notice: string | undefined = truncated ? TRUNCATED_NOTICE : undefined;
	if (!truncated && isJsonTitle(path)) {
		const masked = maskSecrets(text);
		if (masked.masked) {
			text = masked.text;
			notice = MASK_NOTICE;
		}
	}
	return { title, lines: splitLines(text), notice };
}

/** Same pipeline for text already in memory (virtual probes, session content); no size/binary notice. */
export function viewerFromText(title: string, text: string): ViewerText {
	let body = text;
	let notice: string | undefined;
	if (isJsonTitle(title)) {
		const masked = maskSecrets(body);
		if (masked.masked) {
			body = masked.text;
			notice = MASK_NOTICE;
		}
	}
	return { title, lines: splitLines(body), notice };
}

/** Keeps offset inside [0, total - height] so the viewport never scrolls past the end. */
export function clampOffset(offset: number, total: number, height: number): number {
	const max = Math.max(0, Math.floor(total) - Math.floor(height));
	return Math.max(0, Math.min(Math.floor(offset), max));
}

/** Renders exactly height lines, each at most width columns: path header, optional notice, numbered body. */
export function renderViewer(state: ViewerState, width: number, height: number, theme?: ViewerTheme): string[] {
	const w = Math.max(0, Math.floor(width));
	const h = Math.max(0, Math.floor(height));
	if (h === 0) return [];

	const rows: string[] = [];
	const header = leftTruncate(state.title, w);
	rows.push(fit(theme?.bold ? theme.bold(header) : header, w));
	if (state.notice !== undefined && rows.length < h) {
		rows.push(fit(state.notice, w));
	}

	const bodyHeight = h - rows.length;
	if (bodyHeight > 0) {
		const gutter = digits(state.lines.length) + 1;
		const avail = Math.max(0, w - gutter);
		const wrapped: { readonly num: number; readonly text: string }[] = [];
		state.lines.forEach((line, index) => {
			for (const chunk of hardWrap(line, avail)) wrapped.push({ num: index + 1, text: chunk });
		});
		const offset = clampOffset(state.offset, wrapped.length, bodyHeight);
		for (let i = 0; i < bodyHeight; i += 1) {
			const row = wrapped[offset + i];
			if (row === undefined) {
				rows.push("");
				continue;
			}
			const num = String(row.num).padStart(gutter - 1, " ");
			rows.push(fit(`${num}|${row.text}`, w));
		}
	}

	while (rows.length < h) rows.push("");
	return rows.slice(0, h);
}
