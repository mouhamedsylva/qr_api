import { BadRequestException, Injectable } from '@nestjs/common';
import sharp from 'sharp';

/** Taille maximale d'un fichier envoyé (avant recompression). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
];

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Normalisation des photos envoyées : le fichier est réellement décodé (un
 * fichier qui n'est pas une image est refusé, quel que soit son type
 * annoncé), redressé selon l'EXIF, réduit à 1600 px et recompressé en WebP.
 * Les métadonnées (dont la position GPS des photos de téléphone) sont retirées.
 * Une photo de 4 Mo passe ainsi à ~150 Ko, adapté aux réseaux mobiles.
 */
@Injectable()
export class ImageService {
  async toWebp(
    file: { buffer: Buffer; mimetype: string; size: number },
    maxSide = 1600,
  ): Promise<ProcessedImage> {
    if (!ACCEPTED_TYPES.includes(file.mimetype)) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_IMAGE',
        message:
          'Format non pris en charge : envoyez une photo JPEG, PNG ou WebP',
      });
    }
    try {
      const { data, info } = await sharp(file.buffer, {
        failOn: 'error',
        limitInputPixels: 50_000_000,
      })
        .rotate()
        .resize({
          width: maxSide,
          height: maxSide,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height };
    } catch {
      throw new BadRequestException({
        code: 'INVALID_IMAGE',
        message: 'Image illisible : envoyez une photo JPEG, PNG ou WebP',
      });
    }
  }
}
