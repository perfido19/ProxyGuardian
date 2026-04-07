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

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const missing = [...new Set(ips)].filter(
        ip => ip && !submittedRef.current.has(ip)
      );
      if (missing.length === 0) return;
      missing.forEach(ip => submittedRef.current.add(ip));

      apiRequest("POST", "/api/ip-info/batch", { ips: missing })
        .then(r => r.json())
        .then((data: Record<string, { asn: string; org: string; countryCode: string }>) => {
          for (const [ip, info] of Object.entries(data)) {
            client.setQueryData(["ip-info", ip], info);
          }
        })
        .catch(() => {});
    }, 200);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [ips.length]); // si riesegue quando la lista cresce (es. streaming)
}
