import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/** Identifiant de cette instance du serveur (journal des verrous). */
const INSTANCE_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * Verrou à bail en base : une tâche ne s'exécute que sur une instance à la
 * fois ; si l'instance s'arrête en cours, le bail expire et une autre reprend.
 */
@Injectable()
export class JobLockService {
  constructor(private readonly prisma: PrismaService) {}

  /** Exécute `task` si le verrou est obtenu ; renvoie null sinon. */
  async runExclusive<T>(
    name: string,
    leaseMs: number,
    task: () => Promise<T>,
  ): Promise<{ result: T } | null> {
    const now = new Date();
    await this.prisma.jobLock.createMany({
      data: [{ name, lockedUntil: new Date(0), owner: INSTANCE_ID }],
      skipDuplicates: true,
    });
    const acquired = await this.prisma.jobLock.updateMany({
      where: { name, lockedUntil: { lt: now } },
      data: {
        lockedUntil: new Date(now.getTime() + leaseMs),
        owner: INSTANCE_ID,
      },
    });
    if (acquired.count === 0) return null;

    try {
      const result = await task();
      await this.release(name, null);
      return { result };
    } catch (err) {
      await this.release(name, (err as Error).message);
      throw err;
    }
  }

  private release(name: string, error: string | null) {
    return this.prisma.jobLock.update({
      where: { name },
      data: {
        lockedUntil: new Date(),
        lastRunAt: new Date(),
        lastError: error?.slice(0, 500) ?? null,
      },
    });
  }

  status() {
    return this.prisma.jobLock.findMany({ orderBy: { name: 'asc' } });
  }
}
