import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { type Probe, type ProbeEnv } from "../../extension/omo-where/model.ts";
import { probeSystemPrompt } from "../../extension/omo-where/probes/system-prompt.ts";
import { makeTree, type Tree } from "../helpers/tree.ts";

const trees: Tree[] = [];
afterEach(() => {
	while (trees.length > 0) trees.pop()!.cleanup();
});

/** Probe needs no filesystem, but the env still points at a throwaway tree, never a real home. */
function envOf(systemPrompt?: string): ProbeEnv {
	const tree = makeTree({ "agent": null, "proj": null, "home": null });
	trees.push(tree);
	return {
		cwd: tree.path("proj"),
		agentDir: tree.path("agent"),
		home: tree.path("home"),
		env: {},
		trusted: true,
		senpi: {},
		host: { missingPackages: [] },
		live: systemPrompt === undefined ? {} : { systemPrompt },
	};
}

const skeleton = readFileSync(join(import.meta.dir, "..", "fixtures", "system-prompt-skeleton.txt"), "utf-8");
const layerRows = (probes: readonly Probe[]): Probe[] => probes.filter((probe) => probe.kind === "virtual" && probe.path !== "system-prompt");

describe("probeSystemPrompt", () => {
	test("acceptance: virtual system-prompt row is rank 1 with the whole prompt", () => {
		const category = probeSystemPrompt(envOf(skeleton));

		expect(category.id).toBe("prompt");
		expect(category.label).toBe("시스템 프롬프트");
		const main = category.probes[0];
		expect(main?.path).toBe("system-prompt");
		expect(main?.kind).toBe("virtual");
		expect(main?.status).toBe("loaded");
		expect(main?.rank).toBe(1);
		expect(main?.reason).toBe(`${skeleton.length}자 · 지금 세션에 들어간 전체`);
		expect(main?.text).toBe(skeleton);
	});

	test("acceptance: skeleton -> layer labels in fixture order", () => {
		const category = probeSystemPrompt(envOf(skeleton));

		expect(layerRows(category.probes).every((probe) => probe.reason === `${(probe.text ?? "").length}자`)).toBe(true);
		expect(layerRows(category.probes).map((probe) => probe.path)).toEqual([
			"system-prompt:기본 지침(프리셋)",
			"system-prompt:지침 파일 묶음",
			"system-prompt:스킬 목록",
			"system-prompt:작업 환경",
			"system-prompt:할 일 규칙",
			"system-prompt:bash 시간 제한",
			"system-prompt:터미널 세션",
			"system-prompt:규칙 묶음",
			"system-prompt:MCP 안내 (context7)",
			"system-prompt:메모리 정보",
		]);
		// Contiguous slices: layer texts reassemble the whole prompt in order.
		expect(layerRows(category.probes).map((probe) => probe.text ?? "").join("")).toBe(skeleton);
		expect(layerRows(category.probes).every((probe) => probe.status === "loaded")).toBe(true);
	});

	test("acceptance: Project Context file rows - one row per ### heading", () => {
		const category = probeSystemPrompt(envOf(skeleton));

		const file = category.probes.find((probe) => probe.path === "C:/proj/AGENTS.md");
		expect(file?.kind).toBe("file");
		expect(file?.status).toBe("loaded");
		expect(file?.reason).toBe("지침 파일");
		const contextIndex = category.probes.findIndex((probe) => probe.path === "system-prompt:지침 파일 묶음");
		expect(category.probes[contextIndex + 1]?.path).toBe("C:/proj/AGENTS.md");
	});

	test("acceptance: absent prompt -> one missing row", () => {
		for (const prompt of [undefined, ""]) {
			const category = probeSystemPrompt(envOf(prompt));
			expect(category.probes.length).toBe(1);
			const row = category.probes[0];
			expect(row?.path).toBe("system-prompt");
			expect(row?.kind).toBe("virtual");
			expect(row?.status).toBe("missing");
			expect(row?.reason).toBe("세션 프롬프트를 읽을 수 없음");
		}
	});

	test("layers follow the text order, not the marker table order", () => {
		const prompt = "Base\n<!-- senpi-memory:x:begin -->\nM\n<workstation>\nW\n";
		const category = probeSystemPrompt(envOf(prompt));

		expect(layerRows(category.probes).map((probe) => probe.path)).toEqual([
			"system-prompt:기본 지침(프리셋)",
			"system-prompt:메모리 정보",
			"system-prompt:작업 환경",
		]);
	});

	test("a prompt with no marker yields one preset layer covering all of it", () => {
		const prompt = "only synthesized text";
		const category = probeSystemPrompt(envOf(prompt));

		expect(category.probes.length).toBe(2);
		const layer = category.probes[1];
		expect(layer?.path).toBe("system-prompt:기본 지침(프리셋)");
		expect(layer?.text).toBe(prompt);
		expect(layer?.reason).toBe(`${prompt.length}자`);
	});
});
