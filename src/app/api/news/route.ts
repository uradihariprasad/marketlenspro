/**
 * News & Events (Phase 4.10): real RSS feeds from Indian market newsrooms,
 * fetched server-side with graceful UNAVAILABLE state. No fabricated
 * headlines — if all feeds fail, the UI shows an explicit unavailable state.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface NewsItem { title: string; link: string; pubDate: string; source: string }

const FEEDS: { url: string; source: string }[] = [
  { url: "https://www.moneycontrol.com/rss/marketreports.xml", source: "Moneycontrol Markets" },
  { url: "https://www.moneycontrol.com/rss/MCtopnews.xml", source: "Moneycontrol Top" },
  { url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", source: "ET Markets" },
];

function parseRss(xml: string, source: string, limit: number): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const b of blocks.slice(0, limit)) {
    const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(b)?.[1]?.trim();
    const link = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(b)?.[1]?.trim();
    const pubDate = /<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i.exec(b)?.[1]?.trim();
    if (title && link) items.push({ title: decodeEntities(title), link, pubDate: pubDate ?? "", source });
  }
  return items;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#\d+;/g, "")
    .trim();
}

let cache: { at: number; items: NewsItem[]; errors: string[] } = { at: 0, items: [], errors: [] };

export async function GET() {
  if (Date.now() - cache.at < 120_000 && (cache.items.length > 0 || cache.errors.length > 0)) {
    return NextResponse.json({ ...cache, available: cache.items.length > 0 });
  }
  const items: NewsItem[] = [];
  const errors: string[] = [];
  for (const f of FEEDS) {
    try {
      const res = await fetch(f.url, {
        signal: AbortSignal.timeout(10000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; fno-intel-news/1.0)", Accept: "application/rss+xml, text/xml, */*" },
      });
      if (!res.ok) {
        errors.push(`${f.source}: HTTP ${res.status}`);
        continue;
      }
      items.push(...parseRss(await res.text(), f.source, 15));
    } catch {
      errors.push(`${f.source}: unreachable`);
    }
  }
  items.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  cache = { at: Date.now(), items: items.slice(0, 40), errors };
  return NextResponse.json({ ...cache, available: items.length > 0 });
}
