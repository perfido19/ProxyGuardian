# Security Review

Esegui una security review del codice o della feature specificata.

**Target:** $ARGUMENTS

## Checklist review

### Input / Output
- [ ] Tutti gli input validati con zod o equivalente
- [ ] Nessuna interpolazione di stringhe in query SQL
- [ ] Output sanitizzato prima di restituire al client

### Auth & Authz
- [ ] Ogni endpoint ha il middleware `requireRole` corretto
- [ ] API key agent verificata su tutte le route agente
- [ ] Nessun endpoint accessibile senza autenticazione (salvo `/health`, `/login`)

### Secrets
- [ ] Nessun secret hardcoded nel codice
- [ ] `.env` non committato
- [ ] Nessun log di API key, password, token

### Networking
- [ ] Agente non esposto su IP pubblici
- [ ] Whitelist NetBird applicata prima di operazioni fail2ban
- [ ] Timeout configurati per chiamate agli agenti

### Comandi shell (solo agent)
- [ ] `execFile` usato (non `exec`)
- [ ] Argomenti passati come array, non come stringa interpolata
- [ ] Timeout per ogni comando shell

Riporta i problemi trovati con severity: CRITICAL / HIGH / MEDIUM / LOW.
