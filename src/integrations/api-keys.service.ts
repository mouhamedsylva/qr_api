import { Injectable, NotFoundException } from '@nestjs/common';
import { BillingService } from '../billing/billing.service';
import { sha256 } from '../common/utils/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateApiKeyDto } from './dto/integrations.dto';
import {
  ApiScope,
  generateApiKey,
  looksLikeApiKey,
} from './integrations.rules';

export interface ApiClient {
  keyId: string;
  restaurantId: string;
  scopes: ApiScope[];
}

/** Ne met à jour « dernière utilisation » qu'une fois par minute au plus. */
const LAST_USED_RESOLUTION_MS = 60_000;

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

/** Clés d'API par établissement (INT-01). */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  list(restaurantId: string) {
    return this.prisma.apiKey.findMany({
      where: { restaurantId },
      select: PUBLIC_FIELDS,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** La clé complète n'est renvoyée qu'ici : seule son empreinte est conservée. */
  async create(restaurantId: string, dto: CreateApiKeyDto, actorId: string) {
    const { key, prefix } = generateApiKey();
    const created = await this.prisma.apiKey.create({
      data: {
        restaurantId,
        name: dto.name,
        scopes: dto.scopes,
        prefix,
        keyHash: sha256(key),
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdById: actorId,
      },
      select: PUBLIC_FIELDS,
    });
    return { ...created, key };
  }

  async revoke(restaurantId: string, id: string) {
    const res = await this.prisma.apiKey.updateMany({
      where: { id, restaurantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException('Clé introuvable');
  }

  /**
   * Authentifie une clé ; null si elle est inconnue, révoquée, expirée, ou si
   * l'établissement n'est plus actif ou n'a plus l'API dans son forfait.
   */
  async authenticate(rawKey: string | undefined): Promise<ApiClient | null> {
    if (!looksLikeApiKey(rawKey)) return null;
    const key = await this.prisma.apiKey.findUnique({
      where: { keyHash: sha256(rawKey) },
      include: {
        restaurant: {
          select: { ownerId: true, status: true, deletedAt: true },
        },
      },
    });
    const now = new Date();
    if (
      !key ||
      key.revokedAt ||
      (key.expiresAt && key.expiresAt <= now) ||
      key.restaurant.deletedAt ||
      key.restaurant.status !== 'ACTIVE' ||
      !(await this.billing.hasFeature(key.restaurant.ownerId, 'api'))
    ) {
      return null;
    }
    if (
      !key.lastUsedAt ||
      now.getTime() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
    ) {
      await this.prisma.apiKey.update({
        where: { id: key.id },
        data: { lastUsedAt: now },
      });
    }
    return {
      keyId: key.id,
      restaurantId: key.restaurantId,
      scopes: key.scopes as ApiScope[],
    };
  }
}
