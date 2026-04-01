import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { IUserRequest } from 'shared/interfaces';
import { checkMongoId } from 'shared/utils/validateMongoId.util';
import { AppConfig } from 'common/constants';

import { CommentRepository } from '../repositories/comment.repository';
import { CreateCommentDto, UpdateCommentDto } from '../dtos';

@Injectable()
export class CommentService {
  constructor(
    private readonly commentRepo: CommentRepository
    // private readonly replyCommentService: ReplyCommentService
  ) {}

  async create(commentDto: CreateCommentDto, user: Partial<IUserRequest>) {
    return await this.commentRepo.create({ ...commentDto, userId: user.userId });
  }

  async getCommentsOfSongForClient(songId: string, page: number) {
    checkMongoId(songId);
    const size = AppConfig.PAGINATION.SIZE_DEFAUT;
    const p = Math.max(1, Number(page) || 1);
    const skip = (p - 1) * size;
    const data = await this.commentRepo.getCommentsOfSongForClient(songId, skip, size);
    return {
      meta: {
        page,
        size
      },
      data
    };
  }

  async getLatestComments(page: number, size?: number) {
    const pageSize = size || AppConfig.PAGINATION.SIZE_DEFAUT;
    const p = Math.max(1, Number(page) || 1);
    const skip = (p - 1) * pageSize;
    
    const [data, total] = await Promise.all([
      this.commentRepo.getLatestComments(skip, pageSize),
      this.commentRepo.countTotalComments()
    ]);

    return {
      meta: {
        page: p,
        size: pageSize,
        totalElements: total,
        totalPages: Math.ceil(total / pageSize)
      },
      data
    };
  }

  async update(id: string, commentDto: UpdateCommentDto, user: Partial<IUserRequest>) {
    checkMongoId(id);
    await this.assertIsOwner(id, user.userId);

    return await this.commentRepo.update(id, {
      content: commentDto.content
    });
  }

  async remove(id: string, user: Partial<IUserRequest>) {
    checkMongoId(id);
    await this.assertIsOwner(id, user.userId);

    return await this.commentRepo.remove(id, user.userId);
  }

  private async assertIsOwner(id: string, userId: string) {
    const comment = await this.commentRepo.findById(id);

    if (!comment) throw new NotFoundException('Không tìm thấy bình luận');

    if (String(comment.userId) !== userId) {
      throw new ForbiddenException('Bạn không thể xóa bình luận của người khác');
    }
  }
}
