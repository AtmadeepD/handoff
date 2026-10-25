# HANDOFF — M1

Single-service architecture: Node.js + TypeScript + Express + Socket.IO. Vite builds the browser client into `dist/public`; the same Node process serves the static client, `/health`, and Socket.IO.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The M1 integration test is `npm test` and the production build is `npm run build`.

## Production

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Health check path: `/health`
- Node version: 20 or newer
- No database: rooms exist in process memory and expire after 30 minutes without activity. A host restart clears all rooms.

## GitHub + Render deployment

1. Sign in to GitHub as **AtmadeepD**. Open `https://github.com/new`.
2. Repository name: `handoff`. Choose **Private** or **Public** as you prefer. Do not add a README, `.gitignore`, or license (this project already includes them). Click **Create repository**.
3. On your Mac, unzip the project, open Terminal in the `handoff` folder, then run:

   ```bash
   git init
   git add .
   git commit -m "Build HANDOFF M1 lobby"
   git branch -M main
   git remote add origin https://github.com/AtmadeepD/handoff.git
   git push -u origin main
   ```

   If Git asks you to authenticate, use GitHub CLI (`gh auth login`) or Git Credential Manager. Do not put a personal access token directly in the remote URL.
4. Sign in to Render at `https://render.com` and choose **New +** → **Web Service**.
5. Connect GitHub if asked, then select `AtmadeepD/handoff`. If it is not listed, choose the GitHub connection's repository access settings and grant access to `handoff`.
6. Set **Name** to `handoff`; **Runtime** to `Node`; **Branch** to `main`; **Build Command** to `npm install && npm run build`; **Start Command** to `npm start`; **Instance Type** to the free instance if offered.
7. Leave the port setting to the platform default. The app reads `PORT` from the environment and binds to `0.0.0.0`.
8. Click **Create Web Service** and wait for the deploy to finish. Open the generated `https://...onrender.com` URL.
9. Open `https://YOUR-SERVICE.onrender.com/health`. A healthy response looks like `{"ok":true,"service":"handoff","rooms":0,"uptimeSeconds":...}`.
10. Test on two devices: create a room on Device A; scan the QR on Device B; confirm both names appear; refresh Device B and confirm it returns to the room; try a bogus code and confirm a readable error.

## Free-host wake-up

A free service may sleep after inactivity. Before a session, open the service URL or `/health` and wait for a successful JSON response, then create/join the room. The first request can take a little while while the service wakes. Do not create a room until the service has responded. Rooms are in-memory and disappear after a restart/deploy, or after 30 minutes idle.

## Current M1 scope

The lobby and room plumbing are implemented. The Start Shift button is intentionally disabled until M2 adds the actual simulation. Gameplay, full browser automation, and M2–M7 are not included in this milestone.
