# Brand Extractor Service

Minimal Node.js service that accepts a JSON POST to `/extract` with `{ "url": "https://example.com" }` and returns parsed brand signals.

Quick start

```bash
cd backend
npm install
npm start
```

Request example

```bash
curl -X POST http://localhost:7777/extract -H 'Content-Type: application/json' -d '{"url":"https://stripe.com"}'
```

Response shape

```
{ ok: true, url: "https://...", data: { title, description, icons: [], ogImages: [], logos: [], images: [], typography: [] } }
```

Notes

- This is a minimal server for MVP use. For JS-heavy sites, add a Puppeteer/Playwright fallback to render the page before scraping.
- The service can optionally generate a hero image server-side when `HF_TOKEN` and either `HF_IMAGE_ENDPOINT` or `HF_IMAGE_MODEL` are configured in `backend/.env`.
- Copy `backend/.env.example` to `backend/.env` and fill in secrets on the server only; never put keys in the Chrome extension.
- Consider caching results server-side for production and adding URL validation and rate limiting.
