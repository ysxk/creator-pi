//! `ViewVideo` and `ViewAudio`: a clip or a recording handed to the model as
//! media, not as text.
//!
//! The host applies the same path policy `Read` does, checks that the file is
//! the container its extension names, and answers with a reference
//! (`video` / `audio: { path, mimeType, size }`) and no bytes. Whether the
//! model can watch or listen is the runtime's knowledge: it declares these
//! tools only for a model that takes the medium, and it attaches the file to
//! the tool result. `Read` refuses both kinds as binary, so a model that
//! cannot watch a clip is never told it was given one.

use serde_json::{json, Value};
use std::fs::File;
use std::io::Read;
use std::path::Path;

use super::{display_tool_path, ignore_rules, require_workspace};
use crate::workspace::resolve_tool_path_with_external;

/// The two media tools, which differ only in the kind of file they take.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum MediaKind {
    Video,
    Audio,
}

impl MediaKind {
    fn tool_name(self) -> &'static str {
        match self {
            Self::Video => "ViewVideo",
            Self::Audio => "ViewAudio",
        }
    }

    pub(super) fn noun(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Audio => "audio",
        }
    }

    fn mime(self, extension: &str) -> Option<&'static str> {
        match self {
            Self::Video => inline_video_mime(extension),
            Self::Audio => inline_audio_mime(extension),
        }
    }
}

/// The medium a file extension names, if it is one of the two.
pub(super) fn media_kind_of_extension(extension: &str) -> Option<MediaKind> {
    if inline_video_mime(extension).is_some() {
        Some(MediaKind::Video)
    } else if inline_audio_mime(extension).is_some() {
        Some(MediaKind::Audio)
    } else {
        None
    }
}

/// Resolve and admit the file a media tool names, and answer with a reference.
pub(super) fn tool_view_media(
    kind: MediaKind,
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    args: &Value,
    allow_external_paths: bool,
) -> Result<Value, (String, String)> {
    let root = require_workspace(workspace)?;
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_ARGUMENT".into(), "path required".into()))?;
    let (resolved, root_kind) =
        resolve_tool_path_with_external(root, scratch, path, allow_external_paths)
            .map_err(|e| (e.clone(), e))?;
    if ignore_rules::is_sensitive_path(&resolved) {
        return Err(ignore_rules::denied_error(path));
    }
    let meta = std::fs::metadata(&resolved).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ("FILE_NOT_FOUND".into(), format!("File not found: {path}"))
        } else {
            ("TOOL_FAILED".into(), format!("read failed: {e}"))
        }
    })?;
    if !meta.is_file() {
        return Err((
            "INVALID_ARGUMENT".into(),
            format!("{} requires a regular file: {path}", kind.tool_name()),
        ));
    }
    let display = display_tool_path(root_kind, root, &resolved);
    let extension = resolved
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let Some(mime) = kind.mime(&extension) else {
        let other = media_kind_of_extension(&extension)
            .filter(|other| *other != kind)
            .map(|other| format!("; use {} for it", other.tool_name()))
            .unwrap_or_default();
        return Err((
            "INVALID_ARGUMENT".into(),
            format!(
                "{} takes a {} file, and {display} is not one{other}",
                kind.tool_name(),
                kind.noun()
            ),
        ));
    };
    match kind {
        MediaKind::Video => read_video_reference(&resolved, &display, meta.len(), mime),
        MediaKind::Audio => read_audio_reference(&resolved, &display, meta.len(), mime),
    }
}

/// Video containers ViewVideo answers with a reference. Mirrors `VIDEO_EXTENSIONS` in
/// packages/shared/src/attachment-formats.ts; host-core cannot import it.
fn inline_video_mime(extension: &str) -> Option<&'static str> {
    match extension {
        "mp4" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "mpeg" | "mpg" => Some("video/mpeg"),
        "avi" => Some("video/x-msvideo"),
        "wmv" => Some("video/x-ms-wmv"),
        "flv" => Some("video/x-flv"),
        "3gp" => Some("video/3gpp"),
        _ => None,
    }
}

/// Whether the head of a file is one of the containers `inline_video_mime`
/// names. A text file renamed to `.mp4` must not reach a provider as video
/// data: the request it rides in would be refused and the turn lost with it.
fn looks_like_video_container(head: &[u8]) -> bool {
    const ISO_BMFF_BOXES: [&[u8]; 6] = [b"ftyp", b"moov", b"mdat", b"free", b"wide", b"skip"];
    (head.len() >= 8 && ISO_BMFF_BOXES.contains(&&head[4..8]))
        || head.starts_with(b"\x1a\x45\xdf\xa3")
        || head.starts_with(b"RIFF")
        || head.starts_with(b"\x00\x00\x01\xba")
        || head.starts_with(b"\x00\x00\x01\xb3")
        || head.starts_with(b"\x30\x26\xb2\x75")
        || head.starts_with(b"FLV")
}

/// Answer ViewVideo with where the clip is, never with its bytes.
///
/// The path policy has already been applied by the caller, so the reference
/// names a file this session may read. Whether the model can watch it is the
/// runtime's knowledge, not the host's: the runtime attaches the clip to the
/// tool result for a model that takes video, and says so in words for one
/// that does not. Shipping tens of megabytes through two JSON hops to maybe
/// discard them would be the wrong default.
fn read_video_reference(
    resolved: &Path,
    display: &str,
    size: u64,
    mime: &str,
) -> Result<Value, (String, String)> {
    let mut head = [0u8; 12];
    let read = File::open(resolved)
        .and_then(|mut file| file.read(&mut head))
        .map_err(|e| ("TOOL_FAILED".into(), format!("read failed: {e}")))?;
    if !looks_like_video_container(&head[..read]) {
        return Err((
            "TOOL_BINARY_CONTENT".into(),
            format!("{display} does not look like a valid {mime} video"),
        ));
    }
    Ok(json!({
        "path": display,
        "text": format!("Video file {display} ({size} bytes, {mime})."),
        "video": {
            "path": resolved.to_string_lossy(),
            "mimeType": mime,
            "size": size,
        },
    }))
}

/// Audio containers ViewAudio answers with a reference. Mirrors `AUDIO_EXTENSIONS` in
/// packages/shared/src/attachment-formats.ts; host-core cannot import it.
fn inline_audio_mime(extension: &str) -> Option<&'static str> {
    match extension {
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "aiff" | "aif" => Some("audio/aiff"),
        "aac" => Some("audio/aac"),
        "ogg" | "oga" => Some("audio/ogg"),
        "flac" => Some("audio/flac"),
        "m4a" => Some("audio/mp4"),
        _ => None,
    }
}

/// Whether the head of a file is one of the containers `inline_audio_mime`
/// names: an ID3 tag or an MPEG/ADTS frame sync, RIFF/WAVE, FORM/AIFF, OggS,
/// fLaC, or an ISO-BMFF box (m4a). A text file renamed to `.mp3` must not
/// reach a provider as audio data: the request it rides in would be refused
/// and the turn lost with it.
fn looks_like_audio_container(head: &[u8]) -> bool {
    const ISO_BMFF_BOXES: [&[u8]; 6] = [b"ftyp", b"moov", b"mdat", b"free", b"wide", b"skip"];
    head.starts_with(b"ID3")
        || (head.len() >= 2 && head[0] == 0xff && (head[1] & 0xe0) == 0xe0)
        || (head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WAVE")
        || (head.len() >= 12
            && head.starts_with(b"FORM")
            && (&head[8..12] == b"AIFF" || &head[8..12] == b"AIFC"))
        || head.starts_with(b"OggS")
        || head.starts_with(b"fLaC")
        || (head.len() >= 8 && ISO_BMFF_BOXES.contains(&&head[4..8]))
}

/// Answer ViewAudio with where the recording is, never with its bytes.
///
/// The same contract as `read_video_reference`: the runtime, which knows the
/// model, attaches the recording to the tool result for a model that takes
/// audio and says so in words for one that does not.
fn read_audio_reference(
    resolved: &Path,
    display: &str,
    size: u64,
    mime: &str,
) -> Result<Value, (String, String)> {
    let mut head = [0u8; 12];
    let read = File::open(resolved)
        .and_then(|mut file| file.read(&mut head))
        .map_err(|e| ("TOOL_FAILED".into(), format!("read failed: {e}")))?;
    if !looks_like_audio_container(&head[..read]) {
        return Err((
            "TOOL_BINARY_CONTENT".into(),
            format!("{display} does not look like a valid {mime} audio file"),
        ));
    }
    Ok(json!({
        "path": display,
        "text": format!("Audio file {display} ({size} bytes, {mime})."),
        "audio": {
            "path": resolved.to_string_lossy(),
            "mimeType": mime,
            "size": size,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_video_is_answered_with_a_reference_not_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        let mut bytes = vec![0, 0, 0, 0x20];
        bytes.extend_from_slice(b"ftypisom");
        bytes.extend_from_slice(&[0u8; 64]);
        std::fs::write(&path, &bytes).unwrap();

        let content =
            read_video_reference(&path, "clip.mp4", bytes.len() as u64, "video/mp4").unwrap();
        assert_eq!(content["video"]["mimeType"], "video/mp4");
        assert_eq!(content["video"]["size"], bytes.len() as u64);
        assert_eq!(content["video"]["path"], path.to_string_lossy().as_ref());
        assert!(content.get("images").is_none());

        // A text file with a video extension is refused, not referenced.
        let fake = dir.path().join("notes.mp4");
        std::fs::write(&fake, b"just some notes, nothing to watch").unwrap();
        let error = read_video_reference(&fake, "notes.mp4", 33, "video/mp4").unwrap_err();
        assert_eq!(error.0, "TOOL_BINARY_CONTENT");
    }

    #[test]
    fn an_audio_file_is_answered_with_a_reference_not_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.mp3");
        let bytes = b"ID3\x04\x00\x00\x00\x00\x00\x00 payload";
        std::fs::write(&path, bytes).unwrap();
        let content =
            read_audio_reference(&path, "memo.mp3", bytes.len() as u64, "audio/mpeg").unwrap();
        assert_eq!(content["audio"]["mimeType"], "audio/mpeg");
        assert_eq!(content["audio"]["size"], bytes.len() as u64);
        assert_eq!(content["audio"]["path"], path.to_string_lossy().as_ref());
        assert!(content.get("images").is_none());
        assert!(content.get("video").is_none());
        // A text file with an audio extension is refused, not referenced.
        let fake = dir.path().join("notes.wav");
        std::fs::write(&fake, "just some words in a file").unwrap();
        let error = read_audio_reference(&fake, "notes.wav", 25, "audio/wav").unwrap_err();
        assert_eq!(error.0, "TOOL_BINARY_CONTENT");
    }

    #[test]
    fn audio_containers_are_recognized_by_their_first_bytes() {
        assert!(looks_like_audio_container(
            b"ID3\x04\x00\x00\x00\x00\x02\x01"
        ));
        assert!(looks_like_audio_container(b"\xff\xfb\x90\x64\x00\x00"));
        assert!(looks_like_audio_container(b"\xff\xf1\x50\x80\x00\x1f"));
        assert!(looks_like_audio_container(b"RIFF\x24\x08\x00\x00WAVEfmt "));
        assert!(looks_like_audio_container(b"FORM\x00\x00\x00\x00AIFFCOMM"));
        assert!(looks_like_audio_container(b"OggS\x00\x02\x00\x00"));
        assert!(looks_like_audio_container(b"fLaC\x00\x00\x00\x22"));
        assert!(looks_like_audio_container(b"\x00\x00\x00\x1cftypM4A "));
        // A RIFF that is not a WAVE is some other container, not audio.
        assert!(!looks_like_audio_container(b"RIFF\x00\x00\x00\x00AVI "));
        assert!(!looks_like_audio_container(b"#!/bin/sh\n"));
        assert!(!looks_like_audio_container(b""));
        for extension in [
            "mp3", "wav", "aiff", "aif", "aac", "ogg", "oga", "flac", "m4a",
        ] {
            assert!(inline_audio_mime(extension).is_some(), "{extension}");
        }
        assert!(inline_audio_mime("mp4").is_none());
        assert!(inline_audio_mime("txt").is_none());
    }

    #[test]
    fn video_containers_are_recognized_by_their_first_bytes() {
        assert!(looks_like_video_container(b"\x00\x00\x00\x18ftypmp42"));
        assert!(looks_like_video_container(b"\x00\x00\x00\x08wide\x00\x00"));
        assert!(looks_like_video_container(b"\x1a\x45\xdf\xa3\x01\x00"));
        assert!(looks_like_video_container(b"RIFF\x00\x00\x00\x00AVI "));
        assert!(!looks_like_video_container(b"#!/bin/sh\n"));
        assert!(!looks_like_video_container(b""));
        for extension in [
            "mp4", "mov", "webm", "mpeg", "mpg", "avi", "wmv", "flv", "3gp",
        ] {
            assert!(inline_video_mime(extension).is_some(), "{extension}");
        }
        assert!(inline_video_mime("txt").is_none());
    }

    #[test]
    fn each_tool_takes_only_its_own_medium() {
        let dir = tempfile::tempdir().unwrap();
        let clip = dir.path().join("clip.mp4");
        let mut bytes = vec![0, 0, 0, 0x20];
        bytes.extend_from_slice(b"ftypisom");
        bytes.extend_from_slice(&[0u8; 64]);
        std::fs::write(&clip, &bytes).unwrap();
        std::fs::write(
            dir.path().join("memo.mp3"),
            b"ID3\x04\x00\x00\x00\x00\x00\x00 payload",
        )
        .unwrap();
        std::fs::write(dir.path().join("notes.txt"), "words").unwrap();
        let root = Some(dir.path());
        let view =
            |kind, path: &str| tool_view_media(kind, root, None, &json!({ "path": path }), false);

        let video = view(MediaKind::Video, "clip.mp4").unwrap();
        assert_eq!(video["path"], "clip.mp4");
        assert_eq!(video["video"]["mimeType"], "video/mp4");
        let audio = view(MediaKind::Audio, "memo.mp3").unwrap();
        assert_eq!(audio["audio"]["mimeType"], "audio/mpeg");

        // The other medium is pointed at its own tool.
        let error = view(MediaKind::Audio, "clip.mp4").unwrap_err();
        assert_eq!(error.0, "INVALID_ARGUMENT");
        assert!(error.1.contains("use ViewVideo"), "{}", error.1);
        let error = view(MediaKind::Video, "notes.txt").unwrap_err();
        assert_eq!(error.0, "INVALID_ARGUMENT");
        assert!(!error.1.contains("use View"), "{}", error.1);
        assert_eq!(
            view(MediaKind::Video, "missing.mp4").unwrap_err().0,
            "FILE_NOT_FOUND"
        );
        // The path policy is Read's: nothing outside the roots without approval.
        assert_eq!(
            view(MediaKind::Video, "../elsewhere.mp4").unwrap_err().0,
            "PATH_OUTSIDE_WORKSPACE"
        );
    }
}
