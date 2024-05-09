import * as wtf from 'wtf_wikipedia';
// @ts-expect-error no types available
import wtf_disambig from 'wtf-plugin-disambig';
wtf.extend(wtf_disambig);

async function getByTitle(title: string) {
  let doc = await wtf.fetch(title, { 'Api-User-Agent': 'Orchard/1.0', lang: 'en', title });
  if (Array.isArray(doc)) {
    // Shouldn't return an array when we're just fetching 1 URL, but just in case
    return doc[0];
  }

  return doc;
}

export async function getWikipediaPage(title: string, section?: string) {
  let doc = getByTitle(title);

  // @ts-expect-error No types for disambig plugin
  let disambig = doc.disambig();

  if (disambig) {
    if (section) {
      // @ts-expect-error no types
      let first = disambig.pages.find((p) => p.section === section);
      if (first) {
        return getByTitle(first.link);
      }
    } else {
      return getByTitle(disambig.pages[0].link);
    }
  } else {
    return doc;
  }
}

export async function getWikipediaInfoBox(title: string) {
  const doc = await getWikipediaPage(title);
  return doc?.infobox()?.keyValue();
}
