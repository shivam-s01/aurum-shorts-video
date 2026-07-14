// =============================================================================
// Aurum Shorts — Cloudflare Worker — YT VIDEO resolution (muxed)
// (Rewritten 2026-07-15 to match the main audio worker's architecture.)
//
// Fully separate deploy from the main Aurum audio-resolution worker. Same
// multi-client chain pattern (PO-Token WEB_EMBEDDED_PLAYER / android_vr /
// ios / tv-embed / piped), same budgeted-deadline discipline so a single
// resolve can never hang the app — but this one asks for MUXED (video+
// audio together) formats instead of audio-only adaptiveFormats, since the
// Shorts feed plays one combined stream per card rather than syncing a
// separate audio source.
//
// Bugs fixed vs the previous version of this file:
//   1. /api/video-proxy used to IGNORE the already-resolved `url`+`client`
//      the app passes it (from a prior /api/video-resolve call) and called
//      resolveYtVideo() a SECOND time from scratch. That second resolve is
//      non-deterministic — it can land on a different client (e.g. Piped
//      instead of ANDROID_VR) than the first one, so the User-Agent sent
//      to fetch the URL no longer matches the client that minted it.
//      googlevideo.com silently throttles/truncates on that mismatch —
//      exactly the "stuck on artwork, video/audio never starts" symptom.
//      FIX: the proxy now reuses the passed-through url+client as a pure
//      re-fetch. Zero re-resolving, guaranteed matching User-Agent.
//   2. No PO Token path at all — WEB_EMBEDDED_PLAYER-with-PoToken is often
//      the most reliable client for videos where android_vr/ios/tv get
//      rate-limited or return empty formats. Added, non-blocking (capped
//      at POT_FETCH_TIMEOUT_MS = 3000ms) so a cold PO Token provider only
//      degrades this one request to "old behavior," never blocks it.
//   3. No hard overall deadline across the whole chain — added
//      TOTAL_RESOLVE_BUDGET_MS the same way the audio worker does, via
//      withDeadline()/remaining(), so a resolve can never silently stack
//      timeouts past what the app is willing to wait.
//   4. No debug route — added /api/debug-yt-video, mirroring the audio
//      worker's /api/debug-yt, so future failures show WHICH client/stage
//      failed and why instead of a bare 502.
// =============================================================================

// PO Token provider — self-hosted bgutil-ytdlp-pot-provider on Render.
// Same instance the main audio worker uses. Intentionally short timeout:
// we are not trying to wait out a cold start here — see keepAlivePot()
// below for how that's handled instead. If the provider doesn't answer in
// 3s, we proceed without a token for this request rather than blocking it.
const POT_PROVIDER_URL = 'https://aurum-pot.onrender.com/get_pot';
const POT_FETCH_TIMEOUT_MS = 3000;

const FETCH_TIMEOUT_MS = 5000;

// Overall hard cap for the ENTIRE resolveYtVideo() call, across every
// client + Piped instance combined. Guarantees the app never waits longer
// than this for a resolve to give up, no matter how many retries/instances
// are configured below.
const TOTAL_RESOLVE_BUDGET_MS = 15000;

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

// Wraps a promise so it never keeps the caller waiting past `msLeft`. Used
// to enforce POT_FETCH_TIMEOUT_MS without ever blocking beyond it.
function withDeadline(promise, msLeft, fallbackValue = null) {
  if (msLeft <= 0) return Promise.resolve(fallbackValue);
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), msLeft)),
  ]);
}

async function fetchPoToken() {
  try {
    const resp = await fetchWithTimeout(POT_PROVIDER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, POT_FETCH_TIMEOUT_MS);
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    if (data?.poToken) {
      return { poToken: data.poToken, visitorData: data.visitorData || null };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Fire-and-forget ping to keep/wake the Render instance, WITHOUT the
// current request waiting on it. `ctx.waitUntil` lets this keep running
// after the response has already been sent back to the client, so a cold
// provider only costs FUTURE requests a warmer instance, never this one.
function keepAlivePot(waitUntil) {
  const ping = fetch(POT_PROVIDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).catch(() => null);
  if (waitUntil) waitUntil(ping);
}

// =============================================================================
// ATTEMPT — PO-Token-backed WEB_EMBEDDED_PLAYER. Only used when a token
// was actually obtained within POT_FETCH_TIMEOUT_MS. PO Tokens are
// platform-bound — a bgutil (BotGuard/web) token is valid for
// WEB_EMBEDDED_PLAYER, not ANDROID_VR (DroidGuard) or IOS.
// =============================================================================
async function ytWebEmbeddedWithPot(videoId, pot, timeoutMs) {
  if (!pot?.poToken) return null;
  try {
    const context = {
      client: {
        clientName: 'WEB_EMBEDDED_PLAYER',
        clientVersion: '1.20250101.00.00',
        hl: 'en',
        gl: 'US',
      },
      thirdParty: { embedUrl: `https://www.youtube.com/watch?v=${videoId}` },
    };
    if (pot.visitorData) context.client.visitorData = pot.visitorData;

    const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        videoId,
        context,
        serviceIntegrityDimensions: { poToken: pot.poToken },
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
    if (Date.now() > deadlineAt) break; // out of overall budget — stop trying more instances
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
// clients/instances are configured above. PO Token fetch is capped hard at
// POT_FETCH_TIMEOUT_MS and never blocks beyond that.
// =============================================================================
async function resolveYtVideo(videoId, waitUntil) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + TOTAL_RESOLVE_BUDGET_MS;
  const remaining = () => Math.max(0, deadlineAt - Date.now());

  // Detached keep-alive ping so future requests have a better shot at a
  // warm PO Token provider. Not awaited — costs this request nothing.
  keepAlivePot(waitUntil);

  const pot = await withDeadline(fetchPoToken(), Math.min(POT_FETCH_TIMEOUT_MS, remaining()));

  if (pot?.poToken && remaining() > 0) {
    const webResponse = await ytWebEmbeddedWithPot(videoId, pot, Math.min(FETCH_TIMEOUT_MS, remaining()));
    const extracted = extractMuxedUrl(webResponse, 'WEB_EMBEDDED_PLAYER');
    if (extracted) return extracted;
  }

  if (remaining() > 0) {
    const androidVrResponse = await ytAndroidVr(videoId, 2, Math.min(FETCH_TIMEOUT_MS, Math.max(1500, remaining() / 3)));
    const extracted = extractMuxedUrl(androidVrResponse, 'ANDROID_VR');
    if (extracted) return extracted;
  }

  if (remaining() > 0) {
    const iosResponse = await ytIos(videoId, Math.min(FETCH_TIMEOUT_MS, remaining()));
    const extracted = extractMuxedUrl(iosResponse, 'IOS');
    if (extracted) return extracted;
  }

  if (remaining() > 0) {
    const tvResponse = await ytTvEmbeddedBypass(videoId, Math.min(FETCH_TIMEOUT_MS, remaining()));
    const extracted = extractMuxedUrl(tvResponse, 'TVHTML5_SIMPLY_EMBEDDED_PLAYER');
    if (extracted) return extracted;
  }

  if (remaining() > 0) {
    const piped = await ytPipedFallback(videoId, Math.min(4000, remaining()), deadlineAt);
    if (piped) return { ...piped, client: 'PIPED' };
  }

  return null;
}

function extractMuxedUrl(playerResponse, clientName) {
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
    client: clientName,
  };
}

// =============================================================================
// Route handlers
// =============================================================================
async function handleVideoResolve(videoId, waitUntil) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);
  const video = await resolveYtVideo(videoId, waitUntil);
  if (!video) return jsonResp({ success: false, error: 'No muxed video stream found' }, 502);
  return jsonResp({ success: true, ...video, videoId });
}

// Direct-proxy route — lets the app just point a native video player at
// this URL instead of round-tripping the resolved URL first, and supports
// Range requests for seeking/buffering.
const CLIENT_USER_AGENTS = {
  WEB_EMBEDDED_PLAYER: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  ANDROID_VR: 'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
  IOS: 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
  TVHTML5_SIMPLY_EMBEDDED_PLAYER: 'Mozilla/5.0 (PlayStation; PlayStation 4/12.02) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
  // Piped-sourced URLs are already publicly-servable CDN links (not
  // freshly minted by a specific YT client in this request), a plain
  // mobile browser UA is the right/expected one here.
  PIPED: 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36',
};

async function handleVideoProxy(videoId, request, waitUntil) {
  if (!videoId) return new Response('id required', { status: 400 });

  const { searchParams } = new URL(request.url);
  // FIX (see header comment #1): the app already calls /api/video-resolve
  // first and hands us back the EXACT resolved `url` + `client` it got.
  // Reuse it — a pure re-fetch, zero re-resolving, guaranteed matching
  // User-Agent. Only fall back to a fresh resolve if nothing was passed
  // (e.g. this route hit directly without a prior resolve call).
  const passedUrl = searchParams.get('url');
  const passedClient = searchParams.get('client');

  let video;
  if (passedUrl) {
    video = { url: passedUrl, client: passedClient || 'ANDROID_VR' };
  } else {
    video = await resolveYtVideo(videoId, waitUntil);
  }
  if (!video?.url) return new Response('Could not resolve video', { status: 502 });

  const rangeHeader = request.headers.get('Range');
  // IMPORTANT: this User-Agent must match whichever client actually
  // obtained `video.url` from YouTube. googlevideo.com CDN URLs are bound
  // to the requesting client's identity; a mismatched or generic browser
  // User-Agent here can get the request silently throttled/truncated by
  // the CDN — the "loads one frame then stalls" symptom.
  const userAgent = CLIENT_USER_AGENTS[video.client] || CLIENT_USER_AGENTS.ANDROID_VR;

  let upstream;
  let fetchError = null;
  try {
    upstream = await fetch(video.url, {
      headers: {
        'User-Agent': userAgent,
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
    });
  } catch (e) {
    fetchError = e;
  }

  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    // Surface the real upstream status/error instead of a bare 502, so
    // failures like "URL expired", "403 from CDN", "network error
    // reaching googlevideo" are distinguishable from each other.
    return jsonResp({
      success: false,
      error: 'Stream unavailable',
      upstreamStatus: upstream ? upstream.status : null,
      upstreamStatusText: upstream ? upstream.statusText : null,
      fetchError: fetchError ? String(fetchError) : null,
      clientUsed: video.client,
      userAgentUsed: userAgent,
      urlHost: (() => { try { return new URL(video.url).host; } catch (_) { return null; } })(),
    }, 502);
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

// =============================================================================
// DEBUG — runs every client independently (not budgeted, not short-
// circuited) and reports what each one actually returned/threw. Use this
// to see WHICH client is failing and why, since resolveYtVideo() swallows
// all errors via catch(_) { return null } for the normal fast-path.
// =============================================================================
async function handleDebugYtVideo(videoId) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);
  const report = {};

  const potStart = Date.now();
  let pot = null;
  try {
    pot = await fetchPoToken();
    report.poToken = { ok: !!pot?.poToken, tookMs: Date.now() - potStart, hasVisitorData: !!pot?.visitorData };
  } catch (e) {
    report.poToken = { ok: false, tookMs: Date.now() - potStart, error: String(e) };
  }

  if (pot?.poToken) {
    const t0 = Date.now();
    try {
      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: 'WEB_EMBEDDED_PLAYER',
              clientVersion: '1.20250101.00.00',
              hl: 'en',
              gl: 'US',
              ...(pot.visitorData ? { visitorData: pot.visitorData } : {}),
            },
            thirdParty: { embedUrl: `https://www.youtube.com/watch?v=${videoId}` },
          },
          serviceIntegrityDimensions: { poToken: pot.poToken },
        }),
      }, 6000);
      const json = await resp.json().catch(() => null);
      report.webEmbedded = {
        httpStatus: resp.status,
        playabilityStatus: json?.playabilityStatus?.status || null,
        reason: json?.playabilityStatus?.reason || null,
        muxedFormatCount: (json?.streamingData?.formats || []).length,
        tookMs: Date.now() - t0,
      };
    } catch (e) {
      report.webEmbedded = { error: String(e), tookMs: Date.now() - t0 };
    }
  } else {
    report.webEmbedded = { skipped: 'no PO token' };
  }

  {
    const t0 = Date.now();
    try {
      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          'X-YouTube-Client-Name': '28',
          'X-YouTube-Client-Version': '1.71.26',
        },
        body: JSON.stringify({ videoId, context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.71.26', osVersion: '12L', hl: 'en', gl: 'US' } } }),
      }, 6000);
      const json = await resp.json().catch(() => null);
      report.androidVr = {
        httpStatus: resp.status,
        playabilityStatus: json?.playabilityStatus?.status || null,
        reason: json?.playabilityStatus?.reason || null,
        muxedFormatCount: (json?.streamingData?.formats || []).length,
        tookMs: Date.now() - t0,
      };
    } catch (e) {
      report.androidVr = { error: String(e), tookMs: Date.now() - t0 };
    }
  }

  {
    const t0 = Date.now();
    try {
      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
          'X-YouTube-Client-Name': '5',
          'X-YouTube-Client-Version': '19.29.1',
        },
        body: JSON.stringify({ videoId, context: { client: { clientName: 'IOS', clientVersion: '19.29.1', deviceModel: 'iPhone16,2', hl: 'en', gl: 'US' } } }),
      }, 6000);
      const json = await resp.json().catch(() => null);
      report.ios = {
        httpStatus: resp.status,
        playabilityStatus: json?.playabilityStatus?.status || null,
        reason: json?.playabilityStatus?.reason || null,
        muxedFormatCount: (json?.streamingData?.formats || []).length,
        tookMs: Date.now() - t0,
      };
    } catch (e) {
      report.ios = { error: String(e), tookMs: Date.now() - t0 };
    }
  }

  {
    const t0 = Date.now();
    try {
      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (PlayStation; PlayStation 4/12.02) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
          'X-YouTube-Client-Name': '85',
          'X-YouTube-Client-Version': '2.0',
        },
        body: JSON.stringify({ videoId, context: { client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', platform: 'TV', hl: 'en', gl: 'US' }, thirdParty: { embedUrl: `https://www.youtube.com/watch?v=${videoId}` } } }),
      }, 6000);
      const json = await resp.json().catch(() => null);
      report.tvEmbedded = {
        httpStatus: resp.status,
        playabilityStatus: json?.playabilityStatus?.status || null,
        reason: json?.playabilityStatus?.reason || null,
        muxedFormatCount: (json?.streamingData?.formats || []).length,
        tookMs: Date.now() - t0,
      };
    } catch (e) {
      report.tvEmbedded = { error: String(e), tookMs: Date.now() - t0 };
    }
  }

  report.piped = {};
  for (const instance of PIPED_INSTANCES) {
    const t0 = Date.now();
    try {
      const resp = await fetchWithTimeout(`${instance}/streams/${videoId}`, { headers: { 'Content-Type': 'application/json' } }, 6000);
      const data = await resp.json().catch(() => null);
      const videoStreams = (data?.videoStreams || []).filter((s) => s.url && !s.videoOnly);
      report.piped[instance] = {
        httpStatus: resp.status,
        muxedStreamCount: videoStreams.length,
        error: data?.error || null,
        tookMs: Date.now() - t0,
      };
    } catch (e) {
      report.piped[instance] = { error: String(e), tookMs: Date.now() - t0 };
    }
  }

  return jsonResp({ videoId, report });
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
    const waitUntil = ctx?.waitUntil?.bind(ctx);

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
      return handleVideoResolve(searchParams.get('id') || '', waitUntil);
    }
    if (pathname === '/api/video-proxy') {
      return handleVideoProxy(searchParams.get('id') || '', request, waitUntil);
    }
    if (pathname === '/api/debug-yt-video') {
      return handleDebugYtVideo(searchParams.get('id') || '');
    }

    if (pathname === '/health') {
      return jsonResp({
        status: 'ok',
        worker: 'aurum-shorts-video-v2-budgeted',
        potProvider: POT_PROVIDER_URL,
        totalResolveBudgetMs: TOTAL_RESOLVE_BUDGET_MS,
        potFetchTimeoutMs: POT_FETCH_TIMEOUT_MS,
        ytClients: [
          'WEB_EMBEDDED_PLAYER (PO-Token, only if token obtained within 3s, muxed formats)',
          'ANDROID_VR (2 retries, muxed formats)',
          'IOS (muxed formats)',
          'TVHTML5_SIMPLY_EMBEDDED_PLAYER (bypass, muxed formats)',
          `Piped videoStreams (multi-instance: ${PIPED_INSTANCES.join(', ')})`,
        ],
        resolutionStrategy: 'budgeted sequential chain — hard 15s cap, PO Token non-blocking, muxed video+audio streams only',
        note: 'Fully isolated from the main Aurum audio-resolution Worker — separate deploy, separate routes.',
      });
    }

    return jsonResp({ error: 'Not found', path: pathname }, 404);
  },
};
