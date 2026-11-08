import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** Préfixe public des fichiers servis par l'API (voir app.setup.ts). */
export const UPLOADS_ROUTE = '/uploads';

/**
 * Stockage des fichiers envoyés (photos des plats).
 * Implémentation actuelle : disque local (UPLOADS_DIR), servi par l'API sous
 * /uploads. Pour la production multi-instances, remplacer par un stockage
 * objet (S3, Cloudflare R2…) en gardant la même interface : put / remove.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  readonly root: string;
  private readonly publicBase: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('UPLOADS_DIR') ?? 'uploads');
    const apiUrl =
      config.get<string>('PUBLIC_API_URL') ??
      `http://localhost:${config.get<number>('PORT') ?? 3000}`;
    this.publicBase = `${apiUrl.replace(/\/+$/, '')}${UPLOADS_ROUTE}`;
  }

  /** Enregistre un fichier et renvoie son URL publique. `key` : chemin relatif, ex. restaurants/<id>/menu/<uuid>.webp */
  async put(key: string, data: Buffer): Promise<string> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return `${this.publicBase}/${key}`;
  }

  /** Supprime un fichier à partir de son URL publique ; sans effet si l'URL n'est pas de ce stockage. */
  async remove(url: string): Promise<void> {
    if (!url.startsWith(`${this.publicBase}/`)) return;
    try {
      await unlink(this.pathOf(url.slice(this.publicBase.length + 1)));
    } catch (err) {
      this.logger.warn(
        `Suppression impossible de ${url} : ${(err as Error).message}`,
      );
    }
  }

  /** L'URL appartient-elle à ce stockage ? */
  owns(url: string): boolean {
    return url.startsWith(`${this.publicBase}/`);
  }

  /** Chemin absolu, en refusant toute sortie du dossier racine (« ../ »). */
  private pathOf(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep))
      throw new Error(`Clé de stockage invalide : ${key}`);
    return path;
  }
}
