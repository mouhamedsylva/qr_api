import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AuditService } from '../../audit/audit.service';
import { AUDIT_KEY, AuditMeta } from '../decorators/audit.decorator';
import type { AppRequest } from '../types/request-context';

/** Journalise les routes annotées @Audit après succès, avec le corps de la requête. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta | undefined>(
      AUDIT_KEY,
      context.getHandler(),
    );
    if (!meta) {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest<AppRequest>();
    return next.handle().pipe(
      tap((result) => {
        const param = req.params?.id;
        const entityId =
          (result as { id?: string } | null)?.id ??
          (typeof param === 'string' ? param : undefined) ??
          req.tenant?.restaurantId;
        this.audit
          .log({
            action: meta.action,
            entity: meta.entity,
            entityId,
            restaurantId: req.tenant?.restaurantId,
            actorId: req.user?.id,
            after: req.body as unknown,
            ip: req.ip,
            userAgent: req.get('user-agent'),
          })
          .catch((err) => this.logger.error(err));
      }),
    );
  }
}
