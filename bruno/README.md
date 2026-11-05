# Collection Bruno — QR-Order API

Parcours complet de l'API en **137 requêtes et 193 tests**, rangées dans l'ordre d'utilisation réel : inscription d'un restaurateur, menu, tables, commande client, cuisine, paiement, avis, fidélité, intégrations, administration, puis cas d'erreur.

Chaque requête enregistre ce dont les suivantes ont besoin (jetons, identifiants, code reçu par email). La collection peut être rejouée autant de fois que voulu : emails, téléphone et codes promo sont générés à chaque exécution.

## 1. Prérequis (une seule fois)

1. **Laragon** : démarrer **MySQL** et **Mailpit** (emails de test, interface http://localhost:8025).
2. **API** à jour et lancée :
   ```powershell
   cd qr_api
   npx prisma migrate deploy
   npm run start:dev
   ```
3. **Super-admin** (requis par le dossier 03). PowerShell :
   ```powershell
   npm run build
   $env:SUPER_ADMIN_PASSWORD = 'VotreMotDePasse2026'
   npm run admin:create -- admin@qr-order.local
   ```
4. **Bruno** : https://www.usebruno.com/downloads, puis *Open Collection* → dossier `qr_api/bruno`.
5. En haut à droite, choisir l'environnement **Local**, puis *Configure* → renseigner la variable secrète **adminPassword** (elle n'est jamais écrite dans les fichiers).

## 2. Lancer les tests

- **Tout le parcours** : clic droit sur la collection → *Run* → *Run Collection*. Le rapport liste chaque requête et chaque test.
- **Un dossier** : clic droit sur le dossier → *Run*.
- **Une requête seule** : possible une fois le parcours exécuté au moins jusqu'au dossier concerné, car elle réutilise les variables (jetons, identifiants) déjà enregistrées.
- **Depuis le terminal** (même résultat, utile en intégration continue) :
  ```powershell
  cd qr_api/bruno
  npx @usebruno/cli run -r --env Local --env-var "adminPassword=VotreMotDePasse2026"
  ```

## 3. Contenu

| Dossier | Ce qui est testé |
|---|---|
| 00 · Préparation | Santé de l'API, grille tarifaire, génération des identifiants de l'exécution |
| 01 · Authentification | Inscription, connexion, rotation des jetons, vérification de l'email avec le code lu dans Mailpit |
| 02 · Restaurant | Profil, identité visuelle, régional, TVA, horaires, fermetures, dashboard, page publique |
| 03 · Administration | Super-admin : forfait Premium, recherche, indicateurs, forfaits, journal d'audit |
| 04 · Équipe | Invitation, acceptation, lien à usage unique, droits par membre |
| 05 · Menu | Catégories, plat avec options obligatoires, épuisé / disponible, menu public |
| 06 · Tables et QR | Zone, tables par lot, QR signé, image, scan public, QR falsifié |
| 07 · Client, promo, fidélité | Compte client, code promo, programme de points, récompense |
| 08 · Commandes | Devis, commande à table avec promo, idempotence, ajout d'articles, workflow, export |
| 09 · Cuisine | Poste, tickets, lancement, priorité, « tout prêt » |
| 10 · Paiements | Espèces, Wave (simulateur), reçu, double paiement refusé, remboursement |
| 11 · Avis et fidélité | Avis unique, réponse, note moyenne, points, échange, re-commande |
| 12 · Analytics | Vue d'ensemble, marges, TVA, CSV |
| 13 · Intégrations | Clé d'API, API publique, webhook, liens, export comptable |
| 14 · Supervision | Rattrapage temps réel, journal d'activité, tâches planifiées |
| 15 · Sécurité | Sans jeton, mauvais rôle, autre restaurant, champs inconnus, faux jetons |
| 16 · Fin de parcours | Export et anonymisation des données, mot de passe oublié, déconnexion, suppression de compte |

Chaque requête a un onglet **Docs** qui explique ce qu'elle vérifie et l'exigence du cahier des charges concernée.

## 4. Bon à savoir

- **Rôles** : la collection manipule quatre jetons — propriétaire (`ownerToken`), serveur (`staffToken`), client (`customerToken`) et super-admin (`adminToken`). Les requêtes de sécurité vérifient qu'un rôle ne peut pas faire ce qui ne le concerne pas.
- **Webhooks** : par défaut, `webhookUrl` pointe vers une adresse qui répond 404, pour voir les nouvelles tentatives. Pour voir les envois réels, créez une URL sur https://webhook.site et mettez-la dans l'environnement.
- **Temps réel** : les événements passent par Socket.IO (namespace `/realtime`). Bruno sait aussi ouvrir des connexions WebSocket, mais le parcours vérifie le temps réel via la route de rattrapage (`14 · Supervision`).
- **Emails** : tous les emails (codes, reçus, relances) sont visibles dans Mailpit, http://localhost:8025.
- **Données** : chaque exécution crée un nouveau restaurant dans la base de développement `qr_order`.
- **Trop de requêtes (429)** : la connexion est limitée à 5 essais par minute et par adresse IP. En cas de 429 après plusieurs lancements rapprochés, patientez une minute.
