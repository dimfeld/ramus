import * as extractus from '@extractus/article-extractor';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { Schema } from 'jsonschema';
import { ToolConfig } from './index.js';
import ky from 'ky';

export interface ArticleData {
  title: string;
  content: string;
}

export function readabilityExtract(html: string, url: string | undefined): ArticleData | undefined {
  const dom = new JSDOM(html, {
    url,
  });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article?.textContent) {
    return;
  }

  return {
    title: article.title,
    content: article.textContent,
  };
}

export async function extractusExtract(
  html: string,
  url: string | undefined
): Promise<ArticleData | undefined> {
  const article = await extractus.extractFromHtml(html, url);
  if (!article?.content) {
    return;
  }

  return {
    title: article.title || '',
    content: article.content,
  };
}

const textSchema: Schema = {
  type: 'object',
  required: ['html'],
  properties: {
    html: {
      type: 'string',
      description: 'The raw HTML of the article',
    },
    url: {
      type: 'string',
      description: 'The URL of the article, if known',
    },
  },
};

const urlSchema: Schema = {
  type: 'object',
  required: ['url'],
  properties: {
    url: {
      type: 'string',
      description: 'The URL of the article to fetch',
    },
  },
};

type ExtractorFunction = (
  html: string,
  url?: string
) => ArticleData | undefined | Promise<ArticleData | undefined>;
export type ExtractorChoice = 'readability' | 'extractus';

function toExtractorFunctions(choices: ExtractorChoice[]): ExtractorFunction[] {
  return choices.map((choice) => {
    switch (choice) {
      case 'readability':
        return readabilityExtract;
      case 'extractus':
        return extractusExtract;
    }
  });
}

async function runExtractors(extractors: ExtractorFunction[], html: string, url?: string) {
  let extracted = await Promise.all(extractors.map((extractor) => extractor(html, url)));
  if (extracted.length === 0) {
    return;
  }

  let longest: ArticleData | undefined;

  // If using multiple extractors, return the one with the longest content
  for (let i = 0; i < extracted.length; i++) {
    let article = extracted[i];
    if (article) {
      if (!longest || article.content.length > longest.content.length) {
        longest = extracted[i];
      }
    }
  }

  return longest;
}

/** Extract content from HTML */
export function extractTool(
  extractors: ExtractorChoice[] = ['readability', 'extractus']
): ToolConfig<{ html: string; url?: string }, ArticleData | undefined> {
  const extractorFunctions = toExtractorFunctions(extractors);
  return {
    name: 'ExtractWebPageContent',
    description: 'Extract text from already-downloaded HTML',
    schema: textSchema,
    run({ html, url }: { html: string; url?: string }) {
      return runExtractors(extractorFunctions, html, url);
    },
    asText(value: ArticleData) {
      return value.content;
    },
  };
}

/** Fetch a web page and extract its content */
export function fetchAndExtractTool(
  extractors: ExtractorChoice[] = ['readability', 'extractus']
): ToolConfig<{ url: string }, ArticleData | undefined> {
  const extractorFunctions = toExtractorFunctions(extractors);
  return {
    name: 'FetchAndExtractWebPageContent',
    description: 'Fetch a web page from the internet and extract its contents',
    schema: urlSchema,
    async run({ url }: { url: string }) {
      const response = await ky(url).text();
      return runExtractors(extractorFunctions, response, url);
    },
    asText(value: ArticleData) {
      return value.content;
    },
  };
}
