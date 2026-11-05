import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitationsController, TeamController } from './team.controller';
import { TeamService } from './team.service';

@Module({
  imports: [AuthModule],
  controllers: [TeamController, InvitationsController],
  providers: [TeamService],
})
export class TeamModule {}
