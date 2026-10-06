// QA-only extension: dumps what the live session sees to <OMO_WHERE_QA_OUT>/ctx.json. Never installed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const safe = <T,>(fn: () => T): T | { error: string } => {
  try { return fn(); } catch (e) { return { error: String(e) }; }
};

export default function (pi: any) {
  pi.registerCommand("where-dump", {
    description: "QA: dump session context to ctx.json",
    handler: async (_args: string, ctx: any) => {
      const out = process.env.OMO_WHERE_QA_OUT || process.cwd();
      const opts: any = safe(() => ctx.getSystemPromptOptions());
      const ok = opts && !opts.error;
      const data = {
        loadedExtensionPaths: safe(() => [...ctx.loadedExtensionPaths]),
        contextFiles: ok ? (opts.contextFiles ?? []).map((f: any) => f.path) : opts,
        skills: ok ? (opts.skills ?? []).map((s: any) => ({ name: s.name, filePath: s.filePath })) : opts,
        systemPrompt: safe(() => ctx.getSystemPrompt()),
        mcpServers: safe(() => ctx.getRegisteredMcpServers().map((m: any) => ({ name: m.name, extensionPath: m.extensionPath }))),
        hookSources: safe(() => ctx.getLoadedHookSources()),
      };
      mkdirSync(out, { recursive: true });
      const file = join(out, "ctx.json");
      writeFileSync(file, JSON.stringify(data, null, 2));
      ctx.ui.notify(`where-dump wrote ${file}`, "info");
    },
  });
}
