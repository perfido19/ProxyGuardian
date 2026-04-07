import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Ban, Search } from "lucide-react";
import type { BannedIp } from "@shared/schema";
import { IpCell } from "@/components/ip-cell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface BannedIpsTableProps {
  bannedIps: BannedIp[];
  onUnban: (ip: string, jail: string) => void;
  isUnbanning?: boolean;
}

export function BannedIpsTable({ bannedIps, onUnban, isUnbanning }: BannedIpsTableProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [unbanDialog, setUnbanDialog] = useState<{ ip: string; jail: string } | null>(null);

  const filteredIps = bannedIps.filter(
    (item) =>
      item.ip.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.jail.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleUnban = () => {
    if (unbanDialog) {
      onUnban(unbanDialog.ip, unbanDialog.jail);
      setUnbanDialog(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Cerca IP o jail..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-9"
          data-testid="input-search-banned"
        />
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="font-semibold">Indirizzo IP</TableHead>
              <TableHead className="font-semibold">Jail</TableHead>
              <TableHead className="font-semibold">Data Ban</TableHead>
              <TableHead className="font-semibold">Tempo Rimasto</TableHead>
              <TableHead className="font-semibold">Motivo</TableHead>
              <TableHead className="text-right font-semibold">Azioni</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredIps.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  {searchTerm ? "Nessun IP trovato" : "Nessun IP bannato"}
                </TableCell>
              </TableRow>
            ) : (
              filteredIps.map((item, idx) => (
                <TableRow key={`${item.ip}-${item.jail}-${idx}`} data-testid={`row-banned-${idx}`}>
                  <TableCell data-testid={`ip-${idx}`}>
                    <IpCell ip={item.ip} />
                  </TableCell>
                  <TableCell className="font-mono text-sm" data-testid={`jail-${idx}`}>
                    {item.jail}
                  </TableCell>
                  <TableCell className="text-sm">{item.banTime}</TableCell>
                  <TableCell className="text-sm">{item.timeLeft || 'N/A'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {item.reason || 'N/A'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setUnbanDialog({ ip: item.ip, jail: item.jail })}
                      disabled={isUnbanning}
                      data-testid={`button-unban-${idx}`}
                    >
                      <Ban className="w-3 h-3 mr-1" />
                      Sblocca
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!unbanDialog} onOpenChange={(open) => !open && setUnbanDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Conferma Sblocco IP</AlertDialogTitle>
            <AlertDialogDescription>
              Sei sicuro di voler sbloccare l'IP{" "}
              <span className="font-mono font-semibold">{unbanDialog?.ip}</span> dalla jail{" "}
              <span className="font-mono font-semibold">{unbanDialog?.jail}</span>?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-unban">Annulla</AlertDialogCancel>
            <AlertDialogAction onClick={handleUnban} data-testid="button-confirm-unban">
              Sblocca
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
