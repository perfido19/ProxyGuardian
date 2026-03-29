import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { apiRequest } from "@/lib/queryClient";

export type VpsStatus = "pending" | "running" | "success" | "failed";

export interface VpsState {
  vpsId: string;
  vpsName: string;
  vpsHost: string;
  status: VpsStatus;
  logs: string[];
  error?: string;
}

export type UpgradePageState = "idle" | "running" | "done";

interface UpgradeContextValue {
  pageState: UpgradePageState;
  jobId: string | null;
  vpsStates: Map<string, VpsState>;
  error: string | null;
  startUpgrade: (vpsIds: string[]) => Promise<void>;
  reset: () => void;
  removeVps: (vpsId: string) => void;
}

const UpgradeContext = createContext<UpgradeContextValue | null>(null);

export function useUpgrade() {
  const ctx = useContext(UpgradeContext);
  if (!ctx) throw new Error("useUpgrade must be used inside UpgradeProvider");
  return ctx;
}

export function UpgradeProvider({ children }: { children: ReactNode }) {
  const [pageState, setPageState] = useState<UpgradePageState>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [vpsStates, setVpsStates] = useState<Map<string, VpsState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const updateVps = useCallback((vpsId: string, patch: Partial<VpsState>) => {
    setVpsStates(prev => {
      const next = new Map(prev);
      const cur = next.get(vpsId);
      if (cur) next.set(vpsId, { ...cur, ...patch });
      return next;
    });
  }, []);

  const appendLog = useCallback((vpsId: string, line: string) => {
    setVpsStates(prev => {
      const next = new Map(prev);
      const cur = next.get(vpsId);
      if (cur) next.set(vpsId, { ...cur, logs: [...cur.logs, line] });
      return next;
    });
  }, []);

  const connectSse = useCallback((id: string) => {
    esRef.current?.close();
    const es = new EventSource(`/api/fleet/upgrade/${id}/events`);
    esRef.current = es;

    es.addEventListener("vps-start", (e) => {
      const { vpsId, vpsName } = JSON.parse(e.data);
      setVpsStates(prev => {
        const next = new Map(prev);
        const existing = next.get(vpsId);
        next.set(vpsId, {
          vpsId,
          vpsName,
          vpsHost: existing?.vpsHost ?? "",
          status: "running",
          logs: [],
          error: undefined,
        });
        return next;
      });
    });

    es.addEventListener("vps-log", (e) => {
      const { vpsId, line } = JSON.parse(e.data);
      appendLog(vpsId, line);
    });

    es.addEventListener("vps-done", (e) => {
      const { vpsId, success, error: err } = JSON.parse(e.data);
      updateVps(vpsId, { status: success ? "success" : "failed", error: err });
    });

    es.addEventListener("job-done", () => {
      es.close();
      esRef.current = null;
      setPageState("done");
    });

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setPageState(s => (s === "running" ? "done" : s));
    };
  }, [appendLog, updateVps]);

  // Al mount: controlla job attivo e riconnettiti
  useEffect(() => {
    (async () => {
      try {
        const activeRes = await fetch("/api/fleet/upgrade/active");
        if (!activeRes.ok) return;
        const { jobId: activeId, status: activeStatus } = await activeRes.json();
        if (!activeId) return;

        const snapRes = await fetch(`/api/fleet/upgrade/${activeId}/status`);
        if (!snapRes.ok) return;
        const snap = await snapRes.json();

        const initStates = new Map<string, VpsState>();
        for (const vj of snap.vpsJobs) {
          initStates.set(vj.vpsId, {
            vpsId: vj.vpsId, vpsName: vj.vpsName, vpsHost: vj.vpsHost,
            status: vj.status, logs: [], error: vj.error,
          });
        }
        setVpsStates(initStates);
        setJobId(activeId);
        setPageState(activeStatus === "running" ? "running" : "done");
        // Riconnetti SSE solo se il job è ancora in corso
        if (activeStatus === "running") connectSse(activeId);
      } catch { /* nessun job attivo */ }
    })();
    return () => { esRef.current?.close(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startUpgrade = useCallback(async (vpsIds: string[]) => {
    setError(null);
    setPageState("running");
    setVpsStates(new Map());
    try {
      const res = await apiRequest("POST", "/api/fleet/upgrade/start", { vpsIds });
      const { jobId: id } = await res.json();
      setJobId(id);
      connectSse(id);
    } catch (e: any) {
      setError(e.message);
      setPageState("idle");
    }
  }, [connectSse]);

  const removeVps = useCallback((vpsId: string) => {
    setVpsStates(prev => {
      const next = new Map(prev);
      next.delete(vpsId);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setPageState("idle");
    setJobId(null);
    setVpsStates(new Map());
    setError(null);
  }, []);

  return (
    <UpgradeContext.Provider value={{ pageState, jobId, vpsStates, error, startUpgrade, reset, removeVps }}>
      {children}
    </UpgradeContext.Provider>
  );
}
