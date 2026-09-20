import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureTraecodeWorkspaceMcp } from "./traecode-mcp";
import { HOOK_HARNESSES } from "../harness/hook-lifecycle";

describe("ensureTraecodeWorkspaceMcp", () => {
  const dirs: string[] = [];
  const tmp = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A repo dir plus a fake dist carrying an (empty) mcp-server.js. */
  const repo = () => {
    const dir = tmp("traecode-mcp-repo-");
    const dist = tmp("traecode-mcp-dist-");
    writeFileSync(join(dist, "mcp-server.js"), "// stub");
    return { repo: dir, dist };
  };
  const mcpFile = (r: string) => join(r, ".trae", "mcp.json");
  const readJson = (r: string) => JSON.parse(readFileSync(mcpFile(r), "utf8"));

  it("writes the workspace registration when the file is absent", () => {
    const { repo: r, dist } = repo();
    ensureTraecodeWorkspaceMcp(r, { dist });
    const doc = readJson(r);
    expect(doc.mcpServers.hindsight).toEqual({
      command: "node",
      args: [join(dist, "mcp-server.js")],
      env: { HINDSIGHT_MCP_HARNESS: "traecode", HINDSIGHT_MCP_PROJECT_CWD: r },
    });
  });

  it("is idempotent: a second run rewrites nothing", () => {
    const { repo: r, dist } = repo();
    ensureTraecodeWorkspaceMcp(r, { dist });
    const before = readFileSync(mcpFile(r), "utf8");
    ensureTraecodeWorkspaceMcp(r, { dist });
    expect(readFileSync(mcpFile(r), "utf8")).toBe(before);
  });

  it("preserves sibling servers and merges env into an existing OUR entry", () => {
    const { repo: r, dist } = repo();
    mkdirSync(join(r, ".trae"), { recursive: true });
    writeFileSync(
      mcpFile(r),
      JSON.stringify({
        mcpServers: {
          hindsight: {
            command: "node",
            args: ["/old/hindsight-coding-agents/dist/mcp-server.js"],
            env: { HINDSIGHT_MCP_HARNESS: "traecode", MY_EXTRA: "keep" },
          },
          other: { command: "uvx", args: ["something"] },
        },
      })
    );
    ensureTraecodeWorkspaceMcp(r, { dist });
    const doc = readJson(r);
    expect(doc.mcpServers.other).toEqual({ command: "uvx", args: ["something"] });
    expect(doc.mcpServers.hindsight).toEqual({
      command: "node",
      args: [join(dist, "mcp-server.js")],
      env: {
        HINDSIGHT_MCP_HARNESS: "traecode",
        HINDSIGHT_MCP_PROJECT_CWD: r,
        MY_EXTRA: "keep",
      },
    });
  });

  it("never touches a foreign hindsight entry", () => {
    const { repo: r, dist } = repo();
    mkdirSync(join(r, ".trae"), { recursive: true });
    const foreign = { command: "python", args: ["-m", "my_hindsight"] };
    writeFileSync(mcpFile(r), JSON.stringify({ mcpServers: { hindsight: foreign } }));
    ensureTraecodeWorkspaceMcp(r, { dist });
    expect(readJson(r).mcpServers.hindsight).toEqual(foreign);
  });

  it("leaves an unparseable file alone", () => {
    const { repo: r, dist } = repo();
    mkdirSync(join(r, ".trae"), { recursive: true });
    writeFileSync(mcpFile(r), "{ not json");
    ensureTraecodeWorkspaceMcp(r, { dist });
    expect(readFileSync(mcpFile(r), "utf8")).toBe("{ not json");
  });

  describe("gitignore", () => {
    it("appends the ignore line to an existing .gitignore when creating the file", () => {
      const { repo: r, dist } = repo();
      writeFileSync(join(r, ".gitignore"), "node_modules\n");
      ensureTraecodeWorkspaceMcp(r, { dist });
      const gitignore = readFileSync(join(r, ".gitignore"), "utf8");
      expect(gitignore).toContain("node_modules\n");
      expect(gitignore).toContain(".trae/mcp.json");
    });

    it("creates no .gitignore when the repo has none", () => {
      const { repo: r, dist } = repo();
      ensureTraecodeWorkspaceMcp(r, { dist });
      expect(existsSync(join(r, ".gitignore"))).toBe(false);
    });

    it("does not append when .trae is already ignored", () => {
      const { repo: r, dist } = repo();
      writeFileSync(join(r, ".gitignore"), "node_modules\n.trae/\n");
      ensureTraecodeWorkspaceMcp(r, { dist });
      expect(readFileSync(join(r, ".gitignore"), "utf8")).toBe("node_modules\n.trae/\n");
    });
  });

  it("does nothing for home, root, or relative cwd", () => {
    const { repo: r, dist } = repo();
    ensureTraecodeWorkspaceMcp(homedir(), { dist });
    ensureTraecodeWorkspaceMcp("/", { dist });
    ensureTraecodeWorkspaceMcp("relative/path", { dist });
    expect(existsSync(join(homedir(), ".trae", "mcp.json"))).toBe(false);
    expect(existsSync(join(r, ".trae"))).toBe(false);
  });

  it("does nothing when the dist has no mcp-server.js (unbuilt tree)", () => {
    const { repo: r } = repo();
    const empty = tmp("traecode-mcp-empty-");
    ensureTraecodeWorkspaceMcp(r, { dist: empty });
    expect(existsSync(mcpFile(r))).toBe(false);
  });
});

/** The traecode SessionStart spec must carry the registration step; no other harness may. */
describe("traecode sessionStart spec wiring", () => {
  it("wires ensureMcpRegistration for traecode only", () => {
    const wired = Object.entries(HOOK_HARNESSES)
      .filter(([, spec]) => spec.sessionStart.ensureMcpRegistration !== undefined)
      .map(([name]) => name);
    expect(wired).toEqual(["traecode"]);
  });
});
