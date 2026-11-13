import { Global, Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PlatformSettingsService } from './platform-settings.service';

/** Global : les quotas sont vérifiés par les modules Restaurants, Tables et Équipe. */
@Global()
@Module({
  controllers: [BillingController],
  providers: [BillingService, PlatformSettingsService],
  exports: [BillingService, PlatformSettingsService],
})
export class BillingModule {}
