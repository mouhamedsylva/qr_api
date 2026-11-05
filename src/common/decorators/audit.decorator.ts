import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit';
export interface AuditMeta {
  action: string;
  entity?: string;
}
/** Journalise l'appel réussi dans AuditLog (CON-04). */
export const Audit = (action: string, entity?: string) =>
  SetMetadata(AUDIT_KEY, { action, entity } satisfies AuditMeta);
