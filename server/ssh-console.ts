import { WebSocketServer, WebSocket } from "ws";
import { NodeSSH } from "node-ssh";
import { join } from "path";
import { homedir } from "os";
import * as crypto from "crypto";
import type { Server } from "http";
import { getVpsById } from "./vps-manager";

const SSH_KEY_PATH = join(homedir(), ".ssh", "id_ed25519");

// Token usa-e-getta con TTL 30s per autenticare le WS dall'utente admin
interface SshToken { vpsId: string; userId: string; expiresAt: number; }
const tokens = new Map<string, SshToken>();

export function generateSshToken(vpsId: string, userId: string): string {
  const token = crypto.randomUUID();
  tokens.set(token, { vpsId, userId, expiresAt: Date.now() + 30_000 });
  setTimeout(() => tokens.delete(token), 30_000);
  return token;
}

export function attachSshWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/api/admin/ssh/ws")) return;
    wss.handleUpgrade(req, socket as any, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", async (ws: WebSocket, req: any) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) { ws.close(4001, "Token mancante"); return; }
    const tokenData = tokens.get(token);
    if (!tokenData || Date.now() > tokenData.expiresAt) {
      tokens.delete(token);
      ws.close(4001, "Token non valido o scaduto");
      return;
    }
    tokens.delete(token); // usa-e-getta

    const vps = getVpsById(tokenData.vpsId);
    if (!vps) { ws.close(4004, "VPS non trovato"); return; }

    const send = (type: string, data: string) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type, data }));
    };

    send("status", `Connessione SSH a ${vps.name} (${vps.host})...\r\n`);

    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: vps.host,
        port: 22,
        username: "root",
        privateKeyPath: SSH_KEY_PATH,
        readyTimeout: 15_000,
      });
    } catch (err: any) {
      send("error", `\r\nErrore connessione SSH: ${err.message}\r\n`);
      ws.close();
      return;
    }

    send("status", `Connesso. Apertura shell...\r\n`);

    let cols = 120, rows = 30;
    // Leggi cols/rows dall'URL se presenti
    const qCols = parseInt(url.searchParams.get("cols") ?? "120");
    const qRows = parseInt(url.searchParams.get("rows") ?? "30");
    if (!isNaN(qCols)) cols = qCols;
    if (!isNaN(qRows)) rows = qRows;

    // Accedi alla connessione ssh2 sottostante per aprire la shell
    const conn = (ssh as any).connection;
    conn.shell({ term: "xterm-256color", cols, rows }, (err: any, stream: any) => {
      if (err) {
        send("error", `\r\nErrore apertura shell: ${err.message}\r\n`);
        ws.close();
        ssh.dispose();
        return;
      }

      send("ready", "");

      stream.on("data", (chunk: Buffer) => send("stdout", chunk.toString("binary")));
      stream.stderr.on("data", (chunk: Buffer) => send("stdout", chunk.toString("binary")));

      stream.on("close", () => {
        send("status", "\r\n[Sessione SSH terminata]\r\n");
        ws.close();
        ssh.dispose();
      });

      ws.on("message", (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "stdin") stream.write(msg.data);
          else if (msg.type === "resize") stream.setWindow(msg.rows, msg.cols, 0, 0);
        } catch { /* ignora messaggi malformati */ }
      });

      ws.on("close", () => {
        stream.end();
        ssh.dispose();
      });
    });
  });
}
