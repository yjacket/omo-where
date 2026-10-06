// Probe: 메모리. No host function exposes the memory repo layout, so the harness rule
// (OMO_MEMORY_HOME or <home>/.omo/memory, agents/<id>/repo/{system,skills}) is mirrored here
// and noted in Category.note.
import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import type { ProbeFn } from "../model.ts";
import { describe, isUnder, makeCollector, statKind } from "./fs-util.ts";

const MAX_ENTRIES = 2000;
const MEMORY_NOTE = "OMO_MEMORY_HOME이 없으면 <home>/.omo/memory · 세션 프롬프트의 senpi-memory 표식으로 찾음";

type DirRead = { readonly names: readonly string[]; readonly truncated: boolean } | { readonly missing: true } | { readonly error: string };

function readDirEntries(dir: string): DirRead {
	try {
		const names = readdirSync(dir).sort();
		const truncated = names.length > MAX_ENTRIES;
		return { names: truncated ? names.slice(0, MAX_ENTRIES) : names, truncated };
	} catch (error) {
		return existsSync(dir) ? { error: describe(error) } : { missing: true };
	}
}

const MEMORY_BEGIN = /<!-- senpi-memory:([^:\r\n]+):begin -->/;
const MEMORY_AGENT_ID = /- AGENT_ID: (\S+)/;
const MEMORY_SKILL_AGENT = /[\\/]agents[\\/]([^\\/]+)[\\/]repo[\\/]skills[\\/]/;

/** Which fallback found the agent id; drives the repo row reason and the category note. */
type IdSource = "prompt" | "skills" | "folder";
const ID_SOURCE_REASON: Readonly<Record<"skills" | "folder", string>> = { skills: "세션 스킬 경로로 찾음", folder: "폴더 이름으로 추정" };
const ID_SOURCE_NOTE: Readonly<Record<IdSource, string>> = { prompt: "세션 프롬프트 표식", skills: "세션 스킬 경로", folder: "폴더 이름 추정" };

function idFromPrompt(prompt: string | undefined): string | undefined {
	if (prompt === undefined) return undefined;
	const id = MEMORY_BEGIN.exec(prompt)?.[1] ?? MEMORY_AGENT_ID.exec(prompt)?.[1];
	return id === undefined || id === "" ? undefined : id;
}

/** First live skill under the memory home whose path is .../agents/<id>/repo/skills/... . */
function idFromSkills(skills: readonly { readonly filePath: string }[] | undefined, memoryHome: string): string | undefined {
	for (const skill of skills ?? []) {
		const id = MEMORY_SKILL_AGENT.exec(skill.filePath)?.[1];
		if (id !== undefined && id !== "" && isUnder(skill.filePath, memoryHome)) return id;
	}
	return undefined;
}

/** Agent dirs named "<basename(cwd)>-" that hold a repo dir. */
function folderCandidates(cwd: string, memoryHome: string): readonly string[] {
	const agentsDir = join(memoryHome, "agents");
	const read = readDirEntries(agentsDir);
	if ("missing" in read || "error" in read) return [];
	const prefix = `${basename(resolvePath(cwd))}-`;
	return read.names.filter((name) => name.startsWith(prefix) && statKind(join(agentsDir, name, "repo")).kind === "dir");
}

/** Lists a repo subdir; emit() adds the rows for one entry name. Returns after the dir rows (missing/error/truncated). */
function emitEntries(dir: string, col: ReturnType<typeof makeCollector>, emit: (name: string) => void): void {
	const read = readDirEntries(dir);
	if ("missing" in read) {
		col.add({ path: dir, kind: "dir", status: "missing", reason: "폴더 없음", scope: "omo 플러그인" });
		return;
	}
	if ("error" in read) {
		col.add({ path: dir, kind: "dir", status: "error", reason: `읽지 못함: ${read.error}`, scope: "omo 플러그인" });
		return;
	}
	if (read.truncated) col.add({ path: dir, kind: "dir", status: "error", reason: "목록 잘림", scope: "omo 플러그인" });
	for (const name of read.names) emit(name);
}

function emitMemoryFiles(dir: string, col: ReturnType<typeof makeCollector>): void {
	emitEntries(dir, col, (name) => {
		if (!name.toLowerCase().endsWith(".md")) return;
		col.add({ path: join(dir, name), kind: "file", status: "loaded", reason: "세션에 투영", scope: "omo 플러그인" });
	});
}

function emitMemorySkills(dir: string, col: ReturnType<typeof makeCollector>): void {
	emitEntries(dir, col, (name) => {
		const entry = join(dir, name);
		if (statKind(entry).kind === "dir") {
			const skillFile = join(entry, "SKILL.md");
			if (statKind(skillFile).kind === "file") col.add({ path: skillFile, kind: "file", status: "loaded", reason: "스킬로 쓰임", scope: "omo 플러그인" });
			else col.add({ path: entry, kind: "dir", status: "loaded", reason: "스킬로 쓰임", scope: "omo 플러그인" });
			return;
		}
		col.add({ path: entry, kind: "file", status: "loaded", reason: "스킬로 쓰임", scope: "omo 플러그인" });
	});
}

export const probeMemory: ProbeFn = (env) => {
	const col = makeCollector();
	const configuredHome = env.env.OMO_MEMORY_HOME;
	const memoryHome = configuredHome !== undefined && configuredHome !== "" ? resolvePath(env.cwd, configuredHome) : join(env.home, ".omo", "memory");

	// The real session prompt lacks the per-turn memory injection, so fall back to
	// the live skill paths, then to memory-home folders named "<cwd basename>-".
	let id = idFromPrompt(env.live.systemPrompt);
	let source: IdSource = "prompt";
	if (id === undefined) {
		id = idFromSkills(env.live.skills, memoryHome);
		if (id !== undefined) source = "skills";
	}
	if (id === undefined) {
		const candidates = folderCandidates(env.cwd, memoryHome);
		if (candidates.length === 1) {
			id = candidates[0];
			source = "folder";
		} else if (candidates.length > 1) {
			for (const candidate of candidates) col.add({ path: join(memoryHome, "agents", candidate, "repo"), kind: "dir", status: "missing", reason: "여러 후보 - 세션 정보 없음", scope: "omo 플러그인" });
			return { id: "memory", label: "메모리", probes: col.finish(), note: `${MEMORY_NOTE} · id 못 찾음: 후보 ${candidates.length}개` };
		}
	}
	if (id === undefined) {
		col.add({ path: "memory", kind: "virtual", status: "missing", reason: "메모리 꺼짐 또는 정보 없음", scope: "omo 플러그인" });
		return { id: "memory", label: "메모리", probes: col.finish(), note: MEMORY_NOTE };
	}

	const note = `${MEMORY_NOTE} · id: ${ID_SOURCE_NOTE[source]}`;
	const repoReason = source === "prompt" ? "메모리 저장소" : ID_SOURCE_REASON[source];
	const repo = join(memoryHome, "agents", id, "repo");
	const repoStat = statKind(repo);
	if (repoStat.kind === "error") {
		col.add({ path: repo, kind: "dir", status: "error", reason: `읽지 못함: ${repoStat.message}`, scope: "omo 플러그인" });
		return { id: "memory", label: "메모리", probes: col.finish(), note };
	}
	if (repoStat.kind !== "dir") {
		col.add({ path: repo, kind: "dir", status: "missing", reason: "폴더 없음", scope: "omo 플러그인" });
		return { id: "memory", label: "메모리", probes: col.finish(), note };
	}

	col.add({ path: repo, kind: "dir", status: "loaded", reason: repoReason, scope: "omo 플러그인" });
	emitMemoryFiles(join(repo, "system"), col);
	emitMemorySkills(join(repo, "skills"), col);
	return { id: "memory", label: "메모리", probes: col.finish(), note };
};
