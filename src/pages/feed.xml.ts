// RSS feed of patch releases for both games, generated at build time from
// patches.json (DS) and patches_3ds.json (3DS), newest first.
// Lives at <site>/<base>/feed.xml. Linked from the subscribe card and the
// <link rel="alternate"> tag in the layout head.
import type { APIRoute } from 'astro';
import patchData from '../../public/data/patches.json';
import patch3ds from '../../public/data/patches_3ds.json';

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
  const all = [
    ...patchData.releases.map((r: any) => ({ ...r, game: 'ds' })),
    ...((patch3ds as any).releases ?? []).map((r: any) => ({ ...r, game: '3ds' })),
  ].sort((a: any, b: any) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const items = all
    .map((r: any) => {
      const is3ds = r.game === '3ds';
      const link = r.changelogUrl
        ? `${ROOT}${r.changelogUrl}`
        : `${ROOT}/patches/${is3ds ? '#3ds' : ''}`;
      // RSS description content is entity-encoded HTML: readers render it as
      // HTML, so plain newlines would collapse. Build minimal HTML and
      // escape it once here; escapeXml below escapes it again for the XML
      // document (double-escaping is the correct RSS pattern).
      const changesHtml = (r.changes || [])
        .map((c: string) => `<li>${escapeXml(c)}</li>`)
        .join('');
      // A release's `callout` is the one thing players must act on; it
      // sits between the summary and the change list, as on the site.
      const callout = r.callout
        ? `<p><strong>${escapeXml(r.callout.title)}</strong> ${escapeXml(r.callout.body)}` +
          (r.callout.href
            ? ` <a href="${escapeXml(`${ROOT}${r.callout.href}`)}">${escapeXml(r.callout.label || 'More')}</a>`
            : '') +
          '</p>'
        : '';
      const description = [
        r.headline ? `<p><strong>${escapeXml(r.headline)}</strong></p>` : '',
        r.summary ? `<p>${escapeXml(r.summary)}</p>` : '',
        callout,
        changesHtml ? `<ul>${changesHtml}</ul>` : '',
      ].join('');
      return [
        '    <item>',
        `      <title>${escapeXml(`${is3ds ? '3DS' : 'DS'} patch v${r.version} — ${r.headline}`)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        // DS guids keep their original form so existing readers don't re-show old items.
        `      <guid isPermaLink="false">${is3ds ? 'tongari-boushi-3ds-patch-v' : 'tongari-boushi-patch-v'}${escapeXml(r.version)}</guid>`,
        `      <pubDate>${rfc822(r.date)}</pubDate>`,
        `      <description>${escapeXml(description)}</description>`,
        '    </item>',
      ].join('\n');
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Tongari Boushi Fan-Translation Patches — Releases</title>
    <link>${escapeXml(`${ROOT}/patches/`)}</link>
    <atom:link href="${escapeXml(`${ROOT}/feed.xml`)}" rel="self" type="application/rss+xml" />
    <description>Release announcements for the fan-translation patches of Tongari Boushi to Oshare na Mahou Tsukai (DS, English) and Tongari Boushi to Mahou no Machi (3DS, Italian and English).</description>
    <language>en-us</language>
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
};
