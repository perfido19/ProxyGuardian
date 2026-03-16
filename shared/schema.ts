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
  service: z.string(),
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
  ip: z.string(),
  jail: z.string(),
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
  filename: z.string(),
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
