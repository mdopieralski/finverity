// Validates real responses against the OpenAPI document the app serves, so docs cannot drift from code
// (the ingrid pattern, test group F). @nestjs/swagger emits OpenAPI 3.0, whose `nullable: true` is not
// JSON Schema: it is rewritten to a type union before Ajv compiles anything.
import type { OpenAPIObject } from '@nestjs/swagger';
import { Ajv, type ValidateFunction } from 'ajv';
import { expect } from 'vitest';

import type { Res } from './app.js';

const toJsonSchema = (node: unknown): unknown => {
  if (Array.isArray(node)) {
    return node.map(toJsonSchema);
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = toJsonSchema(v);
  }
  if (out.nullable === true) {
    delete out.nullable;
    if (typeof out.type === 'string') {
      out.type = [out.type, 'null'];
    }
    if (Array.isArray(out.enum)) {
      out.enum = [...out.enum, null];
    }
  }
  return out;
};

export function specValidator(spec: OpenAPIObject) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema({ $id: 'spec', components: toJsonSchema(spec.components) as object });
  const cache = new Map<string, ValidateFunction>();

  return function expectMatchesSpec(res: Res, method: string, path: string): void {
    const operation = (spec.paths[path] as Record<string, any> | undefined)?.[method.toLowerCase()];
    expect(operation, `${method} ${path} is not documented`).toBeTruthy();
    const response = operation.responses[String(res.status)];
    expect(response, `${method} ${path} → ${res.status} is not documented`).toBeTruthy();
    const schema = response.content?.['application/json']?.schema;
    expect(schema, `${method} ${path} → ${res.status} documents no JSON body`).toBeTruthy();
    const key = `${method} ${path} ${res.status}`;
    let validate = cache.get(key);
    if (!validate) {
      const rewritten = JSON.stringify(toJsonSchema(schema)).replaceAll(
        '"#/components/',
        '"spec#/components/'
      );
      validate = ajv.compile(JSON.parse(rewritten));
      cache.set(key, validate);
    }
    expect(validate(res.body), `${key}: ${JSON.stringify(validate.errors)}`).toBe(true);
  };
}

/** Every [method, path template] the spec documents. */
export const operations = (spec: OpenAPIObject): [string, string][] =>
  Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item as object)
      .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
      .map((m): [string, string] => [m.toUpperCase(), path])
  );
