import {
  BadRequestException,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { memoryStorage } from 'multer';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ImageService, MAX_IMAGE_BYTES } from '../storage/image.service';
import { StorageService } from '../storage/storage.service';

/** Taille maximale (plus grand côté) selon l'usage. */
const MAX_SIDE = { logo: 512, banner: 1920 } as const;

/**
 * Envoi du logo ou de la bannière du restaurant (RES-02). Renvoie l'URL
 * publique, à enregistrer ensuite via PATCH /restaurants/:id/branding.
 */
@ApiTags('Restaurants')
@ApiBearerAuth()
@Controller('restaurants/:restaurantId/branding/images')
export class RestaurantImagesController {
  constructor(
    private readonly images: ImageService,
    private readonly storage: StorageService,
  ) {}

  @Post()
  @RequirePermissions('restaurant.update')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @ApiQuery({ name: 'kind', enum: ['logo', 'banner'] })
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
    @Query('kind') kind: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (kind !== 'logo' && kind !== 'banner') {
      throw new BadRequestException({
        code: 'INVALID_KIND',
        message: 'Type d’image attendu : logo ou banner',
      });
    }
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Aucune image reçue (champ « file »)',
      });
    }
    const image = await this.images.toWebp(file, MAX_SIDE[kind]);
    const url = await this.storage.put(
      `restaurants/${restaurantId}/branding/${kind}-${randomUUID()}.webp`,
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
