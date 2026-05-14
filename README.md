# Tongari Boushi to Oshare na Mahou Tsukai — Archive

A fan-built reference site for the Japan-only NDS game *Tongari Boushi to Oshare na Mahou Tsukai* (Magician's Quest 2).

Built as a companion to the fan English translation project at [darkenedforest/tongari-boushi-translation-claude-2026](https://github.com/darkenedforest/tongari-boushi-translation-claude-2026).

## Sections

- **2D Assets** *(live)* — every 2D image extracted from the ROM, browsable with palette and source-container metadata.
- **Dialog Paths** *(planned)* — searchable conversation trees by character, location, and event.
- **3D Models** *(planned)* — NPC and creature models with rotation, animation playback, and texture inspection.
- **Maps** *(planned)* — interactive town and dungeon maps with NPC pin locations and shop overlays.

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
