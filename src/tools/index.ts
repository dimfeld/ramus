export { braveWebSearchTool } from './brave_search.js';
export { fetchAndExtractTool, extractTool } from './extract_article.js';
export { wikipediaTool, wikipediaInfoboxTool } from './wikipedia.js';

import type { Schema } from 'jsonschema';

export interface ToolConfig<INPUT extends object = object, OUTPUT = unknown> {
  name: string;
  description: string;
  schema: Schema;
  run(input: INPUT): Promise<OUTPUT>;
  /** Format the output as text for passing to a model */
  asText(value: OUTPUT): string;
}

export function toOpenAiTool(tool: ToolConfig) {
  return {
    type: 'function',
    function: {
      description: tool.description,
      name: tool.name,
      parameters: tool.schema,
    },
  };
}
