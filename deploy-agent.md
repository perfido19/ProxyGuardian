# Deploy Agent su VPS

Genera la procedura e i file necessari per deployare l'agente ProxyGuardian su un nuovo VPS.

**VPS target:** $ARGUMENTS

## Output richiesto
1. Script bash di deploy completo per il VPS specificato
2. File `.env.example` aggiornato se mancano variabili
3. Comando PM2 / systemd unit file per avvio automatico
4. Checklist post-deploy da verificare manualmente:
   - Binding solo su NetBird IP ✓
   - API key configurata ✓
   - Whitelist NetBird IPs configurata ✓
   - Health check risponde ✓
   - VPS registrato nel db orchestrator ✓
