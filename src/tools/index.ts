export * from './brave_search.js';
import type { Schema } from 'jsonschema';

export interface ToolConfig {
  name: string;
  description: string;
  schema: Schema;
  // TODO need to define some output
  run(input: any): Promise<any>;
}
