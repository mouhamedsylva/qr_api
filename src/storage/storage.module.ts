import { Global, Module } from '@nestjs/common';
import { ImageService } from './image.service';
import { RemoteImageService } from './remote-image.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [StorageService, ImageService, RemoteImageService],
  exports: [StorageService, ImageService, RemoteImageService],
})
export class StorageModule {}
