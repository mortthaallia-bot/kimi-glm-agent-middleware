#!/usr/bin/env python3
"""
Hermes Agent Video Inspector & Keyframe Extractor
Uses local ffprobe/ffmpeg to inspect videos, extract keyframes, and return structured analysis.
"""

import sys
import os
import json
import subprocess
import argparse
from pathlib import Path

FFMPEG_DIR = r"C:\Users\hhjksd\AppData\Local\hermes\tools\ffmpeg"
FFMPEG_EXE = os.path.join(FFMPEG_DIR, "ffmpeg.exe")
FFPROBE_EXE = os.path.join(FFMPEG_DIR, "ffprobe.exe")
DEFAULT_CACHE_DIR = r"C:\Users\hhjksd\AppData\Local\hermes\attachments\video_frames"

def get_probe_data(video_path):
    cmd = [
        FFPROBE_EXE,
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        video_path
    ]
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", check=True)
        return json.loads(res.stdout)
    except Exception as e:
        return {"error": f"Failed to probe video: {e}"}

def extract_frames(video_path, duration, num_frames=5, output_dir=None):
    if not output_dir:
        stem = Path(video_path).stem
        output_dir = os.path.join(DEFAULT_CACHE_DIR, stem)
    os.makedirs(output_dir, exist_ok=True)

    if duration <= 0:
        duration = 1.0

    # Choose evenly spaced timestamps avoiding exact ends
    timestamps = []
    if num_frames == 1:
        timestamps = [duration / 2.0]
    else:
        step = duration / (num_frames + 1)
        timestamps = [round(step * (i + 1), 2) for i in range(num_frames)]

    extracted = []
    for i, ts in enumerate(timestamps):
        out_name = f"frame_{i+1:02d}_{ts:.2f}s.jpg"
        out_path = os.path.join(output_dir, out_name)
        cmd = [
            FFMPEG_EXE,
            "-y",
            "-ss", str(ts),
            "-i", video_path,
            "-frames:v", "1",
            "-q:v", "2",
            out_path
        ]
        try:
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
            if os.path.exists(out_path):
                extracted.append({
                    "frame_index": i + 1,
                    "timestamp_seconds": ts,
                    "image_path": out_path.replace("\\", "/")
                })
        except Exception as e:
            continue

    return extracted

def analyze_video(video_path, max_frames=5):
    if not os.path.exists(video_path):
        return {"error": f"File not found: {video_path}"}

    probe = get_probe_data(video_path)
    if "error" in probe:
        return probe

    fmt = probe.get("format", {})
    streams = probe.get("streams", [])

    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = float(fmt.get("duration", 0) or (video_stream.get("duration", 0) if video_stream else 0))
    file_size_bytes = int(fmt.get("size", 0))

    summary = {
        "status": "success",
        "file_path": video_path.replace("\\", "/"),
        "file_name": Path(video_path).name,
        "file_size_mb": round(file_size_bytes / (1024 * 1024), 2),
        "duration_seconds": round(duration, 2),
        "format": fmt.get("format_name", "unknown"),
        "video": None,
        "audio": None,
        "extracted_keyframes": []
    }

    if video_stream:
        # Calculate FPS
        r_fps = video_stream.get("r_frame_rate", "0/1")
        fps = 0.0
        try:
            num, den = map(int, r_fps.split("/"))
            fps = round(num / den, 2) if den > 0 else 0.0
        except:
            pass

        summary["video"] = {
            "codec": video_stream.get("codec_name"),
            "width": video_stream.get("width"),
            "height": video_stream.get("height"),
            "aspect_ratio": video_stream.get("display_aspect_ratio") or f"{video_stream.get('width')}:{video_stream.get('height')}",
            "fps": fps,
            "total_frames": int(video_stream.get("nb_frames") or round(duration * fps)),
            "pixel_format": video_stream.get("pix_fmt")
        }

    if audio_stream:
        summary["audio"] = {
            "codec": audio_stream.get("codec_name"),
            "sample_rate_hz": audio_stream.get("sample_rate"),
            "channels": audio_stream.get("channels"),
            "channel_layout": audio_stream.get("channel_layout")
        }

    if max_frames > 0 and duration > 0:
        summary["extracted_keyframes"] = extract_frames(video_path, duration, num_frames=max_frames)

    return summary

def main():
    parser = argparse.ArgumentParser(description="Inspect video and extract keyframes")
    parser.add_argument("video_path", help="Path to video file")
    parser.add_argument("--frames", type=int, default=5, help="Number of keyframes to extract")
    parser.add_argument("--json", action="store_true", help="Output pure JSON")

    args = parser.parse_args()
    result = analyze_video(args.video_path, max_frames=args.frames)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if "error" in result:
            print(f"Error: {result['error']}")
            sys.exit(1)

        print(f"=== VIDEO ANALYSIS: {result['file_name']} ===")
        print(f"Duration: {result['duration_seconds']}s | Size: {result['file_size_mb']} MB | Format: {result['format']}")
        if result["video"]:
            v = result["video"]
            print(f"Video: {v['width']}x{v['height']} ({v['aspect_ratio']}) @ {v['fps']} fps | Codec: {v['codec']} | Frames: ~{v['total_frames']}")
        if result["audio"]:
            a = result["audio"]
            print(f"Audio: {a['codec']} | {a['sample_rate_hz']} Hz | {a['channels']} channels ({a['channel_layout']})")
        else:
            print("Audio: None (Silent video)")

        if result["extracted_keyframes"]:
            print(f"\nExtracted Keyframes ({len(result['extracted_keyframes'])} frames):")
            for f in result["extracted_keyframes"]:
                print(f"  - [{f['timestamp_seconds']}s] -> {f['image_path']}")
            print("\nUse `vision_analyze` or image inspection on the frame paths above to visually analyze content.")

if __name__ == "__main__":
    main()
