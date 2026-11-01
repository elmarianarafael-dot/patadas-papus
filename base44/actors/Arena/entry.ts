import { Actor } from 'base44:runtime/actors';

const MAX_PLAYERS = 4;

const clampNum = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

/**
 * Sala cooperativa: guarda el estado público de cada jugador, reparte la lista de
 * enemigos que manda el anfitrión y retransmite los golpes del resto hacia él.
 */
export default class Arena extends Actor {
  players = new Map(); // conn.id -> estado público
  hostSeat = null;

  async handleStart() {
    const saved = await this.storage.get('players');
    if (Array.isArray(saved)) this.players = new Map(saved);
    this.hostSeat = null;
    for (const p of this.players.values()) {
      if (p.rol === 'host') this.hostSeat = p.seat;
    }

    // Tras una hibernación los sockets siguen enganchados: solo se van los que ya no están.
    const live = new Set(this.getConnections().map((c) => c.id));
    for (const id of [...this.players.keys()]) {
      if (!live.has(id)) this.players.delete(id);
    }
    if (this.players.size === 0) this.hostSeat = null;
  }

  roster() {
    return {
      type: 'roster',
      host: this.hostSeat,
      players: [...this.players.values()].map((p) => ({
        seat: p.seat,
        name: p.name,
        char: p.char,
        x: Math.round(p.x),
        y: Math.round(p.y),
        hp: Math.round(p.hp),
        maxHp: Math.round(p.maxHp),
        facing: p.facing,
        walk: Math.round(p.walk * 100) / 100,
      })),
    };
  }

  connOf(seat) {
    for (const [id, p] of this.players) {
      if (p.seat !== seat) continue;
      const conn = this.getConnections().find((c) => c.id === id);
      if (conn) return conn;
    }
    return null;
  }

  async handleConnect(conn) {
    if (!this.players.has(conn.id) && this.players.size >= MAX_PLAYERS) {
      conn.reject(4001, 'sala llena');
      return;
    }

    if (!this.players.has(conn.id)) {
      let maxSeat = 0;
      for (const p of this.players.values()) if (p.seat > maxSeat) maxSeat = p.seat;
      const seat = maxSeat + 1;
      this.players.set(conn.id, {
        seat,
        rol: null,
        name: 'Compa',
        char: null,
        x: 0,
        y: 0,
        hp: 100,
        maxHp: 100,
        facing: 1,
        walk: 0,
      });
      await this.storage.put('players', [...this.players.entries()]);
    }

    const me = this.players.get(conn.id);
    conn.send({ type: 'you', seat: me.seat });
    conn.send(this.roster());
    this.broadcast(this.roster());
  }

  handleMessage(conn, msg) {
    const me = this.players.get(conn.id);
    if (!me || typeof msg !== 'object' || msg === null) return;

    if (msg.type === 'me') {
      if (msg.rol === 'host' || msg.rol === 'guest') {
        me.rol = msg.rol;
        if (msg.rol === 'host') this.hostSeat = me.seat;
        else if (this.hostSeat === me.seat) this.hostSeat = null;
      }
      me.x = clampNum(msg.x, me.x, -1e6, 1e6);
      me.y = clampNum(msg.y, me.y, -1e6, 1e6);
      me.hp = clampNum(msg.hp, me.hp, 0, 9999);
      me.maxHp = clampNum(msg.maxHp, me.maxHp, 1, 9999);
      me.walk = clampNum(msg.walk, me.walk, 0, 1e5);
      me.facing = msg.facing === -1 ? -1 : 1;
      if (typeof msg.char === 'string') me.char = msg.char.slice(0, 40);
      if (typeof msg.name === 'string' && msg.name.trim()) me.name = msg.name.slice(0, 24);
      this.broadcast(this.roster());
      return;
    }

    if (msg.type === 'enemies' && me.seat === this.hostSeat && Array.isArray(msg.list)) {
      const payload = {
        type: 'enemies',
        wave: clampNum(msg.wave, 1, 1, 9999),
        list: msg.list.slice(0, 140),
      };
      for (const [id, p] of this.players) {
        if (p.seat === this.hostSeat) continue;
        const conn2 = this.getConnections().find((c) => c.id === id);
        if (conn2) conn2.send(payload);
      }
      return;
    }

    if (msg.type === 'hits' && me.seat !== this.hostSeat && Array.isArray(msg.list)) {
      const host = this.connOf(this.hostSeat);
      if (host) host.send({ type: 'hits', list: msg.list.slice(0, 40) });
    }
  }

  async handleClose(conn) {
    const me = this.players.get(conn.id);
    if (!me) return;
    this.players.delete(conn.id);
    await this.storage.put('players', [...this.players.entries()]);

    if (me.seat === this.hostSeat) {
      this.hostSeat = null;
      this.broadcast({ type: 'closed' });
    } else {
      this.broadcast(this.roster());
    }
  }
}