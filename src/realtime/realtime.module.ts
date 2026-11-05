import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeController } from './realtime.controller';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/** Global : tout module métier peut diffuser un événement via RealtimeService. */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [RealtimeController],
  providers: [RealtimeService, RealtimeGateway],
  exports: [RealtimeService],
})
export class RealtimeModule {}
