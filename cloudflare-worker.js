// Cloudflare Worker 免费中转服务端脚本
// 若未来将纯网页导出到没有后端的静态环境，可将此文件代码部署至 Cloudflare Workers 免费运行

const peerMailboxes = new Map();
const peerProfiles = new Map();
const peerLastPoll = new Map();

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function pushToWorkerMailbox(code, event) {
  if (!code || !event) return;
  if (!peerMailboxes.has(code)) {
    peerMailboxes.set(code, []);
  }
  let box = peerMailboxes.get(code);
  if (event.eventId && box.some(item => item && item.eventId === event.eventId)) {
    return;
  }
  if (event.type === "group_typing_status") {
    box = box.filter(item => !(item && item.type === "group_typing_status" && item.fromCode === event.fromCode));
  } else if (event.type === "group_member_update" && event.groupId) {
    box = box.filter(item => !(item && item.type === "group_member_update" && String(item.groupId) === String(event.groupId)));
  } else if (event.type === "profile_update" && (event.peerCode || event.fromCode)) {
    const pCode = event.peerCode || event.fromCode;
    box = box.filter(item => !(item && item.type === "profile_update" && (item.peerCode === pCode || item.fromCode === pCode)));
  } else if (event.type === "peer_ack" && event.ackEventId) {
    box = box.filter(item => !(item && item.type === "peer_ack" && item.ackEventId === event.ackEventId));
  }
  box.push(event);
  if (box.length > 200) box.shift();
  peerMailboxes.set(code, box);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: getCorsHeaders() });
    }

    if (url.pathname === "/api/peer/register" && request.method === "POST") {
      try {
        const body = await request.json();
        const { peerCode, name, avatar, myAvatarFrame } = body;
        if (!peerCode) {
          return new Response(JSON.stringify({ error: "Missing peerCode" }), { status: 400, headers: getCorsHeaders() });
        }
        peerProfiles.set(peerCode, { name, avatar, myAvatarFrame, lastSeen: Date.now() });
        return new Response(JSON.stringify({ success: true }), { headers: getCorsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCorsHeaders() });
      }
    }

    if (url.pathname === "/api/peer/send" && request.method === "POST") {
      try {
        const body = await request.json();
        const {
          type = "message",
          eventId,
          ackEventId,
          fromCode,
          toCode,
          content,
          msgType,
          audioData,
          audioDuration,
          senderName,
          senderAvatar,
          senderAvatarFrame,
          peerAvatarFrame,
          timestamp
        } = body;
        if (!toCode) {
          return new Response(JSON.stringify({ error: "Missing target" }), { status: 400, headers: getCorsHeaders() });
        }
        if (type === "peer_ack") {
          const ackEvt = {
            type: "peer_ack",
            eventId: eventId || ("evt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8)),
            ackEventId,
            fromCode,
            toCode,
            timestamp: Date.now()
          };
          pushToWorkerMailbox(toCode, ackEvt);
          return new Response(JSON.stringify({ success: true }), { headers: getCorsHeaders() });
        }
        if (type === "online_ping" || type === "online_pong" || type === "offline_ping") {
          if (fromCode) {
            if (type === "offline_ping") {
              peerLastPoll.delete(fromCode);
            } else {
              peerLastPoll.set(fromCode, Date.now());
            }
          }
          return new Response(JSON.stringify({ success: true }), { headers: getCorsHeaders() });
        }
        if (type !== "message") {
          const customEvt = {
            ...body,
            type,
            eventId: eventId || ("evt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8)),
            timestamp: timestamp || Date.now()
          };
          pushToWorkerMailbox(toCode, customEvt);
          return new Response(JSON.stringify({ success: true, delivered: true }), { headers: getCorsHeaders() });
        }
        if (!content && !audioData) {
          return new Response(JSON.stringify({ error: "Missing content" }), { status: 400, headers: getCorsHeaders() });
        }
        const event = {
          type: "message",
          eventId: eventId || ("evt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8)),
          fromCode,
          toCode,
          content: content || "[语音消息]",
          msgType: msgType || "text",
          audioData: audioData || "",
          audioDuration: audioDuration || 0,
          senderName,
          senderAvatar,
          senderAvatarFrame: senderAvatarFrame || "",
          peerAvatarFrame: peerAvatarFrame || "",
          timestamp: timestamp || Date.now()
        };
        pushToWorkerMailbox(toCode, event);
        return new Response(JSON.stringify({ success: true, delivered: true }), { headers: getCorsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCorsHeaders() });
      }
    }

    if (url.pathname === "/api/peer/profile" && request.method === "POST") {
      try {
        const body = await request.json();
        const { eventId, peerCode, name, avatar, myAvatarFrame, peerAvatarFrame, targetCodes = [] } = body;
        if (!peerCode) {
          return new Response(JSON.stringify({ error: "Missing peerCode" }), { status: 400, headers: getCorsHeaders() });
        }
        peerProfiles.set(peerCode, { name, avatar, myAvatarFrame, lastSeen: Date.now() });
        const event = {
          type: "profile_update",
          eventId: eventId || ("evt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8)),
          peerCode,
          name,
          avatar,
          myAvatarFrame: myAvatarFrame !== undefined ? myAvatarFrame : undefined,
          peerAvatarFrame: peerAvatarFrame !== undefined ? peerAvatarFrame : undefined,
          timestamp: Date.now()
        };
        if (Array.isArray(targetCodes)) {
          for (const target of targetCodes) {
            pushToWorkerMailbox(target, event);
          }
        }
        return new Response(JSON.stringify({ success: true }), { headers: getCorsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCorsHeaders() });
      }
    }

    if (url.pathname === "/api/peer/request" && request.method === "POST") {
      try {
        const body = await request.json();
        const { type = "friend_request", eventId, fromCode, toCode, fromName, fromAvatar, fromAvatarFrame } = body;
        if (!toCode) {
          return new Response(JSON.stringify({ error: "Missing target" }), { status: 400, headers: getCorsHeaders() });
        }
        const event = {
          type: type === "friend_accept" ? "friend_accept" : "friend_request",
          eventId: eventId || ("evt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8)),
          fromCode,
          toCode,
          fromName,
          fromAvatar,
          fromAvatarFrame: fromAvatarFrame || "",
          timestamp: Date.now()
        };
        pushToWorkerMailbox(toCode, event);
        return new Response(JSON.stringify({ success: true }), { headers: getCorsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCorsHeaders() });
      }
    }

    if (url.pathname === "/api/peer/ack" && request.method === "POST") {
      try {
        const body = await request.json();
        const { peerCode, eventIds = [] } = body;
        if (peerCode && Array.isArray(eventIds) && peerMailboxes.has(peerCode)) {
          const idSet = new Set(eventIds);
          const filtered = (peerMailboxes.get(peerCode) || []).filter(item => !item || !item.eventId || !idSet.has(item.eventId));
          peerMailboxes.set(peerCode, filtered);
        }
        return new Response(JSON.stringify({ success: true }), { headers: getCorsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCorsHeaders() });
      }
    }

    if (url.pathname === "/api/peer/poll" && request.method === "GET") {
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response(JSON.stringify({ error: "Missing code" }), { status: 400, headers: getCorsHeaders() });
      }
      peerLastPoll.set(code, Date.now());
      const events = peerMailboxes.get(code) || [];
      const profile = peerProfiles.get(code) || null;
      const onlinePeers = {};
      const peersParam = url.searchParams.get("peers");
      if (peersParam) {
        const now = Date.now();
        peersParam.split(",").forEach((p) => {
          const pCode = p.trim().toUpperCase();
          if (!pCode) return;
          const lastSeen = peerLastPoll.get(pCode) || peerLastPoll.get(p.trim()) || 0;
          onlinePeers[pCode] = Boolean(lastSeen > 0 && now - lastSeen < 25000);
        });
      }
      return new Response(JSON.stringify({ success: true, events, profile, onlinePeers }), { headers: getCorsHeaders() });
    }

    return new Response(JSON.stringify({ status: "running" }), { headers: getCorsHeaders() });
  }
};
