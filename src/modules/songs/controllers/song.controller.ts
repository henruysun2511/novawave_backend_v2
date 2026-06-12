import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import axios from 'axios';
import { Response } from 'express';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import { join } from 'path';
import { Public, ResponseMessage, User } from 'shared/decorators/customize';
import { IUserRequest } from 'shared/interfaces';
import { pipeline } from 'stream/promises';
import { CreateSongDto, QuerySongDtoForClient, UpdateSongDto } from '../dtos';
import { UpdateStatusDto } from '../dtos/update-status.dto';
import { SongService } from '../services/song.service';

@Controller('songs')
export class SongController {
  constructor(private readonly songService: SongService) { }


  @ResponseMessage('Đăng bài hát thành công')
  @Post('')
  async create(@Body() createSongDto: CreateSongDto, @User() user: IUserRequest) {
    return this.songService.create(createSongDto, user);
  }

  // @Public()
  // @Get('top')
  // @ResponseMessage('Lấy ra top bài hát thành công')
  // getTopSongs() {
  //   return this.songService.getTopSongs();
  // }

  @Get('')
  @Public()
  @ResponseMessage('Lấy ra danh sách bài hát thành công')
  async getSongsForClient(@Query() query: QuerySongDtoForClient) {
    return await this.songService.getSongsForClient(query);
  }

  // Update có thể có file hoặc không
  @Put(':id')
  async update(@Param('id') id: string, @Body() songDto: UpdateSongDto, @User() user: IUserRequest) {
    return this.songService.update(id, songDto, user);
  }

  @ResponseMessage('Cập nhật trạng thái thành công')
  @Patch('update-status')
  async updateStatus(@Body() statusDto: UpdateStatusDto, @User() user: IUserRequest) {
    return await this.songService.updateStatus(statusDto, user.userId);
  }

  @Public()
  @Get('leaderboard')
  @Public()
  @ResponseMessage('Lấy bảng xếp hạng thành công')
  async getLeaderboard(@Query('type') type: 'all' | 'week' | 'month' = 'all') {
    return await this.songService.getLeaderboard(type);
  }

  @Get('detail/:id')
  @Public()
  @ResponseMessage('Lấy ra chi tiết bài hát thành công')
  async getDetail(@Param('id') id: string) {
    return await this.songService.getDetail(id);
  }

  @Get(':artistId')
  @ResponseMessage('Lấy ra danh sách bài hát của nghệ sĩ thành công')
  async getSongsByArtistId(@Param('artistId') artistId: string) {
    return await this.songService.getSongsByArtistid(artistId);
  }

  @Delete(':id')
  @ResponseMessage('Xóa thành công')
  async removeForArtist(@Param('id') id: string, @User() user: IUserRequest) {
    return await this.songService.removeForArtist(id, user.userId);
  }

  @Patch(':id/view')
  async incrementViews(@Param('id') id: string, @User() user: IUserRequest) {
    // Truyền thêm userId nếu có (khách thì user?.userId sẽ undefined)
    return await this.songService.incrementViews(id, user?.userId);
  }
}
