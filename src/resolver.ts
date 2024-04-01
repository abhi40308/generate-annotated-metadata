// import $RefParser = require('@bcherny/json-schema-ref-parser')
import $RefParser1 = require('@apidevtools/json-schema-ref-parser')
import {JSONSchema} from './types/JSONSchema'
import {log} from './utils'

export type DereferencedPaths = WeakMap<$RefParser1.JSONSchema, string>

export async function dereference(
  schema: JSONSchema,
  {cwd, $refOptions}: {cwd: string; $refOptions: $RefParser1.ParserOptions},
): Promise<{dereferencedPaths: DereferencedPaths; dereferencedSchema: JSONSchema}> {
  log('green', 'dereferencer', 'Dereferencing input schema:', cwd, schema)
  const parser = new $RefParser1.$RefParser()
  const dereferencedPaths: DereferencedPaths = new WeakMap()
  const dereferencedSchema = (await parser.dereference(cwd, schema as any, {
    ...$refOptions,
    dereference: {
      ...$refOptions.dereference,
      onDereference($ref: any, schema: any) {
        dereferencedPaths.set(schema, $ref)
      },
    },
  })) as any // TODO: fix types
  return {dereferencedPaths, dereferencedSchema}
}
