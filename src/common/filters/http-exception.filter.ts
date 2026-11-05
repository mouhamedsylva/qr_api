import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  423: 'LOCKED',
  429: 'TOO_MANY_REQUESTS',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Format d'erreur uniforme : { statusCode, code, message, details }.
 * Les exceptions métier peuvent fournir leur propre `code` :
 *   throw new ConflictException({ code: 'EMAIL_TAKEN', message: '…' })
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const body = this.toBody(exception);
    if (body.statusCode >= 500) {
      this.logger.error(exception);
    }
    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();
      const defaultCode = STATUS_CODES[statusCode] ?? 'ERROR';
      if (typeof response === 'string') {
        return { statusCode, code: defaultCode, message: response };
      }
      const r = response as Record<string, unknown>;
      // ValidationPipe renvoie message: string[]
      if (Array.isArray(r.message)) {
        return {
          statusCode,
          code: 'VALIDATION_ERROR',
          message: 'Données invalides',
          details: r.message,
        };
      }
      return {
        statusCode,
        code: typeof r.code === 'string' ? r.code : defaultCode,
        message: typeof r.message === 'string' ? r.message : exception.message,
        details: r.details,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          statusCode: HttpStatus.CONFLICT,
          code: 'CONFLICT',
          message: 'Ressource déjà existante',
          details: { target: exception.meta?.target },
        };
      }
      if (exception.code === 'P2025') {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          code: 'NOT_FOUND',
          message: 'Ressource introuvable',
        };
      }
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Erreur interne du serveur',
    };
  }
}
