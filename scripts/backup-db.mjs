#!/usr/bin/env node
/**
 * Sauvegarde de la base (CON-05) : dump compressé horodaté, rétention
 * paramétrable (30 jours par défaut). À planifier quotidiennement
 * (Planificateur de tâches Windows, cron, ou tâche de l'hébergeur).
 *
 *   node scripts/backup-db.mjs
 *
 * Variables : DATABASE_URL (lue dans .env si absente), BACKUP_DIR (./backups),
 * BACKUP_RETENTION_DAYS (30), MYSQLDUMP_PATH (mysqldump).
 *
 * Restauration (à tester chaque trimestre sur une base dédiée) :
 *   gunzip -c backups/<fichier>.sql.gz | mysql -u root qr_order_restore
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (existsSync('.env')) {
    const line = readFileSync('.env', 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('DATABASE_URL='));
    if (line) return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
  }
  throw new Error('DATABASE_URL introuvable');
}

const url = new URL(loadDatabaseUrl());
const database = url.pathname.replace(/^\//, '');
const backupDir = process.env.BACKUP_DIR ?? 'backups';
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const target = join(backupDir, `${database}-${stamp}.sql.gz`);

mkdirSync(backupDir, { recursive: true });

const args = [
  `--host=${url.hostname}`,
  `--port=${url.port || 3306}`,
  `--user=${decodeURIComponent(url.username)}`,
  '--single-transaction', // cohérent sans bloquer l'application
  '--routines',
  '--triggers', // inclut la protection du journal d'audit
  '--set-gtid-purged=OFF',
  database,
];
// Le mot de passe passe par l'environnement, jamais par la ligne de commande.
const env = { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) };

const dump = spawn(process.env.MYSQLDUMP_PATH ?? 'mysqldump', args, { env });
let stderr = '';
dump.stderr.on('data', (d) => (stderr += d));
const exited = new Promise((resolve) => dump.on('close', resolve));

await pipeline(dump.stdout, createGzip(), createWriteStream(target));
const code = await exited;
if (code !== 0) {
  unlinkSync(target);
  console.error(`Échec de mysqldump (code ${code}) :\n${stderr}`);
  process.exit(1);
}
console.log(`Sauvegarde écrite : ${target}`);

// Rétention : suppression des sauvegardes plus anciennes que la limite.
const limit = Date.now() - retentionDays * 86_400_000;
for (const file of readdirSync(backupDir)) {
  const path = join(backupDir, file);
  if (file.startsWith(`${database}-`) && file.endsWith('.sql.gz') && statSync(path).mtimeMs < limit) {
    unlinkSync(path);
    console.log(`Sauvegarde expirée supprimée : ${file}`);
  }
}
