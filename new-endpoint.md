# New Backend Endpoint

Crea un nuovo endpoint Express per l'orchestrator seguendo le convenzioni di ProxyGuardian.

**Ruolo minimo richiesto:** $ARGUMENTS

## Checklist obbligatoria
1. Route in `backend/src/routes/`
2. Schema zod per validazione input
3. Service in `backend/src/services/`
4. Risposta strutturata `{ success, data }` / `{ success, error }`
5. Middleware `requireRole('$ARGUMENTS')` applicato
6. Aggiornare `backend/src/types/api.ts` con i nuovi tipi
7. Registrare la route in `backend/src/app.ts`

Genera tutti i file necessari con path relativi corretti.
