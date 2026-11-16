# Netlify Deployment Guide - FitGear Pakistan

This guide explains how your unified frontend and backend are deployed to Netlify using **Netlify Functions** and **Node.js 22 native SQLite (`node:sqlite`)**.

---

## 🏗️ Architecture Overview

| Component | Technology | Hosting on Netlify |
| :--- | :--- | :--- |
| **Frontend** | HTML5, CSS3, Vanilla JavaScript | High-speed Global Edge CDN (`publish = "."`) |
| **Backend API** | Node.js 22 Serverless Router | Serverless Functions (`netlify/functions/api.js`) |
| **Database (Cloud)** | Turso LibSQL (`@libsql/client`) | Remote serverless SQLite over HTTP/WebSockets |
| **Database (Local)** | Native SQLite (`node:sqlite DatabaseSync`) | Packaged file / zero-dependency local dev (`node server.js`) |
| **API Proxy** | Netlify Edge Redirects | `/api/*` ➡️ `/.netlify/functions/api/:splat` |
| **Authentication** | Cryptographic HMAC-SHA256 Stateless Tokens | Works across all serverless cold starts & instances |

---

## 🚀 How to Deploy to Netlify

### Option 1: Automatic Deployment via Git (Recommended)

1. **Commit and push** your files to your GitHub / GitLab repository:
   ```bash
   git add .
   git commit -m "Migrate FitGear Pakistan backend and frontend to Netlify Functions"
   git push origin main
   ```

2. **Connect to Netlify**:
   - Go to [app.netlify.com](https://app.netlify.com).
   - Click **"Add new site"** > **"Import an existing project"**.
   - Select your Git provider and repository.

3. **Verify Build Settings** (Netlify auto-detects `netlify.toml`):
   - **Base directory**: *(leave empty)*
   - **Build command**: `node -v` (or `npm run build`)
   - **Publish directory**: `.`
   - **Functions directory**: `netlify/functions`

4. **Add Environment Variables** (*Site configuration > Environment variables*):
   - `NODE_VERSION` = `22` (also pinned in `.nvmrc`)
   - `SESSION_SECRET` = `fitgear_pk_super_secret_session_2026` *(or custom string)*
   - `ADMIN_NAME` = `Admin FitGear`
   - `ADMIN_EMAIL` = `admin@fitgear.pk`
   - `ADMIN_PASSWORD` = `admin123` *(change to your secure admin password)*
   - *(Optional)* JazzCash / EasyPaisa credentials if accepting online cards/wallets.

5. Click **"Deploy site"**. Netlify will deploy your static frontend and functions in seconds!

---

### Option 2: Deploy via Netlify CLI

If you have Netlify CLI installed:
```bash
# Login to your Netlify account
npx netlify login

# Link or initialize site
npx netlify init

# Deploy to production
npx netlify deploy --prod
```

---

## 💻 Local Development Options

### Method A: Standalone Node.js Server (Port 3000)
Runs your frontend and backend on the unified Node.js server:
```bash
npm start
# Server live at http://localhost:3000
```

### Method B: Netlify CLI Emulation (Port 8888)
Emulates Netlify Functions and edge routing locally:
```bash
npx netlify dev
# Live at http://localhost:8888
```

### Method C: Run Migration Tests
Verifies database integrity, auth, orders, and functions:
```bash
npm test
```

---

## 🔒 Notes on Serverless SQLite (`node:sqlite`)
- Netlify Functions execute inside AWS Lambda serverless containers. In Lambda, the deployment directory is read-only, but `/tmp` is fully writable.
- On cold start, the database engine automatically detects the serverless environment and copies your packaged `fitgear.sqlite` to `/tmp/fitgear.sqlite` (or creates and seeds it if empty).
- The authentication system uses stateless cryptographic HMAC tokens so user logins persist seamlessly across cold starts and multiple container instances.
- If you need persistent multi-region cloud database synchronization across long periods of inactivity in the future, you can point to a remote database (e.g. Turso LibSQL or Supabase) with zero changes to your frontend.
