/**
 * Minimal stdio MCP client: spawns a server, sends initialize, and calls tools.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let nextId = 1;

export class McpClient {
  constructor(name, command, args, env = {}) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.pending = new Map();
    this.buffer = "";
    this.proc = null;
  }

  async start() {
    this.proc = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      // .cmd/.bat need a shell; plain executables do not
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.command),
    });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s) process.stderr.write(`[${this.name}] ${s}\n`);
    });
    this.proc.on("exit", (c) => {
      for (const { reject } of this.pending.values())
        reject(new Error(`${this.name} exited (code ${c})`));
      this.pending.clear();
    });
    await this._send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "paper-agent", version: "1.0.0" },
    });
    this._notify("notifications/initialized", {});
    return this;
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    }
  }

  _send(method, params) {
    const id = nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(msg);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${this.name} ${method} timed out`));
        }
      }, 60_000);
    });
  }

  _notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(name, args) {
    // auto-restart dead server before calling
    if (!this.proc || this.proc.exitCode !== null) {
      process.stderr.write(`[${this.name}] respawning…\n`);
      await this.start();
    }
    const res = await this._send("tools/call", { name, arguments: args });
    const text = res?.content?.[0]?.text ?? "";
    if (res?.isError) throw new Error(text || `${this.name} tool ${name} failed`);
    return text;
  }

  async stop() { try { this.proc?.kill(); } catch {} }
}

export async function connectAll() {
  const node = process.execPath;
  const isWin = process.platform === "win32";
  const dexpaprika = new McpClient(
    "dexpaprika",
    isWin ? "npx.cmd" : "npx",
    ["-y", "dexpaprika-mcp@latest"]
  );
  const ccxtPath = fileURLToPath(new URL("../ccxt-mcp/server.js", import.meta.url));
  const ccxt = new McpClient("ccxt", node, [ccxtPath]);
  await dexpaprika.start();
  await ccxt.start();
  return { dexpaprika, ccxt };
}
