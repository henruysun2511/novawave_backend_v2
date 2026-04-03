import { InjectModel } from '@nestjs/mongoose';
import { SongReleseStatus, SongStatus } from 'common/enum';
import { ClientSession, Model, Types } from 'mongoose';
import { SearchPipelineBuilder } from 'shared/utils';

import { UpdateStatusDto } from '../dtos/update-status.dto';
import { SongListen } from '../schemas/song-listen.schema';
import { Song } from '../schemas/song.schema';

export class SongRepository {
  constructor(
    @InjectModel(Song.name) private songRepo: Model<Song>,
    @InjectModel(SongListen.name) private listenModel: Model<SongListen>
  ) {}
  //Thêm bài hát
  async create(songData: Partial<Song>, session: ClientSession): Promise<Song> {
    const song = new this.songRepo(songData);
    await song.save({ session });
    return song;
  }

  async findById(id: string): Promise<Song | null> {
    return this.songRepo.findById(id).lean().exec();
  }

  // Cập nhật bài hát
  async update(id: string, songData: Partial<Song>, session?: ClientSession): Promise<Song | null> {
    if (!songData || Object.keys(songData).length === 0) {
      return await this.findById(id);
    }
    return this.songRepo.findByIdAndUpdate(id, { $set: songData }, { new: true, session }).exec();
  }

  async updateStatus(statusDto: UpdateStatusDto, userId: string): Promise<Song | null> {
    return await this.songRepo
      .findByIdAndUpdate(statusDto.songId, { $set: { status: statusDto.status, updatedBy: userId } }, { new: true })
      .lean()
      .exec();
  }

  async getSongsByAlbumId(albumId: string): Promise<Partial<Song>[]> {
    return this.songRepo.find({ albumId, deleted: false }, '_id name genreNames').lean().exec();
  }

  async getCountSongsByIds(_ids: string[]): Promise<number> {
    return await this.songRepo.countDocuments({ _id: { $in: _ids } });
  }

  async findArtistIdById(_id: string): Promise<string | null> {
    const song = await this.songRepo
      .findOne({ _id, deleted: false })
      .select('artistId')
      .lean<{ artistId: Types.ObjectId }>()
      .exec();
    return song.artistId.toString();
  }

  async checkExist(_id: string): Promise<boolean> {
    return !!(await this.songRepo.exists({ _id, deleted: false }));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async countDocuments(filter: Record<string, any>): Promise<number> {
    return this.songRepo.countDocuments({ ...filter, deleted: false }).exec();
  }

  async findScheduled(now: Date): Promise<Array<{ _id: string; name: string; createdBy: string }>> {
    const pipeline = [
      {
        $match: {
          status: SongStatus.ACTIVED,
          releseStatus: SongReleseStatus.SCHEDULED,
          releaseAt: { $lte: now },
          deleted: false
        }
      },
      {
        $project: {
          _id: { $toString: '$_id' },
          name: 1,
          createdBy: { $toString: '$createdBy' }
        }
      }
    ];

    // cast kết quả aggregate về kiểu mong muốn
    return (await this.songRepo.aggregate(pipeline).exec()) as Array<{ _id: string; name: string; createdBy: string }>;
  }

  async updateManyReleseStatus() {
    await this.songRepo.updateMany(
      {
        releseStatus: SongReleseStatus.SCHEDULED,
        releaseAt: { $lte: new Date() },
        deleted: false,
        status: SongStatus.ACTIVED
      },
      { $set: { releseStatus: SongReleseStatus.PUBLISHED } }
    );
  }

  async getRandomSong(): Promise<Song | null> {
    const result = await this.songRepo.aggregate([{ $sample: { size: 1 } }]);
    return result[0];
  }

  //Xóa bài hát
  async remove(_id: string, userId: string): Promise<Song | null> {
    return this.songRepo
      .findByIdAndUpdate(
        _id,
        { deleted: true, deletedAt: new Date(), deletedBy: userId },
        { new: true } // trả về document đã update
      )
      .exec();
  }

  async findDetailByAlbumId(albumId: string): Promise<Song[] | null> {
    return this.songRepo.aggregate([
      { $match: { albumId } },

      // lookup artist
      {
        $lookup: {
          from: 'artists',
          localField: 'artistId',
          foreignField: '_id',
          as: 'artist'
        }
      },
      { $unwind: '$artist' },

      // lookup album
      {
        $lookup: {
          from: 'albums',
          localField: 'albumId',
          foreignField: '_id',
          as: 'album'
        }
      },
      { $unwind: '$album' },

      // lookup genre
      {
        $lookup: {
          from: 'genres',
          localField: 'genreIds',
          foreignField: '_id',
          as: 'genres'
        }
      },

      // chỉ lấy trường cần thiết
      {
        $project: {
          _id: 1,
          title: 1,
          imageUrl: 1,
          artist: { _id: 1, stageName: 1 },
          album: { _id: 1, name: 1 },
          genres: { _id: 1, name: 1 }
        }
      }
    ]);
  }

  async findByAlbumId(albumId: string): Promise<Song[] | null> {
    return await this.songRepo.find({ albumId, deleted: false }).lean().exec();
  }

  async findSongIdsByAlbumId(albumId: string): Promise<
    | {
        _id: Types.ObjectId;
      }[]
    | []
  > {
    return await this.songRepo.find({ albumId, deleted: false }).select('_id').lean<{ _id: Types.ObjectId }[]>().exec();
  }

  async findAll(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter: Record<string, any>,
    skip: number,
    limit: number,
    sort: Record<string, 1 | -1>
  ): Promise<Song[] | []> {
    const pipeline = [
      { $match: { deleted: false, ...(filter || {}) } },

      // artist
      {
        $lookup: {
          from: 'artists',
          localField: 'createdBy',
          foreignField: 'artistId',
          as: 'artist'
        }
      },
      { $unwind: { path: '$artist', preserveNullAndEmptyArrays: true } },

      // feat artists
      {
        $lookup: {
          from: 'artists',
          localField: 'featArtistIds',
          foreignField: '_id',
          as: 'featArtists'
        }
      },

      // album
      {
        $lookup: {
          from: 'albums',
          localField: 'albumId',
          foreignField: '_id',
          as: 'album'
        }
      },
      { $unwind: { path: '$album', preserveNullAndEmptyArrays: true } },

      // project to match previous select + populated shapes
      {
        $project: {
          _id: 1,
          title: 1,
          duration: 1,
          imageUrl: 1,
          genreNames: 1,
          name: 1,

          artist: { _id: '$artist._id', name: '$artist.name' },
          album: { _id: '$album._id', name: '$album.name' },
          featArtists: {
            $map: {
              input: '$featArtists',
              as: 'a',
              in: { _id: '$$a._id', stageName: '$$a.name' }
            }
          }
        }
      },

      { $sort: sort || { _id: -1 } },
      { $skip: skip || 0 },
      { $limit: limit || 0 }
    ];

    return (await this.songRepo.aggregate(pipeline).exec()) as Song[];
  }

  async getDetail(_id: string): Promise<Song | null> {
    const result = await this.songRepo.aggregate([
      // 1) MATCH bài hát theo ID
      {
        $match: { _id: new Types.ObjectId(_id) }
      },

      // 2) Lookup nghệ sĩ chính
      {
        $lookup: {
          from: 'artists',
          localField: 'artistId',
          foreignField: '_id',
          as: 'artistId', // Trả về dạng object cho frontend
          pipeline: [{ $project: { name: 1, avatarUrl: 1, bannerUrl: 1 } }]
        }
      },
      { $unwind: '$artistId' },

      // 3) Lookup các nghệ sĩ feat
      {
        $lookup: {
          from: 'artists',
          localField: 'featArtistIds',
          foreignField: '_id',
          as: 'featArtists',
          pipeline: [{ $project: { name: 1, avatarUrl: 1 } }]
        }
      },

      // 4) Lookup album
      {
        $lookup: {
          from: 'albums',
          localField: 'albumId',
          foreignField: '_id',
          as: 'albumId', // Trả về dạng object cho frontend
          pipeline: [{ $project: { name: 1, img: 1, total_songs: 1, release_date: 1 } }]
        }
      },
      { $unwind: { path: '$albumId', preserveNullAndEmptyArrays: true } },

      // 5) Lookup total likes
      {
        $lookup: {
          from: 'likes',
          localField: '_id',
          foreignField: 'songId',
          as: 'likes'
        }
      },
      {
        $addFields: {
          likesCount: { $size: '$likes' }
        }
      },
      {
        $project: {
          _id: 1,
          name: 1,
          mp3Link: 1,
          lyrics: 1,
          duration: 1,
          imageUrl: 1,
          artistId: 1,
          albumId: 1,
          featArtists: 1,
          genreNames: 1,
          likesCount: 1,
          releseStatus: 1,
          releaseAt: 1
        }
      }
    ]);

    return result[0];
  }

  async getSongsByArtistId(artistId: string): Promise<Partial<Song[]> | null> {
    const songs = await this.songRepo.aggregate([
      {
        $match: { artistId: new Types.ObjectId(artistId), releseStatus: SongReleseStatus.PUBLISHED }
      },
      {
        $lookup: {
          from: 'albums',
          localField: 'albumId',
          foreignField: '_id',
          as: 'album',
          pipeline: [{ $project: { name: 1 } }]
        }
      },
      { $unwind: { path: '$album', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1,
          imageUrl: 1,
          duration: 1,
          album: 1,
          releseStatus: 1,
          releaseAt: 1
        }
      },
      {
        $sort: { releaseAt: -1 }
      }
    ]);
    return songs;
  }

  async getSongsForClient(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter: Record<string, any>,
    skip: number,
    size: number,
    select?: string | string[]
  ): Promise<Partial<Song[]> | []> {
    const songs = this.songRepo
      .find({ deleted: false, ...filter })
      .populate('artistId', 'name')
      .skip(skip)
      .limit(size)
      .lean();
    if (select) songs.select(select);
    return await songs.exec();
  }

  async searchByName(keyword: string, limit = 20): Promise<Song[] | []> {
    if (!keyword?.trim()) return [];

    const pipeline = SearchPipelineBuilder.textSearch(keyword, {
      limit
    });

    return this.songRepo.aggregate(pipeline);
  }

  async increaseLikes(_id: string, session?: ClientSession): Promise<Song | null> {
    return this.songRepo.findByIdAndUpdate(_id, { $inc: { likes: 1 } }, { new: true, session }).exec();
  }

  async decreaseLikesIfPossible(_id: string, session?: ClientSession): Promise<Song | null> {
    return this.songRepo
      .findOneAndUpdate({ _id, likes: { $gt: 0 } }, { $inc: { likes: -1 } }, { new: true, session })
      .exec();
  }

  async findByIds(_ids: string[]): Promise<Song[] | []> {
    return await this.songRepo
      .find({ _id: { $in: _ids } })
      .lean()
      .exec();
  }

  async findTopByLikes(limit: number): Promise<Song[] | []> {
    return await this.songRepo.find({ deleted: false }).sort({ likes: -1 }).limit(limit).lean().exec();
  }

  findForLeaderboard(skip: number, limit: number) {
    return this.songRepo.find({ deleted: false }).select({ _id: 1, likes: -1 }).skip(skip).limit(limit).lean();
  }

  async genRandomSong(): Promise<Song> {
    const result = await this.songRepo.aggregate([
      { $match: { releseStatus: SongReleseStatus.PUBLISHED, deleted: false } },
      { $sample: { size: 1 } }
    ]);
    return result[0];
  }

  async increaseViews(_id: string): Promise<Song | null> {
    return this.songRepo.findByIdAndUpdate(_id, { $inc: { views: 1 } }, { new: true }).exec();
  }

  // Trong song.repository.ts
  async recordListen(songId: string, userId?: string): Promise<void> {
    await this.listenModel.create({
      songId: new Types.ObjectId(songId),
      userId: userId ? new Types.ObjectId(userId) : null
    });
  }

  async findTopByViews(limit: number = 10): Promise<Song[]> {
    const songs = await this.songRepo
      .find({
        deleted: false,
        status: SongStatus.ACTIVED
      })
      .sort({ views: -1 })
      .limit(limit)
      // Lưu ý: Đảm bảo field trong bảng Artist là 'avatarUrl' hay 'imageUrl'
      // Thông thường project của bạn hay dùng 'imageUrl' cho đồng bộ
      .populate('artistId', 'name imageUrl avatarUrl')
      .lean()
      .exec();

    return (songs as Song[]) || [];
  }

  async getTopSongsByTimeFrame(limit: number, startDate?: Date) {
    // Chỉ lấy điều kiện query, không bọc $match ở đây
    const query = startDate ? { createdAt: { $gte: startDate } } : {};

    return this.listenModel.aggregate([
      { $match: query }, // Bọc $match ở đây là đủ
      {
        $group: {
          _id: '$songId',
          listenCount: { $sum: 1 }
        }
      },
      { $sort: { listenCount: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'songs', // KIỂM TRA KỸ: có thể là 'songs' hoặc 'Song' tùy DB của bạn
          localField: '_id',
          foreignField: '_id',
          as: 'songDetail'
        }
      },
      { $unwind: '$songDetail' },
      {
        $project: {
          _id: 0,
          listenCount: 1,
          song: '$songDetail'
        }
      }
    ]);
  }
}
