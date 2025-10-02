/*
  Vercel Serverless Function: Publish Google Doc as blog post
  - Auth: Bearer ADMIN_SECRET
  - Input JSON: { docUrl, title?, date?, slug? }
  - Env: ADMIN_SECRET, GOOGLE_SERVICE_ACCOUNT_KEY (JSON), GITHUB_TOKEN, GITHUB_REPO (owner/repo), GITHUB_BRANCH
*/

const { GoogleAuth } = require('google-auth-library');
const sanitizeHtml = require('sanitize-html');
const cheerio = require('cheerio');

const GITHUB_API_BASE = 'https://api.github.com';

function response(res, status, body) {
  res.status(status).json(body);
}

function assertEnv(res, name) {
  if (!process.env[name]) {
    response(res, 500, { error: `Missing env var: ${name}` });
    return false;
  }
  return true;
}

function slugify(input) {
  return (input || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'post';
}

function fmtDateDisplay(d) {
  const dt = new Date(d);
  const opts = { year: 'numeric', month: 'long', day: '2-digit' };
  // Ensure 2-digit day without locale quirks
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(dt);
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const year = parts.find(p => p.type === 'year').value;
  return `${month} ${day}, ${year}`;
}

function toISODate(d) {
  if (!d) return new Date().toISOString();
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return new Date().toISOString();
  return dt.toISOString();
}

async function getAccessToken() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return typeof token === 'string' ? token : token.token;
}

function extractDocId(url) {
  if (!url) return null;
  // Typical Doc URL: https://docs.google.com/document/d/<DOCID>/edit
  const m = url.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

async function driveGetMeta(fileId, accessToken) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,createdTime,modifiedTime`; 
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Drive meta error ${r.status}`);
  return r.json();
}

async function driveExportHtml(fileId, accessToken) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/html`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Drive export error ${r.status}`);
  return r.text();
}

function sanitizeContent(html) {
  return sanitizeHtml(html, {
    allowedTags: [
      'p','br','strong','em','ul','ol','li','a','img','blockquote','hr',
      'h1','h2','h3','h4','h5','h6','pre','code','figure','figcaption',
      'table','thead','tbody','tr','th','td','span','div'
    ],
    allowedAttributes: {
      a: ['href','name','target','rel'],
      img: ['src','alt'],
      '*': ['style']
    },
    allowedSchemes: ['http','https','mailto'],
    transformTags: {
      a: (tagName, attribs) => {
        if (attribs.href && attribs.href.startsWith('javascript:')) {
          return { tagName: 'span', attribs: {} };
        }
        // force rel for external links
        if (attribs.href && attribs.href.startsWith('http')) {
          attribs.rel = 'noopener noreferrer';
          attribs.target = '_blank';
        }
        return { tagName, attribs };
      }
    }
  });
}

async function githubGet(path, ref) {
  const repo = process.env.GITHUB_REPO; // owner/repo
  const url = `${GITHUB_API_BASE}/repos/${repo}/contents/${encodeURIComponent(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'User-Agent': 'vercel-function',
      Accept: 'application/vnd.github+json',
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  return r.json();
}

async function githubPut(path, contentBase64, message, sha) {
  const repo = process.env.GITHUB_REPO; // owner/repo
  const branch = process.env.GITHUB_BRANCH || 'main';
  const url = `${GITHUB_API_BASE}/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: contentBase64,
    branch,
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'User-Agent': 'vercel-function',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`GitHub PUT ${path} ${r.status}: ${txt}`);
  }
  return r.json();
}

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}
function b64bin(buf) {
  return Buffer.from(buf).toString('base64');
}

function extractFirstParagraph($) {
  const p = $('p').filter((i, el) => $(el).text().trim().length > 0).first();
  const text = p.text().trim();
  if (!text) return '';
  return text.length > 220 ? text.slice(0, 217) + '...' : text;
}

function sanitizeFilename(name) {
  return (name || 'file').replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function downloadAndRewriteImages($, accessToken, slug) {
  const images = [];
  let counter = 1;
  await Promise.all($('img').map((i, img) => (async () => {
    const src = $(img).attr('src');
    if (!src) return;
    try {
      const r = await fetch(src, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`img ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      let ext = '.png';
      if (ct.includes('jpeg')) ext = '.jpg';
      else if (ct.includes('webp')) ext = '.webp';
      else if (ct.includes('gif')) ext = '.gif';
      // Prefer a readable filename from URL if present
      const urlName = sanitizeFilename((new URL(src)).pathname.split('/').pop());
      const filename = urlName && urlName.includes('.') ? urlName : `img-${counter++}${ext}`;
      const bin = Buffer.from(await r.arrayBuffer());
      images.push({ filename, data: bin });
      // rewrite src
      $(img).attr('src', `../images/blog/${slug}/${filename}`);
      // remove heavy attrs
      $(img).removeAttr('srcset').removeAttr('sizes').removeAttr('loading');
    } catch (e) {
      // leave original src if download fails
    }
  })()).get());
  return images; // array of {filename, data}
}

function buildPostHtml({ title, dateDisplay, contentHtml }) {
  const head = [
    '    <meta charset="UTF-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '    <link rel="stylesheet" href="../styles.css">',
    '    <link rel="preconnect" href="https://fonts.googleapis.com">',
    '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=Lora:wght@400;500;600&display=swap" rel="stylesheet">',
  ].join('\n');
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n    <title>${title} - Katie Kormanik</title>\n${head}\n</head>\n<body>\n\n    <!-- Header -->\n    <header class="header">\n        <div class="container">\n            <h1 class="logo"><a href="../index.html">KATIE KORMANIK</a></h1>\n            <nav class="nav">\n                <a href="../learn.html">Learn</a>\n                <a href="../blog.html">Blog</a>\n                <a href="https://www.linkedin.com/in/katiekormanik/" target="_blank">About</a>\n            </nav>\n        </div>\n    </header>\n\n    <section class="hero">\n        <div class="container">\n            <h2 class="hero-title">${title}</h2>\n            <p class="hero-subtitle">${dateDisplay}</p>\n            <div class="underline"></div>\n        </div>\n    </section>\n    <main class="main-content">\n        <div class="container">\n            <article class="post-card">\n                <div class="post-content">${contentHtml}</div>\n            </article>\n        </div>\n    </main>\n\n    <!-- Footer -->\n    <footer class="footer">\n        <div class="container">\n            <p>&copy; 2025 Katie Kormanik. All rights reserved.</p>\n        </div>\n    </footer>\n\n</body>\n</html>\n`;
}

function buildIndexListHtml(posts) {
  // posts: [{title, slug, dateDisplay, dateISO}]
  return posts.map(p => `<li class="post-list-item"><a href="blog/${p.slug}.html">${p.title}</a><span class="post-date">${p.dateDisplay}</span></li>`).join('\n');
}

function buildRecentPostsCards(posts) {
  const top3 = posts.slice(0, 3);
  return top3.map(p => (
    `<a class="recent-post-card" href="blog/${p.slug}.html">\n`+
    `  <h3>${p.title}</h3>\n`+
    `  <div class="post-date">${p.dateDisplay}</div>\n`+
    `  <p>${p.excerpt || ''}</p>\n`+
    `</a>`
  )).join('\n');
}

async function upsertImageFiles(slug, images) {
  // images: [{filename, data}]
  const branch = process.env.GITHUB_BRANCH || 'main';
  for (const img of images) {
    const path = `images/blog/${slug}/${img.filename}`;
    // check if exists to get sha
    const existing = await githubGet(path, branch);
    const sha = existing?.sha;
    await githubPut(path, b64bin(img.data), `Add image ${img.filename} for ${slug}`, sha);
  }
}

async function loadPostsRegistry() {
  const branch = process.env.GITHUB_BRANCH || 'main';
  const existing = await githubGet('data/posts.json', branch);
  if (existing && existing.content) {
    const json = Buffer.from(existing.content, 'base64').toString('utf8');
    const data = JSON.parse(json);
    return { posts: Array.isArray(data) ? data : (data.posts || []), sha: existing.sha };
  }
  // Fallback: build from blog.html if present
  const blogFile = await githubGet('blog.html', branch);
  if (blogFile?.content) {
    const html = Buffer.from(blogFile.content, 'base64').toString('utf8');
    const $ = cheerio.load(html);
    const posts = [];
    $('ul.post-list > li.post-list-item').each((i, li) => {
      const a = $(li).find('a');
      const title = a.text().trim();
      const href = a.attr('href') || '';
      const slug = href.replace(/^blog\//, '').replace(/\.html$/, '');
      const dateDisplay = $(li).find('.post-date').text().trim();
      posts.push({ title, slug, dateDisplay, dateISO: new Date(dateDisplay).toISOString(), excerpt: '' });
    });
    // no sha
    return { posts, sha: null };
  }
  return { posts: [], sha: null };
}

async function commitPostsRegistry(posts, sha) {
  const branch = process.env.GITHUB_BRANCH || 'main';
  const data = JSON.stringify(posts, null, 2);
  return githubPut('data/posts.json', b64(data), 'Update posts registry', sha);
}

async function updateBlogIndex(posts) {
  const branch = process.env.GITHUB_BRANCH || 'main';
  const existing = await githubGet('blog.html', branch);
  if (!existing?.content) throw new Error('blog.html missing');
  const html = Buffer.from(existing.content, 'base64').toString('utf8');
  const $ = cheerio.load(html);
  const ul = $('ul.post-list');
  if (!ul.length) throw new Error('ul.post-list not found');
  ul.html('\n' + buildIndexListHtml(posts) + '\n');
  const out = $.html();
  return githubPut('blog.html', b64(out), 'Update blog index', existing.sha);
}

async function updateHomeRecent(posts) {
  const branch = process.env.GITHUB_BRANCH || 'main';
  const existing = await githubGet('index.html', branch);
  if (!existing?.content) throw new Error('index.html missing');
  const html = Buffer.from(existing.content, 'base64').toString('utf8');
  const $ = cheerio.load(html);
  const grid = $('section.recent-posts .recent-posts-grid');
  if (!grid.length) return null; // optional
  grid.html('\n' + buildRecentPostsCards(posts) + '\n');
  const out = $.html();
  return githubPut('index.html', b64(out), 'Update homepage recent posts', existing.sha);
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return response(res, 405, { error: 'Use POST' });

    // Env checks
    for (const k of ['ADMIN_SECRET','GOOGLE_SERVICE_ACCOUNT_KEY','GITHUB_TOKEN','GITHUB_REPO']) {
      if (!assertEnv(res, k)) return;
    }

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token !== process.env.ADMIN_SECRET) {
      return response(res, 401, { error: 'Unauthorized' });
    }

    const { docUrl, title: titleOverride, date: dateOverride, slug: slugOverride } = req.body || {};
    if (!docUrl) return response(res, 400, { error: 'docUrl required' });

    const fileId = extractDocId(docUrl);
    if (!fileId) return response(res, 400, { error: 'Invalid Google Doc URL' });

    const accessToken = await getAccessToken();
    const meta = await driveGetMeta(fileId, accessToken);
    const exported = await driveExportHtml(fileId, accessToken);

    // Load and sanitize
    let $ = cheerio.load(exported);
    // Prefer body inner
    const bodyInner = $('body').length ? $('body').html() : exported;
    const sanitized = sanitizeContent(bodyInner);
    $ = cheerio.load(sanitized);

    const title = (titleOverride || meta.name || 'Untitled').trim();
    const slug = slugify(slugOverride || title);
    const dateISO = toISODate(dateOverride || meta.createdTime || new Date());
    const dateDisplay = fmtDateDisplay(dateISO);

    // Download images and rewrite src to local paths
    const images = await downloadAndRewriteImages($, accessToken, slug);

    // Excerpt
    const excerpt = extractFirstParagraph($);

    // Final content HTML
    const contentHtml = $.html();

    // Build final post page
    const postHtml = buildPostHtml({ title, dateDisplay, contentHtml });

    // Read posts registry
    const { posts, sha } = await loadPostsRegistry();

    // Upsert post record
    const filtered = posts.filter(p => p.slug !== slug);
    filtered.push({ title, slug, dateDisplay, dateISO, excerpt });
    // Sort newest first
    filtered.sort((a, b) => new Date(b.dateISO) - new Date(a.dateISO));

    // Commit images, post file, posts.json, blog.html, index.html
    const branch = process.env.GITHUB_BRANCH || 'main';

    // 1) images
    if (images.length) {
      await upsertImageFiles(slug, images);
    }

    // 2) blog/<slug>.html
    const postPath = `blog/${slug}.html`;
    const existingPost = await githubGet(postPath, branch);
    await githubPut(postPath, b64(postHtml), `Publish post: ${title}`, existingPost?.sha);

    // 3) data/posts.json
    await commitPostsRegistry(filtered, sha);

    // 4) update blog.html list
    await updateBlogIndex(filtered);

    // 5) update index.html recent posts cards
    await updateHomeRecent(filtered);

    return response(res, 200, { ok: true, slug, url: `blog/${slug}.html` });
  } catch (e) {
    return response(res, 500, { error: e.message, stack: e.stack });
  }
};
