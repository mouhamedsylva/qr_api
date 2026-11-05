import { IsDateString, IsIn, IsOptional } from 'class-validator';

export class AnalyticsQueryDto {
  /** Début de période (ISO 8601) ; par défaut 30 jours avant `to`. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Fin de période (exclue) ; par défaut maintenant. */
  @IsOptional()
  @IsDateString()
  to?: string;

  /** Export (ANA-04). */
  @IsOptional()
  @IsIn(['json', 'csv'])
  format: 'json' | 'csv' = 'json';

  /** Rapport fiscal : regroupement par jour ou par mois. */
  @IsOptional()
  @IsIn(['day', 'month'])
  groupBy?: 'day' | 'month';
}
