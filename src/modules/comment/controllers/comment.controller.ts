import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ResponseMessage, User } from 'shared/decorators/customize';
import { IUserRequest } from 'shared/interfaces';

import { CommentService } from '../services/comment.service';
import { CreateCommentDto, UpdateCommentDto } from '../dtos';

@Controller('comments')
export class CommentController {
  constructor(private readonly commentService: CommentService) {}

  @Post()
  @ResponseMessage('Tạo bình luận thành công')
  create(@Body() commentDto: CreateCommentDto, @User() user: IUserRequest) {
    return this.commentService.create(commentDto, { userId: user.userId });
  }

  @Get('latest/list')
  @ResponseMessage('Lấy danh sách bình luận mới nhất thành công')
  getLatestComments(@Query('page') page: number, @Query('size') size: number) {
    return this.commentService.getLatestComments(page, size);
  }

  @Get(':id')
  @ResponseMessage('Lấy danh sách bình luận thành công')
  getCommentsOfSongForClient(@Param('id') id: string, @Query('page') page: number) {
    return this.commentService.getCommentsOfSongForClient(id, page);
  }

  // @Get(':id')
  // findOne(@Param('id') id: string) {
  //   return this.commentService.findOne(+id);
  // }

  @Patch(':id')
  @ResponseMessage('Cập nhật bình luận thành công')
  update(@Param('id') id: string, @Body() commentDto: UpdateCommentDto, @User() user: IUserRequest) {
    return this.commentService.update(id, commentDto, { userId: user.userId });
  }

  @Delete(':id')
  @ResponseMessage('Xóa bình luận thành công')
  remove(@Param('id') id: string, @User() user: IUserRequest) {
    return this.commentService.remove(id, { userId: user.userId });
  }
}
