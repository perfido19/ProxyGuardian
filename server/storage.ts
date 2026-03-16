import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, access } from "fs/promises";
import { constants } from "fs";
import type {
  Service,
  BannedIp,
  Stats,
  LogEntry,
  ConfigFile,
  JailConfig,
  Fail2banFilter,
} from "@shared/schema";

const execAsync = promisify(exec);

// Runtime capability detection
class SystemCapabilities {
  private static instance: SystemCapabilities;
  private capabilities: {
    hasSystemctl: boolean;
    hasFail2ban: boolean;
    hasNginxConfigs: boolean;
    hasLogFiles: boolean;
  } | null = null;

  private constructor() {}

  static getInstance(): SystemCapabilities {
    if (!SystemCapabilities.instance) {
      SystemCapabilities.instance = new SystemCapabilities();
    }
    return SystemCapabilities.instance;
  }

  async detect(): Promise<void> {
    if (this.capabilities) return; // Already detected

    this.capabilities = {
      hasSystemctl: await this.checkCommand('systemctl --version'),
      hasFail2ban: await this.checkCommand('fail2ban-client --version'),
      hasNginxConfigs: await this.checkPath('/etc/nginx'),
      hasLogFiles: await this.checkPath('/var/log'),
    };

    console.log('[SystemCapabilities] Detected:', this.capabilities);
  }

  private async checkCommand(command: string): Promise<boolean> {
    try {
      await execAsync(command, { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  private async checkPath(path: string): Promise<boolean> {
    try {
      await access(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  get hasSystemctl(): boolean {
    return this.capabilities?.hasSystemctl ?? false;
  }

  get hasFail2ban(): boolean {
    return this.capabilities?.hasFail2ban ?? false;
  }

  get hasNginxConfigs(): boolean {
    return this.capabilities?.hasNginxConfigs ?? false;
  }

  get hasLogFiles(): boolean {
    return this.capabilities?.hasLogFiles ?? false;
  }

  get isProductionVPS(): boolean {
    return this.hasSystemctl && this.hasFail2ban && this.hasNginxConfigs;
  }
}

export interface IStorage {
  // Services
  getServices(): Promise<Service[]>;
  getServiceStatus(name: string): Promise<Service | undefined>;
  serviceAction(service: string, action: string): Promise<void>;
  
  // Banned IPs
  getBannedIps(): Promise<BannedIp[]>;
  unbanIp(ip: string, jail: string): Promise<void>;
  
  // Statistics
  getStats(): Promise<Stats>;
  
  // Logs
  getLogs(logType: string, lines?: number): Promise<LogEntry[]>;
  
  // Configuration Files
  getConfigFile(filename: string): Promise<ConfigFile | undefined>;
  updateConfigFile(filename: string, content: string): Promise<void>;
  
  // Fail2ban Jails
  getJails(): Promise<JailConfig[]>;
  updateJail(name: string, config: Partial<JailConfig>): Promise<void>;
  
  // Fail2ban Filters
  getFilters(): Promise<Fail2banFilter[]>;
  getFilter(name: string): Promise<Fail2banFilter | undefined>;
  updateFilter(name: string, failregex: string[], ignoreregex?: string[]): Promise<void>;
  
  // Fail2ban Config Files
  getFail2banConfig(type: 'jail.local' | 'fail2ban.local'): Promise<ConfigFile>;
  updateFail2banConfig(type: 'jail.local' | 'fail2ban.local', content: string): Promise<void>;
}

export class MemStorage implements IStorage {
  private caps = SystemCapabilities.getInstance();
  
  private configPaths: Record<string, string> = {
    "country_whitelist.conf": "/etc/nginx/country_whitelist.conf",
    "block_asn.conf": "/etc/nginx/block_asn.conf",
    "block_isp.conf": "/etc/nginx/block_isp.conf",
    "useragent.rules": "/etc/nginx/useragent.rules",
    "ip_whitelist.conf": "/etc/nginx/ip_whitelist.conf",
    "exclusion_ip.conf": "/etc/nginx/exclusion_ip.conf",
  };

  private logPaths: Record<string, string> = {
    "nginx-access": "/var/log/nginx/access.log",
    "nginx-error": "/var/log/nginx/error.log",
    "fail2ban": "/var/log/fail2ban.log",
    "modsec": "/opt/log/modsec_audit.log",
  };

  constructor() {
    // Initialize capabilities detection
    this.caps.detect().catch(err => {
      console.error('[Storage] Failed to detect capabilities:', err);
    });
  }

  private getMockServices(): Service[] {
    return [
      { name: 'nginx', status: 'running', uptime: '5d 12h', pid: 1234 },
      { name: 'fail2ban', status: 'running', uptime: '5d 12h', pid: 1235 },
      { name: 'mariadb', status: 'running', uptime: '5d 12h', pid: 1236 },
    ];
  }

  private getMockBannedIps(): BannedIp[] {
    return [
      {
        ip: '192.168.1.100',
        jail: 'nginx-req-limit',
        banTime: new Date(Date.now() - 3600000).toLocaleString('it-IT'),
        timeLeft: '1h 30m',
        reason: 'Rate limiting violation',
      },
      {
        ip: '10.0.0.50',
        jail: 'nginx-4xx',
        banTime: new Date(Date.now() - 7200000).toLocaleString('it-IT'),
        timeLeft: '45m',
        reason: 'Multiple HTTP 404 errors',
      },
    ];
  }

  private getMockStats(): Stats {
    const timeline = [];
    const now = new Date();
    for (let i = 23; i >= 0; i--) {
      const time = new Date(now.getTime() - i * 60 * 60 * 1000);
      timeline.push({
        time: `${time.getHours()}:00`,
        count: Math.floor(Math.random() * 10) + 1,
      });
    }

    return {
      totalBans24h: 47,
      activeConnections: 23,
      blockedCountries: 15,
      totalRequests24h: 15420,
      topBannedIps: [
        { ip: '192.168.1.100', count: 12 },
        { ip: '10.0.0.50', count: 8 },
        { ip: '172.16.0.25', count: 6 },
        { ip: '203.0.113.15', count: 4 },
        { ip: '198.51.100.42', count: 3 },
      ],
      bansByCountry: [
        { country: 'CN', count: 18 },
        { country: 'RU', count: 12 },
        { country: 'US', count: 8 },
        { country: 'BR', count: 5 },
        { country: 'IN', count: 4 },
      ],
      banTimeline: timeline,
    };
  }

  private getMockLogs(logType: string): LogEntry[] {
    const logs: LogEntry[] = [];
    const now = new Date();
    
    for (let i = 20; i > 0; i--) {
      const time = new Date(now.getTime() - i * 60000);
      const timestamp = time.toLocaleString('it-IT');
      
      if (logType === 'nginx-access') {
        logs.push({
          timestamp,
          message: `192.168.1.${Math.floor(Math.random() * 255)} - - [${timestamp}] "GET /api/endpoint HTTP/1.1" 200 1234`,
          line: 21 - i,
        });
      } else if (logType === 'nginx-error') {
        const levels: ('ERROR' | 'WARN' | 'INFO')[] = ['ERROR', 'WARN', 'INFO'];
        const level = levels[Math.floor(Math.random() * levels.length)];
        logs.push({
          timestamp,
          level,
          message: `[${level.toLowerCase()}] limiting requests, excess: 5.000 by zone "req_limit", client: 192.168.1.${Math.floor(Math.random() * 255)}`,
          line: 21 - i,
        });
      } else if (logType === 'fail2ban') {
        logs.push({
          timestamp,
          level: 'INFO',
          message: `[nginx-req-limit] Ban 192.168.1.${Math.floor(Math.random() * 255)}`,
          line: 21 - i,
        });
      } else {
        logs.push({
          timestamp,
          message: `ModSecurity: Warning. Pattern match "..." at REQUEST_URI. [id "920100"]`,
          line: 21 - i,
        });
      }
    }
    
    return logs;
  }

  async getServices(): Promise<Service[]> {
    await this.caps.detect();
    
    if (!this.caps.hasSystemctl) {
      return this.getMockServices();
    }

    const serviceNames = ['nginx', 'fail2ban', 'mariadb'];
    const services: Service[] = [];

    for (const name of serviceNames) {
      const service = await this.getServiceStatus(name);
      if (service) {
        services.push(service);
      }
    }

    return services;
  }

  async getServiceStatus(name: string): Promise<Service | undefined> {
    await this.caps.detect();
    
    if (!this.caps.hasSystemctl) {
      return this.getMockServices().find(s => s.name === name);
    }

    try {
      const { stdout } = await execAsync(`systemctl status ${name}`, { timeout: 5000 });
      
      const isActive = stdout.includes('Active: active (running)');
      const isInactive = stdout.includes('Active: inactive');
      const isFailed = stdout.includes('Active: failed');
      
      let status: 'running' | 'stopped' | 'error' | 'restarting' = 'stopped';
      if (isActive) status = 'running';
      else if (isFailed) status = 'error';
      
      const pidMatch = stdout.match(/Main PID: (\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1]) : undefined;
      
      const uptimeMatch = stdout.match(/Active: active \(running\) since ([^;]+);/);
      const uptime = uptimeMatch ? this.parseUptime(uptimeMatch[1]) : undefined;

      return {
        name,
        status,
        uptime,
        pid,
      };
    } catch (error) {
      return {
        name,
        status: 'stopped',
      };
    }
  }

  private parseUptime(dateString: string): string {
    try {
      const startDate = new Date(dateString);
      const now = new Date();
      const diff = now.getTime() - startDate.getTime();
      
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
    } catch {
      return 'N/A';
    }
  }

  async serviceAction(service: string, action: string): Promise<void> {
    await this.caps.detect();
    
    if (!this.caps.hasSystemctl) {
      // In non-production, simulate success
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log(`[Mock] Service action: ${service} ${action}`);
      return;
    }

    const validActions = ['start', 'stop', 'restart', 'reload'];
    if (!validActions.includes(action)) {
      throw new Error(`Azione non valida: ${action}`);
    }

    if (action === 'reload' && service !== 'nginx') {
      throw new Error('Reload supportato solo per nginx');
    }

    await execAsync(`systemctl ${action} ${service}`, { timeout: 10000 });
  }

  async getBannedIps(): Promise<BannedIp[]> {
    await this.caps.detect();
    
    if (!this.caps.hasFail2ban) {
      return this.getMockBannedIps();
    }

    const bannedIps: BannedIp[] = [];

    try {
      // Get list of all active jails
      const { stdout: statusOutput } = await execAsync('fail2ban-client status', { timeout: 5000 });
      const jailListMatch = statusOutput.match(/Jail list:\s*(.+)/);
      
      if (jailListMatch) {
        const jails = jailListMatch[1].split(',').map(j => j.trim()).filter(j => j);
        
        // Get banned IPs from each jail
        for (const jail of jails) {
          try {
            const { stdout: jailStatus } = await execAsync(`fail2ban-client status ${jail}`, { timeout: 5000 });
            const jailIps = this.parseFail2banStatus(jailStatus, jail);
            bannedIps.push(...jailIps);
          } catch (error) {
            console.error(`Error getting bans for jail ${jail}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error getting fail2ban status:', error);
    }

    return bannedIps;
  }

  private parseFail2banStatus(output: string, jail: string): BannedIp[] {
    const ips: BannedIp[] = [];
    
    const ipListMatch = output.match(/Banned IP list:\s*(.+)/);
    if (!ipListMatch) return ips;
    
    const ipList = ipListMatch[1].trim().split(/\s+/);
    
    for (const ip of ipList) {
      if (ip && ip !== '') {
        ips.push({
          ip,
          jail,
          banTime: new Date().toLocaleString('it-IT'),
          timeLeft: 'N/A',
          reason: jail === 'nginx-req-limit' ? 'Rate limiting violation' : 'HTTP 4xx errors',
        });
      }
    }
    
    return ips;
  }

  async unbanIp(ip: string, jail: string): Promise<void> {
    await this.caps.detect();
    
    if (!this.caps.hasFail2ban) {
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log(`[Mock] Unban IP: ${ip} from ${jail}`);
      return;
    }

    await execAsync(`fail2ban-client set ${jail} unbanip ${ip}`, { timeout: 5000 });
  }

  async unbanAll(): Promise<{ unbannedCount: number; jailsProcessed: number }> {
    await this.caps.detect();
    
    if (!this.caps.hasFail2ban) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      console.log('[Mock] Unban all IPs');
      return { unbannedCount: 10, jailsProcessed: 3 };
    }

    let unbannedCount = 0;
    let jailsProcessed = 0;

    try {
      // Get list of all active jails
      const { stdout: statusOutput } = await execAsync('fail2ban-client status', { timeout: 5000 });
      const jailListMatch = statusOutput.match(/Jail list:\s*(.+)/);
      
      if (jailListMatch) {
        const jails = jailListMatch[1].split(',').map(j => j.trim()).filter(j => j);
        
        // Unban all IPs from each jail
        for (const jail of jails) {
          try {
            const { stdout: jailStatus } = await execAsync(`fail2ban-client status ${jail}`, { timeout: 5000 });
            const ipListMatch = jailStatus.match(/Banned IP list:\s*(.+)/);
            
            if (ipListMatch) {
              const ips = ipListMatch[1].trim().split(/\s+/).filter(ip => ip);
              
              for (const ip of ips) {
                try {
                  await execAsync(`fail2ban-client set ${jail} unbanip ${ip}`, { timeout: 3000 });
                  unbannedCount++;
                } catch (error) {
                  console.error(`Error unbanning ${ip} from ${jail}:`, error);
                }
              }
            }
            
            jailsProcessed++;
          } catch (error) {
            console.error(`Error processing jail ${jail}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error unbanning all IPs:', error);
      throw new Error('Errore durante lo sblocco di tutti gli IP');
    }

    return { unbannedCount, jailsProcessed };
  }

  async getStats(): Promise<Stats> {
    await this.caps.detect();
    
    if (!this.caps.isProductionVPS) {
      return this.getMockStats();
    }

    const stats: Stats = {
      totalBans24h: 0,
      activeConnections: 0,
      blockedCountries: 0,
      totalRequests24h: 0,
      topBannedIps: [],
      bansByCountry: [],
      banTimeline: [],
    };

    try {
      const bannedIps = await this.getBannedIps();
      stats.totalBans24h = bannedIps.length;

      const ipCounts: Record<string, number> = {};
      bannedIps.forEach(ban => {
        ipCounts[ban.ip] = (ipCounts[ban.ip] || 0) + 1;
      });

      stats.topBannedIps = Object.entries(ipCounts)
        .map(([ip, count]) => ({ ip, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      // Try to get active connections from nginx status page
      try {
        const { stdout } = await execAsync('curl -s http://localhost/nginx_status 2>/dev/null || echo ""', { timeout: 3000 });
        const match = stdout.match(/Active connections:\s*(\d+)/);
        if (match) {
          stats.activeConnections = parseInt(match[1]);
        } else {
          // Fallback: count TCP connections on port 8880
          try {
            const { stdout: ssOutput } = await execAsync(
              'ss -tn state established "( sport = :8880 )" 2>/dev/null | grep -c ESTAB || echo "0"',
              { timeout: 2000 }
            );
            stats.activeConnections = parseInt(ssOutput.trim()) || 0;
          } catch {
            // Final fallback: try netstat
            try {
              const { stdout: netstatOutput } = await execAsync(
                'netstat -tn 2>/dev/null | grep ":8880" | grep -c ESTABLISHED || echo "0"',
                { timeout: 2000 }
              );
              stats.activeConnections = parseInt(netstatOutput.trim()) || 0;
            } catch {
              stats.activeConnections = 0;
            }
          }
        }
      } catch {
        stats.activeConnections = 0;
      }

      try {
        const countryConfig = await this.getConfigFile('country_whitelist.conf');
        if (countryConfig) {
          const lines = countryConfig.content.split('\n').filter(l => !l.trim().startsWith('#') && l.includes('yes'));
          stats.blockedCountries = lines.length;
        }
      } catch {}

      try {
        const { stdout } = await execAsync('wc -l < /var/log/nginx/access.log 2>/dev/null || echo "0"', { timeout: 3000 });
        stats.totalRequests24h = parseInt(stdout.trim()) || 0;
      } catch {}

      const now = new Date();
      for (let i = 23; i >= 0; i--) {
        const time = new Date(now.getTime() - i * 60 * 60 * 1000);
        stats.banTimeline.push({
          time: `${time.getHours()}:00`,
          count: Math.floor(Math.random() * 5),
        });
      }

    } catch (error) {
      console.error('Error getting stats:', error);
    }

    return stats;
  }

  async getLogs(logType: string, lines: number = 100): Promise<LogEntry[]> {
    await this.caps.detect();
    
    if (!this.caps.hasLogFiles) {
      return this.getMockLogs(logType);
    }

    const logPath = this.logPaths[logType];
    if (!logPath) {
      throw new Error(`Tipo di log non valido: ${logType}`);
    }

    try {
      // Check if log file exists
      await access(logPath, constants.R_OK);
      const { stdout } = await execAsync(`tail -n ${lines} ${logPath} 2>/dev/null || echo ""`, { timeout: 5000 });
      return this.parseLogEntries(stdout, logType);
    } catch (error) {
      console.log(`[Storage] Log file ${logPath} not accessible, using mock data`);
      return this.getMockLogs(logType);
    }
  }

  private parseLogEntries(logContent: string, logType: string): LogEntry[] {
    const lines = logContent.split('\n').filter(l => l.trim() !== '');
    const entries: LogEntry[] = [];

    lines.forEach((line, index) => {
      const timestampMatch = line.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|\[\d{2}\/\w+\/\d{4}:\d{2}:\d{2}:\d{2})/);
      const timestamp = timestampMatch ? timestampMatch[1].replace(/[\[\]]/g, '') : new Date().toLocaleString('it-IT');
      
      const levelMatch = line.match(/\[(error|warn|info|debug)\]/i);
      const level = levelMatch ? levelMatch[1].toUpperCase() as 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' : undefined;
      
      entries.push({
        timestamp,
        level,
        message: line,
        line: index + 1,
      });
    });

    return entries;
  }

  async getConfigFile(filename: string): Promise<ConfigFile | undefined> {
    await this.caps.detect();
    
    const path = this.configPaths[filename];
    if (!path) {
      return undefined;
    }

    // For non-production, return mock empty configs
    if (!this.caps.hasNginxConfigs) {
      return {
        filename,
        path,
        content: `# ${this.getConfigDescription(filename)}\n# Questo è un file di esempio in modalità sviluppo\n# In produzione questo file sarà gestito da nginx\n`,
        description: this.getConfigDescription(filename),
      };
    }

    try {
      await access(path, constants.R_OK);
      const content = await readFile(path, 'utf-8');
      
      return {
        filename,
        path,
        content,
        description: this.getConfigDescription(filename),
      };
    } catch (error) {
      console.log(`[Storage] Config file ${filename} not found, creating with default template`);
      
      // Create file with default template
      const defaultContent = this.getDefaultConfigContent(filename);
      
      try {
        await writeFile(path, defaultContent, 'utf-8');
        console.log(`[Storage] Created config file: ${filename}`);
        
        return {
          filename,
          path,
          content: defaultContent,
          description: this.getConfigDescription(filename),
        };
      } catch (writeError) {
        console.error(`[Storage] Failed to create config file ${filename}:`, writeError);
        // Return template anyway so UI can display something
        return {
          filename,
          path,
          content: defaultContent,
          description: this.getConfigDescription(filename),
        };
      }
    }
  }

  private getConfigDescription(filename: string): string {
    const descriptions: Record<string, string> = {
      "country_whitelist.conf": "Whitelist paesi autorizzati (codici ISO 3166-1 alpha-2)",
      "block_asn.conf": "Blacklist ASN (Autonomous System Numbers)",
      "block_isp.conf": "Blacklist provider internet (ISP)",
      "useragent.rules": "Regole per bloccare user-agent specifici",
      "ip_whitelist.conf": "IP esclusi dal rate limiting",
      "exclusion_ip.conf": "IP/range esclusi dal blocco geografico",
    };
    return descriptions[filename] || "";
  }

  private getDefaultConfigContent(filename: string): string {
    const templates: Record<string, string> = {
      "country_whitelist.conf": `# ${this.getConfigDescription(filename)}
# Formato: CODICE_PAESE yes;
# Esempio:
# IT yes;
# DE yes;
# FR yes;
`,
      "block_asn.conf": `# ${this.getConfigDescription(filename)}
# Formato: ASN yes; # Descrizione
# Esempio:
# AS12345 yes; # Provider XYZ
# AS67890 yes; # Hosting ABC
`,
      "block_isp.conf": `# ${this.getConfigDescription(filename)}
# Formato: if ($geoip2_isp ~* "NOME_ISP") { return 403; }
# Esempio:
# if ($geoip2_isp ~* "Hosting Provider") { return 403; }
# if ($geoip2_isp = "Exact ISP Name") { return 403; }
`,
      "useragent.rules": `# ${this.getConfigDescription(filename)}
# Formato: if ($http_user_agent ~* "PATTERN") { return 403; }
# Esempio:
# if ($http_user_agent ~* "bot") { return 403; }
# if ($http_user_agent ~* "scanner") { return 403; }
`,
      "ip_whitelist.conf": `# ${this.getConfigDescription(filename)}
# Formato: IP_O_RANGE;
# Esempio:
# 192.168.1.0/24;
# 10.0.0.1;
`,
      "exclusion_ip.conf": `# ${this.getConfigDescription(filename)}
# Formato: IP_O_RANGE;
# Esempio:
# 203.0.113.0/24;
# 198.51.100.42;
`,
    };
    
    return templates[filename] || `# ${this.getConfigDescription(filename)}\n`;
  }

  async updateConfigFile(filename: string, content: string): Promise<void> {
    await this.caps.detect();
    
    const path = this.configPaths[filename];
    if (!path) {
      throw new Error(`File di configurazione non valido: ${filename}`);
    }

    if (!this.caps.hasNginxConfigs) {
      // In non-production, simulate success
      await new Promise(resolve => setTimeout(resolve, 300));
      console.log(`[Mock] Updated config file: ${filename}`);
      return;
    }

    try {
      await writeFile(path, content, 'utf-8');
    } catch (error) {
      console.error(`Error writing config file ${filename}:`, error);
      throw new Error('Errore nella scrittura del file di configurazione');
    }
  }

  // Fail2ban Jail Management
  
  private getMockJails(): JailConfig[] {
    return [
      {
        name: 'nginx-req-limit',
        enabled: true,
        port: 'http,https',
        filter: 'nginx-req-limit',
        logpath: '/var/log/nginx/error.log',
        maxretry: 5,
        bantime: '3600',
        findtime: '600',
        action: 'iptables-multiport[name=ReqLimit, port="http,https"]',
      },
      {
        name: 'nginx-4xx',
        enabled: true,
        port: 'http,https',
        filter: 'nginx-4xx',
        logpath: '/var/log/nginx/access.log',
        maxretry: 10,
        bantime: '1800',
        findtime: '300',
        action: 'iptables-multiport[name=4xxLimit, port="http,https"]',
      },
      {
        name: 'sshd',
        enabled: false,
        port: 'ssh',
        filter: 'sshd',
        logpath: '/var/log/auth.log',
        maxretry: 3,
        bantime: '86400',
        findtime: '600',
        action: 'iptables-multiport[name=SSH, port="ssh"]',
      },
    ];
  }

  async getJails(): Promise<JailConfig[]> {
    await this.caps.detect();
    
    if (!this.caps.hasFail2ban) {
      return this.getMockJails();
    }

    const jails: JailConfig[] = [];
    
    try {
      const jailLocalPath = '/etc/fail2ban/jail.local';
      await access(jailLocalPath, constants.R_OK);
      const content = await readFile(jailLocalPath, 'utf-8');
      
      // Parse jail.local file
      const jailSections = content.split(/\n\[/).filter(s => s.trim());
      
      for (const section of jailSections) {
        const lines = section.split('\n');
        const nameMatch = lines[0].match(/^([^\]]+)\]/);
        if (!nameMatch || nameMatch[1] === 'DEFAULT') continue;
        
        const name = nameMatch[1].trim();
        const config: Partial<JailConfig> = { name };
        
        for (const line of lines.slice(1)) {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
          
          const [key, ...valueParts] = trimmed.split('=');
          const value = valueParts.join('=').trim();
          
          switch (key.trim()) {
            case 'enabled':
              config.enabled = value.toLowerCase() === 'true';
              break;
            case 'port':
              config.port = value;
              break;
            case 'filter':
              config.filter = value;
              break;
            case 'logpath':
              config.logpath = value;
              break;
            case 'maxretry':
              config.maxretry = parseInt(value);
              break;
            case 'bantime':
              config.bantime = value;
              break;
            case 'findtime':
              config.findtime = value;
              break;
            case 'action':
              config.action = value;
              break;
          }
        }
        
        jails.push(config as JailConfig);
      }
      
      return jails;
    } catch (error) {
      console.log('[Storage] jail.local not accessible, using mock data');
      return this.getMockJails();
    }
  }

  async updateJail(name: string, config: Partial<JailConfig>): Promise<void> {
    await this.caps.detect();
    
    if (!this.caps.hasFail2ban) {
      await new Promise(resolve => setTimeout(resolve, 300));
      console.log(`[Mock] Updated jail: ${name}`, config);
      return;
    }

    try {
      const jailLocalPath = '/etc/fail2ban/jail.local';
      let content = '';
      
      try {
        await access(jailLocalPath, constants.R_OK);
        content = await readFile(jailLocalPath, 'utf-8');
      } catch {
        // File doesn't exist, create new content
        content = '# Fail2ban jail.local - Configuration managed by Dashboard\n\n';
      }
      
      // Find and update the jail section
      const jailRegex = new RegExp(`\\[${name}\\][\\s\\S]*?(?=\\n\\[|$)`, 'g');
      const jailExists = jailRegex.test(content);
      
      if (jailExists) {
        // Update existing jail
        content = content.replace(jailRegex, (match) => {
          let updated = match;
          
          if (config.enabled !== undefined) {
            if (/enabled\s*=/.test(updated)) {
              updated = updated.replace(/enabled\s*=.*/, `enabled = ${config.enabled}`);
            } else {
              updated += `\nenabled = ${config.enabled}`;
            }
          }
          
          if (config.maxretry !== undefined) {
            if (/maxretry\s*=/.test(updated)) {
              updated = updated.replace(/maxretry\s*=.*/, `maxretry = ${config.maxretry}`);
            } else {
              updated += `\nmaxretry = ${config.maxretry}`;
            }
          }
          
          if (config.bantime) {
            if (/bantime\s*=/.test(updated)) {
              updated = updated.replace(/bantime\s*=.*/, `bantime = ${config.bantime}`);
            } else {
              updated += `\nbantime = ${config.bantime}`;
            }
          }
          
          if (config.findtime) {
            if (/findtime\s*=/.test(updated)) {
              updated = updated.replace(/findtime\s*=.*/, `findtime = ${config.findtime}`);
            } else {
              updated += `\nfindtime = ${config.findtime}`;
            }
          }
          
          return updated;
        });
      } else {
        // Add new jail section
        let newSection = `\n[${name}]\n`;
        if (config.enabled !== undefined) newSection += `enabled = ${config.enabled}\n`;
        if (config.port) newSection += `port = ${config.port}\n`;
        if (config.filter) newSection += `filter = ${config.filter}\n`;
        if (config.logpath) newSection += `logpath = ${config.logpath}\n`;
        if (config.maxretry) newSection += `maxretry = ${config.maxretry}\n`;
        if (config.bantime) newSection += `bantime = ${config.bantime}\n`;
        if (config.findtime) newSection += `findtime = ${config.findtime}\n`;
        if (config.action) newSection += `action = ${config.action}\n`;
        
        content += newSection;
      }
      
      await writeFile(jailLocalPath, content, 'utf-8');
      
      // Reload fail2ban to apply changes
      await execAsync('fail2ban-client reload', { timeout: 5000 });
    } catch (error) {
      console.error(`Error updating jail ${name}:`, error);
      throw new Error('Errore nell\'aggiornamento della configurazione jail');
    }
  }

  async getFilters(): Promise<Fail2banFilter[]> {
    await this.caps.detect();
    
    const mockFilters: Fail2banFilter[] = [
      {
        name: 'nginx-req-limit',
        path: '/etc/fail2ban/filter.d/nginx-req-limit.conf',
        failregex: ['limiting requests, excess: .* by zone'],
        description: 'Filtra eccessi di rate limiting nginx',
      },
      {
        name: 'nginx-4xx',
        path: '/etc/fail2ban/filter.d/nginx-4xx.conf',
        failregex: ['"(GET|POST|HEAD).*" (404|403|401)'],
        description: 'Filtra errori HTTP 4xx multipli',
      },
      {
        name: 'sshd',
        path: '/etc/fail2ban/filter.d/sshd.conf',
        failregex: ['Failed password for .* from <HOST>', 'Invalid user .* from <HOST>'],
        description: 'Filtra tentativi di login SSH falliti',
      },
    ];
    
    if (!this.caps.hasFail2ban) {
      return mockFilters;
    }

    const filters: Fail2banFilter[] = [];
    const filterDir = '/etc/fail2ban/filter.d';
    
    try {
      await access(filterDir, constants.R_OK);
      const { stdout } = await execAsync(`ls ${filterDir}/*.conf`, { timeout: 3000 });
      const filterFiles = stdout.trim().split('\n');
      
      for (const filterPath of filterFiles) {
        try {
          const content = await readFile(filterPath, 'utf-8');
          const name = filterPath.split('/').pop()?.replace('.conf', '') || '';
          
          const failregex: string[] = [];
          const ignoreregex: string[] = [];
          
          const lines = content.split('\n');
          for (const line of lines) {
            if (line.trim().startsWith('failregex')) {
              const match = line.match(/failregex\s*=\s*(.+)/);
              if (match) failregex.push(match[1].trim());
            }
            if (line.trim().startsWith('ignoreregex')) {
              const match = line.match(/ignoreregex\s*=\s*(.+)/);
              if (match) ignoreregex.push(match[1].trim());
            }
          }
          
          filters.push({
            name,
            path: filterPath,
            failregex,
            ignoreregex: ignoreregex.length > 0 ? ignoreregex : undefined,
          });
        } catch (error) {
          console.log(`[Storage] Could not read filter ${filterPath}`);
        }
      }
      
      return filters;
    } catch (error) {
      console.log('[Storage] Filter directory not accessible, using mock data');
      return mockFilters;
    }
  }

  async getFilter(name: string): Promise<Fail2banFilter | undefined> {
    const filters = await this.getFilters();
    return filters.find(f => f.name === name);
  }

  async updateFilter(name: string, failregex: string[], ignoreregex?: string[]): Promise<void> {
    await this.caps.detect();
    
    // Validate input
    if (!failregex || failregex.length === 0) {
      throw new Error('Almeno una failregex è richiesta');
    }
    
    // Filter out empty strings
    const validFailregex = failregex.filter(r => r.trim());
    const validIgnoreregex = ignoreregex ? ignoreregex.filter(r => r.trim()) : [];
    
    if (validFailregex.length === 0) {
      throw new Error('Almeno una failregex valida è richiesta');
    }
    
    if (!this.caps.hasFail2ban) {
      await new Promise(resolve => setTimeout(resolve, 300));
      console.log(`[Mock] Updated filter: ${name}`, { failregex: validFailregex, ignoreregex: validIgnoreregex });
      return;
    }

    const filterPath = `/etc/fail2ban/filter.d/${name}.conf`;
    let backupContent = '';
    
    try {
      // Backup existing file content before making changes
      try {
        await access(filterPath, constants.R_OK);
        backupContent = await readFile(filterPath, 'utf-8');
      } catch {
        // File doesn't exist, no backup needed
      }
      
      // Read existing filter file for description
      let description = '';
      
      if (backupContent) {
        // Extract description/comments from existing file
        const lines = backupContent.split('\n');
        const commentLines = lines.filter(line => line.trim().startsWith('#'));
        description = commentLines.join('\n');
      } else {
        // File doesn't exist, create new with default header
        description = `# Fail2ban filter for ${name}\n# Custom filter managed by Dashboard`;
      }
      
      // Build new content with proper fail2ban format
      let content = description + '\n\n[Definition]\n\n';
      
      // Add failregex entries
      validFailregex.forEach(regex => {
        content += `failregex = ${regex}\n`;
      });
      
      // Add blank line before ignoreregex (fail2ban INI format requirement)
      if (validIgnoreregex.length > 0) {
        content += '\n';
        validIgnoreregex.forEach(regex => {
          content += `ignoreregex = ${regex}\n`;
        });
      }
      
      // Write the updated filter file
      await writeFile(filterPath, content, 'utf-8');
      
      // Reload fail2ban to apply changes
      try {
        await execAsync('fail2ban-client reload', { timeout: 5000 });
      } catch (reloadError) {
        // If reload fails, restore backup
        if (backupContent) {
          await writeFile(filterPath, backupContent, 'utf-8');
        }
        throw new Error('Errore nel reload di fail2ban, modifiche annullate');
      }
    } catch (error) {
      // Restore backup on any error
      if (backupContent) {
        try {
          await writeFile(filterPath, backupContent, 'utf-8');
        } catch (restoreError) {
          console.error(`Critical: Failed to restore backup for ${name}:`, restoreError);
        }
      }
      
      console.error(`Error updating filter ${name}:`, error);
      throw new Error(`Errore nell'aggiornamento del filtro ${name}`);
    }
  }

  async getFail2banConfig(type: 'jail.local' | 'fail2ban.local'): Promise<ConfigFile> {
    await this.caps.detect();
    
    const path = type === 'jail.local' ? '/etc/fail2ban/jail.local' : '/etc/fail2ban/fail2ban.local';
    const description = type === 'jail.local' 
      ? 'Configurazione locale delle jail fail2ban' 
      : 'Configurazione globale fail2ban';
    
    if (!this.caps.hasFail2ban) {
      return {
        filename: type,
        path,
        content: `# ${description}\n# Questo è un file di esempio in modalità sviluppo\n`,
        description,
      };
    }

    try {
      await access(path, constants.R_OK);
      const content = await readFile(path, 'utf-8');
      
      return {
        filename: type,
        path,
        content,
        description,
      };
    } catch (error) {
      console.log(`[Storage] ${type} not accessible, using template`);
      return {
        filename: type,
        path,
        content: `# ${description}\n`,
        description,
      };
    }
  }

  async updateFail2banConfig(type: 'jail.local' | 'fail2ban.local', content: string): Promise<void> {
    await this.caps.detect();
    
    const path = type === 'jail.local' ? '/etc/fail2ban/jail.local' : '/etc/fail2ban/fail2ban.local';
    
    if (!this.caps.hasFail2ban) {
      await new Promise(resolve => setTimeout(resolve, 300));
      console.log(`[Mock] Updated ${type}`);
      return;
    }

    try {
      await writeFile(path, content, 'utf-8');
      
      // Reload fail2ban to apply changes
      await execAsync('fail2ban-client reload', { timeout: 5000 });
    } catch (error) {
      console.error(`Error writing ${type}:`, error);
      throw new Error(`Errore nella scrittura di ${type}`);
    }
  }
}

export const storage = new MemStorage();
