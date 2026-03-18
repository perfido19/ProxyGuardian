# Frontend — React + TypeScript + Shadcn/ui

## Stack locale
- React 18 + TypeScript (strict)
- Vite (bundler)
- Shadcn/ui + Tailwind CSS
- React Query (server state)
- React Router (routing)

## Component Rules
- Usare sempre componenti Shadcn/ui come base (`Button`, `Dialog`, `Table`, `Badge`, ecc.)
- Props sempre tipizzate — interfaccia esplicita per ogni componente
- Componenti in PascalCase, file in kebab-case: `VpsStatusCard.tsx` → `vps-status-card.tsx`
- Nessuna chiamata fetch/axios nei componenti → solo tramite hooks in `hooks/`

## State Management
- Server state → React Query (`useQuery`, `useMutation`)
- UI state locale → `useState` / `useReducer`
- Nessuno stato globale custom salvo casi eccezionali (concordare prima)

## Role-based UI
- Usare il hook `useAuth()` per leggere ruolo corrente
- Nascondere/disabilitare azioni non permesse in base al ruolo:
  - `viewer`: solo visualizzazione
  - `operator`: azioni su nginx/fail2ban
  - `admin`: tutto + gestione utenti e configurazioni

## API Client
- Tutte le chiamate API passano per `lib/api-client.ts`
- Tipi di risposta definiti in `types/api.ts` (sincronizzato col backend)
- Gestione errori centralizzata nel client — non duplicare nei componenti

## Bulk Operations Page
- Ogni operazione bulk mostra progress real-time (stato per VPS)
- Risultato finale: tabella con `vpsId | status | error`
- Conferma dialog obbligatoria prima di eseguire su tutti i VPS
