import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { ExternalLink } from "lucide-react";

interface IpInfo {
  asn: string;
  org: string;
  countryCode: string;
}

interface IpCellProps {
  ip: string;
  /** Mostra ASN e link sulla stessa riga invece che su due righe */
  compact?: boolean;
  className?: string;
  /** Usa solo dati gia' in cache, senza lanciare una richiesta singola */
  deferFetch?: boolean;
}

export function IpCell({ ip, compact = false, className, deferFetch = false }: IpCellProps) {
  const { data, isError } = useQuery<IpInfo>({
    queryKey: ["ip-info", ip],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/ip-info/${ip}`);
      return r.json();
    },
    staleTime: 24 * 60 * 60 * 1000,
    retry: false,
    enabled: !!ip && !deferFetch,
    throwOnError: false,
  });

  const link = (
    <a
      href={`https://ipinfo.io/${ip}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono hover:underline hover:text-primary inline-flex items-center gap-1 group"
      onClick={e => e.stopPropagation()}
    >
      {ip}
      <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity" />
    </a>
  );

  const asnBadge = !isError && data?.asn ? (
    <span className="text-muted-foreground font-mono" style={{ fontSize: 11 }}>
      {data.asn}{data.org ? ` · ${data.org}` : ""}
    </span>
  ) : !isError && data?.org ? (
    <span className="text-muted-foreground font-mono" style={{ fontSize: 11 }}>
      {data.org}
    </span>
  ) : null;

  if (compact) {
    return (
      <div className={`flex items-center gap-2 ${className ?? ""}`}>
        {link}
        {asnBadge}
      </div>
    );
  }

  return (
    <div className={className}>
      {link}
      {asnBadge && <div className="mt-0.5">{asnBadge}</div>}
    </div>
  );
}
