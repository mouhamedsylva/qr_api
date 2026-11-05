import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import type { Server, Socket } from 'socket.io';
import {
  PermissionOverrides,
  resolvePermissions,
} from '../auth/rbac/permissions';
import type { AccessTokenPayload } from '../auth/strategies/jwt.strategy';
import { verifyOrderToken } from '../orders/order-token';
import { PrismaService } from '../prisma/prisma.service';
import { orderRoom, restaurantRoom } from './realtime.events';
import { RealtimeService } from './realtime.service';

interface SocketData {
  userId?: string;
  isSuperAdmin?: boolean;
}

type AppSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  SocketData
>;

interface HandshakeAuth {
  /** Équipe : jeton d'accès JWT. */
  token?: string;
  /** Client : suivi d'une commande anonyme. */
  orderId?: string;
  orderToken?: string;
}

/**
 * Passerelle WebSocket (Socket.IO, namespace /realtime).
 * - Équipe : se connecte avec son JWT puis émet `subscribe` { restaurantId }.
 * - Client : se connecte avec { orderId, orderToken } et rejoint la salle de sa commande.
 * Après une reconnexion, le client rattrape les événements via
 * GET /restaurants/:id/events?after=<dernier seq reçu> (NOT-06).
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: true } })
export class RealtimeGateway implements OnGatewayInit {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly orderSecret: string;

  constructor(
    private readonly realtime: RealtimeService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.orderSecret = config.getOrThrow<string>('QR_SIGNING_SECRET');
  }

  /**
   * L'authentification se fait dans un middleware : la connexion n'est
   * établie (événement `connect` côté client) qu'une fois l'identité vérifiée,
   * ce qui évite qu'un `subscribe` immédiat soit traité avant l'authentification.
   * En cas d'échec, le client reçoit `connect_error`.
   */
  afterInit(server: Server) {
    this.realtime.attachServer(server);
    server.use((socket, next) => {
      this.authenticate(socket as AppSocket)
        .then(() => next())
        .catch((err: Error) => {
          this.logger.debug(`Connexion refusée : ${err.message}`);
          next(new Error('UNAUTHORIZED'));
        });
    });
  }

  private async authenticate(client: AppSocket): Promise<void> {
    const auth = (client.handshake.auth ?? {}) as HandshakeAuth;
    if (auth.token) {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(
        auth.token,
      );
      const user = await this.prisma.user.findFirst({
        where: { id: payload.sub, deletedAt: null, status: 'ACTIVE' },
        select: { id: true, isSuperAdmin: true },
      });
      if (!user) throw new Error('utilisateur inactif');
      client.data.userId = user.id;
      client.data.isSuperAdmin = user.isSuperAdmin;
      return;
    }
    if (
      auth.orderId &&
      isUUID(auth.orderId) &&
      verifyOrderToken(this.orderSecret, auth.orderId, auth.orderToken)
    ) {
      await client.join(orderRoom(auth.orderId));
      return;
    }
    throw new Error('authentification absente');
  }

  /** Abonnement de l'équipe aux événements d'un établissement. */
  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() body: { restaurantId?: string },
  ) {
    const restaurantId = body?.restaurantId;
    if (!client.data.userId || !restaurantId || !isUUID(restaurantId)) {
      return { ok: false, error: 'FORBIDDEN' };
    }
    if (!client.data.isSuperAdmin) {
      const membership = await this.prisma.membership.findFirst({
        where: {
          userId: client.data.userId,
          restaurantId,
          deletedAt: null,
          restaurant: { deletedAt: null },
        },
        select: { role: true, permissions: true },
      });
      const allowed =
        membership &&
        resolvePermissions(
          membership.role,
          membership.permissions as PermissionOverrides | null,
        ).has('orders.view');
      if (!allowed) {
        return { ok: false, error: 'FORBIDDEN' };
      }
    }
    await client.join(restaurantRoom(restaurantId));
    return { ok: true, lastSeq: await this.realtime.lastSeq(restaurantId) };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() body: { restaurantId?: string },
  ) {
    if (body?.restaurantId) {
      await client.leave(restaurantRoom(body.restaurantId));
    }
    return { ok: true };
  }
}
