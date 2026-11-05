// Ranking for the Ctrl+K quick search (pure; tested in web/test/command-palette.test.mjs).
export type PaletteItem = { id: string; kind: 'page' | 'computer' | 'action'; title: string; detail?: string; keywords?: string };

/** Every word must match; title prefix matches rank first, then title word matches, then anywhere. */
export function rankPalette(items: PaletteItem[], query: string, limit = 12): PaletteItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.filter(item => item.kind !== 'computer').slice(0, limit);
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    const title = item.title.toLowerCase();
    const haystack = `${title} ${(item.detail ?? '').toLowerCase()} ${(item.keywords ?? '').toLowerCase()}`;
    if (!words.every(word => haystack.includes(word))) continue;
    let score = 0;
    if (title.startsWith(words[0])) score += 100;
    else if (title.split(/[\s\-_.]+/).some(part => part.startsWith(words[0]))) score += 60;
    else if (title.includes(words[0])) score += 30;
    if (item.kind === 'page') score += 5;
    score -= title.length / 100;
    scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title)).slice(0, limit).map(entry => entry.item);
}
