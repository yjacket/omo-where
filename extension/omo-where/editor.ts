// External editor launcher for the /where overlay (plan todo 12, GAP-5).
// Resolves the editor command the harness would use and opens a path in it,
// pausing and always resuming the TUI around the child process.
import { spawnSync } from "node:child_process";

export type EditorEnv = Readonly<Record<string, string | undefined>>;

/** setting > VISUAL > EDITOR > "notepad" on win32, else "nano". */
export function resolveEditorCommand(options: { setting?: string; env: EditorEnv; platform: string }): string {
	const setting = options.setting;
	if (typeof setting === "string" && setting.trim() !== "") return setting;
	const environment = options.env.VISUAL || options.env.EDITOR;
	if (environment) return environment;
	return options.platform === "win32" ? "notepad" : "nano";
}

/** Splits a command line on spaces, honoring double-quoted segments. */
export function splitCommand(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quoted = false;
	let started = false;
	for (const ch of command) {
		if (ch === '"') {
			quoted = !quoted;
			started = true;
			continue;
		}
		if (ch === " " && !quoted) {
			if (started) {
				parts.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += ch;
		started = true;
	}
	if (started) parts.push(current);
	return parts;
}

export type TuiControl = {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
};

export type SpawnResult = { status?: number | null; error?: unknown };
export type SpawnFn = (command: string, args: readonly string[], options: { stdio: "inherit"; shell: boolean }) => SpawnResult;

export type OpenInEditorOptions = {
	tui: TuiControl;
	command: string;
	path: string;
	platform: string;
	spawn?: SpawnFn;
};

export type OpenResult = { ok: boolean; message?: string };

export function openInEditor(options: OpenInEditorOptions): OpenResult {
	const parts = splitCommand(options.command);
	const editor = parts[0] ?? "";
	const editorArgs = parts.slice(1);
	const shell = options.platform === "win32";
	const run: SpawnFn = options.spawn ?? ((command, args, spawnOptions) => spawnSync(command, args, spawnOptions));
	const args = [...editorArgs, options.path];
	const finalArgs = shell ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
	try {
		options.tui.stop();
		const result = run(editor, finalArgs, { stdio: "inherit", shell });
		if (result.status !== 0) return { ok: false, message: `편집기를 열 수 없음: ${options.command}` };
		return { ok: true };
	} catch {
		return { ok: false, message: `편집기를 열 수 없음: ${options.command}` };
	} finally {
		options.tui.start();
		options.tui.requestRender(true);
	}
}
