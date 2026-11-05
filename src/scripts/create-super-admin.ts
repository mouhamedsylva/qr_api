/**
 * Crée (ou promeut) un compte super-admin de la plateforme (module 9).
 * Aucune route d'API ne permet de devenir super-admin : c'est volontaire.
 *
 *   SUPER_ADMIN_PASSWORD='…' npm run admin:create -- admin@qr-order.com
 *
 * Le mot de passe passe par une variable d'environnement pour ne pas
 * apparaître dans l'historique du shell ni dans la liste des processus.
 */
import { hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { TERMS_VERSION } from '../privacy/terms';

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Usage : npm run admin:create -- <email>');
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { isSuperAdmin: true },
      });
      console.log(`Compte existant promu super-admin : ${email}`);
      return;
    }
    if (!password || password.length < 12) {
      throw new Error(
        'SUPER_ADMIN_PASSWORD requis (12 caractères minimum) pour créer le compte',
      );
    }
    await prisma.user.create({
      data: {
        email,
        passwordHash: await hash(password),
        firstName: 'Administrateur',
        lastName: 'QR-Order',
        isSuperAdmin: true,
        emailVerifiedAt: new Date(),
        termsAcceptedAt: new Date(),
        termsVersion: TERMS_VERSION,
      },
    });
    console.log(`Super-admin créé : ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
