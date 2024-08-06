import SwaggerParser from '@apidevtools/swagger-parser';
import { JSONSchema, compile } from 'json-schema-to-typescript';
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
  bodySchema?: SchemaObject;
  bodyInterface?: string;
  querySchema?: SchemaObject;
  queryInterface?: string;
  outputSchema?: SchemaObject;
  outputInterface?: string;
  keywords: string[];
}

async function generateKeywords(
  options: OpenApiToolBuilderOptions,
  url: string,
  description: string
): Promise<string[]> {
  return [];

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
        strict: true,
        schema: {
          type: 'object',
          required: ['keywords'],
          additionalProperties: false,
          properties: {
            keywords: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
        },
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

function generateTs(schema: SchemaObject, name: string): Promise<string> {
  return compile(schema as JSONSchema, name, { bannerComment: '', additionalProperties: false });
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
      let bodySchema;
      let bodyInterface: string | undefined;

      let querySchema: SchemaObject = {
        type: 'object',
        properties: {},
        required: [],
      };

      for (const parameter of (operation.parameters || []) as ParameterObject[]) {
        if (parameter.in === 'body') {
          bodySchema = parameter.schema;
          bodyInterface = await generateTs(parameter.schema, 'Body');
        } else if (parameter.in === 'query') {
          querySchema.properties![parameter.name] = {
            description: parameter.description,
            example: parameter.example,
            // Define a default but it will always always be overridden by the schema
            type: 'string',
            ...parameter.schema,
          };

          if (parameter.required) {
            querySchema.required!.push(parameter.name);
          }
        }
      }

      let queryInterface = Object.keys(querySchema.properties || {}).length
        ? await generateTs(querySchema, 'Query')
        : undefined;

      if (!bodySchema && 'requestBody' in operation && operation.requestBody) {
        const schema = (operation.requestBody as RequestBodyObject).content['application/json']
          ?.schema as SchemaObject;
        if (schema) {
          bodySchema = schema;
          bodyInterface = await generateTs(schema, 'Body');
        }
      }

      // Handle output schema
      let outputSchema: SchemaObject | undefined;
      let outputInterface: string | undefined;
      let response = operation.responses?.['200'] as ResponseObject | undefined;
      if (response) {
        const content =
          response.content?.['application/json'] ?? response.content?.['application/ld+json'];
        const schema = content?.schema as SchemaObject;
        if (schema) {
          outputSchema = schema;
          outputInterface = await generateTs(schema, 'Output');
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
        bodySchema,
        bodyInterface,
        querySchema,
        queryInterface,
        outputSchema,
        outputInterface,
        keywords,
      };

      endpoints.push(endpoint);
    }
  }

  return endpoints;
}
