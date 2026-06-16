import { z } from "zod";

// Service management
export const serviceSchema = z.object({
  name: z.string(),
  status: z.enum(['running', 'stopped', 'error', 'restarting']),
  uptime: z.string().optional(),
  pid: z.number().optional(),
});

export type Service = z.infer<typeof serviceSchema>;

export const serviceActionSchema = z.object({
  service: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Nome servizio non valido"),
  action: z.enum(['start', 'stop', 'restart', 'reload']),
});

export type ServiceAction = z.infer<typeof serviceActionSchema>;

// Banned IPs
export const bannedIpSchema = z.object({
  ip: z.string(),
  jail: z.string(),
  banTime: z.string(),
  timeLeft: z.string().optional(),
  reason: z.string().optional(),
});

export type BannedIp = z.infer<typeof bannedIpSchema>;

export const unbanRequestSchema = z.object({
  ip: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/, "IP non valido"),
  jail: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Nome jail non valido"),
});

export type UnbanRequest = z.infer<typeof unbanRequestSchema>;

// Statistics
export const statsSchema = z.object({
  totalBans24h: z.number(),
  activeConnections: z.number(),
  blockedCountries: z.number(),
  totalRequests24h: z.number(),
  topBannedIps: z.array(z.object({
    ip: z.string(),
    count: z.number(),
  })),
  bansByCountry: z.array(z.object({
    country: z.string(),
    count: z.number(),
  })),
  banTimeline: z.array(z.object({
    time: z.string(),
    count: z.number(),
  })),
});

export type Stats = z.infer<typeof statsSchema>;

// Log entries
export const logEntrySchema = z.object({
  timestamp: z.string(),
  level: z.enum(['ERROR', 'WARN', 'INFO', 'DEBUG']).optional(),
  message: z.string(),
  line: z.number().optional(),
});

export type LogEntry = z.infer<typeof logEntrySchema>;

// Configuration files
export const configFileSchema = z.object({
  filename: z.string(),
  path: z.string(),
  content: z.string(),
  description: z.string().optional(),
});

export type ConfigFile = z.infer<typeof configFileSchema>;

export const updateConfigRequestSchema = z.object({
  filename: z.string().regex(/^[a-zA-Z0-9_.-]+$/, "Nome file non valido"),
  content: z.string(),
});

export type UpdateConfigRequest = z.infer<typeof updateConfigRequestSchema>;

// Fail2ban Jail management
export const jailConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  port: z.string().optional(),
  filter: z.string().optional(),
  logpath: z.string().optional(),
  maxretry: z.number().optional(),
  bantime: z.string().optional(),
  findtime: z.string().optional(),
  action: z.string().optional(),
});

export type JailConfig = z.infer<typeof jailConfigSchema>;

export const updateJailRequestSchema = z.object({
  config: z.object({
    enabled: z.boolean().optional(),
    maxretry: z.number().optional(),
    bantime: z.string().optional(),
    findtime: z.string().optional(),
  }),
});

export type UpdateJailRequest = z.infer<typeof updateJailRequestSchema>;

// Fail2ban Filter
export const fail2banFilterSchema = z.object({
  name: z.string(),
  path: z.string(),
  failregex: z.array(z.string()),
  ignoreregex: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export type Fail2banFilter = z.infer<typeof fail2banFilterSchema>;

export const updateFilterRequestSchema = z.object({
  failregex: z.array(z.string().min(1, "Regex non può essere vuota")).min(1, "Almeno una failregex è richiesta"),
  ignoreregex: z.array(z.string().min(1)).optional(),
});

export type UpdateFilterRequest = z.infer<typeof updateFilterRequestSchema>;

// ─── User & VPS validation (security hardening) ────────────────────────────

export const createUserSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/, "Username non valido"),
  password: z.string().min(8, "Password minimo 8 caratteri"),
  role: z.enum(["admin", "operator"]),
  assignedVps: z.array(z.string()).optional(),
});

export const updateUserSchema = z.object({
  password: z.string().min(8).optional(),
  role: z.enum(["admin", "operator"]).optional(),
  enabled: z.boolean().optional(),
  assignedVps: z.array(z.string()).optional(),
});

const NETBIRD_IP_REGEX = /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const VALID_IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const createVpsSchema = z.object({
  name: z.string().min(1, "Nome richiesto"),
  host: z.string().min(1, "Host richiesto").regex(VALID_IPV4_REGEX, "Host deve essere un IP valido"),
  port: z.number().int().min(1).max(65535).optional(),
  apiKey: z.string().min(8, "API key minimo 8 caratteri"),
  tags: z.array(z.string()).optional(),
});

export const updateVpsSchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().min(1).regex(VALID_IPV4_REGEX, "Host deve essere un IP valido").optional(),
  port: z.number().int().min(1).max(65535).optional(),
  apiKey: z.string().min(8).optional(),
  enabled: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

export const filterNameSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, "Nome filtro non valido");
export const jailNameSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, "Nome jail non valido");
export const ALLOWED_SERVICES = ["nginx", "fail2ban", "mariadb"] as const;
