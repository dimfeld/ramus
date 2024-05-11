export { braveWebSearchTool } from './brave_search.js';
export { wikipediaTool, wikipediaInfoboxTool } from './wikipedia.js';

import type { Schema } from 'jsonschema';

export interface ToolConfig<OUTPUT> {
  name: string;
  description: string;
  schema: Schema;
  run(input: any): Promise<OUTPUT>;
  /** Format the output as text for passing to a model */
  asText(value: OUTPUT): string;
}
