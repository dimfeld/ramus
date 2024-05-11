// @ts-expect-error types are screwed up but this is the proper way to import it
import wtf, { type Section, type Document } from 'wtf_wikipedia';
// @ts-expect-error no types available
import wtf_disambig from 'wtf-plugin-disambig';
// @ts-expect-error no types available
import wtf_plugin_markdown from 'wtf-plugin-markdown';
import { ToolConfig } from './index.js';
wtf.extend(wtf_plugin_markdown);
wtf.extend(wtf_disambig);

async function getByTitle(title: string) {
  let doc = await wtf.fetch(title, { 'Api-User-Agent': 'Orchard/1.0', lang: 'en', title });
  if (Array.isArray(doc)) {
    // Shouldn't return an array when we're just fetching 1 URL, but just in case
    return doc[0];
  }

  return doc;
}

export async function getWikipediaPage(
  title: string,
  section?: string
): Promise<Document | undefined> {
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

export function wikipediaTool(): ToolConfig<Document | undefined> {
  return {
    name: 'Wikipedia',
    description: 'Search Wikipedia',
    schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The title of a Wikipedia page for the topic',
        },
      },
    },
    run({ title }: { title: string }) {
      return getWikipediaPage(title);
    },
    asText(value: Document) {
      // @ts-expect-error No types for markdown plugin
      return value?.markdown() || 'No result found';
    },
  };
}

export function wikipediaInfoboxTool(): ToolConfig<Record<string, string>> {
  return {
    name: 'Wikipedia Infobox',
    description: 'Get infobox data from Wikipedia',
    schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The title of a Wikipedia page for the topic',
        },
      },
    },
    async run({ title }: { title: string }) {
      const doc = await getWikipediaPage(title);
      if (!doc) {
        return {};
      }

      return (doc.infobox()?.keyValue() ?? {}) as Record<string, string>;
    },
    asText(value: Record<string, string>) {
      return Object.entries(value)
        .map(([key, value]) => {
          let outputName = infoboxKeyMap[key];
          if (outputName === null) {
            return '';
          }

          outputName = outputName || key;

          let outputValue = value.replaceAll(/\n+/g, ', ');

          return `${outputName}: ${outputValue}`;
        })
        .filter((x) => x)
        .join('\n');
    },
  };
}

const infoboxKeyMap: Record<string, string | null> = {
  name: 'Name',
  logo: null,
  logo_size: null,
  image: null,
  image_size: null,
  image_caption: null,
  type: 'Company Type',
  traded_as: 'Traded as',
  isin: 'ISIN',
  industry: 'Industry',
  founded: 'Founded',
  founders: 'Founders',
  foundation: 'Year Founded',
  location: 'Address',
  location_city: 'City',
  location_country: 'Location',
  area_served: 'Area served',
  key_people: 'Leadership',
  products: 'Products',
  revenue: 'Revenue',
  operating_income: 'Operating Income',
  net_income: 'Net Income',
  assets: 'Assets',
  equity: 'Market Cap',
  num_employees: 'Number of Employees',
  subsid: 'Subsidiaries',
  website: 'Website',
};
