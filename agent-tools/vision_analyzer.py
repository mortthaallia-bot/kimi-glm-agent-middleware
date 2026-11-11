#!/usr/bin/env python3
"""
Hermes Autonomous Vision Analyzer Bridge
Uses NVIDIA Nemotron Super-VL (120B) with automatic local image encoding to provide instant, free visual inspection.
"""

import sys
import os
import json
import base64
import urllib.request
import urllib.error
from pathlib import Path

NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY") or "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"
NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions"
MODEL_NAME = "nvidia/nemotron-3.5-super-vl-120b-a12b"

def load_env_key():
    global NVIDIA_API_KEY
    env_path = r"C:\Users\hhjksd\AppData\Local\hermes\.env"
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("NVIDIA_API_KEY="):
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if val:
                            NVIDIA_API_KEY = val
                            break
        except Exception:
            pass

def analyze_image_with_nvidia(image_path, question):
    if not os.path.exists(image_path):
        return f"Error: Image file not found: {image_path}"

    with open(image_path, "rb") as f:
        img_bytes = f.read()

    b64_data = base64.b64encode(img_bytes).decode("utf-8")
    ext = Path(image_path).suffix.lower()
    mime = "image/png" if ext == ".png" else "image/webp" if ext == ".webp" else "image/jpeg"
    data_url = f"data:{mime};base64,{b64_data}"

    prompt_text = question if question else "Describe this image in extreme detail, including all text, UI elements, layouts, and colors."

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt_text},
                    {"type": "image_url", "image_url": {"url": data_url}}
                ]
            }
        ],
        "max_tokens": 1500,
        "temperature": 0.2
    }

    req_data = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {NVIDIA_API_KEY}",
        "Content-Type": "application/json",
        "User-Agent": "Hermes-Agent-Vision/1.0"
    }

    req = urllib.request.Request(NVIDIA_ENDPOINT, data=req_data, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            resp_body = resp.read().decode("utf-8")
            data = json.loads(resp_body)
            choice = data.get("choices", [{}])[0]
            msg = choice.get("message", {})
            content = msg.get("content")
            reasoning = msg.get("reasoning_content")

            result = content or reasoning or ""
            if not result:
                return "Vision model returned empty response."
            return result
    except urllib.error.HTTPError as he:
        err_msg = he.read().decode("utf-8", errors="replace")
        return f"NVIDIA Vision API HTTP Error ({he.code}): {err_msg}"
    except Exception as e:
        return f"Vision inspection failed: {e}"

def main():
    if len(sys.argv) < 2:
        print("Usage: python vision_analyzer.py <image_path> [question]")
        sys.exit(1)

    load_env_key()
    image_path = sys.argv[1].replace('"', '')
    question = sys.argv[2] if len(sys.argv) > 2 else "Describe this frame in extreme detail."

    print(f"=== VISION ANALYSIS: {os.path.basename(image_path)} ===")
    analysis = analyze_image_with_nvidia(image_path, question)
    print(analysis)

if __name__ == "__main__":
    main()
