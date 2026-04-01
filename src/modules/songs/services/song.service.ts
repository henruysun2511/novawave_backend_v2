import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { AppConfig, FIELDS } from 'common/constants';
import { NotificationType, SongReleseStatus } from 'common/enum';
import { CustomLogger } from 'loggers/nestToWinstonLogger.service';
import { AlbumService } from 'modules/album/services/album.service';
import { ArtistService } from 'modules/artist/services/artist.service';
import { FollowService } from 'modules/follow/services/follow.service';
import { GenreService } from 'modules/genres/services/genre.service';
import { ICreateNotificationPayload } from 'modules/notification/interfaces/create-notification.interface';
import { NotificationService } from 'modules/notification/services/notification.service';
import { FanoutFollowerProducer } from 'modules/queue/producers';
import { RedisService } from 'modules/redis/services/redis.service';
import { ClientSession, Connection } from 'mongoose';
import { IUserRequest } from 'shared/interfaces';
import { checkMongoId } from 'shared/utils/validateMongoId.util';

import { CreateSongDto, QuerySongDto, QuerySongDtoForClient, SongResponseDto, UpdateSongDto } from '../dtos';
import { UpdateStatusDto } from '../dtos/update-status.dto';
import { buildSongFilterQuery, buildSongFilterQueryForClient } from '../queries/song.query';
import { SongRepository } from '../repositories/song.repository';

@Injectable()
export class SongService {
  constructor(
    private readonly songRepo: SongRepository,
    private readonly genreService: GenreService,
    private readonly artistService: ArtistService,
    private readonly albumService: AlbumService,
    private readonly followService: FollowService,
    private readonly redisService: RedisService,
    private readonly logger: CustomLogger,
    private readonly notificationService: NotificationService,
    private readonly fanoutFollowerProducer: FanoutFollowerProducer,

    @InjectConnection() private readonly connection: Connection
  ) { }

  async create(songDto: CreateSongDto, user: IUserRequest) {
    // Kiểm tra explicit, lyrics
    this.ensureLyricsForExplicit(songDto);

    // Kiểm tra ngày phát hành
    this.validReleaseAt(songDto.releaseAt, songDto.releseStatus);

    await Promise.all([this.validateFeatArtistIds(songDto.featArtistIds), this.validateAlbumId(songDto.albumId)]);

    const [genreNames, artistId] = await Promise.all([
      this.validateGenreNamesStrict(songDto.genreNames),
      this.artistService.getIdByUserId(user.userId)
    ]);

    if (!artistId) {
      throw new BadRequestException('Bạn không phải là nghệ sĩ');
    }

    const session = await this.connection.startSession();
    session.startTransaction();
    try {
      const song = await this.songRepo.create(
        {
          ...songDto,
          genreNames,
          createdBy: user.userId,
          artistId
        },
        session
      );

      // Gọi album service/repo để thêm songId vào album trong cùng session
      if (songDto.albumId) {
        // albumService.addSongToAlbum phải hỗ trợ nhận session và thực hiện update với session
        await this.albumService.addSongToAlbum(songDto.albumId, song._id.toString(), session);
      }

      await session.commitTransaction();

      // Nếu đăng bài luôn thì mới xử lý thông báo ch các follower
      if (songDto.releseStatus === SongReleseStatus.PUBLISHED)
        await this.fanoutFollowerProducer.fanoutFollower({ _id: song._id, name: song.name, artistId });

      return song;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async update(id: string, songDto: UpdateSongDto, user: IUserRequest) {
    checkMongoId(id);
    const albumId = songDto.albumId;

    // Kiểm tra explicit, lyrics
    this.ensureLyricsForExplicit(songDto);

    // Kiểm tra ngày phát hành
    this.validReleaseAt(songDto.releaseAt, songDto.releseStatus);

    await Promise.all([this.validateFeatArtistIds(songDto.featArtistIds), this.validateAlbumId(albumId)]);

    const [existing, genreNames] = await Promise.all([
      this.songRepo.findById(id),
      this.validateGenreNamesStrict(songDto.genreNames)
    ]);

    if (!existing) throw new NotFoundException('Không tìm thấy bài hát');

    const oldAlbumId = existing.albumId ? String(existing.albumId) : undefined;
    const newAlbumId = albumId ? String(albumId) : undefined;

    const session = await this.connection.startSession();
    session.startTransaction();
    try {
      const updated = await this.songRepo.update(
        id,
        {
          ...songDto,
          genreNames,
          updatedBy: user?.userId
        },
        session
      );
      if (!updated) {
        throw new NotFoundException('Không tìm thấy bài hát sau khi cập nhật');
      }

      if (oldAlbumId && newAlbumId && oldAlbumId !== newAlbumId) {
        await this.albumService.removeSongFromAlbum(oldAlbumId, id, session);
        await this.albumService.addSongToAlbum(newAlbumId, id, session);
      } else if (oldAlbumId && !newAlbumId) {
        // đã bỏ album trên DTO -> remove khỏi album cũ
        await this.albumService.removeSongFromAlbum(oldAlbumId, id, session);
      } else if (!oldAlbumId && newAlbumId) {
        // gán album mới
        await this.albumService.addSongToAlbum(newAlbumId, id, session);
      }

      await session.commitTransaction();

      return updated;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  private async validateGenreNamesStrict(genreNames: string[]) {
    if (!genreNames || genreNames.length === 0) return [];
    return await this.genreService.getGenreNamesByGenreNames(genreNames);
  }

  private ensureLyricsForExplicit(dto: { explicit?: boolean; lyrics?: string }) {
    if (dto?.explicit === true) {
      if (!dto.lyrics || dto.lyrics.trim().length === 0) {
        throw new BadRequestException('Lyrics are required when explicit is true');
      }
    }
  }

  private async validateFeatArtistIds(featArtistIds: string[]) {
    if (featArtistIds && featArtistIds.length > 0) {
      const artistCount = await this.artistService.getCountArtistsByIds(featArtistIds);

      if (featArtistIds.length !== artistCount) {
        throw new NotFoundException(`Có nghệ sĩ không tồn tại`);
      }
    }
  }

  private async validateAlbumId(albumId?: string) {
    if (!albumId) return;
    // albumService.findById should return album doc or null (adjust method name if different)
    const album = await this.albumService.findById(albumId);
    if (!album) {
      throw new NotFoundException(`Album not found: ${albumId}`);
    }
  }

  async updateMedia(
    id: string,
    media: { imageUrl?: string; mp3Link?: string; duration?: number },
    session?: ClientSession
  ) {
    return this.songRepo.update(id, media, session);
  }

  async updateStatus(statusDto: UpdateStatusDto, userId: string) {
    const existSong = await this.checkExist(statusDto.songId);
    if (!existSong) throw new NotFoundException('Bài hát không tồn tại');

    return await this.songRepo.updateStatus(statusDto, userId);
  }

  async getSongsByAlbumId(albumId: string) {
    checkMongoId(albumId);
    return await this.songRepo.getSongsByAlbumId(albumId);
  }

  async getCountSongsByIds(ids: string[]) {
    return await this.songRepo.getCountSongsByIds(ids);
  }

  async checkExist(id: string) {
    checkMongoId(id);
    return await this.songRepo.checkExist(id);
  }

  async throwIfExist(id: string) {
    const exist = await this.checkExist(id);
    if (exist) throw new BadRequestException('Bài hát đã tồn tại');
  }

  async throwIfNotExist(id: string) {
    const exist = await this.checkExist(id);
    if (!exist) throw new NotFoundException('Bài hát không tồn tại');
  }

  private validReleaseAt(releaseAt: Date | null, releaseStatus: string) {
    // 1. Trạng thái DRAFT không được có ngày phát hành
    if (releaseStatus === SongReleseStatus.DRAFT) {
      if (releaseAt) {
        throw new BadRequestException('Không được set ngày phát hành khi ở bản nháp');
      }
      return null;
    }

    // 2. Trạng thái PUBLISHED => ngày phát hành = hiện tại
    if (releaseStatus === SongReleseStatus.PUBLISHED) {
      return new Date();
    }

    // 3. Trạng thái SCHEDULED => phải có releaseAt và phải ở tương lai
    if (releaseStatus === SongReleseStatus.SCHEDULED) {
      if (!releaseAt) {
        throw new BadRequestException('Phải chọn ngày phát hành khi lên lịch');
      }
      if (releaseAt < new Date()) {
        throw new BadRequestException('Ngày phát hành phải lớn hơn thời điểm hiện tại');
      }
      return releaseAt;
    }
  }

  private async notifyFollowers(song: Partial<SongResponseDto>) {
    // Lấy danh sách followers của nghệ sĩ

    const followers = await this.followService.findFollowingUser(song.artistId);

    if (!followers || followers.length === 0) return;

    // Tạo payloads
    const payloads = followers.map((f) => {
      return {
        receiverId: String(f.userId),
        title: `Nghệ sĩ bạn theo dõi vừa phát hành bài hát mới`,
        message: `Bài hát "${song.name}" đã được phát hành`,
        type: NotificationType.NEW_SONG_RELEASE,
        referenId: song._id
      } as ICreateNotificationPayload;
    });

    // Batch size
    const BATCH_SIZE = 50;

    // Xử lý theo batch: song song trong batch, tuần tự giữa các batch
    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      const batch = payloads.slice(i, i + BATCH_SIZE);

      // insert nhiều notification 1 lúc
      await this.notificationService.createNotifications(batch);
    }
  }

  async autoPublishSongs() {
    const BATCH_SIZE = 10000;
    const now = new Date();
    const songs = await this.songRepo.findScheduled(now);

    if (!songs || songs.length === 0) return;

    await this.songRepo.updateManyReleseStatus();

    for (let i = 0; i < songs.length; i += BATCH_SIZE) {
      const batch = songs.slice(i, i + BATCH_SIZE);
      await this.notifyFollowersBatch(batch);
    }
  }

  private async notifyFollowersBatch(songs: Partial<SongResponseDto>[]) {
    if (!songs || songs.length === 0) return;

    // Nhóm theo tác giả
    const byArtist = songs.reduce<Record<string, Partial<SongResponseDto>[]>>((acc, s) => {
      const aid = String(s.artistId);
      (acc[aid] = acc[aid] || []).push({
        _id: String(s._id),
        artistId: aid,
        name: s.name
      });

      return acc;
    }, {});

    // Lấy ra mảng key(mảng mã tác giả)
    const artistIds = Object.keys(byArtist);
    if (artistIds.length === 0) return;

    // Chạy song song nhưng 1 tác vụ lỗi thì ko ảnh hưởng đến các tác vụ khác
    const followerResults = await Promise.allSettled(artistIds.map((aid) => this.followService.findFollowingUser(aid)));

    const payloads: ICreateNotificationPayload[] = [];

    for (let i = 0; i < artistIds.length; i++) {
      const aid = artistIds[i];
      const res = followerResults[i];
      if (res.status !== 'fulfilled' || !res.value || res.value.length === 0) continue;

      // Mảng bài hát cần đc phát hành của nghệ sĩ đó
      const artistSongs = byArtist[aid];
      // for each follower, create notification for each song of this artist
      for (const f of res.value) {
        const userId = typeof f.userId === 'object' ? String(f.userId._id) : String(f.userId);
        for (const song of artistSongs) {
          payloads.push({
            receiverId: userId,
            title: `Nghệ sĩ bạn theo dõi vừa phát hành bài hát mới`,
            message: `Bài hát "${song.name}" đã được phát hành`,
            type: NotificationType.NEW_SONG_RELEASE,
            referenId: String(song._id)
          } as ICreateNotificationPayload);
        }
      }
    }

    if (payloads.length === 0) return;

    // Nhóm lô xử lý 500 thông báo 1 lúc
    const BATCH_SIZE = 500;
    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      const batch = payloads.slice(i, i + BATCH_SIZE);

      await this.notificationService.createNotifications(batch);
    }
  }

  async genRandomSong() {
    return await this.songRepo.genRandomSong();
  }

  async findSongsByAlbumId(albumId: string) {
    return this.songRepo.findByAlbumId(albumId);
  }

  async findSongIdsByAlbumId(albumId: string) {
    return this.songRepo.findSongIdsByAlbumId(albumId);
  }

  async getSongsForAdmin(query: QuerySongDto) {
    const page = query.page || 1;
    const size = query.size || 10;
    const skip = (page - 1) * size;

    const { filter, sort } = buildSongFilterQuery(query);

    const [totalElements, data] = await Promise.all([
      this.songRepo.countDocuments(filter),
      this.songRepo.findAll(filter, skip, size, sort)
    ]);
    const totalPages = Math.ceil(totalElements / size);

    return {
      meta: {
        page,
        size,
        totalPages,
        totalElements
      },
      data
    };
  }

  async getSongsForClient(query: QuerySongDtoForClient) {
    const page = query.page;
    const size = AppConfig.PAGINATION.SIZE_DEFAUT;
    const skip = (page - 1) * size;
    const filter = buildSongFilterQueryForClient(query);
    const data = await this.songRepo.getSongsForClient(filter, skip, size, FIELDS.SONG.CLIENT);
    return {
      meta: {
        page,
        size
      },
      data
    };
  }

  async getDetail(id: string) {
    checkMongoId(id);
    const song = await this.songRepo.getDetail(id);
    if (!song) throw new NotFoundException('Bài hát không tồn tại');
    return song;
  }

  async getSongsByArtistid(artistId: string) {
    checkMongoId(artistId);
    const songs = await this.songRepo.getSongsByArtistId(artistId);
    if (!songs) throw new NotFoundException('Nghệ sĩ không tồn tại');
    return songs;
  }

  async removeForAdmin(id: string, userId: string) {
    checkMongoId(id);
    const song = await this.songRepo.remove(id, userId);
    if (!song) throw new NotFoundException('Bài hát không tồn tại');
    return song;
  }

  async removeForArtist(id: string, userId: string) {
    const [artistId, artistidOfSong] = await Promise.all([
      this.artistService.getIdByUserId(userId),
      this.songRepo.findArtistIdById(id)
    ]);
    if (!artistId || artistId !== artistidOfSong) {
      throw new ForbiddenException('Bạn không có quyền xóa bài hát này');
    }
    if (!artistidOfSong) throw new NotFoundException('Bài hát không tồn tại');

    return await this.songRepo.remove(id, userId);
  }

  async increaseLikes(id: string, session?: ClientSession) {
    checkMongoId(id);
    return await this.songRepo.increaseLikes(id, session);
  }

  async decreaseLikesIfPossible(id: string, session?: ClientSession) {
    checkMongoId(id);
    return await this.songRepo.decreaseLikesIfPossible(id, session);
  }

  // top N songIds with scores
  async getTopSongIds(limit = 10) {
    return this.redisService.zrevrange('songs:likes', 0, limit - 1, true);
  }

  // get top songs (preserve order)
  async getTopSongs(limit = 10) {
    const ids = await this.redisService.zrevrange('songs:likes', 0, limit - 1);

    if (!ids || ids.length === 0) {
      const songs = await this.songRepo.findTopByLikes(limit);

      try {
        await this.redisService.zaddMany(
          'songs:likes',
          songs.map((s) => ({ member: String((s as any)._id), score: Number((s as any).likes) || 0 }))
        );
      } catch {
        /* ignore redis errors */
      }
      return songs;
    }
    const songs = await this.songRepo.findByIds(ids);
    // preserve order by ids array
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = new Map<string, any>((songs || []).map((s) => [String((s as any)._id), s] as [string, any]));
    return ids.map((id) => map.get(id)).filter(Boolean);
  }

  async rebuildLeaderboard() {
    this.logger.log('⏳ Start rebuilding leaderboard...');

    try {
      const BATCH_SIZE = 500;
      let skip = 0;

      const items: { member: string; score: number }[] = [];

      while (true) {
        const songs = await this.songRepo.findForLeaderboard(BATCH_SIZE, skip);
        if (!songs.length) break;

        for (const song of songs) {
          if (song.likes > 0) {
            items.push({ member: String(song._id), score: Number(song.likes) || 0 });
          }
        }

        skip += BATCH_SIZE;
      }

      // replace redis key atomically-ish via RedisService helper
      if (items.length > 0) {
        try {
          await this.redisService.zaddMany('songs:likes', items);
        } catch (err) {
          this.logger.error('Failed to write leaderboard to redis', err as any, SongService.name);
        }
      } else {
        // no items -> clear key
        try {
          await this.redisService.del('songs:likes');
        } catch {
          /* ignore */
        }
      }

      this.logger.log('✅ Leaderboard rebuild success');
    } catch (err: any) {
      this.logger.error('❌ Leaderboard rebuild failed', err.stack, SongService.name);
    }
  }

  async incrementViews(id: string, userId?: string) {
    const song = await this.songRepo.increaseViews(id); // Vẫn tăng views tổng ở collection Song
    if (!song) throw new NotFoundException('Song not found');

    // Ghi nhận vào log để làm BXH theo thời gian
    await this.songRepo.recordListen(id, userId);

    return { views: song.views };
  }

  async getLeaderboard(type: 'all' | 'week' | 'month') {
    const limit = 10;
    let result;

    if (type === 'all') {
      result = await this.songRepo.findTopByViews(limit);
      // Kết quả đã là [Song, Song, ...]
      return result;
    }

    const now = new Date();
    let startDate: Date;
    if (type === 'week') {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (type === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const topByTime = await this.songRepo.getTopSongsByTimeFrame(limit, startDate);

    // FLAT dữ liệu: Chuyển từ [{ song: {...}, listenCount: 10 }] thành [{ ...song, views: 10 }]
    return topByTime.map(item => ({
      ...item.song,
      views: item.listenCount // Ghi đè views tổng bằng views theo khung giờ để hiển thị
    }));
  }
}
