# lain.xin

Experimental lab site — static Astro build for GitHub Pages.

## Develop

```bash
npm install
npm run dev
```

## Edit content (no code required)

Almost everything lives under `src/content/` (Markdown) or `src/data/site.json` (site copy).

| What | Where |
|------|--------|
| **Blog posts** | [`src/content/posts/`](src/content/posts/) — one `.md` file per post |
| **Projects / work** | [`src/content/projects/`](src/content/projects/) |
| **Lab updates** | [`src/content/lab/`](src/content/lab/) |
| **Open source** | [`src/content/open-source/`](src/content/open-source/) |
| **Services** | [`src/content/services/`](src/content/services/) |
| **About page** | [`src/content/pages/about.md`](src/content/pages/about.md) |
| **Hero, CTAs, page intros, contact, channels** | [`src/data/site.json`](src/data/site.json) |
| **Trainer sprite** | [`public/trainer.png`](public/trainer.png) |

### Add a blog post

1. Copy [`src/content/posts/_template.md`](src/content/posts/_template.md) to a new file, e.g. `my-post.md`.
2. Fill in frontmatter + body:

```md
---
title: My post title
summary: One line for the writing index.
date: 2026-07-21
draft: false
---

Your Markdown body here.
```

3. Set `draft: false` to publish. Files starting with `_` or `draft: true` stay off the site.

### Add a project

Create `src/content/projects/my-project.md`:

```md
---
title: My Project
summary: Short blurb for lists.
status: building
tags: [game, experiment]
year: "2026"
order: 5
---

Longer description in Markdown.
```

`status` is one of: `active`, `building`, `signal`, `archived`.

### Add a lab signal

Create `src/content/lab/2026-07-21-short-slug.md`:

```md
---
title: What shipped today
date: 2026-07-21
channel: maya
project: Maya Unified
---

Short update body.
```

### Change the homepage hero

Edit fields under `hero` in [`src/data/site.json`](src/data/site.json) — headline, support text, buttons, HP/EXP, coords, etc.

## Deploy

1. Create a public GitHub repo and push `main`.
2. Repo **Settings → Pages → Build and deployment → Source**: GitHub Actions.
3. The `Deploy to GitHub Pages` workflow builds and publishes `dist/`.

## DNS for lain.xin

`public/CNAME` already contains `lain.xin`.

At your registrar, point the apex (and optionally `www`) at GitHub Pages:

**A records** for `@` / `lain.xin`:

| Type | Name | Value |
|------|------|--------|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |

**Optional www:**

| Type | Name | Value |
|------|------|--------|
| CNAME | `www` | `<your-github-user>.github.io` |

Then in the repo Pages settings, confirm the custom domain `lain.xin` and wait for DNS + HTTPS.
