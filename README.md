# Tongari Boushi to Oshare na Mahou Tsukai — Archive

A fan-built reference site for the Japan-only NDS game *Tongari Boushi to Oshare na Mahou Tsukai* (Magician's Quest 2).


## Stack

- [Astro](https://astro.build/) with [React](https://react.dev/) islands — static-first for fast browsing, interactive components only on the routes that need them.
- GitHub Pages deployment via the workflow in `.github/workflows/deploy.yml`.

## Local development

```bash
npm install
npm run dev
```

Site builds to `dist/` via `npm run build`.

## Data layer

The 2D Assets gallery reads `public/data/manifest.json`, a list of records of the shape:

```json
{
  "png_path": "/assets/.../foo.png",
  "source_container": "2d/inputmagic/msg.ofs",
  "category": "magic_glyphs",
  "ncgr_inner_index": 17,
  "width": 256,
  "height": 192,
  "bpp": 8,
  "palette_strategy": "sibling"
}
```

PNGs live under `public/assets/` alongside the manifest. The extraction pipeline that produces both lives in the translation project's `src/translator/_sprite_*.py` scripts.

## License

Site code is MIT.

Game content (sprites, names, dialog) is © 2011 Konami Digital Entertainment. This is an unofficial fan archive and is not affiliated with Konami.
