import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsUrl, MaxLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { memoryStorage } from 'multer';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ImageService, MAX_IMAGE_BYTES } from '../storage/image.service';
import { RemoteImageService } from '../storage/remote-image.service';
import { StorageService } from '../storage/storage.service';

export class ImageFromUrlDto {
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(2000)
  url: string;
}

/** Types acceptés tels quels ; les autres images (gif, jpg…) sont confiées à sharp, qui vérifie le contenu réel. */
const NATIVE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
];

/**
 * Photos des plats (MEN-02) : envoi d'un fichier, ou récupération depuis un
 * lien (import de menu). Dans les deux cas, l'image est recompressée et
 * hébergée par QR-Order ; la réponse donne l'URL publique à placer dans `images`.
 */
@ApiTags('Menu')
@ApiBearerAuth()
@Controller('restaurants/:restaurantId/menu/images')
export class MenuImagesController {
  constructor(
    private readonly images: ImageService,
    private readonly remote: RemoteImageService,
    private readonly storage: StorageService,
  ) {}

  @Post()
  @RequirePermissions('menu.manage')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
    }),
  )
  async upload(
    @Param('restaurantId', ParseUUIDPipe) restaurantId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Aucune image reçue (champ « file »)',
      });
    }
    return this.store(restaurantId, file);
  }

  /** Récupère une image à partir d'un lien (https, Google Drive, Dropbox) et l'héberge. */
  @Post('from-url')
  @RequirePermissions('menu.manage')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async fromUrl(
    @Param('restaurantId', ParseUUIDPipe) restaurantId: string,
    @Body() dto: ImageFromUrlDto,
  ) {
    // Déjà hébergée par QR-Order : rien à télécharger.
    if (this.storage.owns(dto.url)) return { url: dto.url };
    const file = await this.remote.download(dto.url);
    return this.store(restaurantId, {
      ...file,
      mimetype: NATIVE_TYPES.includes(file.mimetype)
        ? file.mimetype
        : 'image/jpeg',
    });
  }

  private async store(
    restaurantId: string,
    file: { buffer: Buffer; mimetype: string; size: number },
  ) {
    const image = await this.images.toWebp(file);
    const url = await this.storage.put(
      `restaurants/${restaurantId}/menu/${randomUUID()}.webp`,
      image.data,
    );
    return {
      url,
      width: image.width,
      height: image.height,
      size: image.data.length,
    };
  }
}
