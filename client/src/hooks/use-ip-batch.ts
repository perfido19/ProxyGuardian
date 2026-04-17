import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

/**
 * Pre-popola la cache React Query ["ip-info", ip] per una lista di IP
 * con una singola chiamata batch al server, evitando N richieste parallele.
 * Debounced 200ms per gestire liste che arrivano in streaming.
 */
export function useIpBatch(ips: string[]) {
  const client = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submittedRef = useRef(new Set<string>());
  const normalizedIps = [...new Set(ips.filter(Boolean))].sort();
  const batchKey = normalizedIps.join(",");

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const missing = normalizedIps.filter(
        ip => ip && !submittedRef.current.has(ip)
      );
      if (missing.length === 0) return;
      missing.forEach(ip => submittedRef.current.add(ip));

      const chunks: string[][] = [];
      for (let i = 0; i < missing.length; i += 100) {
        chunks.push(missing.slice(i, i + 100));
      }

      Promise.all(chunks.map(chunk =>
        apiRequest("POST", "/api/ip-info/batch", { ips: chunk })
          .then(r => r.json())
          .then((data: Record<string, { asn: string; org: string; countryCode: string }>) => {
            for (const [ip, info] of Object.entries(data)) {
              client.setQueryData(["ip-info", ip], info);
            }
          })
      )).catch(() => {});
    }, 200);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [batchKey]);
}
