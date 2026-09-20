/**
 * TraeCode's per-repo workspace MCP registration — why it exists and why the hook writes it.
 *
 * TraeCode launches USER-level MCP servers (Trae CN's `<userData>/User/mcp.json`) with the
 * ELECTRON PROCESS's cwd — the user's home directory, not the workspace the agent is chatting in.
 * With `optInOnly: true`, a home-cwd mcp-server resolves no opted-in bank and self-disables, so
 * the agent sees ZERO hindsight tools even in a fully opted-in repo (the hooks, which DO receive
 * the workspace cwd in their payload, keep working — the memory works, only the tools vanish).
 *
 * The fix needs no core change: mcp-server.ts honors `HINDSIGHT_MCP_PROJECT_CWD`, and Trae ALSO
 * reads a per-workspace `<repo>/.trae/mcp.json` (verified in the Trae CN bundle: workspace-folder
 * managers join each folder's `.trae/mcp.json` under the `mcp.config.ws<n>.` scope key, parse the
 * SAME `mcpServers` top-level object as the user file, keep `{command, args, cwd, env}` for stdio
 * servers, and hot-reload the file with a 200ms debounce). So the SessionStart hook — which knows
 * the repo AND runs only where memory is actually live (the caller derives the bank and applies
 * opt-in first) — makes sure that file registers our server pinned to THIS repo:
 *   {"mcpServers":{"hindsight":{"command":"node","args":["<dist>/mcp-server.js"],
 *     "env":{"HINDSIGHT_MCP_HARNESS":"traecode","HINDSIGHT_MCP_PROJECT_CWD":"<repo>"}}}}
 *
 * Fidelity rules, in order: never throw; never touch a foreign "hindsight" entry (same ownership
 * check the installer applies to user-level files); never clobber the rest of the document; and
 * rewrite only on a real diff so the hook is idempotent. The registration carries an absolute,
 * machine-specific path, so a repo .gitignore that does not already ignore the file gets the one
 * line that keeps it out of version control — but only when a .gitignore already exists: creating
 * one is a bigger statement about the repo than a hook should make.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diag } from "./diag";

const MCP_SERVER_NAME = "hindsight";
const MCP_FILE_REL = join(".trae", "mcp.json");

/** Where the packaged `dist/mcp-server.js` sits: a sibling of this module in the flat `dist/`
 *  bundle, `<pkg>/dist` from the source tree — mirroring skill-sync.ts's packaged-skill probe. */
function bundledDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return existsSync(join(here, "mcp-server.js")) ? here : join(here, "..", "..", "dist");
}

/** Same shape check the installer applies to user-level registrations (isOurMcpEntry there):
 *  name ownership alone would let this hook hijack a user's own `hindsight` server. Duplicated
 *  rather than imported — installer.ts drags the whole install surface into the hook bundle. */
function isOurMcpEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as { command?: unknown; args?: unknown };
  if (candidate.command !== "node" || !Array.isArray(candidate.args)) return false;
  const script = candidate.args[0];
  if (typeof script !== "string") return false;
  const parts = script.replaceAll("\\", "/").split("/").filter(Boolean);
  return (
    parts.at(-1) === "mcp-server.js" &&
    parts.at(-2) === "dist" &&
    (parts.at(-3) === "coding-agents" || parts.at(-3) === "hindsight-coding-agents")
  );
}

/** Key-order-insensitive JSON comparison: a spread-built entry may equal the existing one while
 *  serializing differently, and equality is what gates the rewrite (idempotency, not formatting). */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** True when a .gitignore line already covers `<repo>/.trae/mcp.json`. Lines mentioning `.trae`
 *  count as covered — the cost of a false "covered" is just an untracked file, while appending
 *  under a negation (`!.trae/mcp.json`) or an over-broad match would second-guess the user. */
function gitignoreCovers(lines: string[]): boolean {
  return lines.some((l) => {
    const t = l.trim();
    return t.includes(".trae");
  });
}

/** Append the one ignore line when a .gitignore exists without it. Best-effort by the caller. */
function ensureGitignored(repo: string): void {
  const gitignore = join(repo, ".gitignore");
  if (!existsSync(gitignore)) return; // no .gitignore: not ours to create
  const current = readFileSync(gitignore, "utf8");
  if (gitignoreCovers(current.split("\n"))) return;
  const addition =
    (current.endsWith("\n") || current === "" ? "" : "\n") +
    "# hindsight MCP registration (machine-specific)\n.trae/mcp.json\n";
  writeFileSync(gitignore, current + addition);
}

/**
 * Ensure `<repo>/.trae/mcp.json` registers the hindsight MCP server for THIS repo. Never throws,
 * never rewrites anything but our own entry, and does nothing when already correct.
 */
export function ensureTraecodeWorkspaceMcp(
  cwd: string,
  opts: { home?: string; dist?: string } = {}
): void {
  try {
    const home = opts.home ?? homedir();
    // Trae launched the USER-level server from home — that is exactly the registration we are
    // repairing; writing a workspace file into $HOME would create a pseudo-workspace there.
    if (!cwd || !isAbsolute(cwd) || dirname(cwd) === cwd || cwd === home) return;
    const dist = opts.dist ?? bundledDistDir();
    const script = join(dist, "mcp-server.js");
    if (!existsSync(script)) return; // a dev tree before any build: no registration to point at
    const file = join(cwd, MCP_FILE_REL);

    let doc: Record<string, unknown> = {};
    let exists = false;
    try {
      doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      exists = true;
    } catch {
      if (existsSync(file)) return; // unparseable: leave the user's file untouched, never clobber
    }
    const servers = (
      doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
        ? doc.mcpServers
        : (doc.mcpServers = {})
    ) as Record<string, unknown>;

    const entry = {
      command: "node",
      args: [script],
      env: { HINDSIGHT_MCP_HARNESS: "traecode", HINDSIGHT_MCP_PROJECT_CWD: cwd },
    };
    const existing = servers[MCP_SERVER_NAME];
    let merged: Record<string, unknown>;
    if (existing === undefined) {
      merged = entry;
    } else if (isOurMcpEntry(existing)) {
      // Ours to correct — but keep whatever else the user hung off the entry (extra env, cwd).
      const env = (existing as { env?: Record<string, unknown> }).env;
      merged = {
        ...(existing as Record<string, unknown>),
        command: entry.command,
        args: entry.args,
        env: { ...(env ?? {}), ...entry.env },
      };
    } else {
      diag("traecode", "workspace_mcp_foreign_entry", { cwd, file });
      return; // a foreign "hindsight" server is the user's decision, not ours to overwrite
    }
    if (existing !== undefined && canon(merged) === canon(existing)) return; // already correct — idempotent no-op

    servers[MCP_SERVER_NAME] = merged;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    if (!exists) ensureGitignored(cwd);
    diag("traecode", "workspace_mcp_registered", { cwd, file });
  } catch (e) {
    diag("traecode", "workspace_mcp_register_failed", {
      cwd,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
