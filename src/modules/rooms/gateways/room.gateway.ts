import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from '@nestjs/websockets';
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { env } from 'configs';
import { CustomLogger } from 'loggers/nestToWinstonLogger.service';

import { CreateRoomMessageDto, RoomControlDto } from '../dtos';
import { RoomService } from '../services/room.service';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: '*'
  }
})
export class RoomGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly logger: CustomLogger,
    @Inject(forwardRef(() => RoomService))
    private readonly roomService: RoomService
  ) {}

  handleConnection(client: Socket) {
    const token = client.handshake.auth?.token;

    if (!token) {
      client.disconnect();
      return;
    }

    try {
      const payload = this.jwtService.verify(token, { secret: env.JWT_ACCESS_TOKEN_SECRET });
      client.data.userId = payload.sub;
      void client.join(`host_${payload.sub}`);
    } catch {
      this.logger.warn('Room socket auth failed', RoomGateway.name);
      client.disconnect();
    }
  }

  @SubscribeMessage('JOIN_ROOM')
  async joinRoom(@ConnectedSocket() client: Socket, @MessageBody('roomId') roomId: string) {
    const payload = await this.roomService.join(roomId, client.data.userId);
    await client.join(this.getRoomChannel(roomId));
    return payload;
  }

  @SubscribeMessage('LEAVE_ROOM')
  async leaveRoom(@ConnectedSocket() client: Socket, @MessageBody('roomId') roomId: string) {
    const payload = await this.roomService.leave(roomId, client.data.userId);
    await client.leave(this.getRoomChannel(roomId));
    return payload;
  }

  @SubscribeMessage('SEND_MESSAGE')
  async sendMessage(@ConnectedSocket() client: Socket, @MessageBody() body: CreateRoomMessageDto & { roomId: string }) {
    return this.roomService.createMessage(body.roomId, { content: body.content }, client.data.userId);
  }

  @SubscribeMessage('HOST_CONTROL')
  async hostControl(@ConnectedSocket() client: Socket, @MessageBody() body: RoomControlDto) {
    return this.roomService.handleHostControl(body, client.data.userId);
  }

  broadcastRoomUpdated(roomId: string, payload: unknown) {
    this.server.to(this.getRoomChannel(roomId)).emit('ROOM_UPDATED', payload);
  }

  broadcastRoomEnded(roomId: string, payload: unknown) {
    this.server.to(this.getRoomChannel(roomId)).emit('ROOM_ENDED', payload);
  }

  broadcastQueueUpdated(roomId: string, payload: unknown) {
    this.server.to(this.getRoomChannel(roomId)).emit('QUEUE_UPDATED', payload);
  }

  broadcastRequestResolved(roomId: string, payload: unknown) {
    this.server.to(this.getRoomChannel(roomId)).emit('REQUEST_UPDATED', payload);
  }

  broadcastMessage(roomId: string, payload: unknown) {
    this.server.to(this.getRoomChannel(roomId)).emit('RECEIVE_MESSAGE', payload);
  }

  broadcastUserJoined(roomId: string, payload: unknown) {
    this.server.to(this.getRoomChannel(roomId)).emit('USER_JOINED', payload);
  }

  broadcastUserLeft(roomId: string, payload: unknown) {
    this.server.to(this.getRoomChannel(roomId)).emit('USER_LEFT', payload);
  }

  notifyNewRequest(roomId: string, payload: unknown, _hostId: string) {
    // Chỉ emit vào room channel - host đã ở trong room channel nên sẽ nhận được
    // Không emit thêm vào host private channel để tránh host nhận 2 lần
    this.server.to(this.getRoomChannel(roomId)).emit('NEW_REQUEST_NOTIFICATION', payload);
  }

  broadcastParticipantModerated(roomId: string, payload: unknown) {
    this.server.to(this.getRoomChannel(roomId)).emit('PARTICIPANT_MODERATED', payload);
  }

  broadcastPlayerSync(roomId: string, payload: unknown) {
    this.server.to(this.getRoomChannel(roomId)).emit('PLAYER_STATE_SYNC', payload);
  }

  broadcastHostControl(roomId: string, payload: unknown) {
    this.server.to(this.getRoomChannel(roomId)).emit('HOST_CONTROL', payload);
  }

  private getRoomChannel(roomId: string) {
    return `room_${roomId}`;
  }
}
