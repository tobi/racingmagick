import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'racingmagick',
  description: 'Universal motorsport telemetry parser and normalized query layer',
  base: '/racingmagick/',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: '/logo.svg',
    search: { provider: 'local' },
    nav: [
      { text: 'Guide', link: '/querying-data' },
      { text: 'Model', link: '/abstraction-model' },
      { text: 'Channels', link: '/channels-and-units' },
      { text: 'Formats', link: '/formats' },
      { text: 'Testing', link: '/testing' },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Querying data', link: '/querying-data' },
          { text: 'Examples', link: '/examples' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Abstraction model', link: '/abstraction-model' },
          { text: 'Channels and units', link: '/channels-and-units' },
          { text: 'Formats', link: '/formats' },
          { text: 'Testing', link: '/testing' },
        ],
      },
      {
        text: 'Format notes',
        items: [
          { text: 'MoTeC', link: '/motec_format' },
          { text: 'Pi/Cosworth PDS', link: '/pds_format' },
          { text: 'VBOX', link: '/VBO_FORMAT' },
          { text: 'Video sync', link: '/video_sync' },
          { text: 'Video matching', link: '/video-matching' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/tobi/racingmagick' },
    ],
  },
});
