import { config } from 'dotenv';

// Charge .env.test avant tout import de l'application (Prisma lit DATABASE_URL au démarrage).
config({ path: '.env.test', override: true, quiet: true });
process.env.NODE_ENV = 'test';

if (!process.env.DATABASE_URL?.includes('_test')) {
  throw new Error('Les tests e2e doivent utiliser une base de test (*_test)');
}
