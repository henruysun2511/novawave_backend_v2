import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Types } from 'mongoose';
import { TimestampSchema } from 'shared/base/timestamps.schema';

@Schema({ timestamps: true })
export class Comment extends TimestampSchema {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true })
  userId: string | Types.ObjectId;

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Song', required: true })
  songId: string | Types.ObjectId;

  @Prop({ type: String, required: true })
  content: string;

  // thời điểm nghe (tính bằng giây) khi gửi comment, optional
  @Prop({ type: Number, required: false })
  playbackPositionSec?: number;
}

export const CommentSchema = SchemaFactory.createForClass(Comment);
