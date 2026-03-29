import { NodeSSH } from "node-ssh";
import { existsSync, mkdirSync, createWriteStream } from "fs";
import { join } from "path";
import * as http from "http";
import * as crypto from "crypto";
import * as os from "os";
import type { Response } from "express";
import { getAllVps } from "./vps-manager";

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const UPGRADE_SCRIPT_PATH =
  process.env.UPGRADE_SCRIPT_PATH ?? join(os.homedir(), "proxy_upgrade.sh");
const NGINX_TAR_PATH =
  process.env.NGINX_TAR_PATH ?? join(DATA_DIR, "nginx-1.26.2.tar.gz");
const SSH_KEY_PATH = join(os.homedir(), ".ssh", "id_ed25519");
const NGINX_VERSION = "1.26.2";
const NGINX_URL = `http://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz`;
const BATCH_SIZE = 20;
const MAX_LOG_LINES = 3000;

export interface VpsUpgradeJob {
  vpsId: string;
  vpsName: string;
  vpsHost: string;
  status: "pending" | "running" | "success" | "failed";
  logs: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface UpgradeJob {
  id: string;
  createdAt: string;
  status: "running" | "done";
  vpsJobs: Map<string, VpsUpgradeJob>;
  successCount: number;
  failCount: number;
}

const jobs = new Map<string, UpgradeJob>();
const sseClients = new Map<string, Set<Response>>();

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function emit(jobId: string, event: string, data: unknown) {
  const clients = sseClients.get(jobId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /**/ }
  }
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
}

// ─── nginx tar.gz cache ───────────────────────────────────────────────────────

function ensureNginxTar(): Promise<void> {
  if (existsSync(NGINX_TAR_PATH)) return Promise.resolve();
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const file = createWriteStream(NGINX_TAR_PATH);
    http
      .get(NGINX_URL, (res) => {
        if (res.statusCode !== 200) {
          file.destroy();
          reject(new Error(`Download nginx fallito: HTTP ${res.statusCode}. Copia manualmente nginx-${NGINX_VERSION}.tar.gz in data/`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", (e) => { file.destroy(); reject(e); });
      })
      .on("error", (e) => { file.destroy(); reject(e); });
  });
}

// ─── Upgrade singolo VPS ──────────────────────────────────────────────────────

async function upgradeVps(job: UpgradeJob, vpsJob: VpsUpgradeJob): Promise<void> {
  const { vpsId } = vpsJob;
  vpsJob.status = "running";
  vpsJob.startedAt = new Date().toISOString();
  emit(job.id, "vps-start", { vpsId, vpsName: vpsJob.vpsName });

  const addLog = (line: string) => {
    const clean = stripAnsi(line.trim());
    if (!clean) return;
    if (vpsJob.logs.length < MAX_LOG_LINES) vpsJob.logs.push(clean);
    emit(job.id, "vps-log", { vpsId, line: clean });
  };

  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vpsJob.vpsHost,
      port: 22,
      username: "root",
      privateKeyPath: SSH_KEY_PATH,
      readyTimeout: 30_000,
    });

    addLog("[dashboard] Connesso via SSH. Caricamento file...");
    await ssh.putFile(UPGRADE_SCRIPT_PATH, "/tmp/proxy_upgrade.sh");
    await ssh.putFile(NGINX_TAR_PATH, "/usr/local/src/nginx-1.26.2.tar.gz");
    addLog("[dashboard] File caricati. Avvio upgrade...");

    const result = await ssh.execCommand("bash /tmp/proxy_upgrade.sh", {
      onStdout: (chunk: Buffer) =>
        chunk.toString().split("\n").forEach(addLog),
      onStderr: (chunk: Buffer) =>
        chunk.toString().split("\n").forEach(addLog),
    });

    if (result.code === 0) {
      vpsJob.status = "success";
      job.successCount++;
      emit(job.id, "vps-done", { vpsId, success: true });
    } else {
      throw new Error(`Script terminato con exit code ${result.code ?? "null"}`);
    }
  } catch (err: any) {
    vpsJob.status = "failed";
    vpsJob.error = err.message;
    job.failCount++;
    addLog(`[dashboard] ERRORE: ${err.message}`);
    emit(job.id, "vps-done", { vpsId, success: false, error: err.message });
  } finally {
    vpsJob.finishedAt = new Date().toISOString();
    ssh.dispose();
  }
}

// ─── Avvio job ────────────────────────────────────────────────────────────────

export async function startUpgradeJob(vpsIds: string[] | "all"): Promise<string> {
  if (!existsSync(UPGRADE_SCRIPT_PATH))
    throw new Error(`Script non trovato: ${UPGRADE_SCRIPT_PATH}. Imposta UPGRADE_SCRIPT_PATH in .env`);
  if (!existsSync(SSH_KEY_PATH))
    throw new Error(`Chiave SSH non trovata: ${SSH_KEY_PATH}`);

  const allVps = getAllVps().filter((v) => v.enabled);
  const selected =
    vpsIds === "all" ? allVps : allVps.filter((v) => vpsIds.includes(v.id));
  if (selected.length === 0) throw new Error("Nessun VPS selezionato o abilitato");

  const jobId = crypto.randomUUID();
  const job: UpgradeJob = {
    id: jobId,
    createdAt: new Date().toISOString(),
    status: "running",
    vpsJobs: new Map(),
    successCount: 0,
    failCount: 0,
  };

  for (const vps of selected) {
    job.vpsJobs.set(vps.id, {
      vpsId: vps.id,
      vpsName: vps.name,
      vpsHost: vps.host,
      status: "pending",
      logs: [],
    });
  }

  jobs.set(jobId, job);
  sseClients.set(jobId, new Set());

  // Background execution
  (async () => {
    try {
      await ensureNginxTar();
    } catch (err: any) {
      for (const [vpsId, vpsJob] of job.vpsJobs) {
        vpsJob.status = "failed";
        vpsJob.error = `nginx.tar.gz non disponibile: ${err.message}`;
        job.failCount++;
        emit(jobId, "vps-done", { vpsId, success: false, error: vpsJob.error });
      }
      job.status = "done";
      emit(jobId, "job-done", { successCount: 0, failCount: job.vpsJobs.size });
      closeJobClients(jobId);
      return;
    }

    const vpsArray = Array.from(job.vpsJobs.values());
    for (let i = 0; i < vpsArray.length; i += BATCH_SIZE) {
      const batch = vpsArray.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map((v) => upgradeVps(job, v)));
    }

    job.status = "done";
    emit(jobId, "job-done", {
      successCount: job.successCount,
      failCount: job.failCount,
    });
    closeJobClients(jobId);
  })().catch((err) => {
    // Errore imprevisto nel background job — marca tutto come fallito
    job.status = "done";
    for (const vpsJob of job.vpsJobs.values()) {
      if (vpsJob.status === "pending" || vpsJob.status === "running") {
        vpsJob.status = "failed";
        vpsJob.error = `Errore interno: ${err?.message ?? err}`;
        job.failCount++;
      }
    }
    emit(jobId, "job-done", { successCount: job.successCount, failCount: job.failCount });
    closeJobClients(jobId);
  });

  return jobId;
}

function closeJobClients(jobId: string) {
  const clients = sseClients.get(jobId);
  if (clients) {
    for (const res of clients) {
      try { res.end(); } catch { /**/ }
    }
    sseClients.delete(jobId);
  }
}

// ─── SSE subscription ─────────────────────────────────────────────────────────

export function subscribeToJob(jobId: string, res: Response): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Replay history
  for (const vpsJob of job.vpsJobs.values()) {
    if (vpsJob.status === "pending") continue;
    res.write(`event: vps-start\ndata: ${JSON.stringify({ vpsId: vpsJob.vpsId, vpsName: vpsJob.vpsName })}\n\n`);
    for (const line of vpsJob.logs) {
      res.write(`event: vps-log\ndata: ${JSON.stringify({ vpsId: vpsJob.vpsId, line })}\n\n`);
    }
    if (vpsJob.status === "success" || vpsJob.status === "failed") {
      res.write(`event: vps-done\ndata: ${JSON.stringify({ vpsId: vpsJob.vpsId, success: vpsJob.status === "success", error: vpsJob.error })}\n\n`);
    }
  }

  if (job.status === "done") {
    res.write(`event: job-done\ndata: ${JSON.stringify({ successCount: job.successCount, failCount: job.failCount })}\n\n`);
    res.end();
    return true;
  }

  // Register for future events
  const clients = sseClients.get(jobId)!;
  clients.add(res);
  res.on("close", () => clients.delete(res));
  return true;
}

// ─── Status snapshot ──────────────────────────────────────────────────────────

export function getJobSnapshot(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    id: job.id,
    createdAt: job.createdAt,
    status: job.status,
    successCount: job.successCount,
    failCount: job.failCount,
    total: job.vpsJobs.size,
    vpsJobs: Array.from(job.vpsJobs.values()).map((j) => ({
      vpsId: j.vpsId,
      vpsName: j.vpsName,
      vpsHost: j.vpsHost,
      status: j.status,
      error: j.error,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      logCount: j.logs.length,
    })),
  };
}

export function getJobLogs(jobId: string, vpsId: string): string[] | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  return job.vpsJobs.get(vpsId)?.logs ?? null;
}

export function getActiveJob(): { id: string; status: "running" | "done" } | null {
  let latest: UpgradeJob | null = null;
  for (const job of jobs.values()) {
    if (!latest || job.createdAt > latest.createdAt) latest = job;
  }
  if (!latest) return null;
  return { id: latest.id, status: latest.status };
}
