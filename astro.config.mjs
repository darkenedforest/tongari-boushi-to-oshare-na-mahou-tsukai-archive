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
});
