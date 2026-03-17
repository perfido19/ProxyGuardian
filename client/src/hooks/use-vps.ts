import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";

export interface VpsConfig {
  id: string; name: string; host: string; port: number;
  apiKey: "***"; enabled: boolean; tags: string[];
  createdAt: string; lastSeen?: string;
  lastStatus?: "online" | "offline" | "unknown";
}

export interface BulkResult {
  vpsId: string; vpsName: string; success: boolean; data?: any; error?: string;
}

export function useVpsList() {
  return useQuery<VpsConfig[]>({ queryKey: ["/api/vps"], refetchInterval: 30000 });
}

export function useVpsHealth() {
  return useQuery<Record<string, boolean>>({ queryKey: ["/api/vps/health/all"], refetchInterval: 15000 });
}

export function useCreateVps() {
  return useMutation({
    mutationFn: async (data: { name: string; host: string; port?: number; apiKey: string; tags?: string[] }) => {
      const res = await apiRequest("POST", "/api/vps", data);
      return res.json() as Promise<VpsConfig>;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/vps"] }),
  });
}

export function useUpdateVps() {
  return useMutation({
    mutationFn: async ({ id, ...data }: any) => {
      const res = await apiRequest("PUT", `/api/vps/${id}`, data);
      return res.json() as Promise<VpsConfig>;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/vps"] }),
  });
}

export function useDeleteVps() {
  return useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/vps/${id}`, {}); },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/vps"] }),
  });
}

export function useBulkOperation() {
  return useMutation({
    mutationFn: async ({ vpsIds, path, body }: { vpsIds: string[] | "all"; path: string; body?: any }) => {
      const res = await apiRequest("POST", "/api/vps/bulk/post", { vpsIds, path, body });
      return res.json() as Promise<BulkResult[]>;
    },
  });
}
