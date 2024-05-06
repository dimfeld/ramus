import { test, expect } from 'bun:test';

import { CompiledDag, compileDag } from './compile.js';
import { DagConfiguration } from './types.js';

async function noop() {}

test('valid DAG', () => {
  const dag: DagConfiguration<{}> = {
    one: {
      run: noop,
    },
    two: {
      parents: ['one'],
      run: noop,
    },
    three: {
      parents: ['one', 'two'],
      run: noop,
    },
    four: {
      parents: ['three'],
      run: noop,
    },
    five: {
      run: noop,
    },
    six: {
      parents: ['five', 'three'],
      run: noop,
    },
    seven: {
      run: noop,
    },
  };

  const { leafNodes, rootNodes } = compileDag(dag);
  rootNodes.sort();
  leafNodes.sort();

  expect(rootNodes).toEqual(['five', 'one', 'seven']);
  expect(leafNodes).toEqual(['four', 'seven', 'six']);
});

test('missing parent', () => {
  const dag: DagConfiguration<{}> = {
    one: {
      run: noop,
    },
    two: {
      parents: ['one', 'three'],
      run: noop,
    },
  };

  expect(() => compileDag(dag)).toThrow(`Node 'two' has unknown parent 'three'`);
});

test('cycle at root', () => {
  const dag: DagConfiguration<{}> = {
    one: {
      parents: ['six'],
      run: noop,
    },
    two: {
      parents: ['one'],
      run: noop,
    },
    three: {
      parents: ['one', 'two'],
      run: noop,
    },
    four: {
      parents: ['three'],
      run: noop,
    },
    five: {
      run: noop,
    },
    six: {
      parents: ['five', 'three'],
      run: noop,
    },
    seven: {
      run: noop,
    },
  };

  expect(() => compileDag(dag)).toThrow('Cycle detected: one -> six -> three -> one');
});

test('cycle in the middle', () => {
  const dag: DagConfiguration<{}> = {
    one: {
      run: noop,
    },
    two: {
      parents: ['one', 'four'],
      run: noop,
    },
    three: {
      parents: ['one', 'two'],
      run: noop,
    },
    four: {
      parents: ['three'],
      run: noop,
    },
    five: {
      parents: ['four'],
      run: noop,
    },
  };

  expect(() => compileDag(dag)).toThrow('Cycle detected: two -> four -> three -> two');
});

test('two-node cycle', () => {
  const dag: DagConfiguration<{}> = {
    one: {
      parents: ['two'],
      run: noop,
    },
    two: {
      parents: ['one'],
      run: noop,
    },
  };

  expect(() => compileDag(dag)).toThrow('Cycle detected: one -> two -> one');
});

test('no nodes', () => {
  expect(() => new CompiledDag({ name: 'test', nodes: {} })).toThrow('DAG has no nodes');
});
