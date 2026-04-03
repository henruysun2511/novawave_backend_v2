import { InjectModel } from '@nestjs/mongoose';
import { Injectable } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { RoomQueueItemStatus } from 'common/enum';

import { RoomQueueItem } from '../schemas/room-queue-item.schema';

@Injectable()
export class RoomQueueRepository {
  constructor(@InjectModel(RoomQueueItem.name) private readonly queueRepo: Model<RoomQueueItem>) {}

  async createMany(items: Partial<RoomQueueItem>[]) {
    return this.queueRepo.insertMany(items, { ordered: true });
  }

  async create(item: Partial<RoomQueueItem>) {
    return this.queueRepo.create(item);
  }

  async findById(id: string) {
    return this.queueRepo
      .findOne({ _id: id, deleted: false })
      .populate({
        path: 'songId',
        select: '_id name imageUrl mp3Link lyrics duration artistId',
        populate: { path: 'artistId', select: '_id name avatarUrl' }
      })
      .populate('requestedBy', '_id username avatar')
      .populate('approvedBy', '_id username avatar')
      .lean()
      .exec();
  }

  async findByRoomId(roomId: string, statuses?: RoomQueueItemStatus[]) {
    const filter: Record<string, unknown> = {
      roomId: new Types.ObjectId(roomId),
      deleted: false
    };
    if (statuses?.length) {
      filter.status = { $in: statuses };
    }

    return this.queueRepo
      .find(filter)
      .populate({
        path: 'songId',
        select: '_id name imageUrl mp3Link lyrics duration artistId',
        populate: { path: 'artistId', select: '_id name avatarUrl' }
      })
      .populate('requestedBy', '_id username avatar')
      .populate('approvedBy', '_id username avatar')
      .sort({ order: 1, createdAt: 1 })
      .lean()
      .exec();
  }

  async update(id: string, queueData: Partial<RoomQueueItem>) {
    return this.queueRepo
      .findByIdAndUpdate(id, { $set: queueData }, { new: true })
      .populate({
        path: 'songId',
        select: '_id name imageUrl mp3Link lyrics duration artistId',
        populate: { path: 'artistId', select: '_id name avatarUrl' }
      })
      .populate('requestedBy', '_id username avatar')
      .populate('approvedBy', '_id username avatar')
      .lean()
      .exec();
  }

  async getMaxOrder(roomId: string) {
    const item = await this.queueRepo
      .findOne({
        roomId: new Types.ObjectId(roomId),
        deleted: false,
        status: { $in: [RoomQueueItemStatus.APPROVED, RoomQueueItemStatus.PLAYING, RoomQueueItemStatus.PLAYED] }
      })
      .sort({ order: -1 })
      .select('order')
      .lean<{ order?: number }>()
      .exec();

    return item?.order ?? 0;
  }

  async countPendingByRoomId(roomId: string) {
    return this.queueRepo.countDocuments({
      roomId: new Types.ObjectId(roomId),
      deleted: false,
      status: RoomQueueItemStatus.PENDING
    });
  }

  async countPendingByRoomIdAndUserId(roomId: string, userId: string) {
    return this.queueRepo.countDocuments({
      roomId: new Types.ObjectId(roomId),
      requestedBy: new Types.ObjectId(userId),
      deleted: false,
      status: RoomQueueItemStatus.PENDING
    });
  }

  async findDuplicate(roomId: string, songId: string) {
    return this.queueRepo
      .findOne({
        roomId: new Types.ObjectId(roomId),
        songId: new Types.ObjectId(songId),
        deleted: false,
        status: {
          $in: [RoomQueueItemStatus.PENDING, RoomQueueItemStatus.APPROVED, RoomQueueItemStatus.PLAYING]
        }
      })
      .lean()
      .exec();
  }

  async findCurrentPlaying(roomId: string) {
    return this.queueRepo
      .findOne({
        roomId: new Types.ObjectId(roomId),
        deleted: false,
        status: RoomQueueItemStatus.PLAYING
      })
      .lean()
      .exec();
  }

  async findNextPlayable(roomId: string, currentOrder?: number) {
    const filter: Record<string, unknown> = {
      roomId: new Types.ObjectId(roomId),
      deleted: false,
      status: RoomQueueItemStatus.APPROVED
    };

    if (typeof currentOrder === 'number') {
      filter.order = { $gt: currentOrder };
    }

    return this.queueRepo.findOne(filter).sort({ order: 1, createdAt: 1 }).lean().exec();
  }
}
