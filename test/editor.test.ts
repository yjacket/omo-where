import { describe, expect, test } from "bun:test";
import { type OpenResult, openInEditor, resolveEditorCommand, type SpawnFn, type SpawnResult, splitCommand, type TuiControl } from "../extension/omo-where/editor.ts";

type SpawnCall = { command: string; args: readonly string[]; options: { stdio: "inherit"; shell: boolean } };

function fakeTui(calls: string[]): TuiControl {
	return {
		stop: () => void calls.push("stop"),
		start: () => void calls.push("start"),
		requestRender: (force?: boolean) => void calls.push(`requestRender:${String(force)}`),
	};
}

function fakeSpawn(calls: SpawnCall[], result: SpawnResult): SpawnFn {
	return (command, args, options) => {
		calls.push({ command, args: [...args], options });
		return result;
	};
}

describe("resolveEditorCommand", () => {
	test("case: precedence - setting wins over VISUAL and EDITOR", () => {
		expect(resolveEditorCommand({ setting: "code -n", env: { VISUAL: "vim", EDITOR: "nano" }, platform: "linux" })).toBe("code -n");
	});

	test("case: precedence - VISUAL wins over EDITOR", () => {
		expect(resolveEditorCommand({ env: { VISUAL: "vim", EDITOR: "emacs" }, platform: "linux" })).toBe("vim");
		expect(resolveEditorCommand({ env: { EDITOR: "emacs" }, platform: "linux" })).toBe("emacs");
	});

	test("case: precedence - blank setting falls through to the environment", () => {
		expect(resolveEditorCommand({ setting: "   ", env: { EDITOR: "emacs" }, platform: "linux" })).toBe("emacs");
	});

	test("case: precedence - default is notepad on win32 and nano elsewhere", () => {
		expect(resolveEditorCommand({ env: {}, platform: "win32" })).toBe("notepad");
		expect(resolveEditorCommand({ env: {}, platform: "linux" })).toBe("nano");
	});
});

describe("splitCommand", () => {
	test("case: quoted split - double quotes keep spaces in one token", () => {
		expect(splitCommand('"C:\\Program Files\\Microsoft VS Code\\Code.exe" -n --wait')).toEqual(["C:\\Program Files\\Microsoft VS Code\\Code.exe", "-n", "--wait"]);
		expect(splitCommand("code --new-window")).toEqual(["code", "--new-window"]);
	});
});

describe("openInEditor", () => {
	test("case: order - stop, spawn, start, requestRender(true)", () => {
		const calls: string[] = [];
		const spawnCalls: SpawnCall[] = [];
		const result = openInEditor({ tui: fakeTui(calls), command: "code -n", path: "/tmp/notes.md", platform: "linux", spawn: fakeSpawn(spawnCalls, { status: 0 }) });
		expect(result).toEqual({ ok: true });
		expect(calls).toEqual(["stop", "start", "requestRender:true"]);
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]).toEqual({ command: "code", args: ["-n", "/tmp/notes.md"], options: { stdio: "inherit", shell: false } });
	});

	test("case: path with spaces is quoted on win32 and shell is on", () => {
		const spawnCalls: SpawnCall[] = [];
		const result = openInEditor({ tui: fakeTui([]), command: "notepad", path: "C:\\My Notes\\todo list.md", platform: "win32", spawn: fakeSpawn(spawnCalls, { status: 0 }) });
		expect(result).toEqual({ ok: true });
		expect(spawnCalls[0]?.command).toBe("notepad");
		expect(spawnCalls[0]?.args).toEqual(['"C:\\My Notes\\todo list.md"']);
		expect(spawnCalls[0]?.options).toEqual({ stdio: "inherit", shell: true });
	});

	test("case: quoted command split reaches the spawner on win32", () => {
		const spawnCalls: SpawnCall[] = [];
		openInEditor({ tui: fakeTui([]), command: '"C:\\Program Files\\VSCode\\Code.exe" -n', path: "C:\\src\\a.md", platform: "win32", spawn: fakeSpawn(spawnCalls, { status: 0 }) });
		expect(spawnCalls[0]?.command).toBe("C:\\Program Files\\VSCode\\Code.exe");
		expect(spawnCalls[0]?.args).toEqual(["-n", "C:\\src\\a.md"]);
	});

	test("case: start is called when spawn throws", () => {
		const calls: string[] = [];
		const spawn: SpawnFn = () => {
			calls.push("spawn");
			throw new Error("EAGAIN");
		};
		const result: OpenResult = openInEditor({ tui: fakeTui(calls), command: "code", path: "/tmp/a.md", platform: "linux", spawn });
		expect(result).toEqual({ ok: false, message: "편집기를 열 수 없음: code" });
		expect(calls).toEqual(["stop", "spawn", "start", "requestRender:true"]);
	});

	test("case: non-zero status gives the failure message and still resumes the TUI", () => {
		const calls: string[] = [];
		const result = openInEditor({ tui: fakeTui(calls), command: "code -n", path: "/tmp/a.md", platform: "linux", spawn: fakeSpawn([], { status: 2 }) });
		expect(result).toEqual({ ok: false, message: "편집기를 열 수 없음: code -n" });
		expect(calls).toEqual(["stop", "start", "requestRender:true"]);
	});

	test("case: spawn error with null status gives the failure message", () => {
		const result = openInEditor({ tui: fakeTui([]), command: "code", path: "/tmp/a.md", platform: "linux", spawn: fakeSpawn([], { status: null, error: new Error("ENOENT") }) });
		expect(result).toEqual({ ok: false, message: "편집기를 열 수 없음: code" });
	});
});
