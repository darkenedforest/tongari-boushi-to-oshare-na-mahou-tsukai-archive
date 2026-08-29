// RSS feed of patch releases, generated at build time from patches.json.
// Lives at <site>/<base>/feed.xml. Linked from the subscribe card and the
// <link rel="alternate"> tag in the layout head.
import type { APIRoute } from 'astro';
import patchData from '../../public/data/patches.json';

const SITE = (import.meta.env.SITE || 'https://darkenedforest.github.io').replace(/\/+$/, '');
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');
const ROOT = `${SITE}${BASE}`;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rfc822(isoDate: string): string {
  // Release dates are date-only; pin to noon UTC so the day never shifts.
  return new Date(`${isoDate}T12:00:00Z`).toUTCString();
}

export const GET: APIRoute = () => {
  const items = patchData.releases
    .map((r: any) => {
      const link = r.changelogUrl
        ? `${ROOT}${r.changelogUrl}`
        : `${ROOT}/patches/`;
      // RSS description content is entity-encoded HTML: readers render it as
      // HTML, so plain newlines would collapse. Build minimal HTML and
      // escape it once here; escapeXml below escapes it again for the XML
      // document (double-escaping is the correct RSS pattern).
      const changesHtml = (r.changes || [])
        .map((c: string) => `<li>${escapeXml(c)}</li>`)
        .join('');
      const description = [
        r.headline ? `<p><strong>${escapeXml(r.headline)}</strong></p>` : '',
        r.summary ? `<p>${escapeXml(r.summary)}</p>` : '',
        changesHtml ? `<ul>${changesHtml}</ul>` : '',
      ].join('');
      return [
        '    <item>',
        `      <title>${escapeXml(`v${r.version} — ${r.headline}`)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="false">tongari-boushi-patch-v${escapeXml(r.version)}</guid>`,
        `      <pubDate>${rfc822(r.date)}</pubDate>`,
        `      <description>${escapeXml(description)}</description>`,
        '    </item>',
      ].join('\n');
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Tongari Boushi English Patch — Releases</title>
    <link>${escapeXml(`${ROOT}/patches/`)}</link>
    <atom:link href="${escapeXml(`${ROOT}/feed.xml`)}" rel="self" type="application/rss+xml" />
    <description>Release announcements for the English fan-translation patch of Tongari Boushi to Oshare na Mahou Tsukai (DS).</description>
    <language>en-us</language>
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
};
