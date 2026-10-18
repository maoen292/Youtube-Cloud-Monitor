/**
 * YouTube 頻道全自動雲端監控系統 (公開 UU + 會員限定 UUMO 雙清單正式版)
 * 預設監控頻道範例：白星優米 (Umi, @umitw46 / UCzGz6LnrLQ49h5Nio2uwQGw)
 * Favorite V-Tuber, please remember to subscribe to her: Umi (白星優米) https://youtube.com/@umitw46?si=YAS3N6vEymUu1UDW
 *
 * 【必要綁定 (設定 Settings -> 個繫結 Bindings & 變數 Variables)】
 * 1. KV 命名空間綁定名稱：YT_STATE
 * 2. 環境變數 (必填)：YOUTUBE_API_KEY      (你的 Google Cloud API 金鑰)
 * 3. 環境變數 (必填)：DISCORD_WEBHOOK_URL  (你的 Discord 頻道 Webhook 網址)
 * 4. 環境變數 (選填)：UPLOAD_PLAYLIST_ID   (可填目標頻道 UC 或 UU 開頭之 24 碼 ID，未填則預設為白星優米)
 * 5. 環境變數 (選填)：CHANNEL_NAME         (自訂通知顯示的頻道稱呼，未填則預設為「優米」或自動抓取頻道名稱)
 * 6. 環境變數 (選填)：ADMIN_TOKEN          (自訂安全密碼，若有設定則手動打開測試網址時需加上 ?token=密碼)
 *
 * 【瀏覽器測試網址用法】
 * - 正常巡檢與狀態查看：https://你的worker網址.workers.dev/
 * - 模擬正式開播通知：  https://你的worker網址.workers.dev/?test=live
 * - 模擬建立待機室通知：https://你的worker網址.workers.dev/?test=upcoming
 * - 模擬新影片上架通知：https://你的worker網址.workers.dev/?test=video
 */

// 預設範例頻道設定（若未在 Cloudflare 設定環境變數，將使用此預設值；其他使用者可直接於後台環境變數覆蓋，或直接修改下方字串）
const DEFAULT_CHANNEL_ID = "UUzGz6LnrLQ49h5Nio2uwQGw";
const DEFAULT_CHANNEL_NAME = "優米";

export default {
  // 1. 每分鐘由 Cron 觸發器 (* * * * *) 自動觸發
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkYouTubeChannel(env));
  },

  // 2. 瀏覽器手動巡檢與一鍵模擬測試入口
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const adminToken = (env.ADMIN_TOKEN || "").trim();

      // 若使用者有設定 ADMIN_TOKEN，則驗證網址 token 參數，防止公開網址遭外人惡意觸發洗版
      if (adminToken) {
        const reqToken = url.searchParams.get("token");
        if (reqToken !== adminToken) {
          return new Response(
            JSON.stringify(
              {
                status: "protected",
                message: "系統運作中。你已啟用 ADMIN_TOKEN 安全防護，請在網址後方加上 ?token=你的密碼（或 &token=你的密碼）以進行測試。",
              },
              null,
              2
            ),
            { status: 403, headers: { "Content-Type": "application/json;charset=UTF-8" } }
          );
        }
      }

      const testType = url.searchParams.get("test");

      if (testType && ["live", "upcoming", "video"].includes(testType)) {
        const testResult = await runSimulationTest(env, testType);
        return new Response(JSON.stringify(testResult, null, 2), {
          headers: { "Content-Type": "application/json;charset=UTF-8" },
        });
      }

      const result = await checkYouTubeChannel(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json;charset=UTF-8" },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ status: "exception", error: err.message }, null, 2),
        { status: 500, headers: { "Content-Type": "application/json;charset=UTF-8" } }
      );
    }
  },
};

// 自動清理參數並推導「公開清單 (UU)」與「會員限定清單 (UUMO)」
function getChannelPlaylists(rawPlaylistId) {
  let cleaned = (rawPlaylistId || DEFAULT_CHANNEL_ID).trim().replace(/['"]/g, "");
  let channelSuffix = "zGz6LnrLQ49h5Nio2uwQGw";

  if (cleaned.startsWith("UUMO") && cleaned.length === 26) {
    channelSuffix = cleaned.slice(4);
  } else if ((cleaned.startsWith("UC") || cleaned.startsWith("UU")) && cleaned.length === 24) {
    channelSuffix = cleaned.slice(2);
  }

  return {
    publicPlaylistId: `UU${channelSuffix}`,
    memberPlaylistId: `UUMO${channelSuffix}`,
  };
}

// 取得頻道顯示名稱（優先使用環境變數 CHANNEL_NAME，若監控預設頻道則顯示「優米」，若換成其他頻道且未填名稱則自動抓取頻道原名）
function resolveChannelName(env, youtubeChannelTitle) {
  const customName = (env.CHANNEL_NAME || "").trim();
  if (customName) return customName;

  const rawId = (env.UPLOAD_PLAYLIST_ID || "").trim();
  if (!rawId || rawId.includes("zGz6LnrLQ49h5Nio2uwQGw")) {
    return DEFAULT_CHANNEL_NAME;
  }

  return youtubeChannelTitle || DEFAULT_CHANNEL_NAME;
}

// 讀取單一播放清單最新 10 筆影片 ID（若該頻道無會員清單則安全忽略 404，且不印出 API Key 內容以保護資安）
async function fetchPlaylistVideoIds(playlistId, apiKey, isMemberPlaylist = false) {
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(playlistId)}&maxResults=10&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);

  if (!res.ok) {
    if (isMemberPlaylist && res.status === 404) {
      return [];
    }
    const errText = await res.text();
    throw new Error(
      `YouTube playlistItems API 錯誤 (${res.status}) | 清單: [${playlistId}] | 金鑰長度: ${apiKey.length} 碼 | 回應: ${errText}`
    );
  }

  const data = await res.json();
  return (data.items || [])
    .map((item) => item.contentDetails?.videoId || item.snippet?.resourceId?.videoId)
    .filter(Boolean);
}

// 一鍵模擬測試器（不影響 KV 資料庫狀態）
async function runSimulationTest(env, testType) {
  const { publicPlaylistId } = getChannelPlaylists(env.UPLOAD_PLAYLIST_ID);
  const apiKey = (env.YOUTUBE_API_KEY || "").trim().replace(/['"]/g, "");
  const webhookUrl = (env.DISCORD_WEBHOOK_URL || "").trim().replace(/['"]/g, "");

  const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(publicPlaylistId)}&maxResults=1&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(playlistUrl);
  const data = await res.json();
  const latestItem = data.items?.[0];

  const videoId = latestItem?.contentDetails?.videoId || "dQw4w9WgXcQ";
  const title = `【系統模擬測試】${latestItem?.snippet?.title || "測試直播標題"}`;
  const timeIso = latestItem?.snippet?.publishedAt || new Date().toISOString();
  const channelName = resolveChannelName(env, latestItem?.snippet?.channelTitle);

  await sendDiscordNotification(webhookUrl, testType, videoId, title, timeIso, false, channelName);

  return {
    status: "simulation_sent",
    simulatedType: testType,
    message: `已成功向 Discord 發送【${testType}】類型的模擬通知！請前往 Discord 確認（本次測試不會修改 YT_STATE 資料庫）。`,
    sampleVideoUsed: { videoId, title, timeIso, channelName },
  };
}

// 核心巡檢與狀態機邏輯
async function checkYouTubeChannel(env) {
  const { publicPlaylistId, memberPlaylistId } = getChannelPlaylists(env.UPLOAD_PLAYLIST_ID);
  const apiKey = (env.YOUTUBE_API_KEY || "").trim().replace(/['"]/g, "");
  const webhookUrl = (env.DISCORD_WEBHOOK_URL || "").trim().replace(/['"]/g, "");

  // 自動健檢：確認綁定是否完整
  if (!env.YT_STATE || !apiKey || !webhookUrl) {
    return {
      status: "error",
      message: "缺少必要的環境變數或 KV 綁定，請檢查 Worker 的 Settings -> Bindings",
      bindingsCheck: {
        YT_STATE_BOUND: Boolean(env.YT_STATE),
        PUBLIC_PLAYLIST_ID: publicPlaylistId,
        MEMBER_PLAYLIST_ID: memberPlaylistId,
        YOUTUBE_API_KEY_SET: Boolean(apiKey),
        DISCORD_WEBHOOK_URL_SET: Boolean(webhookUrl),
      },
    };
  }

  // 步驟 A：平行讀取「一般公開清單 (UU)」與「會員限定清單 (UUMO)」（共消耗 2 點 API 配額）
  const [publicVideoIds, memberVideoIds] = await Promise.all([
    fetchPlaylistVideoIds(publicPlaylistId, apiKey, false),
    fetchPlaylistVideoIds(memberPlaylistId, apiKey, true),
  ]);

  const memberVideoSet = new Set(memberVideoIds);
  const latestVideoIds = [...new Set([...publicVideoIds, ...memberVideoIds])];

  // 步驟 B：從 KV 讀取狀態機筆記本 monitor_state（消耗 1 次 KV 讀取）
  let state = await env.YT_STATE.get("monitor_state", { type: "json" });

  // 【情況 1：系統全新首次啟動初始化（防洗版機制）】
  if (!state || !state.initialized) {
    state = {
      initialized: true,
      memberInitialized: true,
      notifiedVideos: [],
      activeStreams: {},
    };

    if (latestVideoIds.length > 0) {
      const videosData = await fetchVideosDetails(latestVideoIds, apiKey);
      for (const video of videosData) {
        const videoId = video.id;
        const broadcastStatus = video.snippet?.liveBroadcastContent || "none";
        const title = video.snippet?.title || "未命名影片";
        const scheduledTime = video.liveStreamingDetails?.scheduledStartTime || video.snippet?.publishedAt;
        const isMembersOnly = memberVideoSet.has(videoId);
        const channelName = resolveChannelName(env, video.snippet?.channelTitle);

        if (broadcastStatus === "live") {
          await sendDiscordNotification(webhookUrl, "live", videoId, title, scheduledTime, isMembersOnly, channelName);
          state.activeStreams[videoId] = { status: "live", title, scheduledStartTime: scheduledTime, isMembersOnly };
        } else if (broadcastStatus === "upcoming") {
          await sendDiscordNotification(webhookUrl, "upcoming", videoId, title, scheduledTime, isMembersOnly, channelName);
          state.activeStreams[videoId] = { status: "upcoming", title, scheduledStartTime: scheduledTime, isMembersOnly };
        } else {
          // 已經結束的歷史舊影片：只記錄 ID，不發送通知洗版
          state.notifiedVideos.push(videoId);
        }
      }
    }

    await env.YT_STATE.put("monitor_state", JSON.stringify(state));
    return { status: "initialized", message: "首次啟動初始化完成（含公開與會員清單），已寫入 monitor_state", state };
  }

  // 【情況 2：從舊版升級為雙清單時的防洗版同步】
  let stateChanged = false;
  if (!state.memberInitialized) {
    const existingIds = new Set([...state.notifiedVideos, ...Object.keys(state.activeStreams || {})]);
    const unrecordedMemberIds = memberVideoIds.filter((id) => !existingIds.has(id));

    if (unrecordedMemberIds.length > 0) {
      const memberVideosData = await fetchVideosDetails(unrecordedMemberIds, apiKey);
      for (const video of memberVideosData) {
        const videoId = video.id;
        const currStatus = video.snippet?.liveBroadcastContent || "none";
        if (currStatus === "none") {
          state.notifiedVideos.push(videoId);
        }
      }
    }
    state.memberInitialized = true;
    stateChanged = true;
  }

  // 【情況 3：日常每分鐘巡檢】
  const activeStreamIds = Object.keys(state.activeStreams || {});
  const newVideoIds = latestVideoIds.filter(
    (id) => !state.notifiedVideos.includes(id) && !activeStreamIds.includes(id)
  );

  const idsToCheck = [...new Set([...newVideoIds, ...activeStreamIds])];

  if (idsToCheck.length === 0) {
    if (stateChanged) {
      await env.YT_STATE.put("monitor_state", JSON.stringify(state));
    }
    return { status: "ok", message: "無新影片或狀態變更（本次未消耗 KV 寫入）", state };
  }

  // 步驟 C：批量查詢影片詳細直播狀態（最多 50 部合併為 1 次請求，僅消耗 1 點 API 配額）
  const videosData = await fetchVideosDetails(idsToCheck, apiKey);
  const returnedIds = new Set();

  for (const video of videosData) {
    const videoId = video.id;
    returnedIds.add(videoId);
    const currStatus = video.snippet?.liveBroadcastContent || "none";
    const title = video.snippet?.title || "未命名影片";
    const scheduledTime =
      video.liveStreamingDetails?.scheduledStartTime ||
      video.liveStreamingDetails?.actualStartTime ||
      video.snippet?.publishedAt;
    const isMembersOnly = memberVideoSet.has(videoId) || Boolean(state.activeStreams[videoId]?.isMembersOnly);
    const channelName = resolveChannelName(env, video.snippet?.channelTitle);

    // 3A. 追蹤清單中的待機室/直播狀態變化
    if (state.activeStreams[videoId]) {
      const prevStatus = state.activeStreams[videoId].status;

      if (prevStatus === "upcoming" && currStatus === "live") {
        await sendDiscordNotification(webhookUrl, "live", videoId, title, scheduledTime, isMembersOnly, channelName);
        state.activeStreams[videoId].status = "live";
        state.activeStreams[videoId].title = title;
        stateChanged = true;
      } else if (currStatus === "none") {
        // 直播結束（關播）：不發送通知，移入已處理清單
        delete state.activeStreams[videoId];
        if (!state.notifiedVideos.includes(videoId)) {
          state.notifiedVideos.unshift(videoId);
        }
        stateChanged = true;
      }
    }
    // 3B. 全新發現的影片或待機室
    else {
      if (currStatus === "live") {
        await sendDiscordNotification(webhookUrl, "live", videoId, title, scheduledTime, isMembersOnly, channelName);
        state.activeStreams[videoId] = { status: "live", title, scheduledStartTime: scheduledTime, isMembersOnly };
        stateChanged = true;
      } else if (currStatus === "upcoming") {
        await sendDiscordNotification(webhookUrl, "upcoming", videoId, title, scheduledTime, isMembersOnly, channelName);
        state.activeStreams[videoId] = { status: "upcoming", title, scheduledStartTime: scheduledTime, isMembersOnly };
        stateChanged = true;
      } else {
        await sendDiscordNotification(webhookUrl, "video", videoId, title, video.snippet?.publishedAt, isMembersOnly, channelName);
        state.notifiedVideos.unshift(videoId);
        stateChanged = true;
      }
    }
  }

  // 清除已被刪除或轉私人的待機室，避免無限輪詢
  for (const trackedId of activeStreamIds) {
    if (!returnedIds.has(trackedId)) {
      delete state.activeStreams[trackedId];
      if (!state.notifiedVideos.includes(trackedId)) {
        state.notifiedVideos.unshift(trackedId);
      }
      stateChanged = true;
    }
  }

  // 僅在狀態有變化時才寫入 KV（保留最近 80 筆已通知 ID）
  if (stateChanged) {
    state.notifiedVideos = state.notifiedVideos.slice(0, 80);
    await env.YT_STATE.put("monitor_state", JSON.stringify(state));
  }

  return { status: "ok", stateChanged, state };
}

async function fetchVideosDetails(videoIds, apiKey) {
  if (!videoIds || videoIds.length === 0) return [];
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${videoIds.join(",")}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`YouTube videos API 錯誤 (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return data.items || [];
}

// 轉換為東八區 (UTC+8) 時間格式
function formatTaipeiTime(isoString) {
  if (!isoString) return "未定 / 即時發布";
  const date = new Date(isoString);
  const formatter = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${formatter.format(date)} (UTC+8)`;
}

// 發送 Discord Webhook 訊息
async function sendDiscordNotification(
  webhookUrl,
  type,
  videoId,
  title,
  timeIso,
  isMembersOnly = false,
  channelName = DEFAULT_CHANNEL_NAME
) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const formattedTime = formatTaipeiTime(timeIso);
  const memberTag = isMembersOnly ? "🔒【會員限定】" : "";
  let messageContent = "";

  if (type === "live") {
    messageContent =
      `@everyone ${memberTag}${channelName}開台通知 開始直播囉！快進來～\n` +
      `📺 **影片名稱**：${title}\n` +
      `🕒 **預計開始時間**：${formattedTime}\n` +
      `🔗 **直播連結**：${videoUrl}`;
  } else if (type === "upcoming") {
    messageContent =
      `@everyone ⏳ ${memberTag}${channelName}建立直播待機室囉！\n` +
      `📺 **影片名稱**：${title}\n` +
      `🕒 **預計開始時間**：${formattedTime}\n` +
      `🔗 **直播連結**：${videoUrl}`;
  } else {
    messageContent =
      `@everyone 🎬 ${memberTag}${channelName}發布新影片囉！\n` +
      `📺 **影片名稱**：${title}\n` +
      `🕒 **發布時間**：${formattedTime}\n` +
      `🔗 **影片連結**：${videoUrl}`;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: messageContent }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Discord Webhook 發送失敗 (${res.status}): ${errText}`);
  }
}
