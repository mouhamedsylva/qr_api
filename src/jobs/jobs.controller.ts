import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SuperAdminOnly } from '../common/decorators/super-admin.decorator';
import { JobsService } from './jobs.service';

/** Supervision des tâches planifiées et des files (ADM-09). */
@ApiTags('Administration')
@ApiBearerAuth()
@SuperAdminOnly()
@Controller('admin/jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  status() {
    return this.jobs.status();
  }

  @Post(':name/run')
  @HttpCode(HttpStatus.OK)
  run(@Param('name') name: string) {
    return this.jobs.run(name);
  }
}
