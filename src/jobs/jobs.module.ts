import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { IntegrationsModule } from '../integrations/integrations.module';
import { PaymentsModule } from '../payments/payments.module';
import { JobLockService } from './job-lock.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [ScheduleModule.forRoot(), IntegrationsModule, PaymentsModule],
  controllers: [JobsController],
  providers: [JobsService, JobLockService, MaintenanceService],
})
export class JobsModule {}
