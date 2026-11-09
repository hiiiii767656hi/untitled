/**
 * 3D Multiplayer Physics Sandbox - Anti-Cheat Node.js Sunucusu
 * Özellikler:
 * - Bağımsız portal çifti (scaleX, scaleY, yer/duvar normali ve rotasyon senkronizasyonu)
 * - Yerdeki ve duvardaki portallar için hatasız ışınlanma ve tolerans yönetimi
 * - Karakter ve obje büyüme/küçülme (scaleFactor) desteği ve senkronizasyonu
 * - El eşyaları (Sağ el silah, Sol el off-hand blok) ve Minecraft swing animasyon senkronizasyonu
 * - Gelişmiş Anti-Cheat (boyuta ve portal geçişlerine göre dinamik hız/ışınlanma toleransı)
 * - HTTP Statik Dosya Sunumu (index.html, firebase config, public assets) + WebSocket + UDP
 * Çalıştırma: node server.js
 */

import http from 'http';
import crypto from 'crypto';
import dgram from 'dgram';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'mert2014';
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const MAX_PROPS = 200;
const MAX_CARS = 20;

let tcpClients = new Set();
let udpClients = {};
let players = {};
let props = {};
let cars = {};
let portalsByPlayer = {};
let propSeq = 0;

function clampNum(val, def = 0, limit = 10000) {
  const v = parseFloat(val);
  if (isNaN(v) || !isFinite(v)) return def;
  return Math.max(-limit, Math.min(limit, v));
}

function clampRange(val, min, max, def) {
  const v = parseFloat(val);
  if (isNaN(v) || !isFinite(v)) return def;
  return Math.max(min, Math.min(max, v));
}

function playerPublic(p) {
  return {
    type: 'playerUpdate',
    id: p.id,
    color: p.color,
    skin: p.skin || 'steve',
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    hp: p.hp,
    armor: p.armor || 0,
    playerScale: p.playerScale || 1.0,
    holdingWeapon: p.holdingWeapon || 0,
    holdingItem: p.holdingItem || 'ramp',
    isSwinging: !!p.isSwinging,
    isAdmin: !!p.isAdmin,
    godMode: !!p.godMode,
    isShattered: !!p.isShattered,
    driving: !!p.driving,
    marble: !!p.marble,
    mq: p.mq || [0, 0, 0, 1],
    rag: p.rag
  };
}

function carPublic(c) {
  return {
    type: 'carUpdate',
    id: c.id,
    color: c.color,
    driverId: c.driverId || '',
    steerAngle: c.steerAngle || 0,
    wheelSpin: c.wheelSpin || 0,
    scaleFactor: c.scaleFactor || 1.0,
    x: c.x,
    y: c.y,
    z: c.z,
    qx: c.qx,
    qy: c.qy,
    qz: c.qz,
    qw: c.qw
  };
}

function encodeWsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len <= 125) {
    header = Buffer.from([0x81, len]);
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function broadcast(dataObj, excludeClient = null) {
  const raw = JSON.stringify(dataObj);
  const frame = encodeWsFrame(raw);
  for (const c of tcpClients) {
    if (c !== excludeClient && c.alive && c.playerId) {
      try { c.sock.write(frame); } catch (e) {}
    }
  }
  for (const k in udpClients) {
    const u = udpClients[k];
    if (u !== excludeClient && u.alive && u.playerId) {
      try { udpServer.send(raw, u.port, u.address); } catch (e) {}
    }
  }
}

function broadcastAll(dataObj) {
  broadcast(dataObj, null);
}

function sendToClient(client, dataObj) {
  if (!client || !client.alive) return;
  const raw = JSON.stringify(dataObj);
  if (client.proto === 'TCP') {
    try { client.sock.write(encodeWsFrame(raw)); } catch (e) {}
  } else if (client.proto === 'UDP') {
    try { udpServer.send(raw, client.port, client.address); } catch (e) {}
  }
}

function systemChat(text, targetClient = null, color = '#facc15') {
  const pkt = { type: 'chat', uid: 'SUNUCU', color, text };
  if (targetClient) sendToClient(targetClient, pkt);
  else broadcastAll(pkt);
}

function setPlayerAdmin(targetId, state = true) {
  const p = players[targetId];
  if (!p) return false;
  p.isAdmin = Boolean(state);
  if (!p.isAdmin) p.godMode = false;
  sendToClient(p.client, { type: 'adminStatus', isAdmin: p.isAdmin });
  broadcastAll(playerPublic(p));
  const msg = state
    ? '👑 ADMIN yetkisi verildi! Artık [P] tuşuyla Admin Panelini açabilirsiniz.'
    : 'Admin yetkiniz kaldırıldı.';
  systemChat(msg, p.client, state ? '#34d399' : '#f87171');
  return true;
}

function healPlayer(targetId) {
  if (targetId === 'all') {
    for (const pid in players) {
      players[pid].hp = 100;
      players[pid].armor = 100;
      players[pid].isShattered = false;
      sendToClient(players[pid].client, { type: 'hpUpdate', hp: 100, armor: 100 });
      broadcastAll(playerPublic(players[pid]));
    }
    systemChat('Tüm oyuncuların Can ve Zırhı 100 yapıldı!', null, '#34d399');
    return true;
  }
  const p = players[targetId];
  if (!p) return false;
  p.hp = 100;
  p.armor = 100;
  p.isShattered = false;
  sendToClient(p.client, { type: 'hpUpdate', hp: 100, armor: 100 });
  broadcastAll(playerPublic(p));
  systemChat('Can ve Zırhınız dolduruldu!', p.client, '#34d399');
  return true;
}

function killPlayer(targetId) {
  if (targetId === 'all') {
    for (const pid in players) {
      players[pid].hp = 0;
      players[pid].armor = 0;
      players[pid].isShattered = true;
      sendToClient(players[pid].client, { type: 'playerHit', targetId: pid, hp: 0, armor: 0, dx: 0, dy: 1.2, dz: 0 });
      broadcastAll(playerPublic(players[pid]));
    }
    systemChat('Tüm oyuncular admin tarafından parçalandı!', null, '#f87171');
    return true;
  }
  const p = players[targetId];
  if (!p) return false;
  p.hp = 0;
  p.armor = 0;
  p.isShattered = true;
  sendToClient(p.client, { type: 'playerHit', targetId, hp: 0, armor: 0, dx: 0, dy: 1.2, dz: 0 });
  broadcastAll(playerPublic(p));
  return true;
}

function teleportPlayer(targetId, x, y, z) {
  const p = players[targetId];
  if (!p) return false;
  p.x = x; p.y = y; p.z = z;
  p.lastCheckTime = Date.now();
  p.lastPortalTime = Date.now();
  sendToClient(p.client, { type: 'teleport', x, y, z });
  return true;
}

function kickPlayer(targetId, reason = 'Sunucudan atıldınız.') {
  const p = players[targetId];
  if (!p) return false;
  sendToClient(p.client, { type: 'kick', reason });
  systemChat(`Sunucudan atıldınız: ${reason}`, p.client, '#ef4444');
  removePlayerById(targetId);
  setTimeout(() => {
    if (p.client && p.client.sock) {
      try { p.client.sock.destroy(); } catch (e) {}
    }
  }, 40);
  p.client.alive = false;
  return true;
}

function clearAllProps() {
  props = {};
  broadcastAll({ type: 'clearProps' });
}

function anyActivePortalPairExists() {
  for (const ownerId in portalsByPlayer) {
    const pair = portalsByPlayer[ownerId];
    if (pair && pair.blue && pair.orange) return true;
  }
  return false;
}

function removePlayerById(pid) {
  if (pid && players[pid]) {
    delete players[pid];
    delete portalsByPlayer[pid];
    for (const cid in cars) {
      if (cars[cid].driverId === pid) {
        cars[cid].driverId = '';
        broadcastAll(carPublic(cars[cid]));
      }
    }
    broadcastAll({ type: 'playerLeave', id: pid });
  }
}

function handleChatCommand(client, p, text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === '/help') {
    systemChat('Komutlar: /admin <şifre>, /list, /god, /heal, /kill, /clear, /say', client);
    return;
  }
  if (cmd === '/list') {
    const ids = Object.keys(players).map(pid => `${pid}${players[pid].isAdmin ? '👑' : ''}(${players[pid].hp}HP/${players[pid].armor || 0}🛡️)`);
    systemChat('Oyuncular: ' + (ids.join(', ') || 'Yok'), client);
    return;
  }
  if (cmd === '/admin' || cmd === '/login') {
    if (args.length >= 1 && args[0] === ADMIN_PASSWORD) {
      setPlayerAdmin(p.id, true);
    } else {
      systemChat('⛔ Hatalı admin şifresi!', client, '#ef4444');
    }
    return;
  }

  if (!p.isAdmin) {
    systemChat('⛔ Bu komutu sadece yetkililer (Admin) kullanabilir!', client, '#ef4444');
    return;
  }

  if (cmd === '/god') {
    p.godMode = !p.godMode;
    sendToClient(client, { type: 'godMode', enabled: p.godMode });
    systemChat(`Ölümsüzlük: ${p.godMode ? 'AÇIK' : 'KAPALI'}`, client, '#34d399');
  } else if (cmd === '/heal') {
    healPlayer(args[0] || p.id);
  } else if (cmd === '/kill' && args[0]) {
    killPlayer(args[0]);
  } else if (cmd === '/kick' && args[0]) {
    kickPlayer(args[0]);
  } else if (cmd === '/clear') {
    clearAllProps();
  } else if (cmd === '/say' && args.length > 0) {
    systemChat('📢 [DUYURU] ' + args.join(' '), null, '#f43f5e');
  }
}

function handlePacket(client, rawText) {
  let msg;
  try { msg = JSON.parse(rawText); } catch (e) { return; }
  if (!msg || typeof msg !== 'object') return;
  const mtype = msg.type;
  let pid = client.playerId;

  if (mtype === 'join') {
    let rawId = String(msg.id || '').replace(/[^\w-]/g, '').substring(0, 18);
    if (!rawId || (!rawId.startsWith('Anon_') && !rawId.startsWith('Steve_') && !rawId.startsWith('Player_'))) {
      rawId = 'Steve_' + Math.random().toString(36).substring(2, 7);
    }
    if (pid && pid !== rawId && players[pid] && players[pid].client === client) {
      removePlayerById(pid);
    }
    if (players[rawId] && players[rawId].client !== client) {
      rawId = `${rawId}_${Math.floor(Math.random() * 900 + 100)}`;
    }
    client.playerId = rawId;

    const adminPass = String(msg.adminPass || '').trim();
    const autoAdmin = (adminPass !== '' && adminPass === ADMIN_PASSWORD);
    const color = HEX_RE.test(msg.color) ? msg.color : '#00ffff';

    const p = {
      id: rawId,
      color,
      skin: String(msg.skin || 'steve').substring(0, 65536),
      x: clampNum(msg.x, 0, 500),
      y: clampNum(msg.y, 15, 500),
      z: clampNum(msg.z, 8, 500),
      yaw: clampNum(msg.yaw, 0, 20),
      hp: 100,
      armor: 50,
      playerScale: clampRange(msg.playerScale, 0.25, 4.5, 1.0),
      holdingWeapon: typeof msg.holdingWeapon === 'number' ? msg.holdingWeapon : 0,
      holdingItem: String(msg.holdingItem || 'ramp').substring(0, 30),
      isSwinging: false,
      isAdmin: autoAdmin,
      godMode: false,
      isShattered: false,
      driving: false,
      marble: false,
      mq: [0, 0, 0, 1],
      rag: null,
      lastPortalTime: 0,
      lastCheckTime: Date.now(),
      client
    };
    players[rawId] = p;

    sendToClient(client, {
      type: 'init',
      selfId: rawId,
      isAdmin: autoAdmin,
      players: Object.values(players).filter(o => o.id !== rawId).map(playerPublic),
      props: Object.values(props),
      cars: Object.values(cars).map(carPublic),
      portalsByPlayer
    });

    if (autoAdmin) {
      sendToClient(client, { type: 'adminStatus', isAdmin: true });
      systemChat('👑 Yetkili girişi doğrulandı! [P] tuşuyla Admin Panelini açabilirsiniz.', client, '#34d399');
    }
    broadcast(playerPublic(p), client);
  }

  else if (mtype === 'playerUpdate') {
    const p = players[pid];
    if (!p) return;

    const nx = clampNum(msg.x, p.x, 500);
    const ny = clampNum(msg.y, p.y, 500);
    const nz = clampNum(msg.z, p.z, 500);

    if (msg.portalPass) p.lastPortalTime = Date.now();
    if (msg.playerScale !== undefined) p.playerScale = clampRange(msg.playerScale, 0.25, 4.5, p.playerScale || 1.0);
    if (typeof msg.holdingWeapon === 'number') p.holdingWeapon = msg.holdingWeapon;
    if (typeof msg.holdingItem === 'string') p.holdingItem = msg.holdingItem.substring(0, 30);
    p.isSwinging = Boolean(msg.isSwinging);

    const scaleSpeedFactor = Math.max(1.0, Math.sqrt(p.playerScale || 1.0));
    const recentlyUsedPortal = (Date.now() - (p.lastPortalTime || 0)) < 4000 || anyActivePortalPairExists();

    if (!p.isAdmin && !p.driving && !recentlyUsedPortal) {
      const now = Date.now();
      const dt = Math.max(0.03, (now - (p.lastCheckTime || now)) / 1000);
      const distXZ = Math.hypot(nx - p.x, nz - p.z);
      if (distXZ / dt > 280 * scaleSpeedFactor && distXZ > 110 * scaleSpeedFactor) {
        sendToClient(client, { type: 'teleport', x: p.x, y: p.y, z: p.z });
        return;
      }
      p.lastCheckTime = now;
    } else {
      p.lastCheckTime = Date.now();
    }

    p.x = nx; p.y = ny; p.z = nz;
    p.yaw = clampNum(msg.yaw, 0, 20);
    if (HEX_RE.test(msg.color)) p.color = msg.color;
    if (typeof msg.skin === 'string') p.skin = msg.skin.substring(0, 65536);
    p.isShattered = Boolean(msg.isShattered);
    p.driving = Boolean(msg.driving);
    p.marble = Boolean(msg.marble);
    if (Array.isArray(msg.mq) && msg.mq.length === 4) p.mq = msg.mq.map(v => clampNum(v, 0, 1));
    p.rag = (p.isShattered && Array.isArray(msg.rag)) ? msg.rag : null;
    broadcast(playerPublic(p), client);
  }

  else if (mtype === 'placePortal') {
    if (!pid) return;
    const isOrange = Boolean(msg.isOrange);
    const fallbackScale = clampRange(msg.scale, 0.4, 5.0, 1.5);
    const scaleX = clampRange(msg.scaleX, 0.4, 5.0, fallbackScale);
    const scaleY = clampRange(msg.scaleY, 0.4, 5.0, fallbackScale);
    const effectiveScale = Math.round(Math.sqrt(scaleX * scaleY) * 100) / 100;

    if (!portalsByPlayer[pid]) {
      portalsByPlayer[pid] = { blue: null, orange: null };
    }
    const pData = {
      type: 'placePortal',
      ownerId: pid,
      isOrange,
      x: clampNum(msg.x, 0, 350),
      y: clampNum(msg.y, 0, 350),
      z: clampNum(msg.z, 0, 350),
      nx: clampNum(msg.nx, 0, 1),
      ny: clampNum(msg.ny, 1, 1),
      nz: clampNum(msg.nz, 0, 1),
      scale: effectiveScale,
      scaleX,
      scaleY,
      wallIdx: typeof msg.wallIdx === 'number' ? msg.wallIdx : -1,
      ux: msg.ux !== undefined ? clampNum(msg.ux, 0, 1) : null,
      uy: msg.uy !== undefined ? clampNum(msg.uy, 0, 1) : null,
      uz: msg.uz !== undefined ? clampNum(msg.uz, 0, 1) : null
    };
    if (isOrange) portalsByPlayer[pid].orange = pData;
    else portalsByPlayer[pid].blue = pData;
    broadcast(pData, client);
  }

  else if (mtype === 'portalScale') {
    if (!pid) return;
    const scale = clampRange(msg.scale, 0.4, 5.0, 1.5);
    const scaleX = clampRange(msg.scaleX, 0.4, 5.0, scale);
    const scaleY = clampRange(msg.scaleY, 0.4, 5.0, scale);
    if (portalsByPlayer[pid]) {
      if (msg.isOrange === true && portalsByPlayer[pid].orange) {
        portalsByPlayer[pid].orange.scale = scale;
        portalsByPlayer[pid].orange.scaleX = scaleX;
        portalsByPlayer[pid].orange.scaleY = scaleY;
      } else if (msg.isOrange === false && portalsByPlayer[pid].blue) {
        portalsByPlayer[pid].blue.scale = scale;
        portalsByPlayer[pid].blue.scaleX = scaleX;
        portalsByPlayer[pid].blue.scaleY = scaleY;
      } else {
        if (portalsByPlayer[pid].blue) {
          portalsByPlayer[pid].blue.scale = scale;
          portalsByPlayer[pid].blue.scaleX = scaleX;
          portalsByPlayer[pid].blue.scaleY = scaleY;
        }
        if (portalsByPlayer[pid].orange) {
          portalsByPlayer[pid].orange.scale = scale;
          portalsByPlayer[pid].orange.scaleX = scaleX;
          portalsByPlayer[pid].orange.scaleY = scaleY;
        }
      }
    }
    broadcast({ type: 'portalScale', ownerId: pid, isOrange: msg.isOrange, scale, scaleX, scaleY }, client);
  }

  else if (mtype === 'teleportProp') {
    if (!pid) return;
    const propId = String(msg.id || '');
    const pr = props[propId];
    if (pr) {
      pr.x = clampNum(msg.x, pr.x, 300);
      pr.y = clampNum(msg.y, pr.y, 200);
      pr.z = clampNum(msg.z, pr.z, 300);
      if (msg.scaleFactor !== undefined) pr.scaleFactor = clampRange(msg.scaleFactor, 0.25, 4.5, pr.scaleFactor || 1.0);
      if (msg.qx !== undefined) {
        pr.qx = clampNum(msg.qx, 0, 1);
        pr.qy = clampNum(msg.qy, 0, 1);
        pr.qz = clampNum(msg.qz, 0, 1);
        pr.qw = clampNum(msg.qw, 1, 1);
      }
      broadcast({
        type: 'teleportProp',
        id: propId,
        x: pr.x,
        y: pr.y,
        z: pr.z,
        scaleFactor: pr.scaleFactor || 1.0,
        vx: clampNum(msg.vx, 0, 90),
        vy: clampNum(msg.vy, 0, 90),
        vz: clampNum(msg.vz, 0, 90),
        qx: pr.qx,
        qy: pr.qy,
        qz: pr.qz,
        qw: pr.qw
      }, client);
    }
  }

  else if (mtype === 'teleportCar') {
    if (!pid) return;
    const cid = String(msg.id || '');
    const c = cars[cid];
    if (c) {
      c.x = clampNum(msg.x, c.x, 400);
      c.y = clampNum(msg.y, c.y, 300);
      c.z = clampNum(msg.z, c.z, 400);
      if (msg.scaleFactor !== undefined) c.scaleFactor = clampRange(msg.scaleFactor, 0.4, 3.0, c.scaleFactor || 1.0);
      if (msg.qx !== undefined) {
        c.qx = clampNum(msg.qx, 0, 1);
        c.qy = clampNum(msg.qy, 0, 1);
        c.qz = clampNum(msg.qz, 0, 1);
        c.qw = clampNum(msg.qw, 1, 1);
      }
      broadcast({
        type: 'teleportCar',
        id: cid,
        x: c.x,
        y: c.y,
        z: c.z,
        scaleFactor: c.scaleFactor || 1.0,
        vx: clampNum(msg.vx, 0, 90),
        vy: clampNum(msg.vy, 0, 90),
        vz: clampNum(msg.vz, 0, 90),
        qx: c.qx,
        qy: c.qy,
        qz: c.qz,
        qw: c.qw
      }, client);
    }
  }

  else if (mtype === 'playerHit') {
    const now = Date.now();
    if (!pid || now - (client.lastHit || 0) < 150) return;
    client.lastHit = now;
    const tgt = players[String(msg.targetId || '')];
    if (!tgt || tgt.id === pid || tgt.godMode) return;
    let dmg = parseInt(clampNum(msg.damage, 25, 50), 10);

    if (tgt.armor > 0) {
      const absorbed = Math.min(tgt.armor, Math.ceil(dmg * 0.65));
      tgt.armor -= absorbed;
      dmg -= absorbed;
    }
    tgt.hp = Math.max(0, tgt.hp - dmg);

    sendToClient(tgt.client, {
      type: 'playerHit',
      targetId: tgt.id,
      hp: tgt.hp,
      armor: tgt.armor,
      damage: dmg,
      dx: clampNum(msg.dx, 0, 3),
      dy: clampNum(msg.dy, 0, 3),
      dz: clampNum(msg.dz, 0, 3)
    });
    if (tgt.hp <= 0) {
      tgt.isShattered = true;
      systemChat(`💥 ${pid}, ${tgt.id} oyuncusunu parçaladı!`, null, '#fca5a5');
    }
    broadcastAll(playerPublic(tgt));
  }

  else if (mtype === 'healSelf') {
    const p = players[pid];
    if (!p) return;
    const maxHeal = p.isAdmin ? 100 : 50;
    const amount = Math.min(maxHeal, parseInt(clampNum(msg.amount, 50, 100), 10));
    p.hp = Math.min(100, p.hp + amount);
    if (msg.armor) p.armor = Math.min(100, (p.armor || 0) + parseInt(clampNum(msg.armor, 50, 100), 10));
    sendToClient(client, { type: 'hpUpdate', hp: p.hp, armor: p.armor });
    broadcastAll(playerPublic(p));
  }

  else if (mtype === 'armorSelf') {
    const p = players[pid];
    if (!p) return;
    const amount = parseInt(clampNum(msg.amount, 50, 100), 10);
    p.armor = Math.min(100, (p.armor || 0) + amount);
    sendToClient(client, { type: 'hpUpdate', hp: p.hp, armor: p.armor });
    broadcastAll(playerPublic(p));
  }

  else if (mtype === 'adminAction') {
    const p = players[pid];
    if (!p || !p.isAdmin) {
      systemChat('⛔ Yetkisiz Admin işlemi engellendi!', client, '#ef4444');
      return;
    }
    const act = msg.action;
    const tid = String(msg.targetId || '');
    if (act === 'heal') healPlayer(tid || pid);
    else if (act === 'kill') killPlayer(tid);
    else if (act === 'kick') kickPlayer(tid);
    else if (act === 'makeAdmin') setPlayerAdmin(tid, true);
    else if (act === 'tpTo' && players[tid]) teleportPlayer(pid, players[tid].x, players[tid].y + 2, players[tid].z + 2);
    else if (act === 'bring' && players[tid]) teleportPlayer(tid, p.x, p.y + 2, p.z + 2);
    else if (act === 'clearProps') clearAllProps();
    else if (act === 'announce') systemChat('📢 [ADMIN DUYURUSU] ' + String(msg.text || '').substring(0, 100), null, '#f43f5e');
  }

  else if (mtype === 'spawnProp') {
    if (!pid) return;
    propSeq++;
    if (Object.keys(props).length >= MAX_PROPS) {
      const oldest = Object.keys(props)[0];
      delete props[oldest];
      broadcastAll({ type: 'removeProp', id: oldest });
    }
    const propId = String(msg.id || `p_${propSeq}`).replace(/[^\w-]/g, '').substring(0, 32);
    const propObj = {
      type: 'spawnProp',
      id: propId,
      propType: String(msg.propType || 'box').substring(0, 20),
      color: HEX_RE.test(msg.color) ? msg.color : '#ffffff',
      scaleFactor: clampRange(msg.scaleFactor, 0.25, 4.5, 1.0),
      x: clampNum(msg.x, 0, 290),
      y: Math.max(0.2, clampNum(msg.y, 5, 150)),
      z: clampNum(msg.z, 0, 290),
      qx: clampNum(msg.qx, 0, 1),
      qy: clampNum(msg.qy, 0, 1),
      qz: clampNum(msg.qz, 0, 1),
      qw: clampNum(msg.qw, 1, 1)
    };
    props[propId] = propObj;
    broadcastAll(propObj);
  }

  else if (mtype === 'removeProp') {
    const propId = String(msg.id || '');
    if (pid && props[propId]) {
      delete props[propId];
      broadcastAll({ type: 'removeProp', id: propId });
    }
  }

  else if (mtype === 'clearProps') {
    const p = players[pid];
    if (p && p.isAdmin) clearAllProps();
    else systemChat('⛔ Tüm objeleri sadece Admin temizleyebilir!', client, '#ef4444');
  }

  else if (mtype === 'impulseProp') {
    broadcastAll({
      type: 'impulseProp',
      id: String(msg.id || ''),
      fx: clampNum(msg.fx, 0, 90),
      fy: clampNum(msg.fy, 0, 90),
      fz: clampNum(msg.fz, 0, 90)
    });
  }

  else if (mtype === 'spawnCar' || mtype === 'carUpdate') {
    if (!pid) return;
    const cid = String(msg.id || '').replace(/[^\w-]/g, '').substring(0, 40);
    if (!cid) return;
    let c = cars[cid];
    if (!c) {
      if (Object.keys(cars).length >= MAX_CARS) return;
      c = { id: cid, color: '#ff0055', driverId: '', steerAngle: 0, scaleFactor: 1.0, x: 0, y: 2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
      cars[cid] = c;
    } else if (c.driverId && c.driverId !== pid) {
      sendToClient(client, carPublic(c));
      return;
    }
    if (HEX_RE.test(msg.color)) c.color = msg.color;
    c.driverId = msg.driverId === pid ? pid : '';
    c.steerAngle = clampNum(msg.steerAngle, 0, 2);
    if (msg.scaleFactor !== undefined) c.scaleFactor = clampRange(msg.scaleFactor, 0.4, 3.0, c.scaleFactor || 1.0);
    c.x = clampNum(msg.x, 0, 400);
    c.y = clampNum(msg.y, 2, 300);
    c.z = clampNum(msg.z, 0, 400);
    c.qx = clampNum(msg.qx, 0, 1);
    c.qy = clampNum(msg.qy, 0, 1);
    c.qz = clampNum(msg.qz, 0, 1);
    c.qw = clampNum(msg.qw, 1, 1);
    broadcast(carPublic(c), client);
  }

  else if (mtype === 'chat') {
    const now = Date.now();
    if (!pid || now - (client.lastChat || 0) < 250) return;
    client.lastChat = now;
    const p = players[pid];
    const text = String(msg.text || '').trim().substring(0, 100);
    if (!text) return;
    if (text.startsWith('/')) {
      handleChatCommand(client, p, text);
      return;
    }
    const prefix = (p && p.isAdmin) ? '👑 ' : '';
    broadcastAll({ type: 'chat', uid: prefix + pid, color: p ? p.color : '#ffffff', text });
  }
}

// HTTP Server: Statik index.html, firebase-config ve API durumunu sunar
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsedUrl.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      return fs.createReadStream(indexPath).pipe(res);
    }
  }

  if (pathname === '/firebase-applet-config.json') {
    const cfgPath = path.join(__dirname, 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return fs.createReadStream(cfgPath).pipe(res);
    }
  }

  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'online',
      playersCount: Object.keys(players).length,
      propsCount: Object.keys(props).length,
      carsCount: Object.keys(cars).length,
      portalsCount: Object.keys(portalsByPlayer).length
    }));
  }

  // Güvenli statik dosya sunumu (public klasörü)
  if (pathname.startsWith('/public/')) {
    const safePath = path.normalize(path.join(__dirname, pathname));
    if (safePath.startsWith(path.join(__dirname, 'public')) && fs.existsSync(safePath)) {
      const ext = path.extname(safePath).toLowerCase();
      const mimeTypes = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml', '.js': 'application/javascript', '.css': 'text/css'
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      return fs.createReadStream(safePath).pipe(res);
    }
  }

  // Varsayılan fallback
  const fallbackIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(fallbackIndex)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(fallbackIndex).pipe(res);
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Minecraft Sandbox Anti-Cheat Server Aktif! Oyuncu: ${Object.keys(players).length}\n`);
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  sock.setNoDelay(true);

  const client = { proto: 'TCP', sock, playerId: null, alive: true, lastHit: 0, lastChat: 0 };
  tcpClients.add(client);

  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (len > 65536) { sock.destroy(); return; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;

      const mask = masked ? buf.slice(offset, offset + 4) : null;
      const payload = Buffer.from(buf.slice(offset + maskLen, offset + maskLen + len));
      buf = buf.slice(offset + maskLen + len);

      if (masked && mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      if (opcode === 0x8) { sock.end(); return; }
      else if (opcode === 0x9) {
        try { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length & 0x7f]), payload])); } catch (e) {}
      } else if (opcode === 0x1) {
        handlePacket(client, payload.toString('utf8'));
      }
    }
  });

  const cleanUp = () => {
    if (!client.alive) return;
    client.alive = false;
    tcpClients.delete(client);
    removePlayerById(client.playerId);
  };
  sock.on('close', cleanUp);
  sock.on('error', cleanUp);
});

const udpServer = dgram.createSocket('udp4');
udpServer.on('message', (msg, rinfo) => {
  const key = `${rinfo.address}:${rinfo.port}`;
  let uclient = udpClients[key];
  if (!uclient) {
    uclient = { proto: 'UDP', address: rinfo.address, port: rinfo.port, playerId: null, alive: true, lastSeen: Date.now() };
    udpClients[key] = uclient;
  }
  uclient.lastSeen = Date.now();
  handlePacket(uclient, msg.toString('utf8'));
});

setInterval(() => {
  const now = Date.now();
  for (const key in udpClients) {
    if (now - udpClients[key].lastSeen > 15000) {
      udpClients[key].alive = false;
      removePlayerById(udpClients[key].playerId);
      delete udpClients[key];
    }
  }
}, 5000);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  const parts = line.trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const arg = parts[1];
  if (cmd === 'list') {
    for (const pid in players) {
      console.log(`- [${players[pid].client.proto}] ${pid} | Admin: ${players[pid].isAdmin} | Boyut: ${players[pid].playerScale || 1}x | HP: ${players[pid].hp} | Silah: ${players[pid].holdingWeapon} | Blok: ${players[pid].holdingItem}`);
    }
  } else if (cmd === 'admin' && arg) setPlayerAdmin(arg, true);
  else if (cmd === 'unadmin' && arg) setPlayerAdmin(arg, false);
  else if (cmd === 'heal' && arg) healPlayer(arg);
  else if (cmd === 'kill' && arg) killPlayer(arg);
  else if (cmd === 'kick' && arg) kickPlayer(arg);
  else if (cmd === 'clear') clearAllProps();
});

let currentPort = parseInt(PORT, 10);
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[Server] Port ${currentPort} meşgul, ${currentPort + 1} portuna geçiliyor...`);
    currentPort += 1;
    server.listen(currentPort, '0.0.0.0', () => {
      console.log(`Minecraft Sandbox Anti-Cheat Sunucusu 0.0.0.0:${currentPort} üzerinde aktif!`);
    });
    try { udpServer.bind(currentPort, '0.0.0.0'); } catch (e) {}
  } else {
    console.error('[Server Error]', err);
  }
});

server.listen(currentPort, '0.0.0.0', () => {
  console.log(`Minecraft Sandbox Anti-Cheat Sunucusu 0.0.0.0:${currentPort} üzerinde aktif!`);
});
try { udpServer.bind(currentPort, '0.0.0.0'); } catch (e) {}
