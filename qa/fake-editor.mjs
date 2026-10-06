// QA fake $VISUAL: logs argv, never touches its file argument.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const out = process.env.OMO_WHERE_QA_OUT || process.cwd();
mkdirSync(out, { recursive: true });
appendFileSync(join(out, "editor-log.txt"), JSON.stringify(process.argv.slice(2)) + "\n");
process.stderr.write("fake-editor: invoked\n");
process.exit(0);
