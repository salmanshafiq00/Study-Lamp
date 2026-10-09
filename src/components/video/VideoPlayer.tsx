"use client";

import * as React from "react";
import YouTube, { type YouTubeProps, type YouTubePlayer } from "react-youtube";
import { detectVideoPlatform, generateCanonicalUrl, generateEmbedUrl } from "@/lib/video-platforms";
import { FacebookEmbed } from "./FacebookEmbed";
import { useAuth } from "@/components/auth/AuthProvider";
import { getSignedDriveUrls } from "@/lib/driveClient";

interface Props {
  youtubeVideoId?: string | null;
  videoUrl: string;
  /** Set together for a platform === "google_drive" video (Phase 16) — see
   *  DriveVideoPlayer below. Every other platform ignores these. */
  platform?: string;
  driveFileId?: string | null;
  driveConnectionId?: string | null;
  startSeconds?: number;
  autoPlay?: boolean;
  className?: string;
  onProgress: (currentSeconds: number, durationSeconds: number, force?: boolean) => void;
  onPause: (currentSeconds: number, durationSeconds: number, force?: boolean) => void;
  onEnded: (currentSeconds: number, durationSeconds: number) => void;
}

/**
 * Dispatches to the right player for a video's platform. Every platform but
 * Google Drive renders through YouTubeOrEmbedPlayer (unchanged — see its own
 * doc comment); a platform === "google_drive" video renders through
 * DriveVideoPlayer instead, since Study Lamp holds the Drive credentials
 * needed to sign a short-lived stream URL (see /api/drive/stream/[fileId]) rather than
 * relying on a public embeddable URL the way every other platform does.
 */
export function VideoPlayer({ youtubeVideoId, videoUrl, platform, driveFileId, driveConnectionId, startSeconds = 0, autoPlay = false, className, onProgress, onPause, onEnded }: Props) {
  if (platform === "google_drive" && driveFileId && driveConnectionId) {
    return (
      <DriveVideoPlayer
        driveFileId={driveFileId}
        driveConnectionId={driveConnectionId}
        startSeconds={startSeconds}
        autoPlay={autoPlay}
        className={className}
        onProgress={onProgress}
        onPause={onPause}
        onEnded={onEnded}
      />
    );
  }

  return (
    <YouTubeOrEmbedPlayer
      youtubeVideoId={youtubeVideoId}
      videoUrl={videoUrl}
      startSeconds={startSeconds}
      autoPlay={autoPlay}
      className={className}
      onProgress={onProgress}
      onPause={onPause}
      onEnded={onEnded}
    />
  );
}

/**
 * Secure playback for a Drive-hosted video (Phase 16): a plain native
 * <video> tag pointed at the ownership-checked stream proxy
 * (/api/drive/stream/[fileId]) — never a direct Drive URL, and no OAuth
 * token. The signed URL is a short-lived capability. The proxy forwards Range headers, so
 * seeking/scrubbing works exactly like a normal <video src> would against
 * any other file host.
 *
 * Native <video> exposes currentTime/duration directly (no postMessage
 * dance needed the way YouTube's iframe requires), so progress tracking
 * here is simpler than the YouTube path — same throttling/force-save shape,
 * reusing the same onProgress/onPause/onEnded contract as every other
 * player in this file.
 */
function DriveVideoPlayer({
  driveFileId, driveConnectionId, startSeconds, autoPlay, className, onProgress, onPause, onEnded,
}: {
  driveFileId: string;
  driveConnectionId: string;
  startSeconds: number;
  autoPlay: boolean;
  className?: string;
  onProgress: Props["onProgress"];
  onPause: Props["onPause"];
  onEnded: Props["onEnded"];
}) {
  const { user } = useAuth();
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const lastSaveRef = React.useRef(0);
  const lastFlushRef = React.useRef(0);
  const onProgressRef = React.useRef(onProgress);
  onProgressRef.current = onProgress;
  const [authedSrc, setAuthedSrc] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // Read the auth object through a ref so a new object with the same uid (token refresh) never restarts playback.
  const userRef = React.useRef(user);
  userRef.current = user;
  const uid = user?.uid ?? null;
  /** Where to continue after the signed link had to be renewed mid-playback. */
  const resumeAtRef = React.useRef<number | null>(null);
  const renewedRef = React.useRef(false);

  const signStreamUrl = React.useCallback(async (): Promise<string> => {
    const currentUser = userRef.current;
    if (!currentUser) throw new Error("Not signed in.");
    const idToken = await currentUser.getIdToken();
    const [signedUrl] = await getSignedDriveUrls(idToken, currentUser.uid, [{
      fileId: driveFileId,
      connectionId: driveConnectionId,
      purpose: "stream",
    }]);
    return signedUrl;
  }, [driveFileId, driveConnectionId]);

  React.useEffect(() => {
    let active = true;
    setAuthedSrc(null);
    setLoadError(null);
    resumeAtRef.current = null;
    renewedRef.current = false;
    if (!uid) return;
    signStreamUrl()
      .then((signedUrl) => { if (active) setAuthedSrc(signedUrl); })
      .catch(() => { if (active) setLoadError("Couldn't load this video from Google Drive."); });
    return () => { active = false; };
  }, [uid, signStreamUrl]);

  // The signed link lasts 6 hours. If playback fails (expired link after a long pause, dropped connection),
  // renew it once and continue from the same second instead of leaving a dead player.
  async function handleVideoError() {
    const el = videoRef.current;
    if (renewedRef.current) {
      setAuthedSrc(null);
      setLoadError("This video stopped loading. Check your connection or Drive access, then reload the page.");
      return;
    }
    renewedRef.current = true;
    resumeAtRef.current = el?.currentTime || startSeconds || null;
    try {
      setAuthedSrc(await signStreamUrl());
    } catch {
      setAuthedSrc(null);
      setLoadError("Couldn't reconnect to Google Drive. Reload the page and try again.");
    }
  }

  const flushProgress = React.useCallback(() => {
    const video = videoRef.current;
    const now = Date.now();
    if (!video || now - lastFlushRef.current < 1000) return;
    lastFlushRef.current = now;
    onProgressRef.current(video.currentTime, video.duration || 0, true);
  }, []);

  React.useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") flushProgress();
    }
    window.addEventListener("pagehide", flushProgress);
    window.addEventListener("beforeunload", flushProgress);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushProgress);
      window.removeEventListener("beforeunload", flushProgress);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flushProgress();
    };
  }, [flushProgress]);

  function handleLoadedMetadata() {
    const el = videoRef.current;
    const resumeAt = resumeAtRef.current;
    if (resumeAt !== null) {
      // Renewed link: continue where playback broke, and play on (it was playing or about to).
      if (el) el.currentTime = resumeAt;
      resumeAtRef.current = null;
      renewedRef.current = false;
      el?.play().catch(() => {});
      return;
    }
    if (el && startSeconds > 0) el.currentTime = startSeconds;
    if (autoPlay) el?.play().catch(() => {});
  }

  function handleTimeUpdate() {
    const el = videoRef.current;
    if (!el) return;
    const now = Date.now();
    if (now - lastSaveRef.current < 60000) return; // same 60s throttle as the YouTube path
    lastSaveRef.current = now;
    onProgress(el.currentTime, el.duration || 0);
  }

  function handlePause() {
    const el = videoRef.current;
    if (!el) return;
    lastSaveRef.current = Date.now();
    onPause(el.currentTime, el.duration || 0, true);
  }

  function handleEnded() {
    const el = videoRef.current;
    if (!el) return;
    onEnded(el.currentTime, el.duration || 0);
  }

  if (!authedSrc) {
    return (
      <div className={['flex aspect-video w-full items-center justify-center rounded-xl bg-black', className].filter(Boolean).join(' ')}>
        <p className="text-sm text-muted-foreground">{loadError || "Loading from Google Drive…"}</p>
      </div>
    );
  }

  return (
    <div className={['relative z-0 aspect-video w-full overflow-hidden rounded-xl bg-black shadow-sm', className].filter(Boolean).join(' ')}>
      <video
        ref={videoRef}
        src={authedSrc}
        controls
        playsInline
        preload="metadata"
        className="h-full w-full"
        onError={() => void handleVideoError()}
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onPause={handlePause}
        onEnded={handleEnded}
      />
    </div>
  );
}

/**
 * Renders the YouTube IFrame player when a youtubeVideoId is available —
 * that path is unchanged and is the only one with progress tracking, since
 * it's the only platform whose iframe exposes a JS API to read/seek
 * playback position (react-youtube's onStateChange/getCurrentTime).
 *
 * Facebook videos and Reels render via FacebookEmbed (the SDK-based
 * `fb-video` xfbml player) instead of a bare iframe — see that
 * component's doc comment for why a plain `plugins/video.php` iframe
 * isn't used here despite `generateEmbedUrl` still being able to build
 * one. Vimeo (and anything else with a public direct-iframe embed) still
 * renders via generateEmbedUrl's iframe URL directly.
 *
 * There's no postMessage progress API for Facebook or Vimeo the way
 * there is for YouTube, so watch position isn't tracked for either — the
 * same trade-off YouTube's Shorts and every other non-YouTube platform
 * already made before this.
 *
 * Only when a platform has no public embed mechanism at all (a bare
 * `generic` URL) does this fall back to a simple "open externally" card —
 * this app never hosts or proxies video files itself (a Drive video is the
 * one exception — see DriveVideoPlayer above — because Study Lamp already
 * holds the credentials to fetch it on the user's behalf).
 */
function YouTubeOrEmbedPlayer({ youtubeVideoId, videoUrl, startSeconds = 0, autoPlay = false, className, onProgress, onPause, onEnded }: Omit<Props, "platform" | "driveFileId" | "driveConnectionId">) {
  const playerRef = React.useRef<YouTubePlayer | null>(null);
  const intervalRef = React.useRef<ReturnType<typeof setInterval>>();
  // The YouTube IFrame API's own internal messaging can throw (its minified
  // code references an internal "M_ID" field) if a player method is called
  // while the player is mid-teardown or mid-video-swap — e.g. an in-flight
  // setInterval tick landing right as the component unmounts, or right as
  // Next/Prev swaps videos. This flag, plus a try/catch around every call
  // into the player, turns that into "skip this one save" instead of an
  // uncaught console error.
  const isMountedRef = React.useRef(true);

  const clearPoll = () => intervalRef.current && clearInterval(intervalRef.current);

  async function safeReadTime(target: YouTubePlayer): Promise<[number, number] | null> {
    if (!isMountedRef.current) return null;
    try {
      const [cur, dur] = await Promise.all([target.getCurrentTime(), target.getDuration()]);
      return [Number(cur), Number(dur)];
    } catch {
      return null;
    }
  }

  // `startSeconds` is fed from the same progress state we save periodically,
  // so it changes on every tick. `opts` must NOT be rebuilt on those
  // updates — react-youtube treats a new `opts` object as a real change
  // and reloads/reseeks the underlying iframe player, which pauses
  // playback. We only want the resume position once — at mount, or when
  // the video itself actually changes (e.g. Prev/Next) — so it's captured
  // into a ref synchronously during render (not an effect, which would run
  // one tick too late and hand the memo the previous video's position).
  const lastVideoIdRef = React.useRef<string | null | undefined>(undefined);
  const resumeSecondsRef = React.useRef(startSeconds);
  if (lastVideoIdRef.current !== youtubeVideoId) {
    lastVideoIdRef.current = youtubeVideoId;
    resumeSecondsRef.current = startSeconds;
  }

  const opts: YouTubeProps["opts"] = React.useMemo(() => ({
    width: "100%",
    height: "100%",
    playerVars: {
      start: Math.floor(resumeSecondsRef.current),
      rel: 0,
      modestbranding: 1,
      controls: 1,
      fs: 1,
      playsinline: 1,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [youtubeVideoId]);

  function handleReady(e: { target: YouTubePlayer }) {
    playerRef.current = e.target;
    if (autoPlay) {
      try { e.target.playVideo(); } catch { /* Browser autoplay policy may block this. */ }
    }
  }

  function handleStateChange(e: { data: number; target: YouTubePlayer }) {
    const YT_PLAYING = 1;
    const YT_PAUSED = 2;
    const YT_ENDED = 0;

    clearPoll();

    if (e.data === YT_PLAYING) {
      // Periodic save while playing — every 60s, not every second, to
      // minimize Firestore writes (see README > Firestore optimization).
      intervalRef.current = setInterval(async () => {
        const result = await safeReadTime(e.target);
        if (result) onProgress(result[0], result[1]);
      }, 60000);
    }

    if (e.data === YT_PAUSED) {
      // Pausing is a natural checkpoint — force the save so the exact
      // position is captured even if you paused seconds after the last
      // throttled periodic save (otherwise a short viewing session could
      // end without ever persisting real progress).
      safeReadTime(e.target).then((result) => { if (result) onPause(result[0], result[1], true); });
    }

    if (e.data === YT_ENDED) {
      Promise.all([e.target.getCurrentTime(), e.target.getDuration()]).then(([cur, dur]) => {
        const currentSeconds = Number(cur);
        const durationSeconds = Number(dur);
        // Ignore an inconsistent early ended signal. It can happen when the
        // iframe reports a rounded duration near the end of a video.
        if (durationSeconds > 0 && currentSeconds < durationSeconds - 2) {
          onProgress(currentSeconds, durationSeconds, true);
          return;
        }
        onEnded(currentSeconds, durationSeconds);
      }).catch(() => {});
    }
  }

  // Save on page leave / unmount as a safety net.
  React.useEffect(() => {
    isMountedRef.current = true;
    function flushProgress() {
      const p = playerRef.current;
      if (!p) return;
      // Same reasoning as the pause handler — this is the last chance to
      // persist progress before the tab/route changes, so it must not be
      // silently dropped by the periodic-save throttle.
      safeReadTime(p).then((result) => { if (result) onProgress(result[0], result[1], true); });
    }
    window.addEventListener("beforeunload", flushProgress);
    window.addEventListener("pagehide", flushProgress);
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") flushProgress();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", flushProgress);
      window.removeEventListener("pagehide", flushProgress);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearPoll();
      flushProgress();
      // Set after the final save is *initiated* (safeReadTime still checks
      // isMountedRef itself before touching the player, but this ensures
      // any subsequent stray call — e.g. a late interval tick that slipped
      // through — is a guaranteed no-op).
      isMountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!youtubeVideoId) {
    if (detectVideoPlatform(videoUrl) === "facebook") {
      // Re-derive the canonical (Reel- or Watch-shaped) URL from whatever
      // videoUrl actually is, rather than assuming it's already in that
      // shape — defensive against any pre-fix record that slipped through
      // storage with a raw/unnormalized URL. generateCanonicalUrl() is
      // idempotent for an already-canonical URL, so this is a no-op for
      // every normal record.
      const href = generateCanonicalUrl(videoUrl) || videoUrl;
      return <FacebookEmbed key={href} href={href} videoUrl={videoUrl} className={className} />;
    }

    const embedUrl = generateEmbedUrl(videoUrl);

    if (embedUrl) {
      return (
        <div className={['relative z-0 w-full overflow-hidden rounded-xl bg-black shadow-sm', className].filter(Boolean).join(' ')}>
          {/* We do not know whether a generic iframe embed is portrait or
             landscape until the actual provider tells us. The safe default is
             to constrain width only and let the embedded player keep its own
             intrinsic height instead of forcing a landscape 16:9 box. */}
          <iframe
            src={embedUrl}
            className="block w-full border-0"
            allow="autoplay; encrypted-media; picture-in-picture; web-share"
            allowFullScreen
            title={videoUrl}
          />
        </div>
      );
    }

    return (
      <div className={['flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-xl bg-secondary text-center', className].filter(Boolean).join(' ')}>
        <p className="text-sm text-muted-foreground">This video is hosted externally.</p>
        <a href={videoUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-accent underline">
          Open video in a new tab →
        </a>
      </div>
    );
  }

  return (
    <div className={['relative z-0 aspect-video w-full overflow-hidden rounded-xl bg-black shadow-sm', className].filter(Boolean).join(' ')}>
      <YouTube
        videoId={youtubeVideoId}
        opts={opts}
        onReady={handleReady}
        onStateChange={handleStateChange}
        className="h-full w-full"
        iframeClassName="h-full w-full"
      />
    </div>
  );
}
