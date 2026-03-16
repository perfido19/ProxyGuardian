import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Download, Pause, Play } from "lucide-react";
import type { LogEntry } from "@shared/schema";
import { Badge } from "@/components/ui/badge";

interface LogViewerProps {
  logs: LogEntry[];
  title: string;
  testId?: string;
}

const levelColors = {
  ERROR: "bg-red-500/10 text-red-700 dark:text-red-400",
  WARN: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  INFO: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  DEBUG: "bg-gray-500/10 text-gray-700 dark:text-gray-400",
};

export function LogViewer({ logs, title, testId }: LogViewerProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = logs.filter((log) =>
    log.message.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleDownload = () => {
    const content = logs.map(log => 
      `${log.timestamp} ${log.level ? `[${log.level}]` : ''} ${log.message}`
    ).join('\n');
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Cerca nei log..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
            data-testid={`input-search-${testId}`}
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setAutoScroll(!autoScroll)}
            data-testid={`button-autoscroll-${testId}`}
          >
            {autoScroll ? <Pause className="w-4 h-4 mr-1" /> : <Play className="w-4 h-4 mr-1" />}
            {autoScroll ? 'Pausa' : 'Auto-scroll'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDownload}
            data-testid={`button-download-${testId}`}
          >
            <Download className="w-4 h-4 mr-1" />
            Scarica
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="h-96 bg-card border rounded-md overflow-auto font-mono text-xs"
        data-testid={`log-container-${testId}`}
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            {searchTerm ? "Nessun log trovato" : "Nessun log disponibile"}
          </div>
        ) : (
          <div className="p-4 space-y-1">
            {filteredLogs.map((log, idx) => (
              <div
                key={idx}
                className="flex gap-2 py-1 hover-elevate rounded px-2 -mx-2"
                data-testid={`log-entry-${idx}`}
              >
                {log.line && (
                  <span className="text-muted-foreground select-none w-12 text-right flex-shrink-0">
                    {log.line}
                  </span>
                )}
                <span className="text-muted-foreground flex-shrink-0">
                  {log.timestamp}
                </span>
                {log.level && (
                  <Badge
                    variant="secondary"
                    className={`${levelColors[log.level]} flex-shrink-0 px-2 py-0 text-xs`}
                  >
                    {log.level}
                  </Badge>
                )}
                <span className="break-all">{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
