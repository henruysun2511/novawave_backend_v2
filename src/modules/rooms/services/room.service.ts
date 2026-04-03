import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef
} from '@nestjs/common';
import { AppConfig } from 'common/constants';
import {
  RoomControlAction,
  RoomModerationAction,
  RoomParticipantRole,
  RoomParticipantStatus,
  RoomQueueItemStatus,
  RoomSourceType,
  RoomStatus
} from 'common/enum';
import { AlbumService } from 'modules/album/services/album.service';
import { PlaylistService } from 'modules/playlist/services/playlist.service';
import { SongService } from 'modules/songs/services/song.service';
import { IUserRequest } from 'shared/interfaces';
import { checkMongoId } from 'shared/utils/validateMongoId.util';

import {
  AddRoomQueueItemDto,
  CreateRoomDto,
  CreateRoomMessageDto,
  ModerateRoomParticipantDto,
  QueryRoomDto,
  RoomControlDto,
  SyncRoomPlaybackDto,
  UpdateRoomDto,
  UpdateRoomQueueItemDto
} from '../dtos';
import { RoomGateway } from '../gateways/room.gateway';
import { RoomMessageRepository } from '../repositories/room-message.repository';
import { RoomParticipantRepository } from '../repositories/room-participant.repository';
import { RoomQueueRepository } from '../repositories/room-queue.repository';
import { RoomRepository } from '../repositories/room.repository';

const MAX_PENDING_REQUESTS_PER_ROOM = 100;
const MAX_PENDING_REQUESTS_PER_USER = 5;

type PopulatedUserRef = {
  _id?: string;
  username?: string;
  avatar?: string;
} | null;

type RoomDetailLike = {
  hostId?: string | PopulatedUserRef | { _id?: { toString(): string } } | { toString(): string } | null;
  currentSongId?: string | { toString(): string } | null;
  startedAt?: Date;
  status?: RoomStatus;
  deleted?: boolean;
};

@Injectable()
export class RoomService {
  constructor(
    private readonly roomRepo: RoomRepository,
    private readonly roomQueueRepo: RoomQueueRepository,
    private readonly roomParticipantRepo: RoomParticipantRepository,
    private readonly roomMessageRepo: RoomMessageRepository,
    private readonly songService: SongService,
    private readonly playlistService: PlaylistService,
    private readonly albumService: AlbumService,
    @Inject(forwardRef(() => RoomGateway))
    private readonly roomGateway: RoomGateway
  ) {}

  async create(createRoomDto: CreateRoomDto, user: IUserRequest) {
    const activeRoom = await this.roomRepo.findOneActiveByHostId(user.userId);
    if (activeRoom) {
      throw new BadRequestException('Bạn đang có một phòng đang hoạt động');
    }

    const { sourceType, sourceId, songIds } = await this.resolveInitialSource(createRoomDto);
    const now = new Date();
    const scheduledAt = createRoomDto.scheduledAt;

    if (scheduledAt && scheduledAt <= now) {
      throw new BadRequestException('Thời gian lên lịch phải lớn hơn hiện tại');
    }

    const startImmediately = !scheduledAt;
    const room = await this.roomRepo.create({
      name: createRoomDto.name,
      description: createRoomDto.description,
      imageUrl: createRoomDto.imageUrl,
      hostId: user.userId,
      sourceType,
      sourceId,
      scheduledAt,
      startedAt: startImmediately ? now : undefined,
      status: startImmediately ? RoomStatus.STREAMING : RoomStatus.WAITING,
      isPlaying: startImmediately,
      playbackPositionMs: 0,
      playbackStartedAt: startImmediately ? now : undefined,
      participantCount: 1,
      createdBy: user.userId
    });

    const queueItems = songIds.map((songId, index) => ({
      roomId: room._id,
      songId,
      requestedBy: user.userId,
      approvedBy: user.userId,
      order: index + 1,
      status: startImmediately && index === 0 ? RoomQueueItemStatus.PLAYING : RoomQueueItemStatus.APPROVED,
      createdBy: user.userId
    }));

    const insertedQueue = await this.roomQueueRepo.createMany(queueItems);

    await this.roomParticipantRepo.create({
      roomId: room._id,
      userId: user.userId,
      role: RoomParticipantRole.HOST,
      status: RoomParticipantStatus.ACTIVE,
      joinedAt: now,
      lastSeenAt: now,
      createdBy: user.userId
    });

    const firstQueueItem = insertedQueue[0];
    await this.roomRepo.update(String(room._id), {
      currentSongId: firstQueueItem.songId,
      currentQueueItemId: firstQueueItem._id
    });

    return this.getDetail(String(room._id), user.userId);
  }

  async findAll(query: QueryRoomDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const size = Math.max(1, Number(query.size) || AppConfig.PAGINATION.SIZE_DEFAUT);
    const skip = (page - 1) * size;

    const filter: Record<string, unknown> = {
      status: query.status ? query.status : { $in: [RoomStatus.WAITING, RoomStatus.STREAMING, RoomStatus.PAUSED] }
    };

    if (query.search?.trim()) {
      filter.name = { $regex: query.search.trim(), $options: 'i' };
    }

    const [totalElements, data] = await Promise.all([
      this.roomRepo.countDocuments(filter),
      this.roomRepo.findAll(filter, skip, size)
    ]);

    return {
      meta: {
        page,
        size,
        totalPages: Math.ceil(totalElements / size),
        totalElements
      },
      data
    };
  }

  async findMine(userId: string) {
    return this.roomRepo.findAll({ hostId: userId }, 0, 100);
  }

  async getDetail(id: string, userId?: string) {
    const room = await this.findRoomOrThrow(id);
    const [queue, participants] = await Promise.all([
      this.roomQueueRepo.findByRoomId(id, [
        RoomQueueItemStatus.PENDING,
        RoomQueueItemStatus.APPROVED,
        RoomQueueItemStatus.PLAYING
      ]),
      this.roomParticipantRepo.listActiveByRoomId(id)
    ]);

    const currentSongId = room.currentSongId ? String(room.currentSongId) : '';
    const currentSong = currentSongId ? await this.songService.getDetail(currentSongId) : null;
    const isHost = !!userId && this.getRoomHostId(room) === userId;

    return {
      ...room,
      currentSong,
      participants,
      queue: isHost ? queue : queue.filter((item) => item.status !== RoomQueueItemStatus.PENDING)
    };
  }

  async update(id: string, updateRoomDto: UpdateRoomDto, userId: string) {
    const room = await this.assertHost(id, userId);
    const patch: Record<string, unknown> = {};

    if (updateRoomDto.name) patch.name = updateRoomDto.name;
    if (updateRoomDto.description !== undefined) patch.description = updateRoomDto.description;
    if (updateRoomDto.imageUrl) patch.imageUrl = updateRoomDto.imageUrl;

    if (updateRoomDto.scheduledAt) {
      if (room.status !== RoomStatus.WAITING) {
        throw new BadRequestException('Chỉ được đổi lịch khi phòng chưa bắt đầu');
      }
      if (updateRoomDto.scheduledAt <= new Date()) {
        throw new BadRequestException('Thời gian lên lịch phải lớn hơn hiện tại');
      }
      patch.scheduledAt = updateRoomDto.scheduledAt;
    }

    if (updateRoomDto.status) {
      Object.assign(patch, this.buildStatusPatch(room, updateRoomDto.status));
    }

    const updated = await this.roomRepo.update(id, patch);
    if (updated?.status === RoomStatus.ENDED) {
      this.roomGateway.broadcastRoomEnded(id, updated);
    } else {
      this.roomGateway.broadcastRoomUpdated(id, updated);
    }
    return updated;
  }

  async remove(id: string, userId: string) {
    await this.assertHost(id, userId);
    const updated = await this.roomRepo.softDelete(id, userId);
    this.roomGateway.broadcastRoomEnded(id, updated);
    return updated;
  }

  async getQueue(id: string, userId: string) {
    const room = await this.findRoomOrThrow(id);
    const queue = await this.roomQueueRepo.findByRoomId(id, [
      RoomQueueItemStatus.PENDING,
      RoomQueueItemStatus.APPROVED,
      RoomQueueItemStatus.PLAYING,
      RoomQueueItemStatus.PLAYED
    ]);
    const isHost = this.getRoomHostId(room) === userId;
    return isHost ? queue : queue.filter((item) => item.status !== RoomQueueItemStatus.PENDING);
  }

  async addQueueItem(roomId: string, queueDto: AddRoomQueueItemDto, user: IUserRequest) {
    const room = await this.ensureRoomAccessible(roomId, user.userId);
    await this.songService.throwIfNotExist(queueDto.songId);

    const duplicate = await this.roomQueueRepo.findDuplicate(roomId, queueDto.songId);
    if (duplicate) {
      throw new BadRequestException('Bài hát đã tồn tại trong hàng đợi hoặc đang chờ duyệt');
    }

    const hostId = this.getRoomHostId(room);
    const isHost = hostId === user.userId;

    if (!isHost) {
      await this.ensureActiveParticipant(roomId, user.userId);
    }

    if (!isHost) {
      const [pendingByRoom, pendingByUser] = await Promise.all([
        this.roomQueueRepo.countPendingByRoomId(roomId),
        this.roomQueueRepo.countPendingByRoomIdAndUserId(roomId, user.userId)
      ]);

      if (pendingByRoom >= MAX_PENDING_REQUESTS_PER_ROOM) {
        throw new BadRequestException('Phòng đang có quá nhiều yêu cầu bài hát chờ duyệt');
      }

      if (pendingByUser >= MAX_PENDING_REQUESTS_PER_USER) {
        throw new BadRequestException('Bạn đang có quá nhiều yêu cầu bài hát chưa được duyệt');
      }
    }

    const nextOrder = (await this.roomQueueRepo.getMaxOrder(roomId)) + 1;
    const item = await this.roomQueueRepo.create({
      roomId,
      songId: queueDto.songId,
      requestedBy: user.userId,
      approvedBy: isHost ? user.userId : undefined,
      order: nextOrder,
      status: isHost ? RoomQueueItemStatus.APPROVED : RoomQueueItemStatus.PENDING,
      createdBy: user.userId
    });

    const detail = await this.roomQueueRepo.findById(String(item._id));

    if (isHost) {
      this.roomGateway.broadcastQueueUpdated(roomId, detail);
    } else {
      this.roomGateway.notifyNewRequest(roomId, detail, hostId);
    }

    return detail;
  }

  async updateQueueItem(roomId: string, queueId: string, dto: UpdateRoomQueueItemDto, userId: string) {
    await this.assertHost(roomId, userId);

    const queueItem = await this.roomQueueRepo.findById(queueId);
    if (!queueItem || String(queueItem.roomId) !== roomId) {
      throw new NotFoundException('Không tìm thấy bài hát trong hàng đợi');
    }

    if (![RoomQueueItemStatus.APPROVED, RoomQueueItemStatus.REJECTED].includes(dto.status)) {
      throw new BadRequestException('Trạng thái duyệt không hợp lệ');
    }

    const updated = await this.roomQueueRepo.update(queueId, {
      status: dto.status,
      approvedBy: userId,
      updatedBy: userId
    });

    this.roomGateway.broadcastRequestResolved(roomId, updated);
    if (updated?.status === RoomQueueItemStatus.APPROVED) {
      this.roomGateway.broadcastQueueUpdated(roomId, updated);
    }
    return updated;
  }

  async removeQueueItem(roomId: string, queueId: string, userId: string) {
    await this.assertHost(roomId, userId);

    const queueItem = await this.roomQueueRepo.findById(queueId);
    if (!queueItem || String(queueItem.roomId) !== roomId) {
      throw new NotFoundException('Không tìm thấy bài hát trong hàng đợi');
    }

    const updated = await this.roomQueueRepo.update(queueId, {
      status: RoomQueueItemStatus.REMOVED,
      deleted: true,
      deletedAt: new Date(),
      deletedBy: userId
    });

    this.roomGateway.broadcastQueueUpdated(roomId, updated);
    return updated;
  }

  async syncPlayback(roomId: string, dto: SyncRoomPlaybackDto, userId: string) {
    await this.assertHost(roomId, userId);
    const room = await this.findRoomOrThrow(roomId);
    const patch: Record<string, unknown> = { updatedBy: userId };

    if (dto.currentSongId) {
      await this.songService.throwIfNotExist(dto.currentSongId);
      patch.currentSongId = dto.currentSongId;
    }

    if (dto.currentQueueItemId) {
      const queueItem = await this.roomQueueRepo.findById(dto.currentQueueItemId);
      if (!queueItem || String(queueItem.roomId) !== roomId) {
        throw new BadRequestException('Bài hát đồng bộ không thuộc phòng');
      }
      patch.currentQueueItemId = dto.currentQueueItemId;
    }

    if (dto.currentTime !== undefined) patch.playbackPositionMs = dto.currentTime;
    if (dto.startedAt) patch.playbackStartedAt = dto.startedAt;

    if (dto.isPlaying !== undefined) {
      patch.isPlaying = dto.isPlaying;
      patch.status = dto.isPlaying
        ? RoomStatus.STREAMING
        : room.status === RoomStatus.ENDED
          ? RoomStatus.ENDED
          : RoomStatus.PAUSED;
    }

    const updated = await this.roomRepo.update(roomId, patch);
    this.roomGateway.broadcastPlayerSync(roomId, updated);
    return updated;
  }

  async getMessages(roomId: string, page = 1, size = AppConfig.PAGINATION.SIZE_DEFAUT) {
    await this.findRoomOrThrow(roomId);

    const p = Math.max(1, Number(page) || 1);
    const pageSize = Math.max(1, Number(size) || AppConfig.PAGINATION.SIZE_DEFAUT);
    const skip = (p - 1) * pageSize;

    const [data, totalElements] = await Promise.all([
      this.roomMessageRepo.findByRoomId(roomId, skip, pageSize),
      this.roomMessageRepo.countByRoomId(roomId)
    ]);

    return {
      meta: {
        page: p,
        size: pageSize,
        totalPages: Math.ceil(totalElements / pageSize),
        totalElements
      },
      data
    };
  }

  async getParticipants(roomId: string) {
    await this.findRoomOrThrow(roomId);
    return this.roomParticipantRepo.listActiveByRoomId(roomId);
  }

  async join(roomId: string, userId: string) {
    const room = await this.ensureRoomAccessible(roomId, userId);
    const existing = await this.roomParticipantRepo.findByRoomIdAndUserId(roomId, userId);
    const now = new Date();

    if (!existing) {
      await this.roomParticipantRepo.create({
        roomId,
        userId,
        role: RoomParticipantRole.LISTENER,
        status: RoomParticipantStatus.ACTIVE,
        joinedAt: now,
        lastSeenAt: now,
        createdBy: userId
      });
      await this.roomRepo.incrementParticipantCount(roomId, 1);
    } else if (existing.status !== RoomParticipantStatus.ACTIVE) {
      if (existing.status === RoomParticipantStatus.BANNED) {
        throw new ForbiddenException('Bạn đã bị cấm khỏi phòng');
      }
      await this.roomParticipantRepo.updateByRoomIdAndUserId(roomId, userId, {
        status: RoomParticipantStatus.ACTIVE,
        joinedAt: now,
        leftAt: null,
        lastSeenAt: now,
        updatedBy: userId
      });
      await this.roomRepo.incrementParticipantCount(roomId, 1);
    } else {
      await this.roomParticipantRepo.updateByRoomIdAndUserId(roomId, userId, {
        lastSeenAt: now,
        updatedBy: userId
      });
    }

    const participant = await this.roomParticipantRepo.findByRoomIdAndUserId(roomId, userId);
    this.roomGateway.broadcastUserJoined(roomId, participant);

    return { room, participant };
  }

  async leave(roomId: string, userId: string) {
    const room = await this.findRoomOrThrow(roomId);
    const existing = await this.roomParticipantRepo.findByRoomIdAndUserId(roomId, userId);

    if (!existing || existing.status !== RoomParticipantStatus.ACTIVE) {
      return { success: true };
    }

    if (existing.role === RoomParticipantRole.HOST) {
      throw new BadRequestException('Chủ phòng không thể rời phòng, hãy kết thúc phòng');
    }

    await this.roomParticipantRepo.updateByRoomIdAndUserId(roomId, userId, {
      status: RoomParticipantStatus.LEFT,
      leftAt: new Date(),
      updatedBy: userId
    });
    await this.roomRepo.incrementParticipantCount(roomId, -1);

    this.roomGateway.broadcastUserLeft(roomId, { roomId, userId, roomStatus: room.status });
    return { success: true };
  }

  async moderateParticipant(
    roomId: string,
    participantUserId: string,
    dto: ModerateRoomParticipantDto,
    userId: string
  ) {
    const room = await this.assertHost(roomId, userId);
    checkMongoId(participantUserId);

    const participant = await this.roomParticipantRepo.findByRoomIdAndUserId(roomId, participantUserId);
    if (!participant) {
      throw new NotFoundException('Không tìm thấy người tham gia');
    }

    if (String(participant.userId) === this.getRoomHostId(room)) {
      throw new BadRequestException('Không thể xử lý chủ phòng');
    }

    const nextStatus =
      dto.action === RoomModerationAction.BAN ? RoomParticipantStatus.BANNED : RoomParticipantStatus.KICKED;

    await this.roomParticipantRepo.updateByRoomIdAndUserId(roomId, participantUserId, {
      status: nextStatus,
      leftAt: new Date(),
      moderatedBy: userId,
      moderationReason: dto.reason,
      updatedBy: userId
    });

    if (participant.status === RoomParticipantStatus.ACTIVE) {
      await this.roomRepo.incrementParticipantCount(roomId, -1);
    }

    this.roomGateway.broadcastParticipantModerated(roomId, {
      roomId,
      userId: participantUserId,
      action: dto.action,
      reason: dto.reason
    });

    return { success: true };
  }

  async createMessage(roomId: string, dto: CreateRoomMessageDto, userId: string) {
    const room = await this.ensureRoomAccessible(roomId, userId);
    if (this.getRoomHostId(room) !== userId) {
      await this.ensureActiveParticipant(roomId, userId);
    }

    await this.roomMessageRepo.create({
      roomId,
      userId,
      content: dto.content,
      createdBy: userId
    });

    const latest = (await this.roomMessageRepo.findByRoomId(roomId, 0, 1))[0];
    this.roomGateway.broadcastMessage(roomId, latest);
    return latest;
  }

  async handleHostControl(dto: RoomControlDto, userId: string) {
    await this.assertHost(dto.roomId, userId);

    switch (dto.action) {
      case RoomControlAction.PLAY:
        return this.syncPlayback(
          dto.roomId,
          { isPlaying: true, currentTime: dto.currentTime, startedAt: new Date() },
          userId
        );
      case RoomControlAction.PAUSE:
        return this.syncPlayback(dto.roomId, { isPlaying: false, currentTime: dto.currentTime }, userId);
      case RoomControlAction.SEEK:
        return this.syncPlayback(dto.roomId, { currentTime: dto.currentTime }, userId);
      case RoomControlAction.NEXT:
        return this.playNext(dto.roomId, userId);
      case RoomControlAction.END:
        return this.update(dto.roomId, { status: RoomStatus.ENDED }, userId);
      case RoomControlAction.SYNC:
        return this.syncPlayback(
          dto.roomId,
          {
            currentQueueItemId: dto.currentQueueItemId,
            currentSongId: dto.currentSongId,
            currentTime: dto.currentTime
          },
          userId
        );
      default:
        throw new BadRequestException('Lệnh điều khiển không hợp lệ');
    }
  }

  private async playNext(roomId: string, userId: string) {
    const currentPlaying = await this.roomQueueRepo.findCurrentPlaying(roomId);

    let previousPlayingUpdated: unknown = null;
    if (currentPlaying) {
      previousPlayingUpdated = await this.roomQueueRepo.update(String(currentPlaying._id), {
        status: RoomQueueItemStatus.PLAYED,
        updatedBy: userId
      });
    }

    const nextPlayable = await this.roomQueueRepo.findNextPlayable(roomId, currentPlaying?.order);

    if (!nextPlayable) {
      const updated = await this.roomRepo.update(roomId, {
        currentSongId: null,
        currentQueueItemId: null,
        isPlaying: false,
        playbackPositionMs: 0,
        status: RoomStatus.PAUSED,
        updatedBy: userId
      });
      this.roomGateway.broadcastHostControl(roomId, { action: RoomControlAction.NEXT, room: updated, queueItem: null });
      return updated;
    }

    const playingItem = await this.roomQueueRepo.update(String(nextPlayable._id), {
      status: RoomQueueItemStatus.PLAYING,
      approvedBy: userId,
      updatedBy: userId
    });

    const updated = await this.roomRepo.update(roomId, {
      currentSongId: nextPlayable.songId,
      currentQueueItemId: nextPlayable._id,
      isPlaying: true,
      playbackPositionMs: 0,
      playbackStartedAt: new Date(),
      startedAt: new Date(),
      status: RoomStatus.STREAMING,
      updatedBy: userId
    });

    this.roomGateway.broadcastHostControl(roomId, {
      action: RoomControlAction.NEXT,
      room: updated,
      queueItem: playingItem
    });
    if (previousPlayingUpdated) {
      this.roomGateway.broadcastQueueUpdated(roomId, previousPlayingUpdated);
    }
    this.roomGateway.broadcastQueueUpdated(roomId, playingItem);

    return updated;
  }

  private async findRoomOrThrow(roomId: string) {
    checkMongoId(roomId);
    const room = await this.roomRepo.findById(roomId);
    if (!room) {
      throw new NotFoundException('Không tìm thấy phòng');
    }
    return room;
  }

  private async assertHost(roomId: string, userId: string) {
    const room = await this.findRoomOrThrow(roomId);
    const hostId = this.getRoomHostId(room);
    if (hostId !== userId) {
      throw new ForbiddenException('Chỉ chủ phòng mới được thực hiện thao tác này');
    }
    return room;
  }

  private async ensureRoomAccessible(roomId: string, userId: string) {
    const room = await this.findRoomOrThrow(roomId);
    const isHost = this.getRoomHostId(room) === userId;

    if (room.deleted) {
      throw new BadRequestException('Ph?ng ?? k?t th?c');
    }

    if (room.status === RoomStatus.ENDED && !isHost) {
      throw new BadRequestException('Ph?ng ?? k?t th?c');
    }

    const participant = await this.roomParticipantRepo.findByRoomIdAndUserId(roomId, userId);
    if (participant?.status === RoomParticipantStatus.BANNED) {
      throw new ForbiddenException('B?n ?? b? c?m kh?i ph?ng');
    }

    return room;
  }

  private buildStatusPatch(room: RoomDetailLike, status: RoomStatus) {
    const now = new Date();

    switch (status) {
      case RoomStatus.STREAMING:
        return {
          status,
          isPlaying: true,
          startedAt: room.startedAt ?? now,
          playbackStartedAt: now
        };
      case RoomStatus.PAUSED:
        return {
          status,
          isPlaying: false
        };
      case RoomStatus.ENDED:
        return {
          status,
          isPlaying: false,
          endedAt: now
        };
      case RoomStatus.WAITING:
        if (room.startedAt) {
          throw new BadRequestException('Không thể chuyển phòng đã bắt đầu về trạng thái chờ');
        }
        return {
          status,
          isPlaying: false
        };
      default:
        throw new BadRequestException('Trạng thái phòng không hợp lệ');
    }
  }

  private async resolveInitialSource(createRoomDto: CreateRoomDto) {
    const sources = [createRoomDto.initialSongId, createRoomDto.playlistId, createRoomDto.albumId].filter(Boolean);
    if (sources.length !== 1) {
      throw new BadRequestException('Phải chọn đúng một nguồn phát: bài hát, album hoặc playlist');
    }

    if (createRoomDto.initialSongId) {
      await this.songService.throwIfNotExist(createRoomDto.initialSongId);
      return {
        sourceType: RoomSourceType.SONG,
        sourceId: createRoomDto.initialSongId,
        songIds: [createRoomDto.initialSongId]
      };
    }

    if (createRoomDto.playlistId) {
      const playlist = await this.playlistService.getSongIdsOfPlaylistById(createRoomDto.playlistId);
      if (!playlist?.songIds?.length) {
        throw new BadRequestException('Playlist chưa có bài hát nào');
      }
      return {
        sourceType: RoomSourceType.PLAYLIST,
        sourceId: createRoomDto.playlistId,
        songIds: playlist.songIds.map((id) => String(id))
      };
    }

    const albumExists = await this.albumService.checkExist(createRoomDto.albumId);
    if (!albumExists) {
      throw new BadRequestException('Album không tồn tại');
    }
    const songs = await this.songService.findSongIdsByAlbumId(createRoomDto.albumId);
    if (!songs?.length) {
      throw new BadRequestException('Album chưa có bài hát nào');
    }

    return {
      sourceType: RoomSourceType.ALBUM,
      sourceId: createRoomDto.albumId,
      songIds: songs.map((song) => String(song._id))
    };
  }

  private async ensureActiveParticipant(roomId: string, userId: string) {
    const participant = await this.roomParticipantRepo.findByRoomIdAndUserId(roomId, userId);
    if (!participant || participant.status !== RoomParticipantStatus.ACTIVE) {
      throw new ForbiddenException('Bạn cần tham gia phòng trước khi thực hiện thao tác này');
    }
  }

  private getRoomHostId(room: RoomDetailLike) {
    if (room.hostId && typeof room.hostId === 'object' && '_id' in room.hostId && room.hostId._id) {
      return String(room.hostId._id);
    }
    return String(room.hostId ?? '');
  }
}
