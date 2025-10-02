#!/usr/bin/env python3
import os
import re
import sys
import json
import time
import shutil
from urllib.parse import urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

WP_API = "https://turnthewheel.org/wp-json/wp/v2/posts"
SITE_NAME = "Katie Kormanik"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLOG_DIR = os.path.join(ROOT, "blog")
IMAGES_DIR = os.path.join(ROOT, "images", "blog")
STYLES_REL_ROOT = "styles.css"  # from site root

HEAD_COMMON = """    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <link rel=\"stylesheet\" href=\"{STYLES_PATH}\">\n    <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n    <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n    <link href=\"https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=Lora:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n"""


HEADER_NAV_ROOT = """
    <!-- Header -->
    <header class=\"header\">
        <div class=\"container\">
            <h1 class=\"logo\"><a href=\"index.html\">KATIE KORMANIK</a></h1>
            <nav class=\"nav\">
                <a href=\"learn.html\">Learn</a>
                <a href=\"blog.html\">Blog</a>
                <a href=\"https://www.linkedin.com/in/katiekormanik/\" target=\"_blank\">About</a>
            </nav>
        </div>
    </header>
"""

HEADER_NAV_POST = """
    <!-- Header -->
    <header class=\"header\">
        <div class=\"container\">
            <h1 class=\"logo\"><a href=\"../index.html\">KATIE KORMANIK</a></h1>
            <nav class=\"nav\">
                <a href=\"../learn.html\">Learn</a>
                <a href=\"../blog.html\">Blog</a>
                <a href=\"https://www.linkedin.com/in/katiekormanik/\" target=\"_blank\">About</a>
            </nav>
        </div>
    </header>
"""

FOOTER = """
    <!-- Footer -->
    <footer class=\"footer\">
        <div class=\"container\">
            <p>&copy; 2025 Katie Kormanik. All rights reserved.</p>
        </div>
    </footer>
"""

def ensure_dirs():
    os.makedirs(BLOG_DIR, exist_ok=True)
    os.makedirs(IMAGES_DIR, exist_ok=True)


def fmt_date(iso):
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(iso.replace('Z','+00:00'))
        return dt.strftime('%B %d, %Y')
    except Exception:
        return iso


def fetch_posts():
    all_posts = []
    page = 1
    per_page = 100
    while True:
        url = f"{WP_API}?per_page={per_page}&page={page}&_embed=1&_fields=id,slug,link,title.rendered,date,content.rendered"
        r = requests.get(url, timeout=30)
        if r.status_code == 400 or r.status_code == 404:
            break
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, list) or len(data) == 0:
            break
        all_posts.extend(data)
        if len(data) < per_page:
            break
        page += 1
        time.sleep(0.2)
    # Sort newest to oldest
    all_posts.sort(key=lambda p: p.get('date',''), reverse=True)
    return all_posts


def normalize_url(u: str) -> str:
    try:
        p = urlparse(u)
        # Strip query and fragment, drop trailing slash
        path = p.path.rstrip('/')
        p2 = p._replace(path=path, query='', fragment='')
        return urlunparse(p2)
    except Exception:
        return u


def sanitize_filename(name: str) -> str:
    name = re.sub(r'[^A-Za-z0-9._-]+', '-', name).strip('-')
    return name or 'file'


def download_image(src_url: str, slug: str) -> str:
    if not src_url:
        return src_url
    try:
        p = urlparse(src_url)
        filename = sanitize_filename(os.path.basename(p.path))
        if not filename:
            filename = f"img-{int(time.time()*1000)}.jpg"
        # Ensure per-post directory exists
        post_img_dir = os.path.join(IMAGES_DIR, slug)
        os.makedirs(post_img_dir, exist_ok=True)
        local_path = os.path.join(post_img_dir, filename)
        # Avoid re-downloading if exists
        if not os.path.exists(local_path):
            headers = {"User-Agent": "Mozilla/5.0"}
            with requests.get(src_url, headers=headers, stream=True, timeout=60) as resp:
                resp.raise_for_status()
                with open(local_path, 'wb') as f:
                    shutil.copyfileobj(resp.raw, f)
        # From a post file (blog/slug.html), relative path to the per-post images dir
        return f"../images/blog/{slug}/{filename}"
    except Exception:
        return src_url


def clean_and_localize_content(html: str, link_to_slug: dict, current_slug: str) -> str:
    # html5lib preserves whitespace and complex structures more faithfully
    soup = BeautifulSoup(html or '', 'html5lib')

    # Remove common WP share/subscribe blocks
    for sel in [
        '.sharedaddy', '.sd-sharing-enabled', '.jp-relatedposts',
        '.wp-block-jetpack-subscriptions', '.wp-block-jetpack-contact-form'
    ]:
        for node in soup.select(sel):
            node.decompose()

    # Fix images: download and point to local paths
    for img in soup.find_all('img'):
        src = img.get('src') or img.get('data-src') or img.get('data-lazy-src') or img.get('data-full-url') or img.get('data-orig-file')
        if src:
            local_src = download_image(src, current_slug)
            img['src'] = local_src
            for attr in ['srcset','sizes','decoding','loading','data-src','data-lazy-src','data-full-url','data-orig-file']:
                if attr in img.attrs:
                    del img[attr]

    # Rewrite internal post links to local pages
    link_keys = list(link_to_slug.keys())
    for a in soup.find_all('a'):
        href = a.get('href')
        if not href:
            continue
        norm = normalize_url(href)
        # Direct match
        if norm in link_to_slug:
            slug = link_to_slug[norm]
            a['href'] = f"./{slug}.html"
            continue
        # Try to match by path containing slug
        path = urlparse(norm).path.strip('/')
        for link, slug in link_to_slug.items():
            if f"/{slug}/" in f"/{path}/":
                a['href'] = f"./{slug}.html"
                break

    # Return inner HTML of body to avoid embedding full <html> document
    if soup.body:
        return ''.join(str(child) for child in soup.body.contents)
    return str(soup)


def render_post_html(title: str, date: str, content_html: str, slug: str) -> str:
    head = HEAD_COMMON.replace("{STYLES_PATH}", "../" + STYLES_REL_ROOT)
    return f"""<!DOCTYPE html>
<html lang=\"en\">
<head>
    <title>{title} - {SITE_NAME}</title>
{head}</head>
<body>
{HEADER_NAV_POST}
    <section class=\"hero\">
        <div class=\"container\">
            <h2 class=\"hero-title\">{title}</h2>
            <p class=\"hero-subtitle\">{date}</p>
            <div class=\"underline\"></div>
        </div>
    </section>
    <main class=\"main-content\">
        <div class=\"container\">
            <article class=\"post-card\">
                <div class=\"post-content\">{content_html}</div>
            </article>
        </div>
    </main>
{FOOTER}
</body>
</html>
"""


def render_blog_index(posts):
    head = HEAD_COMMON.replace("{STYLES_PATH}", STYLES_REL_ROOT)
    items = []
    for p in posts:
        title = p.get('title',{}).get('rendered') or 'Untitled'
        date = fmt_date(p.get('date',''))
        slug = p.get('slug','post')
        items.append(f"<li class=\"post-list-item\"><a href=\"blog/{slug}.html\">{title}</a><span class=\"post-date\">{date}</span></li>")
    items_html = "\n".join(items)
    return f"""<!DOCTYPE html>
<html lang=\"en\">
<head>
    <title>Blog - {SITE_NAME}</title>
{head}</head>
<body>
{HEADER_NAV_ROOT}
    <section class=\"hero\">
        <div class=\"container\">
            <h2 class=\"hero-title\">Blog</h2>
            <div class=\"underline\"></div>
        </div>
    </section>
    <main class=\"main-content\">
        <div class=\"container\">
            <section class=\"blog-index\">
                <ul class=\"post-list\">
{items_html}
                </ul>
            </section>
        </div>
    </main>
{FOOTER}
</body>
</html>
"""


def main():
    ensure_dirs()
    print("Fetching posts from WordPress…", file=sys.stderr)
    posts = fetch_posts()
    if not posts:
        print("No posts found.", file=sys.stderr)
        sys.exit(1)

    link_to_slug = {}
    for p in posts:
        link = normalize_url(p.get('link',''))
        slug = p.get('slug')
        if link and slug:
            link_to_slug[link] = slug

    # Generate per-post pages
    print(f"Generating {len(posts)} post pages…", file=sys.stderr)
    for p in posts:
        title = p.get('title',{}).get('rendered') or 'Untitled'
        date = fmt_date(p.get('date',''))
        slug = p.get('slug','post')
        raw_html = p.get('content',{}).get('rendered') or ''
        content_html = clean_and_localize_content(raw_html, link_to_slug, slug)
        out_path = os.path.join(BLOG_DIR, f"{slug}.html")
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(render_post_html(title, date, content_html, slug))

    # Generate blog.html index
    print("Generating blog.html index…", file=sys.stderr)
    index_html = render_blog_index(posts)
    with open(os.path.join(ROOT, 'blog.html'), 'w', encoding='utf-8') as f:
        f.write(index_html)

    print("Done.")


if __name__ == '__main__':
    main()
