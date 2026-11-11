# ⚡ Kimi & GLM Autonomous Agent Middleware
> **Production-grade Full-Stack Middleware converting Kimi and GLM into autonomous, full-capability coding, video, and research agents with zero text leakage, multimodal vision inspection, and 24/7 watchdog.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Python Version](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://python.org)

---

## 📖 نظرة عامة | Overview

هذا المشروع يوفر بنية تحتية متكاملة وسيرفرات وسيطة (Middleware Proxies) متوافقة تماماً مع معيار **OpenAI API Standard** (`/v1/chat/completions`)، صُممت خصيصاً لتحويل نماذج **Kimi** و **GLM** من مجرد نماذج شات تقليدية إلى **Autonomous Coding & Research Agents** كاملة القدرات تعمل مع أدوات المطورين مثل **Hermes Desktop, OpenCode, Cursor, LibreChat**.

### المكونات الأساسية | Architecture
| الخدمة | المنفذ (Port) | الوظيفة | Endpoint |
|---|---|---|---|
| **Kimi Agent Middleware** | `8001` | وسيط اعتراض التدفق + محرك حقن الأدوات لـ Kimi | `http://localhost:8001/v1` |
| **Kimi Upstream RPC** | `8000` | اتصال ثنائي فائق السرعة عبر Connect RPC مع Kimi Web | `http://localhost:8000/v1` |
| **GLM Agent Middleware** | `3000` | سيرفر وسيط لـ GLM (DOAI-Proxy) مع ترجمة الأدوات | `http://localhost:3000/v1` |
| **Z.ai Headless Bridge** | `8002` | محرك احتياطي عبر متصفح Edge بدون واجهة (Headless) | `http://localhost:8002/v1` |
| **24/7 Watchdog Manager** | `8099` | مراقبة حية وإعادة تشغيل تلقائي للسيرفرات فور انهيارها | `http://localhost:8099/status` |

---

## 🚀 المميزات الخارقة | Key Features

### 1. محرك اعتراض الأدوات المباشر (Direct Function Call & Balanced Parser)
- يتعرف ويعترض جميع أشكال استدعاء الدوال:
  - `tool_name({"param":"val"})` (Direct Call)
  - `<<<tool_name:{"param":"val"}>>>` (Shorthand JSON)
  - `<tool_name>...</tool_name>` (XML Action format)
  - `TOOL_CALL: name ARGUMENTS: {...}` (Standard Text Format)
- **صمام أمان لمنع التسريب (Anti-Leak Safety Net):** يمنع نهائياً تسريب أي استدعاء أداة كنص محادثة في الشات. إذا لم تكن الأداة مسجلة في واجهة العميل، يتم تحويلها تلقائياً إلى تنفيذ في التيرمينال عبر الـ Bridge.

### 2. محرك قراءة وفحص الفيديو (`read_video`)
- مزود بسكربت فحص محلي فائق السرعة عبر `ffprobe` و `ffmpeg`.
- يستخرج المواصفات الدقيقة: المدة الزمنية، الأبعاد (Resolution)، نسبة العرض (Aspect Ratio)، معدل الإطارات (FPS)، الترميز (Codecs)، وقنوات الصوت.
- يشرح الفيديو ويستخرج لقطات مفتاحية (Keyframes) على فترات متساوية ويحفظها كصور عالية الدقة في الكاش للاستعراض.

### 3. منظومة الرؤية البصرية المجانية الذاتية (`vision_analyze`)
- متصلة بنموذج الرؤية العملاق **NVIDIA Nemotron 3.5 Super-VL (120B)** مجاناً عبر الـ API.
- تتيح للـ Agent فحص أي صورة أو لقطة فيديو واستخراج عناصر الـ UI، النصوص، الألوان، والتخطيطات المعمارية بدقة فائقة.

### 4. البحث واستخراج محتوى الويب (`local_search` & `local_extract`)
- يتيح للـ Agent البحث في الإنترنت وقراءة المقالات والروابط الخارجية حتى لو كانت ميزة التصفح مغلقة في الموقع السحابي.

---

## 🛠️ التثبيت والتشغيل | Installation & Setup

### المتطلبات المسبقة:
- **Node.js**: إصدار 18 فما فوق.
- **Python**: إصدار 3.10 فما فوق.
- **FFmpeg & FFprobe**: (موجودان بالفعل أو مثبتان في النظام).

### الخطوة 1: تثبيت الاعتماديات (Dependencies)
يمكنك تثبيت جميع حزم السيرفرات بضغطة زر واحدة:
```bash
# عبر ملف الباتش المرفق (Windows):
install-all.bat

# أو يدوياً عبر npm:
npm run install:all
```

### الخطوة 2: ضبط الإعدادات والمفاتيح (Configuration)
1. انسخ ملف الإعدادات في مجلد `kimi-agent-server`:
   ```bash
   cp kimi-agent-server/.env.example kimi-agent-server/.env
   ```
2. ضع توكن الـ JWT الخاص بك لـ Kimi في المتغير `STRAICO_API_KEY`.
3. انسخ ملف الإعدادات في مجلد `glm-agent-server`:
   ```bash
   cp glm-agent-server/.env.example glm-agent-server/.env
   ```
4. ضع مفتاح الـ API الخاص بك لـ GLM في المتغير `GLM_API_KEY`.

---

## ▶️ أوامر التشغيل | Running the Servers

### 1. تشغيل جميع السيرفرات مع الـ Watchdog (موصى به - يعمل 24/7):
```bash
# نقرة مزدوجة على:
start-all.bat

# أو من سطر الأوامر:
npm start
```
سيقوم الـ Watchdog بتشغيل السيرفرات الثلاثة معاً ومراقبة حالتها كل 10 ثوانٍ وإعادة تشغيل أي سيرفر فورياً في حال توقفه.

### 2. تشغيل كل سيرفر على حدة (اختياري):
- **سيرفر Kimi:**
  ```bash
  npm run kimi
  ```
- **سيرفر GLM:**
  ```bash
  npm run glm
  ```
- **سيرفر Z.ai:**
  ```bash
  npm run zai
  ```

---

## 🔌 طريقة الربط مع التطبيقات | How to Connect

### 1. الربط مع Hermes Desktop
في ملف الإعدادات الخاص بـ Hermes (`C:\Users\<user>\AppData\Local\hermes\config.yaml`):

```yaml
model:
  default: "kimi-latest"
  provider: "kimi_local"
  base_url: "http://localhost:8001/v1"
  api_mode: "chat_completions"

providers:
  kimi_local:
    name: "Kimi Agent Middleware"
    base_url: "http://localhost:8001/v1"
    api_key: "your_kimi_token"
    api_mode: "chat_completions"
    default_model: "kimi-latest"
    models:
      - "kimi-latest"
      - "kimi-k2-thinking"

  glm_local:
    name: "GLM Agent Middleware"
    base_url: "http://localhost:3000/v1"
    api_key: "your_glm_token"
    api_mode: "chat_completions"
    default_model: "glm-5.2"
    models:
      - "glm-5.2"
      - "glm-5.3"
```

### 2. الربط مع OpenCode / Cursor / Continue.dev
اختر مزود **OpenAI Compatible**:
- **Base URL:** `http://localhost:8001/v1` (لـ Kimi) أو `http://localhost:3000/v1` (لـ GLM)
- **API Key:** أي نص أو التوكن الخاص بك.
- **Model Name:** `kimi-latest` أو `glm-5.2`.

### 3. تجربة الاتصال عبر cURL
```bash
curl http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kimi-latest",
    "messages": [{"role": "user", "content": "read_file({\"path\": \"./package.json\"})"}]
  }'
```

---

## 📦 النشر على GitHub | Publishing to GitHub

تم تجهيز هذا المجلد ليكون مستودع Git جاهزاً للنشر فوراً:

```bash
# 1. الدخول لمجلد المشروع:
cd C:\Users\hhjksd\Desktop\kimi-glm-agent-middleware

# 2. إنشاء مستودع جديد على حسابك في GitHub (مثلاً: kimi-glm-agent-middleware)

# 3. ربط المستودع البعيد:
git remote add origin https://github.com/mortthaallia-bot/kimi-glm-agent-middleware.git

# 4. رفع الكود بالكامل:
git branch -M main
git push -u origin main
```

---

## 📜 الترخيص | License
هذا المشروع مرخص تحت رخصة **MIT License**.
