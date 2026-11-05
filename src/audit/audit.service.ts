import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  action: string;
  restaurantId?: string | null;
  actorId?: string | null;
  entity?: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
}

const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'passwordHash',
  'pin',
  'pinHash',
  'tokenHash',
  'codeHash',
  'refreshToken',
];

/** Journal d'audit append-only (CON-04, ADM-08) : aucune méthode de mise à jour. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry, tx: Prisma.TransactionClient = this.prisma) {
    await tx.auditLog.create({
      data: {
        action: entry.action,
        restaurantId: entry.restaurantId ?? null,
        actorId: entry.actorId ?? null,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
        ip: entry.ip,
        userAgent: entry.userAgent?.slice(0, 255),
      },
    });
  }
}

function toJson(value: unknown) {
  if (value === undefined || value === null) {
    return Prisma.JsonNull;
  }
  // Retire les champs sensibles et normalise Decimal/Date.
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) =>
      SENSITIVE_KEYS.includes(key) ? undefined : v,
    ),
  ) as Prisma.InputJsonValue;
}
