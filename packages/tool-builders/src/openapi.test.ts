import { expect, test } from 'vitest';
import { createChronicleClient } from '@dimfeld/chronicle';

import { parseOpenAPI } from './openapi.js';

test('weather.gov', async () => {
  const result = await parseOpenAPI({
    chronicle: createChronicleClient(),
    model: 'groq/llama-3.1-8b-instant',
    specPath: __dirname + '/../fixtures/openapi.weather.gov.json',
  });

  console.dir(result);
});
