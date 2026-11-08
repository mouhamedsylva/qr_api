import {
  BadRequestException,
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
import { randomUUID } from 'node:crypto';
import { memoryStorage } from 'multer';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ImageService, MAX_IMAGE_BYTES } from '../storage/image.service';
import { StorageService } from '../storage/storage.service';

/**
 * Envoi de la photo d'un plat (MEN-02). Renvoie l'URL publique à placer dans
 * `images` lors de la création ou de la modification de l'article.
 */
@ApiTags('Menu')
@ApiBearerAuth()
@Controller('restaurants/:restaurantId/menu/images')
export class MenuImagesController {
  constructor(
    private readonly images: ImageService,
    private readonly storage: StorageService,
  ) {}

  @Post()
  @RequirePermissions('menu.manage')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
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
