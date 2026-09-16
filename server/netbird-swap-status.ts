import { NodeSSH } from "node-ssh";
import { getAllVps, getVpsById, agentGet } from "./vps-manager";

export interface NetbirdSwapStatus {
  id: string;
  name: string;
  installed: boolean;
  state: "primary" | "backup" | null;
  timerActive: boolean;
  backupDaemonActive: boolean;
  lastEvent: string | null;
  online: boolean;
  error?: string;
}

const SWAP_CHECK_CMD =
  "cat /var/lib/netbird-swap/state 2>/dev/null; echo ---; " +
  "systemctl is-active netbird-swap.timer 2>/dev/null; echo ---; " +
  "systemctl is-active netbird-backup 2>/dev/null; echo ---; " +
  "journalctl -t netbird-swap --no-pager -n 1 -o cat 2>/dev/null";

function parseSwapOutput(stdout: string): Omit<NetbirdSwapStatus, "id" | "name" | "online" | "error"> {
  const [state, timer, backup, lastEvent] = stdout.split("---").map((s) => s.trim());
  const installed = state.length > 0;
  return {
    installed,
    state: installed ? (state as "primary" | "backup") : null,
    timerActive: timer === "active",
    backupDaemonActive: backup === "active",
    lastEvent: lastEvent || null,
  };
}

// main e dynapannel non hanno l'agent ProxyGuardian (non fanno parte della
// flotta gestita) - controllati via SSH diretto con le stesse credenziali
// usate manualmente per l'installazione del failover NetBird.
interface ExtraHost { id: string; name: string; host: string; username: string; password: string; }

function getExtraHosts(): ExtraHost[] {
  const hosts: ExtraHost[] = [];
  // Riusa MAIN_HOST/MAIN_SSH_PASS, gia' configurate per la feature Main
  // Backend (server/routes.ts) - stesso .env, evita variabili duplicate.
  // MAIN_HOST e' l'IP pubblico (80.244.4.35): usarlo qui invece dell'IP
  // NetBird evita un problema uovo-e-gallina se il controllo gira proprio
  // durante un blackout NetBird (l'IP mesh sarebbe irraggiungibile).
  if (process.env.MAIN_HOST && process.env.MAIN_SSH_PASS) {
    hosts.push({
      id: "main",
      name: "main",
      host: process.env.MAIN_HOST,
      username: "root",
      password: process.env.MAIN_SSH_PASS,
    });
  }
  if (process.env.DYNAPANNEL_SSH_HOST && process.env.DYNAPANNEL_SSH_PASSWORD) {
    hosts.push({
      id: "dynapannel",
      name: "dynapannel",
      host: process.env.DYNAPANNEL_SSH_HOST,
      username: "root",
      password: process.env.DYNAPANNEL_SSH_PASSWORD,
    });
  }
  return hosts;
}

async function getFleetSwapStatus(): Promise<NetbirdSwapStatus[]> {
  // getAllVps() restituisce apiKey redatta ("***") per sicurezza - serve
  // ririprendere il config completo per-id per avere la chiave vera
  // (stesso pattern di /api/fleet/netbird/update-status poco sopra).
  const vpsList = getAllVps().filter((v) => v.enabled).map((s) => getVpsById(s.id)).filter((v): v is NonNullable<typeof v> => v !== undefined);
  const results = await Promise.allSettled(
    vpsList.map(async (vps): Promise<NetbirdSwapStatus> => {
      try {
        const data = await agentGet(vps, "/api/netbird-swap/status");
        return { id: vps.id, name: vps.name, online: true, ...data };
      } catch (err: any) {
        return {
          id: vps.id,
          name: vps.name,
          installed: false,
          state: null,
          timerActive: false,
          backupDaemonActive: false,
          lastEvent: null,
          online: false,
          error: err.message,
        };
      }
    })
  );
  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { id: "?", name: "?", installed: false, state: null, timerActive: false, backupDaemonActive: false, lastEvent: null, online: false, error: "unknown" }
  );
}

async function getExtraHostsSwapStatus(): Promise<NetbirdSwapStatus[]> {
  const hosts = getExtraHosts();
  const results = await Promise.allSettled(
    hosts.map(async (h): Promise<NetbirdSwapStatus> => {
      const ssh = new NodeSSH();
      try {
        await ssh.connect({ host: h.host, port: 22, username: h.username, password: h.password, readyTimeout: 10_000 });
        const result = await ssh.execCommand(SWAP_CHECK_CMD);
        ssh.dispose();
        return { id: h.id, name: h.name, online: true, ...parseSwapOutput(result.stdout) };
      } catch (err: any) {
        ssh.dispose();
        return {
          id: h.id,
          name: h.name,
          installed: false,
          state: null,
          timerActive: false,
          backupDaemonActive: false,
          lastEvent: null,
          online: false,
          error: err.message,
        };
      }
    })
  );
  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { id: "?", name: "?", installed: false, state: null, timerActive: false, backupDaemonActive: false, lastEvent: null, online: false, error: "unknown" }
  );
}

export async function getAllNetbirdSwapStatus(): Promise<NetbirdSwapStatus[]> {
  const [fleet, extra] = await Promise.all([getFleetSwapStatus(), getExtraHostsSwapStatus()]);
  return [...extra, ...fleet];
}
