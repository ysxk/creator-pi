import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { formatAudioTime } from "../lib/audio-time";
import { IconPause, IconPlay } from "./icons";
import { cx } from "./ui";
import "../styles/audio-player.css";

/**
 * The app's own audio player: a play/pause button, a seek bar and the time,
 * drawn with the design tokens instead of the browser's control, which sits
 * in the chat like a foreign object. The audio element underneath is hidden
 * and does the playing; this component only mirrors its state.
 *
 * Every surface that plays a recording — a chip's hover card, the file view,
 * a recording a reply names, Markdown audio — uses this one component, so a
 * recording looks and behaves the same wherever it is heard.
 */
export function AudioPlayer({
  src,
  title,
  compact = false,
  className,
  onError,
}: {
  src: string;
  /** Spoken name for the controls; the player shows no text of its own. */
  title?: string;
  /** The hover-card size: a shorter bar and a smaller button. */
  compact?: boolean;
  className?: string;
  /** The element could not load or decode the source. */
  onError?: () => void;
}) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  // While the thumb is held, the bar follows the pointer, not the playhead.
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const seekId = useId();

  // A new source starts over: the previous recording's state must not show
  // under it for a frame.
  useEffect(() => {
    setPlaying(false);
    setDuration(0);
    setPosition(0);
    setScrubbing(null);
  }, [src]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }, []);

  const onDuration = (event: SyntheticEvent<HTMLAudioElement>) => {
    const value = event.currentTarget.duration;
    setDuration(Number.isFinite(value) ? value : 0);
  };
  const onTime = (event: SyntheticEvent<HTMLAudioElement>) => {
    if (scrubbing === null) setPosition(event.currentTarget.currentTime);
  };
  const seekTo = (value: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setPosition(value);
  };

  const shown = scrubbing ?? position;
  const progress = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  const label = title ? `${t(playing ? "chat.audioPause" : "chat.audioPlay")} — ${title}` : t(playing ? "chat.audioPause" : "chat.audioPlay");
  return (
    <div
      className={cx("audio-player", compact && "is-compact", className)}
      data-state={playing ? "playing" : "paused"}
      role="group"
      aria-label={title ?? t("chat.audioPlayer")}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={onDuration}
        onDurationChange={onDuration}
        onTimeUpdate={onTime}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
        onError={onError}
      />
      <button
        type="button"
        className="audio-player-toggle"
        aria-label={label}
        title={label}
        onClick={toggle}
      >
        {playing ? (
          <IconPause size={compact ? 12 : 14} filled />
        ) : (
          <IconPlay size={compact ? 12 : 14} filled />
        )}
      </button>
      <input
        id={seekId}
        className="audio-player-seek"
        type="range"
        min={0}
        max={duration > 0 ? duration : 1}
        step={0.1}
        value={duration > 0 ? shown : 0}
        disabled={duration <= 0}
        style={{ "--audio-progress": `${progress}%` } as CSSProperties}
        aria-label={t("chat.audioSeek")}
        aria-valuetext={`${formatAudioTime(shown)} / ${formatAudioTime(duration)}`}
        onPointerDown={() => setScrubbing(position)}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (scrubbing !== null) setScrubbing(value);
          else seekTo(value);
        }}
        onPointerUp={(event) => {
          const value = Number(event.currentTarget.value);
          setScrubbing(null);
          seekTo(value);
        }}
        onPointerCancel={() => setScrubbing(null)}
      />
      <span className="audio-player-time" aria-hidden="true">
        {formatAudioTime(shown)}
        <span className="audio-player-time-separator"> / </span>
        {formatAudioTime(duration)}
      </span>
    </div>
  );
}
