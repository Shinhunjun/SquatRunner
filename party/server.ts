import type * as Party from "partykit/server";

interface PlayerInfo {
  id: string;
  name: string;
  lane: number;
  calibrated: boolean;
}

export default class GameRoom implements Party.Server {
  players = new Map<string, PlayerInfo>();
  hostId: string | null = null;

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection) {
    conn.send(JSON.stringify({
      type: "room_state",
      players: Array.from(this.players.values()),
      hostId: this.hostId,
    }));
  }

  onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    if (typeof message !== "string") return;
    const data = JSON.parse(message) as Record<string, unknown>;

    if (data.type === "join") {
      if (!this.hostId) this.hostId = sender.id;
      this.players.set(sender.id, {
        id: sender.id,
        name: typeof data.name === "string" ? data.name : `P${this.players.size + 1}`,
        lane: 0,
        calibrated: false,
      });
      this.room.broadcast(JSON.stringify({
        type: "player_joined",
        players: Array.from(this.players.values()),
        hostId: this.hostId,
      }));
    }

    // 참가자 → 호스트: lane 업데이트만 특수 처리
    if (data.type === "lane_update") {
      const p = this.players.get(sender.id);
      if (p) {
        p.lane = typeof data.lane === "number" ? data.lane : 0;
        p.calibrated = data.calibrated !== false;
        this.room.broadcast(JSON.stringify({
          type: "lane_update",
          playerId: sender.id,
          lane: p.lane,
          calibrated: p.calibrated,
        }), [sender.id]);
      }
      return;
    }

    // join은 위에서 처리됨 — 그 외 모든 메시지(game_sync, tick, full_sync 등)는
    // 자동 브로드캐스트. 새 타입 추가 시 서버 수정 불필요.
    if (data.type !== "join") {
      this.room.broadcast(JSON.stringify(data), [sender.id]);
    }
  }

  onClose(conn: Party.Connection) {
    this.players.delete(conn.id);
    if (conn.id === this.hostId) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    this.room.broadcast(JSON.stringify({
      type: "player_left",
      playerId: conn.id,
      players: Array.from(this.players.values()),
      hostId: this.hostId,
    }));
  }
}

GameRoom satisfies Party.Worker;
