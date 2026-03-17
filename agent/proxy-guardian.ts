import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../server/storage";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Tool definitions ─────────────────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: "get_services_status",
    description: "Get the current status of system services (nginx, fail2ban, mariadb). Returns name, status, uptime, and PID for each service.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_stats",
    description: "Get dashboard statistics: total bans in 24h, active connections, blocked countries, total requests, top banned IPs, bans by country, and ban timeline.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_banned_ips",
    description: "Get the list of currently banned IPs with jail, ban time, and reason.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_logs",
    description: "Read system log entries. Available log types: nginx_access, nginx_error, fail2ban, system.",
    input_schema: {
      type: "object",
      properties: {
        log_type: {
          type: "string",
          enum: ["nginx_access", "nginx_error", "fail2ban", "system"],
          description: "Type of log to read",
        },
        lines: {
          type: "number",
          description: "Number of log lines to retrieve (default: 50, max: 200)",
        },
      },
      required: ["log_type"],
    },
  },
  {
    name: "unban_ip",
    description: "Unban an IP address from a specific fail2ban jail.",
    input_schema: {
      type: "object",
      properties: {
        ip: { type: "string", description: "The IP address to unban" },
        jail: { type: "string", description: "The fail2ban jail name" },
      },
      required: ["ip", "jail"],
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "get_services_status": {
        const services = await storage.getServices();
        return JSON.stringify(services, null, 2);
      }
      case "get_stats": {
        const stats = await storage.getStats();
        return JSON.stringify(stats, null, 2);
      }
      case "get_banned_ips": {
        const ips = await storage.getBannedIps();
        return JSON.stringify(ips, null, 2);
      }
      case "get_logs": {
        const logType = input.log_type as string;
        const lines = Math.min(Number(input.lines ?? 50), 200);
        const logs = await storage.getLogs(logType, lines);
        return JSON.stringify(logs, null, 2);
      }
      case "unban_ip": {
        const ip = input.ip as string;
        const jail = input.jail as string;
        await storage.unbanIp(ip, jail);
        return JSON.stringify({ success: true, message: `IP ${ip} unbanned from jail ${jail}` });
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg });
  }
}

// ─── Streaming agent ──────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function* streamProxyGuardianResponse(
  history: ChatMessage[],
  userMessage: string,
): AsyncGenerator<string> {
  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  const system = `You are ProxyGuardian AI, an intelligent assistant embedded in the ProxyGuardian dashboard — a proxy infrastructure management system built around nginx and fail2ban on Ubuntu/Linux.

Your capabilities:
- Check service health (nginx, fail2ban, mariadb)
- Inspect system statistics and traffic data
- List and manage banned IPs
- Read system logs (nginx access/error, fail2ban, system)
- Unban IP addresses when requested and justified

Your expertise covers:
- nginx configuration, reverse proxying, rate limiting, ModSecurity WAF
- fail2ban jails, filters, and ban management
- Linux server security and hardening
- Network traffic analysis and anomaly detection
- DDoS mitigation and IP reputation

Always use the available tools to fetch live data before answering questions about system state. Be concise and security-focused. When unbanning an IP, always confirm the action explicitly with the user before proceeding unless they have clearly stated the IP and jail.

Respond in the same language the user is using (Italian or English).`;

  while (true) {
    const stream = client.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system,
      messages,
      tools,
    });

    let fullText = "";
    let fullContent: Anthropic.ContentBlock[] = [];

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
        fullText += event.delta.text;
      }
    }

    const finalMessage = await stream.finalMessage();
    fullContent = finalMessage.content;

    if (finalMessage.stop_reason === "end_turn") break;

    if (finalMessage.stop_reason !== "tool_use") break;

    // Handle tool calls
    const toolUseBlocks = fullContent.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    messages.push({ role: "assistant", content: fullContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUseBlocks) {
      yield `\n\n*[Tool: ${tool.name}]*\n`;
      const result = await executeTool(tool.name, tool.input as Record<string, unknown>);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tool.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}
