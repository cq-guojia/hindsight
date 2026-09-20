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

// ── the workspace-MCP gate (trae.mcp.enableWorkspaceMcp) ─────────────────────────────────────
//
// Trae only reads per-repo `.trae/mcp.json` when this global setting is on — otherwise every
// registration above is dead weight and the MCP tools stay invisible. Both the installer (which
// asks and writes) and the SessionStart hook (which hints) need the same detection, so it lives
// here: the registration and its gate are one concern.

const WORKSPACE_MCP_KEY = "trae.mcp.enableWorkspaceMcp";
const HINT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The Electron userData dir holding user-level config (`User/mcp.json`, `User/settings.json`),
 *  edition-branded: the CN build uses "Trae CN", the international build "Trae". Probing beats
 *  assuming — both editions coexist on machines that switched. */
export function traecodeUserDataDir(home: string): string {
  const root =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? join(home, "AppData", "Roaming"))
        : (process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
  for (const brand of ["Trae CN", "Trae"]) {
    const dir = join(root, brand);
    if (existsSync(dir)) return dir;
  }
  return join(root, "Trae CN");
}

export const traecodeUserSettingsPath = (home: string): string =>
  join(traecodeUserDataDir(home), "User", "settings.json");

/** Where the hint rate-limit and the installer's "I enabled it" snapshot live — inside the staged
 *  runtime, mirroring auto-update's state precedent (a runtime replace resets them, which at worst
 *  costs one extra hint). Reads and writes here are sandbox-approved via the install-time rule. */
function gateStateFile(): string {
  return join(dirname(bundledDistDir()), ".workspace-mcp.json");
}

type GateState = { workspaceMcpEnabled?: boolean; lastHint?: number };
type GateStateOpts = { stateFile?: string };

function readGateState(opts: GateStateOpts = {}): GateState {
  try {
    return JSON.parse(readFileSync(opts.stateFile ?? gateStateFile(), "utf8"));
  } catch {
    return {};
  }
}

/** "on" / "off" / "unknown" for the workspace-MCP gate. Plain JSON decides; a comment-bearing
 *  (JSONC) settings file falls back to a targeted regex, and if even that finds nothing the
 *  answer is "unknown" — the caller decides whether that still warrants a hint. */
export function workspaceMcpGateState(settingsPath: string): "on" | "off" | "unknown" {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch {
    return "unknown"; // absent file or a sandbox that denies the read
  }
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    return doc[WORKSPACE_MCP_KEY] === true ? "on" : "off";
  } catch {
    // JSONC: one boolean survives a comment-aware parser's absence — a regex over the raw text.
    const hit = raw.match(new RegExp(`"${WORKSPACE_MCP_KEY}"\\s*:\\s*(true|false)`));
    return hit ? (hit[1] === "true" ? "on" : "off") : "unknown";
  }
}

/** Turn the gate on in the user's settings.json. Plain JSON is edited in place (key order kept);
 *  a JSONC file is left untouched — silently mangling comments is worse than printing the manual
 *  step. Returns false when the caller should print instructions instead. */
export function enableWorkspaceMcpSetting(settingsPath: string): boolean {
  try {
    let doc: Record<string, unknown> = {};
    try {
      doc = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      if (existsSync(settingsPath)) return false; // JSONC or corrupt: not ours to rewrite
    }
    doc[WORKSPACE_MCP_KEY] = true;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(doc, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Record that the installer turned the gate on — the fallback witness for hook sandboxes that
 *  cannot read the settings file. Never throws. */
export function markWorkspaceMcpEnabled(opts: GateStateOpts = {}): void {
  try {
    writeFileSync(
      opts.stateFile ?? gateStateFile(),
      JSON.stringify({ ...readGateState(opts), workspaceMcpEnabled: true }, null, 2) + "\n"
    );
  } catch {
    /* best-effort: the settings file itself is the primary source of truth */
  }
}

/** The user-facing banner hint (English, like every installer/session message), shown at most
 *  once a day until the gate reads on. undefined = nothing to say. Never throws. */
export function workspaceMcpHint(
  opts: { home?: string; now?: number; stateFile?: string } = {}
): string | undefined {
  try {
    const settingsPath = traecodeUserSettingsPath(opts.home ?? homedir());
    if (workspaceMcpGateState(settingsPath) === "on") return undefined;
    const now = opts.now ?? Date.now();
    const state = readGateState(opts);
    if (state.workspaceMcpEnabled) return undefined; // installer turned it on; settings just unreadable here
    if (typeof state.lastHint === "number" && now - state.lastHint < HINT_MIN_INTERVAL_MS) {
      return undefined;
    }
    writeFileSync(
      opts.stateFile ?? gateStateFile(),
      JSON.stringify({ ...state, lastHint: now }, null, 2) + "\n"
    );
    return (
      "Hindsight MCP tools are hidden: TraeCode does not read per-repo MCP configs until " +
      'workspace MCP is enabled. Turn it on once in Trae settings (search "enableWorkspaceMcp") ' +
      "or re-run `hindsight-coding-agents install traecode` — then reload this window."
    );
  } catch {
    return undefined; // a hint must never break the session it rides
  }
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

/** Ensure `<repo>/.trae/mcp.json` registers the hindsight MCP server for THIS repo, then report
 *  the workspace-MCP gate: the registration only matters once `trae.mcp.enableWorkspaceMcp` is
 *  on, so the returned hint (or undefined) rides the session banner. Never throws. */
export function ensureTraecodeWorkspaceMcp(
  cwd: string,
  opts: { home?: string; dist?: string } = {}
): string | undefined {
  registerTraecodeWorkspaceMcp(cwd, opts);
  return workspaceMcpHint(opts);
}

/** The registration itself — merge-not-clobber, foreign entries untouched, idempotent. Never
 *  throws, never rewrites anything but our own entry, and does nothing when already correct. */
function registerTraecodeWorkspaceMcp(cwd: string, opts: { home?: string; dist?: string } = {}): void {
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
