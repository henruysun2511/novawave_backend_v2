import { IsMongoId, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Trim } from 'shared/decorators/customize';

export class CreateCommentDto {
  @Trim()
  @IsNotEmpty()
  @IsString()
  content: string;

  @IsMongoId()
  songId: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  playbackPositionSec?: number;
}
