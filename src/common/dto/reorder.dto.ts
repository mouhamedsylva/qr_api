import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsUUID,
} from 'class-validator';

/** Nouvel ordre d'affichage : la position de chaque id devient son index (MEN-05). */
export class ReorderDto {
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ids: string[];
}
