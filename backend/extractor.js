const cheerio = require('cheerio');
const { URL } = require('url');

function resolveUrl(base, src) {
  if (!src) return null;
  try {
    return new URL(src, base).toString();
  } catch (e) {
    return src;
  }
}

function pickUnique(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!v) continue;
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function normalizeFontFamilyValue(raw) {
  if (!raw) return null;
  const first = String(raw)
    .split(',')[0]
    .replace(/['"]/g, '')
    .trim();
  if (!first) return null;
  const lower = first.toLowerCase();
  if (['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong'].includes(lower)) {
    return null;
  }
  return first;
}

function extractFontFacesFromCss(cssText, baseUrl) {
  const faces = [];
  const seen = new Set();
  const blockRe = /@font-face\s*{([\s\S]*?)}/gi;
  let blockMatch;

  while ((blockMatch = blockRe.exec(cssText))) {
    const block = blockMatch[1] || '';
    const familyMatch = block.match(/font-family\s*:\s*([^;]+);/i);
    const srcMatch = block.match(/src\s*:\s*([^;]+);/i);
    if (!familyMatch || !srcMatch) continue;

    const family = normalizeFontFamilyValue(familyMatch[1]);
    if (!family) continue;

    const weightMatch = block.match(/font-weight\s*:\s*([^;]+);/i);
    const styleMatch = block.match(/font-style\s*:\s*([^;]+);/i);
    const srcText = srcMatch[1] || '';
    const urlRe = /url\(([^)]+)\)(?:\s*format\(([^)]+)\))?/gi;
    let urlMatch;

    while ((urlMatch = urlRe.exec(srcText))) {
      const rawUrl = String(urlMatch[1] || '').trim().replace(/^['"]|['"]$/g, '');
      if (!rawUrl) continue;

      const resolvedUrl = resolveUrl(baseUrl, rawUrl);
      if (!resolvedUrl) continue;

      const key = `${family}::${resolvedUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const format = (urlMatch[2] || '').replace(/['"]/g, '').trim() || null;
      faces.push({
        family,
        url: resolvedUrl,
        format,
        weight: weightMatch ? weightMatch[1].trim() : null,
        style: styleMatch ? styleMatch[1].trim() : null
      });

      break;
    }
  }

  return faces;
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  }
}

function extractCssImportUrls(cssText) {
  const urls = [];
  const importRe = /@import\s+(?:url\()?['"]?([^'"\)\s;]+)['"]?\)?[^;]*;/gi;
  let match;
  while ((match = importRe.exec(cssText))) {
    const raw = (match[1] || '').trim();
    if (raw) urls.push(raw);
  }
  return urls;
}

async function fetchCssWithImports(url, options = {}) {
  const { seen = new Set(), depth = 0, maxDepth = 2 } = options;
  if (!url || seen.has(url) || depth > maxDepth) return [];
  seen.add(url);

  const cssText = await fetchText(url);
  if (!cssText) return [];

  const out = [{ url, cssText }];
  const importUrls = extractCssImportUrls(cssText);
  for (const rawImportUrl of importUrls) {
    const resolvedImportUrl = resolveUrl(url, rawImportUrl);
    if (!resolvedImportUrl || seen.has(resolvedImportUrl)) continue;
    const nested = await fetchCssWithImports(resolvedImportUrl, { seen, depth: depth + 1, maxDepth });
    out.push(...nested);
  }

  return out;
}

function guessFontMimeType(url, contentType) {
  const cleanContentType = (contentType || '').split(';')[0].trim().toLowerCase();
  if (cleanContentType) return cleanContentType;

  const lower = String(url || '').toLowerCase();
  if (lower.includes('.woff2')) return 'font/woff2';
  if (lower.includes('.woff')) return 'font/woff';
  if (lower.includes('.ttf')) return 'font/ttf';
  if (lower.includes('.otf')) return 'font/otf';
  if (lower.includes('.eot')) return 'application/vnd.ms-fontobject';
  if (lower.includes('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

async function fetchFontDataUri(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    const mime = guessFontMimeType(url, res.headers.get('content-type'));
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (e) {
    return null;
  }
}

function extractFontFamiliesFromCss(cssText) {
  const families = new Set();
  // match font-family: ...; and @font-face { font-family: ... }
  const re = /font-family\s*:\s*([^;\{]+)/gi;
  let m;
  while ((m = re.exec(cssText))) {
    const family = normalizeFontFamilyValue(m[1]);
    if (family) families.add(family);
  }
  // @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
  const googleRe = /family=([^:&\)\n\r\"]+)/gi;
  while ((m = googleRe.exec(cssText))) {
    let family = null;
    try { family = decodeURIComponent(m[1]); } catch { family = m[1]; }
    family = normalizeFontFamilyValue(family);
    if (family) families.add(family);
  }
  return Array.from(families).slice(0, 8);
}

function extractColorsFromCssText(cssText) {
  const colors = new Set();
  // hex colors
  const hexRe = /#([0-9a-fA-F]{3,8})\b/g;
  let m;
  while ((m = hexRe.exec(cssText))) colors.add('#' + m[1]);

  // rgb/rgba
  const rgbRe = /rgba?\([^\)]+\)/gi;
  while ((m = rgbRe.exec(cssText))) colors.add(m[0]);

  // basic named colors (simple heuristic)
  const namedRe = /:\s*(black|white|red|green|blue|orange|yellow|purple|gray|grey|teal|pink)\b/gi;
  while ((m = namedRe.exec(cssText))) colors.add(m[1]);

  return Array.from(colors).slice(0, 12);
}

async function extractFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  const title = ($('title').first().text() || '').trim();

  const description = (
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content') ||
    ''
  ).trim();

  const ogImage = (
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    null
  );

  const icons = [];
  $('link[rel~="icon"]').each((i, el) => {
    const href = $(el).attr('href');
    if (href) icons.push(resolveUrl(baseUrl, href));
  });
  $('link[rel~="apple-touch-icon"]').each((i, el) => {
    const href = $(el).attr('href');
    if (href) icons.push(resolveUrl(baseUrl, href));
  });

  // images
  const topImgs = [];
  $('img').slice(0, 12).each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
    if (src) topImgs.push(resolveUrl(baseUrl, src));
  });

  const ogs = ogImage ? [resolveUrl(baseUrl, ogImage)] : [];
  const images = pickUnique(ogs.concat(topImgs)).slice(0, 12);

  // typography and colors: gather from inline styles, <style> tags, and external stylesheets
  const fonts = new Set();
  const fontFaces = [];
  const fontFaceSeen = new Set();
  const colors = new Set();
  const colorCounts = Object.create(null);

  function addFontFacesFromCss(cssText, cssBaseUrl) {
    for (const face of extractFontFacesFromCss(cssText, cssBaseUrl)) {
      const key = `${face.family}::${face.url}`;
      if (fontFaceSeen.has(key)) continue;
      fontFaceSeen.add(key);
      fontFaces.push(face);
      fonts.add(face.family);
    }
  }

  // helpers: parse/normalize colors, detect neutral/transparent
  function clamp(v, a=0, b=255){ return Math.max(a, Math.min(b, v)); }
  function hexFromRgb(r,g,b){
    return '#'+[r,g,b].map(v=>clamp(Math.round(v)).toString(16).padStart(2,'0')).join('').toLowerCase();
  }
  function parseHex(s){
    const h = s.replace('#','').trim();
    if (h.length===3) return [parseInt(h[0]+h[0],16), parseInt(h[1]+h[1],16), parseInt(h[2]+h[2],16), 1];
    if (h.length===4) return [parseInt(h[0]+h[0],16), parseInt(h[1]+h[1],16), parseInt(h[2]+h[2],16), parseInt(h[3]+h[3],16)/255];
    if (h.length===6) return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16),1];
    if (h.length===8) return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16), parseInt(h.slice(6,8),16)/255];
    return null;
  }
  function parseRgbFunc(s){
    // matches rgb(a) numbers and percentages
    const nums = s.replace(/rgba?|\(|\)|%/gi,'').split(',').map(x=>x.trim()).filter(Boolean);
    if (!nums.length) return null;
    let r = parseFloat(nums[0]), g = parseFloat(nums[1]||r), b = parseFloat(nums[2]||r), a = 1;
    if (s.includes('%')) {
      // convert percentages to 0-255
      r = Math.round(r*2.55); g = Math.round(g*2.55); b = Math.round(b*2.55);
    }
    if (nums[3]!=null) a = parseFloat(nums[3]);
    return [r,g,b,a];
  }
  function rgbToLuminance(r,g,b){
    const srgb = [r,g,b].map(v=>{ v = v/255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); });
    return 0.2126*srgb[0] + 0.7152*srgb[1] + 0.0722*srgb[2];
  }
  function rgbToSaturation(r,g,b){
    r/=255; g/=255; b/=255; const max=Math.max(r,g,b), min=Math.min(r,g,b);
    if (max===min) return 0; const l=(max+min)/2; const d=max-min; return d / (1 - Math.abs(2*l-1));
  }
  function parseColorString(raw){
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase();
    if (s==='transparent') return { transparent: true };
    let rgba = null;
    if (s.startsWith('#')) rgba = parseHex(s);
    else if (s.startsWith('rgb')) rgba = parseRgbFunc(s);
    else {
      // simple named colors map for common names
      const named = { black:'#000000', white:'#ffffff', red:'#ff0000', green:'#008000', blue:'#0000ff', gray:'#808080', grey:'#808080' };
      if (named[s]) rgba = parseHex(named[s]);
    }
    if (!rgba) return null;
    const [r,g,b,a=1] = rgba;
    return { r, g, b, a, hex: hexFromRgb(r,g,b), luminance: rgbToLuminance(r,g,b), saturation: rgbToSaturation(r,g,b), transparent: a===0 };
  }

  function countColor(col) {
    if (!col) return;
    const parsed = parseColorString(col);
    if (!parsed) return;
    // ignore fully transparent
    if (parsed.transparent) return;

    // ignore near-white / near-black neutrals from main scoring
    const NEUTRAL_L_LOW = 0.05; // near black
    const NEUTRAL_L_HIGH = 0.95; // near white
    const MIN_SATURATION = 0.08; // require saturation to be considered non-neutral

    const isNeutral = parsed.luminance < NEUTRAL_L_LOW || parsed.luminance > NEUTRAL_L_HIGH || parsed.saturation < MIN_SATURATION;

    const key = parsed.hex;

    // track neutrals separately but do not add to main counts unless explicit
    if (isNeutral) {
      // store but don't increment main score; keep in colors set for palette visibility
      colors.add(key);
      // keep a separate neutral count to use as fallback
      colorCounts['__neutral__:'+key] = (colorCounts['__neutral__:'+key] || 0) + 1;
      return;
    }

    colorCounts[key] = (colorCounts[key] || 0) + 1;
    colors.add(key);
  }

  // inline styles
  // scan inline styles and attribute-based font info, track colors and fonts per context
  $('[style]').each((i, el) => {
    const style = $(el).attr('style') || '';
    const m = style.match(/font-family:\s*([^;\"']+)/i);
    if (m && m[1]) {
      const family = normalizeFontFamilyValue(m[1]);
      if (family) fonts.add(family);
    }

    const colorMatch = style.match(/color:\s*([^;;]+)/i);
    if (colorMatch && colorMatch[1]) countColor(colorMatch[1].trim());
    const bgMatch = style.match(/background(?:-color)?:\s*([^;;]+)/i);
    if (bgMatch && bgMatch[1]) countColor(bgMatch[1].trim());
  });

  // collect font-family from heading tags specifically and body tags
  const headingFonts = new Map();
  const bodyFonts = new Map();
  $('h1,h2,h3,h4,h5,h6').each((i, el) => {
    const style = $(el).attr('style') || '';
    const m = style.match(/font-family:\s*([^;\"']+)/i);
    if (m && m[1]) {
      const f = normalizeFontFamilyValue(m[1]);
      if (!f) return;
      headingFonts.set(f, (headingFonts.get(f) || 0) + 1);
      fonts.add(f);
    }
  });
  $('p,div,span').slice(0, 200).each((i, el) => {
    const style = $(el).attr('style') || '';
    const m = style.match(/font-family:\s*([^;\"']+)/i);
    if (m && m[1]) {
      const f = normalizeFontFamilyValue(m[1]);
      if (!f) return;
      bodyFonts.set(f, (bodyFonts.get(f) || 0) + 1);
      fonts.add(f);
    }
  });

  // style tags
  const styleTexts = [];
  $('style').each((i, el) => {
    const t = $(el).text() || '';
    styleTexts.push(t);
    for (const f of extractFontFamiliesFromCss(t)) fonts.add(f);
    addFontFacesFromCss(t, baseUrl);
    for (const c of extractColorsFromCssText(t)) countColor(c);
  });

  // external stylesheets
  const cssHrefs = [];
  $('link[rel="stylesheet"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href) cssHrefs.push(resolveUrl(baseUrl, href));
    if (href.includes('fonts.googleapis.com')) {
      const m = href.match(/family=([^:&]+)/);
      if (m && m[1]) {
        let family = null;
        try { family = decodeURIComponent(m[1]); } catch { family = m[1]; }
        family = normalizeFontFamilyValue(family);
        if (family) fonts.add(family);
      }
    }
  });

  // fetch and parse external CSS (best-effort), including nested @import chains
  for (const href of cssHrefs.slice(0, 6)) {
    const cssDocs = await fetchCssWithImports(href, { maxDepth: 2 });
    for (const cssDoc of cssDocs) {
      const cssText = cssDoc && cssDoc.cssText ? cssDoc.cssText : '';
      const cssUrl = cssDoc && cssDoc.url ? cssDoc.url : href;
      if (!cssText) continue;
      for (const f of extractFontFamiliesFromCss(cssText)) fonts.add(f);
      addFontFacesFromCss(cssText, cssUrl);
      for (const c of extractColorsFromCssText(cssText)) countColor(c);
    }
  }

  // detect colors used in buttons/cta elements and header/hero to boost scores
  const buttonSelectors = 'button, a[class*="btn"], [class*="btn"], [class*="cta"], [class*="button"]';
  $(buttonSelectors).each((i, el) => {
    const s = $(el).attr('style') || '';
    const m = s.match(/background(?:-color)?:\s*([^;;]+)/i) || s.match(/color:\s*([^;;]+)/i);
    if (m && m[1]) countColor(m[1].trim());
  });

  // hero/header area boost
  $('[class*="hero"], header').each((i, el) => {
    const s = $(el).attr('style') || '';
    const m = s.match(/background(?:-color)?:\s*([^;;]+)/i) || s.match(/color:\s*([^;;]+)/i);
    if (m && m[1]) countColor(m[1].trim());
  });

  const typography = [];
  // pick heading and body fonts by frequency
  if (headingFonts.size) {
    const sortedH = Array.from(headingFonts.entries()).sort((a, b) => b[1] - a[1]);
    typography.push({ role: 'heading', font: sortedH[0][0] });
  }
  if (bodyFonts.size) {
    const sortedB = Array.from(bodyFonts.entries()).sort((a, b) => b[1] - a[1]);
    typography.push({ role: 'body', font: sortedB[0][0] });
  }
  // fallback to fonts from CSS detection
  if (!typography.length) {
    const allFonts = Array.from(fonts);
    if (allFonts.length) {
      typography.push({ role: 'heading', font: allFonts[0] });
      if (allFonts[1]) typography.push({ role: 'body', font: allFonts[1] });
    }
  }

  const typographyFamilies = new Set(
    typography
      .map(item => normalizeFontFamilyValue(item && item.font))
      .filter(Boolean)
  );

  const selectedFontFaces = typographyFamilies.size
    ? fontFaces.filter(face => typographyFamilies.has(face.family)).slice(0, 6)
    : fontFaces.slice(0, 6);

  for (const face of selectedFontFaces) {
    face.dataUri = await fetchFontDataUri(face.url);
  }

  // build palette and pick primary/secondary/tertiary by score
  const palette = Array.from(colors).slice(0, 24);
  // compute scores for non-neutral colors
  const scored = palette.map(c => ({ color: c, score: colorCounts[c] || 0, neutralScore: colorCounts['__neutral__:'+c] || 0 }));
  // prefer higher real scores first
  scored.sort((a, b) => b.score - a.score || b.neutralScore - a.neutralScore);

  // collect top non-neutral winners
  const winners = scored.filter(s => s.score > 0).map(s => s.color);

  // if we don't have enough (3), consider neutral colors by their neutralScore
  if (winners.length < 3) {
    const neutrals = scored.filter(s => s.neutralScore > 0).sort((a,b)=>b.neutralScore - a.neutralScore).map(s=>s.color);
    for (const n of neutrals) {
      if (winners.length >= 3) break;
      if (!winners.includes(n)) winners.push(n);
    }
  }

  // final fallback: include any palette colors (even with zero score) to fill up to 3
  for (const s of scored.map(x=>x.color)) {
    if (winners.length >= 3) break;
    if (!winners.includes(s)) winners.push(s);
  }

  const primary = winners[0] || null;
  const secondary = winners[1] || null;
  const tertiary = winners[2] || null;

  return {
    title,
    description,
    icons: pickUnique(icons).slice(0, 6),
    ogImages: ogs,
    images,
    typography,
    fontFaces: selectedFontFaces,
    colors: { primary, secondary, tertiary, palette }
  };
}

module.exports = { extractFromHtml, fetchFontDataUri };
