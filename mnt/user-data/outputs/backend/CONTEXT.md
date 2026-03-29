# Backend — Express.js Orchestrator

## Stack locale
- Express.js + TypeScript
- MariaDB (mysql2/promise)
- express-session (auth)
- zod (validazione)
- helmet + rate-limit (security)

## Request Lifecycle
```
Request → auth middleware → role check → zod validation → service → db → response
```

## Route Template
```typescript
// routes/example.ts
import { Router } from 'express';
import { requireRole } from '../middleware/auth';
import { exampleSchema } from '../schemas/example';
import { exampleService } from '../services/example';

const router = Router();

router.post('/', requireRole('operator'), async (req, res) => {
  const parsed = exampleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error });

  const result = await exampleService.doSomething(parsed.data);
  res.json({ success: true, data: result });
});

export default router;
```

## Response Format
Sempre strutturato:
```typescript
// Success
{ success: true, data: T }
// Error
{ success: false, error: string | ZodError }
```

## Database
- Driver: `mysql2/promise`
- Query sempre parametrizzate: `db.execute('SELECT * FROM vps WHERE id = ?', [id])`
- Nessuna interpolazione di stringhe nelle query — SQL injection zero tolerance
- Pool di connessioni configurato in `db/pool.ts`

## Auth Middleware
- `requireRole('viewer' | 'operator' | 'admin')` — non modificare senza conferma
- Sessione utente disponibile in `req.session.user`
- API key per agent-to-orchestrator in header `X-API-Key`

## Agent Communication
- Base URL agenti: `http://{netbird_ip}:3001`
- Timeout: 10 secondi per richiesta
- Retry: 1 tentativo automatico in caso di timeout
- Bulk: max 5 VPS in parallelo (`Promise.allSettled` con concorrenza limitata)

## Logging
- Nessun log di secrets, API key, password
- Log strutturato: `[timestamp] [level] [area] messaggio`
