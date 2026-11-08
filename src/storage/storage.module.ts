import { Global, Module } from '@nestjs/common';
import { ImageService } from './image.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [StorageService, ImageService],
  exports: [StorageService, ImageService],
})
export class StorageModule {}
