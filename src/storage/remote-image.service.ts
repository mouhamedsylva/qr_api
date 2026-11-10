import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { MAX_IMAGE_BYTES } from './image.service';
import { directImageUrl, isForbiddenIp } from './remote-image.util';

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_429_RETRIES = 2;
const USER_AGENT = 'QR-Order/1.0 (import de menu)';

export interface DownloadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

class RemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/**
 * Résolution DNS filtrée, appliquée au moment de la connexion : une adresse
 * privée ou locale est refusée même si le nom change d'adresse entre une
 * vérification et l'appel (DNS rebinding).
 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses;
    const allowed = list.filter((a) => !isForbiddenIp(a.address));
    if (!allowed.length) {
      return callback(
        new RemoteError('IMAGE_URL_FORBIDDEN', 'Adresse non autorisée'),
        '',
        0,
      );
    }
    if ((options as { all?: boolean }).all) {
      return callback(null, allowed);
    }
    callback(null, allowed[0].address, allowed[0].family);
  });
};

/**
 * Téléchargement d'une image depuis un lien (import de menu) : liens de
 * partage Google Drive / Dropbox convertis, réseaux internes refusés,
 * redirections limitées et revérifiées, taille et durée bornées.
 */
@Injectable()
export class RemoteImageService {
  private readonly logger = new Logger(RemoteImageService.name);

  async download(rawUrl: string): Promise<DownloadedImage> {
    let url: URL;
    try {
      url = new URL(directImageUrl(rawUrl));
    } catch {
      throw this.fail('IMAGE_URL_INVALID', 'Lien d’image invalide');
    }

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.fetchFollowing(url);
      } catch (err) {
        if (
          err instanceof RemoteError &&
          err.code === 'RATE_LIMITED' &&
          attempt < MAX_429_RETRIES
        ) {
          await new Promise((r) =>
            setTimeout(r, Math.min(err.retryAfter ?? 3, 10) * 1000),
          );
          continue;
        }
        if (err instanceof RemoteError) {
          const code =
            err.code === 'RATE_LIMITED' ? 'IMAGE_DOWNLOAD_FAILED' : err.code;
          throw this.fail(code, err.message);
        }
        this.logger.debug(
          `Téléchargement impossible (${url.host}) : ${(err as Error).message}`,
        );
        throw this.fail(
          'IMAGE_DOWNLOAD_FAILED',
          'Image injoignable à cette adresse',
        );
      }
    }
  }

  private fail(code: string, message: string) {
    return new BadRequestException({ code, message });
  }

  /** Suit au plus MAX_REDIRECTS redirections, chacune revérifiée. */
  private async fetchFollowing(start: URL): Promise<DownloadedImage> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new RemoteError(
          'IMAGE_URL_INVALID',
          'Seuls les liens http(s) sont acceptés',
        );
      }
      // Adresse IP écrite en clair : Node ne passe pas par `lookup`, on vérifie ici.
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) && isForbiddenIp(host)) {
        throw new RemoteError('IMAGE_URL_FORBIDDEN', 'Adresse non autorisée');
      }
      const result = await this.request(url);
      if ('redirect' in result) {
        url = new URL(result.redirect, url);
        continue;
      }
      return result;
    }
    throw new RemoteError('IMAGE_DOWNLOAD_FAILED', 'Trop de redirections');
  }

  private request(url: URL): Promise<DownloadedImage | { redirect: string }> {
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.get(
        url,
        {
          lookup: safeLookup,
          timeout: TIMEOUT_MS,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'image/avif,image/webp,image/*;q=0.9',
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            return resolve({ redirect: res.headers.location });
          }
          if (status === 429) {
            res.resume();
            const retry = Number(res.headers['retry-after']);
            return reject(
              new RemoteError(
                'RATE_LIMITED',
                'Le site d’origine limite les téléchargements',
                retry || undefined,
              ),
            );
          }
          if (status !== 200) {
            res.resume();
            return reject(
              new RemoteError(
                'IMAGE_DOWNLOAD_FAILED',
                `Le site d’origine a répondu ${status}`,
              ),
            );
          }
          const mimetype = String(res.headers['content-type'] ?? '')
            .split(';')[0]
            .trim()
            .toLowerCase();
          if (!mimetype.startsWith('image/')) {
            res.resume();
            return reject(
              new RemoteError(
                'IMAGE_DOWNLOAD_FAILED',
                'Ce lien ne pointe pas vers une image',
              ),
            );
          }
          const declared = Number(res.headers['content-length']);
          if (declared > MAX_IMAGE_BYTES) {
            res.destroy();
            return reject(
              new RemoteError(
                'IMAGE_TOO_LARGE',
                'Image trop volumineuse (10 Mo maximum)',
              ),
            );
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_IMAGE_BYTES) {
              res.destroy();
              reject(
                new RemoteError(
                  'IMAGE_TOO_LARGE',
                  'Image trop volumineuse (10 Mo maximum)',
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({ buffer: Buffer.concat(chunks), mimetype, size }),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () =>
        req.destroy(
          new RemoteError(
            'IMAGE_DOWNLOAD_FAILED',
            'Le site d’origine ne répond pas',
          ),
        ),
      );
      req.on('error', reject);
    });
  }
}
