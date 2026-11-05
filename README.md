# QR-Order — API

API REST + WebSocket de la plateforme QR-Order (commande par QR code pour la restauration).
NestJS 11 · TypeScript · Prisma 6 · MySQL 8 · Socket.IO.

## Démarrage

Prérequis : Node.js 20+, MySQL 8 (Laragon en local).

```bash
npm install
cp .env.example .env            # puis renseigner les secrets (32 caractères minimum)
npx prisma migrate dev          # crée la base qr_order et applique les migrations
npm run start:dev               # http://localhost:3000/api/v1
```

- Documentation Swagger : `http://localhost:3000/api/docs`
- Santé : `GET /api/v1/health`
- Temps réel : Socket.IO, namespace `/realtime`

Premier super-admin (aucune route d'API ne le permet, c'est volontaire) :

```bash
npm run build
SUPER_ADMIN_PASSWORD='…' npm run admin:create -- admin@exemple.com
```

## Commandes

| Commande | Rôle |
|---|---|
| `npm run start:dev` | API en mode développement (rechargement à chaud) |
| `npm test` | Tests unitaires |
| `npm run test:e2e` | Tests e2e — applique les migrations sur `qr_order_test` (`.env.test`) |
| `npm run lint` | ESLint + Prettier |
| `npm run db:migrate` | Nouvelle migration Prisma |
| `npm run db:backup` | Sauvegarde compressée de la base, rétention 30 jours |
| `npm run admin:create` | Crée ou promeut un super-admin |

## Organisation

| Dossier | Module du cahier des charges |
|---|---|
| `src/auth` | 1 — Authentification, JWT + refresh rotatif, OTP, RBAC et permissions dynamiques |
| `src/restaurants` | 2 — Établissements, réglages, taxes, horaires, dashboard |
| `src/menu` | 3 — Catégories, articles, options, disponibilité, menu public |
| `src/orders` | 4 — Commandes, workflow, totaux, idempotence, historique |
| `src/tables` | 5 — Zones, tables, QR codes signés |
| `src/payments` | 6 — Espèces, Stripe Connect, mobile money, remboursements, reçus |
| `src/billing` | 6 — Forfaits, abonnements SaaS, quotas |
| `src/team` | 7 — Invitations, hiérarchie, révocation |
| `src/realtime` | 8 — Socket.IO, journal d'événements et rattrapage |
| `src/admin` | 9 — Administration plateforme |
| `src/privacy`, `src/audit` | 14 — Données personnelles, journal d'audit inaltérable |

## Principes

- **Multi-tenant** : toute route `/restaurants/:restaurantId/...` passe par `TenantGuard` (appartenance relue à chaque requête) puis `AccessGuard` (rôle + permissions). Un non-membre reçoit 404.
- **Montants** en entiers, dans la plus petite unité de la devise.
- **Erreurs** au format `{ statusCode, code, message, details }`.
- **Idempotence** : en-tête `Idempotency-Key` obligatoire sur la création de commandes et de paiements.
- **Journal d'audit** en ajout seul, protégé par des triggers MySQL. Avec la journalisation binaire activée, la création de triggers demande le privilège `SUPER` ou `log_bin_trust_function_creators = 1` : à vérifier chez l'hébergeur.
- **Simulateur de paiement** (`PAYMENTS_SANDBOX_ENABLED`) : réservé au développement et aux tests ; l'application refuse de démarrer s'il est activé en production.
