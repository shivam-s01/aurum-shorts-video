// =============================================================================
// Aurum Shorts — Cloudflare Worker — YT VIDEO resolution (muxed)
//
// Fully separate deploy from the main Aurum audio-resolution worker.
// Same multi-client chain pattern (android_vr / ios / tv-embed / piped),
// same budgeted-deadline approach so a single resolve can never hang the
// app — but this one asks for MUXED (video+audio together) formats
// instead of audio-only adaptiveFormats, since the Shorts feed plays one
// combined stream per card rather than syncing a separate audio source.
//
// Isolated on purpose: own PO Token endpoint reference, own budget
// constants, own route names — so this can be deployed as its own Worker
// and iterated on (or torn down) without touching the main audio worker
// at all.
// =============================================================================

// Overall hard cap for the ENTIRE resolveYtVideo() call, across every
// client + Piped instance combined.
const TOTAL_RESOLVE_BUDGET_MS = 15000;
const FETCH_TIMEOUT_MS = 5000;

// Multiple Piped instances tried in order. Each one is independently
// operated and can go down without notice.
const PIPED_INSTANCES = [
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space',
  'https://pipedapi.reallyaweso.me',
];

async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
// ATTEMPT — ANDROID_VR. In practice this client reliably returns muxed
// `formats` (not just split adaptiveFormats), which is exactly what we
// want here — no PO Token needed for this one.
// =============================================================================
async function ytAndroidVr(videoId, attempts, perAttemptTimeoutMs) {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          'X-YouTube-Client-Name': '28',
          'X-YouTube-Client-Version': '1.71.26',
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: 'ANDROID_VR',
              clientVersion: '1.71.26',
              osVersion: '12L',
              hl: 'en',
              gl: 'US',
            },
          },
        }),
      }, perAttemptTimeoutMs);
      const json = await resp.json().catch(() => null);
      if (json?.playabilityStatus?.status === 'OK') {
        const hasMuxed = (json?.streamingData?.formats || []).some((f) => f.url);
        if (hasMuxed) return json;
      }
    } catch (_) {
      // fall through to next attempt
    }
  }
  return null;
}

// =============================================================================
// ATTEMPT — iOS client. Fallback if android_vr's muxed formats are empty
// for this video.
// =============================================================================
async function ytIos(videoId, timeoutMs) {
  try {
    const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
        'X-YouTube-Client-Name': '5',
        'X-YouTube-Client-Version': '19.29.1',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'IOS',
            clientVersion: '19.29.1',
            deviceModel: 'iPhone16,2',
            hl: 'en',
            gl: 'US',
          },
        },
      }),
    }, timeoutMs);
    const json = await resp.json().catch(() => null);
    if (json?.playabilityStatus?.status === 'OK') {
      const hasMuxed = (json?.streamingData?.formats || []).some((f) => f.url);
      if (hasMuxed) return json;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// =============================================================================
// ATTEMPT — TVHTML5_SIMPLY_EMBEDDED_PLAYER bypass.
// =============================================================================
async function ytTvEmbeddedBypass(videoId, timeoutMs) {
  try {
    const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (PlayStation; PlayStation 4/12.02) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
        'X-YouTube-Client-Name': '85',
        'X-YouTube-Client-Version': '2.0',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
            clientVersion: '2.0',
            platform: 'TV',
            hl: 'en',
            gl: 'US',
          },
          thirdParty: { embedUrl: `https://www.youtube.com/watch?v=${videoId}` },
        },
      }),
    }, timeoutMs);
    const json = await resp.json().catch(() => null);
    if (json?.playabilityStatus?.status === 'OK') {
      const hasMuxed = (json?.streamingData?.formats || []).some((f) => f.url);
      if (hasMuxed) return json;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// =============================================================================
// ATTEMPT — Piped, tried across multiple instances. Piped's `videoStreams`
// (as opposed to `audioStreams`) are muxed video+audio, which is exactly
// the shape this Worker wants.
// =============================================================================
async function ytPipedFallback(videoId, perInstanceTimeoutMs, deadlineAt) {
  for (const instance of PIPED_INSTANCES) {
    if (Date.now() > deadlineAt) break;
    try {
      const resp = await fetchWithTimeout(`${instance}/streams/${videoId}`, {
        headers: { 'Content-Type': 'application/json' },
      }, perInstanceTimeoutMs);
      if (!resp.ok) continue;
      const data = await resp.json().catch(() => null);
      const videoStreams = (data?.videoStreams || []).filter((s) => s.url && !s.videoOnly);
      if (!videoStreams.length) continue;

      // Prefer smallest muxed stream that's still reasonably watchable —
      // Shorts cards are small/vertical-cropped, no benefit to 1080p, and
      // smaller streams start noticeably faster on swipe.
      const sorted = videoStreams
        .slice()
        .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
      const usable = sorted.find((s) => (s.bitrate || 0) > 300000) || sorted[sorted.length - 1];

      return {
        url: usable.url,
        bitrate: usable.bitrate || null,
        mimeType: usable.mimeType || usable.format || 'video/mp4',
        quality: usable.quality || null,
        isMuxed: true,
        source: `piped:${instance}`,
      };
    } catch (_) {
      continue;
    }
  }
  return null;
}

// =============================================================================
// MAIN resolve — budgeted chain, same deadline discipline as the audio
// worker: never exceeds TOTAL_RESOLVE_BUDGET_MS regardless of how many
// clients/instances are configured above.
// =============================================================================
async function resolveYtVideo(videoId) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + TOTAL_RESOLVE_BUDGET_MS;
  const remaining = () => Math.max(0, deadlineAt - Date.now());

  if (remaining() > 0) {
    const androidVrResponse = await ytAndroidVr(videoId, 2, Math.min(FETCH_TIMEOUT_MS, Math.max(1500, remaining() / 3)));
    const extracted = extractMuxedUrl(androidVrResponse);
    if (extracted) return extracted;
  }

  if (remaining() > 0) {
    const iosResponse = await ytIos(videoId, Math.min(FETCH_TIMEOUT_MS, remaining()));
    const extracted = extractMuxedUrl(iosResponse);
    if (extracted) return extracted;
  }

  if (remaining() > 0) {
    const tvResponse = await ytTvEmbeddedBypass(videoId, Math.min(FETCH_TIMEOUT_MS, remaining()));
    const extracted = extractMuxedUrl(tvResponse);
    if (extracted) return extracted;
  }

  if (remaining() > 0) {
    const piped = await ytPipedFallback(videoId, Math.min(4000, remaining()), deadlineAt);
    if (piped) return piped;
  }

  return null;
}

function extractMuxedUrl(playerResponse) {
  const muxed = playerResponse?.streamingData?.formats || [];
  const sorted = muxed.filter((f) => f.url).sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
  if (!sorted.length) return null;
  // Same "smallest usable, not smallest possible" floor as the Piped path.
  const usable = sorted.find((f) => (f.bitrate || 0) > 300000) || sorted[sorted.length - 1];
  return {
    url: usable.url,
    bitrate: usable.bitrate || null,
    mimeType: usable.mimeType || 'video/mp4',
    quality: usable.qualityLabel || null,
    isMuxed: true,
  };
}

// =============================================================================
// Route handlers
// =============================================================================
async function handleVideoResolve(videoId) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);
  const video = await resolveYtVideo(videoId);
  if (!video) return jsonResp({ success: false, error: 'No muxed video stream found' }, 502);
  return jsonResp({ success: true, ...video, videoId });
}

// Optional direct-proxy route (mirrors the audio worker's /api/yt-proxy
// pattern) — lets the app just point a native video player at this URL
// instead of round-tripping the resolved URL first, and supports Range
// requests for seeking/buffering.
async function handleVideoProxy(videoId, request) {
  if (!videoId) return new Response('id required', { status: 400 });
  const video = await resolveYtVideo(videoId);
  if (!video?.url) return new Response('Could not resolve video', { status: 502 });

  const rangeHeader = request.headers.get('Range');
  const upstream = await fetch(video.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36',
      ...(rangeHeader ? { Range: rangeHeader } : {}),
    },
  }).catch(() => null);

  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    return new Response('Stream unavailable', { status: 502 });
  }
  return proxyVideoResponse(upstream);
}

function proxyVideoResponse(upstream) {
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  const contentLength = upstream.headers.get('Content-Length');
  const contentRange = upstream.headers.get('Content-Range');
  if (contentLength) headers.set('Content-Length', contentLength);
  if (contentRange) headers.set('Content-Range', contentRange);
  return new Response(upstream.body, {
    status: upstream.status === 206 ? 206 : 200,
    headers,
  });
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// =============================================================================
// Main router
// =============================================================================
export default {
  async fetch(request, env, ctx) {
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    if (pathname === '/api/video-resolve') {
      return handleVideoResolve(searchParams.get('id') || '');
    }
    if (pathname === '/api/video-proxy') {
      return handleVideoProxy(searchParams.get('id') || '', request);
    }

    if (pathname === '/health') {
      return jsonResp({
        status: 'ok',
        worker: 'aurum-shorts-video-v1',
        totalResolveBudgetMs: TOTAL_RESOLVE_BUDGET_MS,
        ytClients: [
          'ANDROID_VR (2 retries, muxed formats)',
          'IOS (muxed formats)',
          'TVHTML5_SIMPLY_EMBEDDED_PLAYER (bypass, muxed formats)',
          `Piped videoStreams (multi-instance: ${PIPED_INSTANCES.join(', ')})`,
        ],
        resolutionStrategy: 'budgeted sequential chain — hard 15s cap, muxed video+audio streams only',
        note: 'Fully isolated from the main Aurum audio-resolution Worker — separate deploy, separate routes.',
      });
    }

    return jsonResp({ error: 'Not found', path: pathname }, 404);
  },
};
