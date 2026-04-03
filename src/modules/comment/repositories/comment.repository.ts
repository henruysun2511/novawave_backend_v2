import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Comment } from '../schemas/comment.schema';

export class CommentRepository {
  constructor(@InjectModel(Comment.name) private commentRepo: Model<Comment>) {}

  async create(commentData: Partial<Comment>): Promise<Comment> {
    return await this.commentRepo.create(commentData);
  }

  async countDocumentsBySongId(songId: string) {
    return this.commentRepo.countDocuments({
      songId: songId,
      deleted: false
    });
  }

  //Lấy danh sách bình luận theo songId
  async findBySongId(songId: string, skip: number, limit: number) {
    return this.commentRepo
      .find({
        songId: songId,
        deleted: false
      })
      .select('_id content userId songId createdAt playbackPositionSec')
      .populate('userId', '_id username avatar')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
  }

  async findById(commentId: string) {
    return this.commentRepo.findById(commentId);
  }

  //Sửa
  async update(id: string, commentData: Partial<Comment>): Promise<Comment | null> {
    return await this.commentRepo
      .findByIdAndUpdate(id, { $set: commentData }, { new: true })
      .select('_id content')
      .exec();
  }

  async getCommentsOfSongForClient(songId: string, skip: number, size: number): Promise<Comment[] | []> {
    return await this.commentRepo
      .find({ songId, deleted: false })
      .populate('userId', 'username avatar')
      .skip(skip)
      .limit(size)
      .select('content userId createdAt playbackPositionSec')
      .lean()
      .exec();
  }

  // Lấy danh sách bình luận mới nhất kèm thông tin user và song
  async getLatestComments(skip: number, size: number): Promise<Comment[] | []> {
    return await this.commentRepo
      .find({ deleted: false })
      .populate('userId', 'username avatar')
      .populate('songId', 'name imageUrl')
      .skip(skip)
      .limit(size)
      .select('content userId songId createdAt playbackPositionSec')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  // Đếm tổng số bình luận chưa bị xóa
  async countTotalComments() {
    return this.commentRepo.countDocuments({
      deleted: false
    });
  }

  //Xóa
  async remove(_id: string, userId: string): Promise<void> {
    await this.commentRepo.updateOne({ _id }, { deleted: true, deletedAt: new Date(), deletedBy: userId });
  }
}
