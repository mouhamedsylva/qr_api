import { SetMetadata } from '@nestjs/common';
import type { Feature } from '../../billing/plans.defaults';

export const FEATURE_KEY = 'requiredFeature';
/** Réserve la route aux établissements dont le forfait inclut la fonctionnalité (ADM-04). */
export const RequireFeature = (feature: Feature) =>
  SetMetadata(FEATURE_KEY, feature);
