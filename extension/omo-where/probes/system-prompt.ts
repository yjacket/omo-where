// Probe: 시스템 프롬프트. With env.live.systemPrompt it splits the already-assembled
// prompt into the layers the harness concatenated, in the order they appear in the
// text. Without a prompt it reports one missing row. Pure string work: no filesystem,
// no host function, and it re-implements no harness rule.
import { samePath, type Probe, type ProbeFn, type Scope } from "../model.ts";

const MAIN_PATH = "system-prompt";
const SCOPE: Scope = "세션";
const MISSING_REASON = "세션 프롬프트를 읽을 수 없음";
const FILE_REASON = "지침 파일";
const PRESET_LABEL = "기본 지침(프리셋)";
const CONTEXT_LABEL = "지침 파일 묶음";
const NOTE = "지금 세션에 들어간 완성 프롬프트를 표식으로 잘라 보여줌 · 표식 순서는 프롬프트에 나온 순서";

/** Mutable intermediate row; Probe fields are readonly. */
type MutableProbe = { -readonly [K in keyof Probe]: Probe[K] };

/** A layer starts at the first occurrence of any of its needles; the label is fixed. */
const GROUPS: readonly { readonly label: string; readonly needles: readonly string[] }[] = [
	{ label: CONTEXT_LABEL, needles: ["## Project Context"] },
	{ label: "스킬 목록", needles: ["<skill_roots>", "The following skills for"] },
	{ label: "작업 환경", needles: ["<workstation>"] },
	{ label: "할 일 규칙", needles: ["<Task_Management>"] },
	{ label: "bash 시간 제한", needles: ["## Bash Tool Timeout Policy"] },
	{ label: "터미널 세션", needles: ["## Persistent terminal sessions"] },
	{ label: "규칙 묶음", needles: ["<!--senpi:project-rules:1:start-->"] },
	{ label: "메모리 정보", needles: ["<!-- senpi-memory:"] },
];

/** One MCP block starts a layer whose label carries the server name. */
const MCP_MARKER = /<mcp_instructions server="([^"]+)">/g;
/** A Project Context file starts at a "### <path>" heading inside that section. */
const FILE_HEADING = /^### (.+)$/gm;

type Layer = { readonly start: number; readonly label: string };

function layersOf(prompt: string): Layer[] {
	const layers: Layer[] = [];
	for (const group of GROUPS) {
		let start = -1;
		for (const needle of group.needles) {
			const index = prompt.indexOf(needle);
			if (index >= 0 && (start < 0 || index < start)) start = index;
		}
		if (start >= 0) layers.push({ start, label: group.label });
	}
	for (const match of prompt.matchAll(MCP_MARKER)) layers.push({ start: match.index ?? 0, label: `MCP 안내 (${match[1] ?? ""})` });
	layers.sort((a, b) => a.start - b.start);
	return layers;
}

function filesIn(section: string): string[] {
	const paths: string[] = [];
	for (const match of section.matchAll(FILE_HEADING)) {
		const path = (match[1] ?? "").trim();
		if (path.length > 0 && !paths.some((seen) => samePath(seen, path))) paths.push(path);
	}
	return paths;
}

export const probeSystemPrompt: ProbeFn = (env) => {
	const prompt = env.live.systemPrompt;
	if (typeof prompt !== "string" || prompt.length === 0) {
		return {
			id: "prompt",
			label: "시스템 프롬프트",
			probes: [{ id: MAIN_PATH, rank: 1, path: MAIN_PATH, kind: "virtual", status: "missing", reason: MISSING_REASON, scope: SCOPE }],
			note: NOTE,
		};
	}

	const rows: MutableProbe[] = [];
	const push = (row: Omit<Probe, "rank">): void => {
		rows.push({ ...row, rank: rows.length + 1 });
	};

	push({ id: MAIN_PATH, path: MAIN_PATH, kind: "virtual", status: "loaded", reason: `${prompt.length}자 · 지금 세션에 들어간 전체`, scope: SCOPE, text: prompt });

	const markers = layersOf(prompt);
	const segments: { readonly start: number; readonly end: number; readonly label: string }[] = [];
	const firstStart = markers[0]?.start;
	if (firstStart !== undefined && prompt.slice(0, firstStart).trim().length > 0) segments.push({ start: 0, end: firstStart, label: PRESET_LABEL });
	for (let index = 0; index < markers.length; index++) {
		const marker = markers[index];
		if (marker === undefined) continue;
		segments.push({ start: marker.start, end: markers[index + 1]?.start ?? prompt.length, label: marker.label });
	}
	if (segments.length === 0) segments.push({ start: 0, end: prompt.length, label: PRESET_LABEL });

	for (const segment of segments) {
		const text = prompt.slice(segment.start, segment.end);
		push({ id: `${MAIN_PATH}:${segment.label}`, path: `${MAIN_PATH}:${segment.label}`, kind: "virtual", status: "loaded", reason: `${text.length}자`, scope: SCOPE, text });
		if (segment.label !== CONTEXT_LABEL) continue;
		for (const file of filesIn(text)) {
			push({ id: `system-prompt:file:${file}`, path: file, kind: "file", status: "loaded", reason: FILE_REASON, scope: SCOPE });
		}
	}

	return { id: "prompt", label: "시스템 프롬프트", probes: rows, note: NOTE };
};
