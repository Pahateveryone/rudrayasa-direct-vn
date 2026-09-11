# Rudrayasa Direct VN v5 — Render Free

Stack:

- Render Free Web Service
- MongoDB Atlas Free M0
- whatsapp-web.js RemoteAuth
- FFmpeg
- Chromium headless
- Basic Authentication
- Mobile/iPhone UI

## Environment variables

Set on Render:

```text
MONGODB_URI=mongodb+srv://...
APP_USER=rudrayasa
APP_PASSWORD=PASSWORD_PANJANG_ANDA
SESSION_NAME=rudrayasa-main
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
NODE_OPTIONS=--max-old-space-size=192
```

## Important

Render Free sleeps after inactivity and its local filesystem is ephemeral.
WhatsApp session is therefore stored in MongoDB Atlas through RemoteAuth.

First access after a sleep can take around a minute, plus WhatsApp restore time.

## Security

The whole application except `/healthz` is protected using HTTP Basic Auth.
Use a strong APP_PASSWORD and never place credentials in GitHub.

## Deployment

See the conversation guide for:

1. MongoDB Atlas Free cluster.
2. GitHub repository.
3. Render Blueprint/Web Service.
4. Environment variables.
5. WhatsApp pairing.
6. iPhone usage.
