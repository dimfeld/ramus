import SwaggerParser from '@apidevtools/swagger-parser';
import { compile } from 'json-schema-to-typescript';
import { ChronicleClient } from '@dimfeld/chronicle';
import { OpenAPI, OpenAPIV2, OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';

type ParameterObject =
  | OpenAPIV2.ParameterObject
  | OpenAPIV3.ParameterObject
  | OpenAPIV3_1.ParameterObject;
type RequestBodyObject = OpenAPIV3.RequestBodyObject | OpenAPIV3_1.RequestBodyObject;
type ResponseObject = OpenAPIV3.ResponseObject | OpenAPIV3_1.ResponseObject;
type SchemaObject = OpenAPIV3.SchemaObject | OpenAPIV3_1.SchemaObject;

export interface OpenApiToolBuilderOptions {
  chronicle: ChronicleClient;
  model: string;
  specPath: string | URL;
}

export interface OpenApiEndpointTool {
  name: string;
  url: string;
  method: string;
  description: string;
  inputSchema?: SchemaObject;
  inputInterface?: string;
  outputSchema?: SchemaObject;
  outputInterface?: string;
  keywords: string[];
}

async function generateKeywords(
  options: OpenApiToolBuilderOptions,
  url: string,
  description: string
): Promise<string[]> {
  const response = await options.chronicle({
    model: options.model,
    messages: [
      {
        role: 'user',
        content: `Generate relevant keywords for the following API endpoint: ${url}\nDescription: ${description}\n\nKeywords:`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'keywords',
        description: 'Generated keywords',
        schema: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        strict: true,
      },
    },
    max_tokens: 100,
    stream: false,
    n: 1,
    stop: null,
    temperature: 0.5,
  });

  const keywords = response.choices[0].message.content;
  return JSON.parse(keywords!);
}

async function fetchSpecification(url: string | URL): Promise<OpenAPI.Document> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch specification: ${response.statusText}`);
  }
  return await response.json();
}

export async function parseOpenAPI(options: OpenApiToolBuilderOptions) {
  let spec: string | OpenAPI.Document;
  let specPath = options.specPath;

  try {
    // Check if specPath is a URL
    new URL(specPath);
    spec = await fetchSpecification(specPath);
  } catch (error) {
    // specPath is not a URL, assume it's a local file path
    spec = specPath as string;
  }

  const api = await SwaggerParser.dereference(spec);
  const endpoints = [];

  for (const path in api.paths) {
    const p = api.paths[path];
    if (!p) {
      continue;
    }

    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = p[method] as
        | OpenAPIV2.OperationObject
        | OpenAPIV3.OperationObject
        | OpenAPIV3_1.OperationObject
        | undefined;
      if (!operation) {
        continue;
      }

      // Handle input schema
      let inputSchema;
      let inputInterface: string | undefined;
      if (operation.parameters) {
        const bodySchema = (operation.parameters as ParameterObject[]).find(
          (p) => p.in === 'body'
        )?.schema;
        if (bodySchema) {
          inputSchema = bodySchema;
          inputInterface = await compile(bodySchema, 'Input');
        }
      } else if ('requestBody' in operation && operation.requestBody) {
        const schema = (operation.requestBody as RequestBodyObject).content['application/json']
          ?.schema as SchemaObject;
        if (schema) {
          inputSchema = schema;
          inputInterface = await compile(schema, 'Input');
        }
      }

      // Handle output schema
      let outputSchema: SchemaObject | undefined;
      let outputInterface: string | undefined;
      let response = operation.responses?.['200'] as ResponseObject | undefined;
      if (response) {
        const schema = response.content?.['application/json']?.schema as SchemaObject;
        if (schema) {
          outputSchema = schema;
          outputInterface = await compile(schema, 'Output');
        }
      }

      // Generate keywords if none are provided
      let description = operation.summary || operation.description || '';
      let keywords = operation.tags || (await generateKeywords(options, path, description));

      const endpoint: OpenApiEndpointTool = {
        name: operation.operationId || `${method.toUpperCase()} ${path}`,
        url: path,
        method: method.toUpperCase(),
        description,
        inputSchema,
        inputInterface,
        outputSchema,
        outputInterface,
        keywords,
      };

      endpoints.push(endpoint);
    }
  }

  return endpoints;
}
