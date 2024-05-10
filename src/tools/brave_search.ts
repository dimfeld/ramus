import ky from 'ky';

export interface ContactPoint {
  type: 'contact_point';
  telephone: string;
  email: string;
}

export interface DeepResult {
  // news: NewsResult[];
  // buttons: ButtonResult[];
  // social: KnowledgeGraphProfile[];
  // videos: VideoResult;
  // images: ImageResult[];
}

export interface DiscussionResult {
  type: 'discussion';
  data: ForumData;
}

export interface Discussions {
  type: 'search';
  results: DiscussionResult;
}

export interface ForumData {
  forum_name: string;
  num_answers: number;
  score: string;
  title: string;
  question: string;
  top_comment: string;
}

export interface Faq {
  type: 'faq';
  results: QA[];
}

export interface Organization {
  type: 'organization';
  contact_points: ContactPoint[];
}

export interface QA {
  question: string;
  answer: string;
  title: string;
  url: string;
  meta_url: MetaUrl;
}

export interface Thumbnail {
  src: string;
  alt: string;
  height: number;
  width: number;
  bg_color: string;
  original: string;
  logo: boolean;
  duplicated: boolean;
  theme: string;
}

export interface MetaUrl {
  scheme: string;
  netloc: string;
  hostname: string;
  favicon: string;
  path: string;
}

export interface QueryResult {
  original: string;
  show_strict_warning: boolean;
  altered: string;
  safesearch: boolean;
  is_navigational: boolean;
  is_geolocal: boolean;
  local_decision: string;
  local_locations_idx: number;
  is_trending: boolean;
  is_news_breaking: boolean;
  ask_for_location: boolean;
  language: { main: string };
  spellcheck_off: boolean;
  country: string;
  bad_results: boolean;
  should_fallback: boolean;
  lat: string;
  long: string;
  postal_code: string;
  city: string;
  state: string;
  header_country: string;
  more_results_available: boolean;
  custom_location_label: string;
  reddit_cluster: string;
  summary_key: string;
}

export interface SearchResult {
  type: 'search_result';
  subtype: 'generic';
  deep_results: DeepResult;
  // ??
  schemas: object[];
  meta_url: MetaUrl;
  thumbnail: Thumbnail;
  age: string;
  language: string;
  // location: LocationResult;
  // video: VideoData;
  // movie: MovieData;
  faq: Faq;
  // qa: QAPage;
  // book: Book;
  // rating: Rating;
  // article: Article;
  // product: Product | Review;
  // product_cluster: Array<Product | Review>;
  cluster_type: string;
  cluster: SearchResults[];
  // creative_work: CreativeWork;
  // review: Review;
  // software: Software;
  // recipe: Recipe;
  organization: Organization;
  content_type: string;
  extra_snippets: string[];
}

export interface SearchResults {
  type: 'search';
  results: SearchResult[];
  family_friendly: boolean;
}

export interface BraveSearchResponse {
  /** Not part of the actual response, but this helps identify it later in cases where we might have
   * more than one format. */
  __tool_source: 'brave_search';
  type: 'search';
  discussions: Discussions;
  faq: Faq;
  // infobox
  // locations
  // mixed
  // news
  query: QueryResult;
  // videos
  web: SearchResults;
  // summarizer?;
}

export let BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY;

/** Set the default API key to use for Brave Search. */
export function initBraveSearchApiKey(key: string) {
  BRAVE_SEARCH_API_KEY = key;
}

export interface BraveSearchOptions {
  query: string;
  /** default 20, maximum 20 */
  count?: number;
  /** Number of pages to skip */
  offset?: number;
  /** When a search result was indexed. */
  freshness?: /** Latest day */
  | 'pd'
    /** Latest week */
    | 'pw'
    /** Latest month */
    | 'pm'
    /** Latest year */
    | 'py'
    /** Specific date range: YYYY-MM-DDtoYYYY-MM-DD */
    | `${number}-${number}-${number}to${number}-${number}-${number}`;
  apiKey?: string;
}

export async function braveSearch(options: BraveSearchOptions): Promise<BraveSearchResponse> {
  let searchParams = new URLSearchParams({
    q: options.query,
  });

  if (options.count) {
    searchParams.set('count', options.count.toString());
  }

  if (options.offset) {
    searchParams.set('offset', options.offset.toString());
  }

  if (options.freshness) {
    searchParams.set('freshness', options.freshness);
  }

  const result = await ky(`https://api.search.brave.com/res/v1/web/search`, {
    headers: {
      'X-Subscription-Token': options.apiKey || BRAVE_SEARCH_API_KEY,
    },
    searchParams,
  }).json<BraveSearchResponse>();

  result.__tool_source = 'brave_search';

  return result;
}
