import { SetMetadata } from '@nestjs/common';

export const SUPER_ADMIN_KEY = 'superAdminOnly';
/** Route réservée à l'équipe de la plateforme (module 9). */
export const SuperAdminOnly = () => SetMetadata(SUPER_ADMIN_KEY, true);
