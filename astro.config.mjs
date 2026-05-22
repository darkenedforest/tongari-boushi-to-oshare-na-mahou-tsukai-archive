import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  site: 'https://darkenedforest.github.io',
  base: '/tongari-boushi-to-oshare-na-mahou-tsukai-archive',
  integrations: [react()],
  build: {
    assets: '_astro',
  },
  // Step-259: the Translation Viewer moved from /translation/viewer/ to
  // /translation/ itself. Anyone visiting the old URL is bounced to the
  // new one so external links and bookmarks still resolve. The destination
  // must include the project's GitHub Pages base prefix because Astro's
  // static redirect writes the literal path into a <meta http-equiv="refresh">
  // tag without re-resolving it against `base`. Astro normalizes the
  // trailing slash on its own, so one entry covers both /translation/viewer
  // and /translation/viewer/.
  redirects: {
    '/translation/viewer': '/tongari-boushi-to-oshare-na-mahou-tsukai-archive/translation/',
  },
});
