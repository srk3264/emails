const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { extractFromHtml, fetchFontDataUri } = require('./extractor');
let playwright = null;
try { playwright = require('playwright'); } catch (e) { /* optional */ }

function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) continue;

      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if (!key) continue;

      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (process.env[key] == null || process.env[key] === '') {
        process.env[key] = value;
      }
    }
  } catch (err) {
    console.warn(`failed to load env file ${filePath}: ${err.message}`);
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const IMAGE_PROVIDER_URL = process.env.OPENROUTER_IMAGE_ENDPOINT || process.env.IMAGE_PROVIDER_URL || '';
const IMAGE_PROVIDER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.IMAGE_PROVIDER_API_KEY || '';
const IMAGE_PROVIDER_MODEL = process.env.OPENROUTER_IMAGE_MODEL || process.env.IMAGE_PROVIDER_MODEL || '';

function ensureHttp(url) {
  try {
    new URL(url);
    return url;
  } catch (e) {
    return 'https://' + url.replace(/^\/+/, '');
  }
}

function formatAspectRatio(ratio) {
  const value = Number(ratio);
  if (!Number.isFinite(value) || value <= 0) return '16:9';
  return `${Math.round(value * 100) / 100}:1`;
}

function normalizeFontFamily(value) {
  if (!value) return '';
  const first = String(value).split(',')[0].replace(/["']/g, '').trim();
  if (!first) return '';
  const lower = first.toLowerCase();
  if (['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong'].includes(lower)) {
    return '';
  }
  return first;
}

function colorToSwatches(colors) {
  if (!colors) return [];
  const palette = [];
  if (colors.primary) palette.push(colors.primary);
  if (colors.secondary) palette.push(colors.secondary);
  if (colors.tertiary) palette.push(colors.tertiary);
  if (Array.isArray(colors.palette)) {
    for (const color of colors.palette) {
      if (color) palette.push(color);
    }
  }
  return palette.slice(0, 6);
}

function buildHeroImagePrompt(data) {
  const title = data && data.title ? String(data.title) : 'Untitled brand';
  const description = data && data.description ? String(data.description) : '';
  const colors = colorToSwatches(data && data.colors);
  const heading = normalizeFontFamily(data && data.typography && data.typography[0] && data.typography[0].font) || 'unknown';
  const body = normalizeFontFamily(data && data.typography && data.typography[1] && data.typography[1].font) || 'unknown';
  const logo = Array.isArray(data && data.icons) && data.icons[0] ? data.icons[0] : '';
  const ogImage = Array.isArray(data && data.ogImages) && data.ogImages[0] ? data.ogImages[0] : '';
  const aspectRatio = formatAspectRatio(data && data.heroAspectRatio);

  return [
    `Create a premium editorial hero image for the brand "${title}".`,
    description ? `Brand description: ${description}.` : '',
    colors.length ? `Brand colors: ${colors.join(', ')}.` : '',
    `Typography cues: heading font ${heading}, body font ${body}.`,
    logo ? `Logo reference URL: ${logo}.` : '',
    ogImage ? `Use the open graph image as visual inspiration: ${ogImage}.` : '',
    `Match an aspect ratio of ${aspectRatio}.`,
    'Keep the composition clean, modern, brand-safe, and high contrast. Avoid adding readable text unless absolutely necessary.'
  ].filter(Boolean).join(' ');
}

async function generateHeroImage(data) {
  if (!IMAGE_PROVIDER_URL || !IMAGE_PROVIDER_API_KEY) {
    return null;
  }

  const prompt = buildHeroImagePrompt(data);

  try {
    const response = await fetch(IMAGE_PROVIDER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${IMAGE_PROVIDER_API_KEY}`,
        ...(IMAGE_PROVIDER_MODEL ? { 'X-Model': IMAGE_PROVIDER_MODEL } : {})
      },
      body: JSON.stringify({
        prompt,
        aspectRatio: formatAspectRatio(data && data.heroAspectRatio),
        title: data && data.title ? data.title : null,
        description: data && data.description ? data.description : null,
        ogImage: Array.isArray(data && data.ogImages) ? data.ogImages[0] || null : null,
        colors: data && data.colors ? data.colors : null,
        typography: data && data.typography ? data.typography : null
      })
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const imageUrl = payload && (payload.imageUrl || payload.url || (payload.data && (payload.data.imageUrl || payload.data.url)));
    return typeof imageUrl === 'string' && imageUrl ? imageUrl : null;
  } catch (err) {
    console.warn(`hero image generation skipped: ${err.message}`);
    return null;
  }
}

app.post('/generate-image', async (req, res) => {
  const data = req.body && typeof req.body === 'object' ? req.body : {};
  const prompt = data.prompt || buildHeroImagePrompt(data);
  const imageUrl = await generateHeroImage(data);

  return res.json({
    ok: true,
    configured: Boolean(IMAGE_PROVIDER_URL && IMAGE_PROVIDER_API_KEY),
    prompt,
    imageUrl
  });
});

app.post('/extract', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'missing url in body' });
  }

  const fetchUrl = ensureHttp(url.trim());

  try {
    const resp = await fetch(fetchUrl, { redirect: 'follow' });
    if (!resp.ok) {
      return res.status(502).json({ error: 'failed to fetch target site', status: resp.status });
    }

    const html = await resp.text();
    let data = await extractFromHtml(html, resp.url || fetchUrl);

    // If no fonts/typography were found and Playwright is available, render and retry
    if (playwright && ( !data || !Array.isArray(data.fontFaces) || data.fontFaces.length === 0 || !data.typography || data.typography.length === 0 )) {
      try {
        const browser = await playwright.chromium.launch({ args: ['--no-sandbox'], headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(fetchUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(500);
        // inspect runtime stylesheets and document.fonts to capture JS-injected @font-face rules
        const pageFontInfo = await page.evaluate(() => {
          const out = [];
          try {
            for (const sheet of Array.from(document.styleSheets || [])) {
              try {
                const rules = Array.from(sheet.cssRules || []);
                for (const rule of rules) {
                  // CSSFontFaceRule
                  if (rule.type === CSSRule.FONT_FACE_RULE) {
                    const family = rule.style.getPropertyValue('font-family') || '';
                    const src = rule.style.getPropertyValue('src') || '';
                    const weight = rule.style.getPropertyValue('font-weight') || '';
                    const style = rule.style.getPropertyValue('font-style') || '';
                    out.push({ family, src, weight, style });
                  }
                }
              } catch (e) {
                // ignore cross-origin stylesheets
              }
            }
          } catch (e) {}
          try {
            for (const f of document.fonts || []) {
              try { out.push({ family: f.family || '', weight: f.weight || '', style: f.style || '' }); } catch (e) {}
            }
          } catch (e) {}
          return out;
        });

        const renderedHtml = await page.content();
        await browser.close();
        const renderedData = await extractFromHtml(renderedHtml, resp.url || fetchUrl);
        if (renderedData) {
          if (Array.isArray(renderedData.fontFaces) && renderedData.fontFaces.length > 0) data.fontFaces = renderedData.fontFaces;
          if (Array.isArray(renderedData.typography) && renderedData.typography.length > 0) data.typography = renderedData.typography;
        }

        // parse runtime pageFontInfo for explicit URLs and merge
        if (Array.isArray(pageFontInfo) && pageFontInfo.length) {
          const seen = new Set((data.fontFaces || []).map(f => `${f.family}::${f.url}`));
          for (const pf of pageFontInfo) {
            const src = (pf && pf.src) || '';
            const fam = (pf && pf.family) || '';
            if (src) {
              const urlRe = /url\(([^)]+)\)\s*(?:format\(([^)]+)\))?/gi;
              let m;
              while ((m = urlRe.exec(src))) {
                let raw = (m[1] || '').trim().replace(/^['"]|['"]$/g, '');
                if (!raw) continue;
                try { raw = new URL(raw, fetchUrl).toString(); } catch (e) {}
                const fmt = (m[2] || '').replace(/['"]/g, '').trim() || null;
                const key = `${fam}::${raw}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const face = { family: fam.replace(/['"]/g, '').trim(), url: raw, format: fmt, weight: pf.weight || null, style: pf.style || null };
                try {
                  face.dataUri = await fetchFontDataUri(face.url);
                } catch (e) { face.dataUri = null; }
                data.fontFaces = data.fontFaces || [];
                data.fontFaces.push(face);
              }
            }
          }
        }
      } catch (e) {
        // ignore playwright errors and continue with static data
      }
    }

    const generatedHeroImageUrl = await generateHeroImage(data);
    if (generatedHeroImageUrl) {
      data.generatedHeroImageUrl = generatedHeroImageUrl;
    }

    return res.json({ ok: true, url: resp.url || fetchUrl, data });
  } catch (err) {
    return res.status(500).json({ error: 'extractor error', message: err.message });
  }
});

app.get('/', (req, res) => res.send('Brand extractor running. POST /extract with {"url":"..."}'));

const port = process.env.PORT || 7777;
app.listen(port, () => {
  console.log(`brand extractor listening on http://localhost:${port}`);
});
