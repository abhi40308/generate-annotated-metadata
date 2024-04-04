import {memoize, omit} from 'lodash'
import {DEFAULT_OPTIONS, Options} from './index'
import {
  AST,
  ASTWithStandaloneName,
  hasComment,
  hasStandaloneName,
  T_ANY,
  TArray,
  TEnum,
  TInterface,
  TIntersection,
  TNamedInterface,
  TUnion,
  T_UNKNOWN,
} from './types/AST'
import {log, toSafeString} from './utils'

export function generate(ast: AST, options = DEFAULT_OPTIONS): string {
  const prefix = `import { DocumentUri } from 'vscode-languageserver';
  import { Node, Pair, isMap, isScalar, isSeq } from 'yaml';
  
  export class Annotated {
    node: Node;
    uri: DocumentUri;
  
    constructor(node: Node, uri: DocumentUri) {
      this.node = node;
      this.uri = uri;
    }
  }
  
  export class AnnotatedString extends Annotated {
    get value() {
      if (isScalar(this.node) && typeof this.node.value === 'string') {
        return this.node.value;
      }
    }
  }
  
  export class AnnotatedBoolean extends Annotated {
    get value() {
      if (isScalar(this.node) && typeof this.node.value === 'boolean') {
        return this.node.value;
      }
    }
  }
  
  // Represent the SecretValue schema of OpenDDS
  // https://github.com/hasura/open-data-domain-specification/blob/main/jsonschema/metadata_object.jsonschema#L643
  export class AnnotatedSecretValue extends Annotated {
    get value() {
      return getMapEntry(this.node, 'value', this.uri, AnnotatedString);
    }
    get stringValueFromSecret() {
      return getMapEntry(this.node, 'stringValueFromSecret', this.uri, AnnotatedString);
    }
  }
  
  export class Any extends Annotated {
    get(key: string) {
      return getMapEntry(this.node, key, this.uri, Any);
    }
  }
  
  export class Map<V extends Annotated> extends Annotated {
    private ctor: AnnotatedConstructor<V>;
    constructor(node: Node, uri: DocumentUri, ctor: AnnotatedConstructor<V>) {
      super(node, uri);
      this.ctor = ctor;
    }
    keys(): AnnotatedString[] {
      if (isMap(this.node)) {
        return this.node.items.map((pair) => {
          return new AnnotatedString(pair.key as Node, this.uri);
        });
      }
      return [];
    }
    values(): V[] {
      if (isMap(this.node)) {
        return this.node.items.map((pair) => {
          return new this.ctor(pair.value as Node, this.uri) as V;
        });
      }
      return [];
    }
    entries(): [AnnotatedString, V][] {
      if (isMap(this.node)) {
        return this.node.items.map((pair) => {
          return [new AnnotatedString(pair.key as Node, this.uri), new this.ctor(pair.value as Node, this.uri) as V];
        });
      }
      return [];
    }
    get(key: string): V | undefined {
      if (isMap(this.node)) {
        const node = this.node.items.find((pair) => ((pair.key as AnnotatedString).value as string) === key)?.value;
        return node ? (new this.ctor(node as Node, this.uri) as V) : undefined;
      }
      return undefined;
    }
  }
  
  export class MapEntry<T extends Annotated> {
    keyNode: Node;
    value: T;
    uri: DocumentUri;
  
    get key() {
      return new AnnotatedString(this.keyNode, this.uri).value;
    }
  
    constructor(keyNode: Node, value: T, uri: DocumentUri) {
      this.keyNode = keyNode;
      this.value = value;
      this.uri = uri;
    }
  }
  
  export class Sequence<T extends Annotated> extends Annotated {
    private ctor: AnnotatedConstructor<T>;
    constructor(node: Node, uri: DocumentUri, ctor: AnnotatedConstructor<T>) {
      super(node, uri);
      this.ctor = ctor;
    }
    items() {
      if (isSeq(this.node)) {
        return this.node.items.map((item) => new this.ctor(item as Node, this.uri));
      }
    }
  
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    get() {
      return undefined;
    }
  }
  
  interface AnnotatedConstructor<T extends Annotated> {
    new (node: Node, uri: DocumentUri): T;
  }
  
  function getMapEntry<T extends Annotated>(node: Node, key: string, uri: DocumentUri, ctor: AnnotatedConstructor<T>) {
    return getMapEntryWith(node, key, uri, (pair) => new ctor(pair.value as Node, uri));
  }
  
  function getMapEntrySequence<T extends Annotated>(node: Node, key: string, uri: DocumentUri, ctor: AnnotatedConstructor<T>) {
    return getMapEntryWith<Sequence<T>>(node, key, uri, (pair) => new Sequence<T>(pair.value as Node, uri, ctor));
  }
  
  function getMapEntryMap<T extends Annotated>(node: Node, key: string, uri: DocumentUri, ctor: AnnotatedConstructor<T>) {
    return getMapEntryWith<Map<T>>(node, key, uri, (pair) => new Map<T>(pair.value as Node, uri, ctor));
  }
  
  function getMapEntryWith<T extends Annotated>(
    node: Node,
    key: string,
    uri: DocumentUri,
    fn: (pair: Pair<unknown, unknown>) => T
  ) {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (isScalar(pair.key) && pair.key.value == key) {
          return new MapEntry<T>(pair.key, fn(pair), uri);
        }
      }
    }
  }`

  const types =
    [
      options.bannerComment,
      declareNamedTypes(ast, options, ast.standaloneName!),
      declareNamedInterfaces(ast, options, ast.standaloneName!),
      declareEnums(ast, options),
    ]
      .filter(Boolean)
      .join('\n\n') + '\n' // trailing newline

  return prefix + types
}

function declareEnums(ast: AST, options: Options, processed = new Set<AST>()): string {
  if (processed.has(ast)) {
    return ''
  }

  processed.add(ast)
  let type = ''

  switch (ast.type) {
    case 'ENUM':
      return generateStandaloneEnum(ast, options) + '\n'
    case 'ARRAY':
      return declareEnums(ast.params, options, processed)
    case 'UNION':
    case 'INTERSECTION':
      return ast.params.reduce((prev, ast) => prev + declareEnums(ast, options, processed), '')
    case 'TUPLE':
      type = ast.params.reduce((prev, ast) => prev + declareEnums(ast, options, processed), '')
      if (ast.spreadParam) {
        type += declareEnums(ast.spreadParam, options, processed)
      }
      return type
    case 'INTERFACE':
      return getSuperTypesAndParams(ast).reduce((prev, ast) => prev + declareEnums(ast, options, processed), '')
    default:
      return ''
  }
}

function declareNamedInterfaces(ast: AST, options: Options, rootASTName: string, processed = new Set<AST>()): string {
  if (processed.has(ast)) {
    return ''
  }

  processed.add(ast)
  let type = ''

  switch (ast.type) {
    case 'ARRAY':
      type = declareNamedInterfaces((ast as TArray).params, options, rootASTName, processed)
      break
    case 'INTERFACE':
      type = [
        hasStandaloneName(ast) &&
          (ast.standaloneName === rootASTName || options.declareExternallyReferenced) &&
          generateStandaloneInterface(ast, options),
        getSuperTypesAndParams(ast)
          .map(ast => declareNamedInterfaces(ast, options, rootASTName, processed))
          .filter(Boolean)
          .join('\n'),
      ]
        .filter(Boolean)
        .join('\n')
      break
    case 'INTERSECTION':
    case 'TUPLE':
    case 'UNION':
      type = ast.params
        .map(_ => declareNamedInterfaces(_, options, rootASTName, processed))
        .filter(Boolean)
        .join('\n')
      if (ast.type === 'TUPLE' && ast.spreadParam) {
        type += declareNamedInterfaces(ast.spreadParam, options, rootASTName, processed)
      }
      break
    default:
      type = ''
  }

  return type
}

function declareNamedTypes(ast: AST, options: Options, rootASTName: string, processed = new Set<AST>()): string {
  if (processed.has(ast)) {
    return ''
  }

  processed.add(ast)

  switch (ast.type) {
    case 'ARRAY':
      return [
        declareNamedTypes(ast.params, options, rootASTName, processed),
        hasStandaloneName(ast) ? generateStandaloneType(ast, options) : undefined,
      ]
        .filter(Boolean)
        .join('\n')
    case 'ENUM':
      return ''
    case 'INTERFACE':
      return getSuperTypesAndParams(ast)
        .map(
          ast =>
            (ast.standaloneName === rootASTName || options.declareExternallyReferenced) &&
            declareNamedTypes(ast, options, rootASTName, processed),
        )
        .filter(Boolean)
        .join('\n')
    case 'INTERSECTION':
    case 'TUPLE':
    case 'UNION':
      return [
        hasStandaloneName(ast) ? generateStandaloneType(ast, options) : undefined,
        ast.params
          .map(ast => declareNamedTypes(ast, options, rootASTName, processed))
          .filter(Boolean)
          .join('\n'),
        'spreadParam' in ast && ast.spreadParam
          ? declareNamedTypes(ast.spreadParam, options, rootASTName, processed)
          : undefined,
      ]
        .filter(Boolean)
        .join('\n')
    default:
      if (hasStandaloneName(ast)) {
        return generateStandaloneType(ast, options)
      }
      return ''
  }
}

function generateTypeUnmemoized(ast: AST, options: Options): string {
  const type = generateRawType(ast, options)

  if (options.strictIndexSignatures && ast.keyName === '[k: string]') {
    return `${type} | undefined`
  }

  return type
}
export const generateType = memoize(generateTypeUnmemoized)

function generateRawType(ast: AST, options: Options): string {
  log('magenta', 'generator', ast)

  if (hasStandaloneName(ast)) {
    return toSafeString(ast.standaloneName)
  }

  switch (ast.type) {
    case 'ANY':
      return 'any'
    case 'ARRAY':
      return (() => {
        const type = generateType(ast.params, options)
        return type.endsWith('"') ? '(' + type + ')[]' : type + '[]'
      })()
    case 'BOOLEAN':
      return 'boolean'
    case 'INTERFACE':
      return generateInterface(ast, options)
    case 'INTERSECTION':
      return generateSetOperation(ast, options)
    case 'LITERAL':
      return JSON.stringify(ast.params)
    case 'NEVER':
      return 'never'
    case 'NUMBER':
      return 'number'
    case 'NULL':
      return 'null'
    case 'OBJECT':
      return 'object'
    case 'REFERENCE':
      return ast.params
    case 'STRING':
      return 'string'
    case 'TUPLE':
      return (() => {
        const minItems = ast.minItems
        const maxItems = ast.maxItems || -1

        let spreadParam = ast.spreadParam
        const astParams = [...ast.params]
        if (minItems > 0 && minItems > astParams.length && ast.spreadParam === undefined) {
          // this is a valid state, and JSONSchema doesn't care about the item type
          if (maxItems < 0) {
            // no max items and no spread param, so just spread any
            spreadParam = options.unknownAny ? T_UNKNOWN : T_ANY
          }
        }
        if (maxItems > astParams.length && ast.spreadParam === undefined) {
          // this is a valid state, and JSONSchema doesn't care about the item type
          // fill the tuple with any elements
          for (let i = astParams.length; i < maxItems; i += 1) {
            astParams.push(options.unknownAny ? T_UNKNOWN : T_ANY)
          }
        }

        function addSpreadParam(params: string[]): string[] {
          if (spreadParam) {
            const spread = '...(' + generateType(spreadParam, options) + ')[]'
            params.push(spread)
          }
          return params
        }

        function paramsToString(params: string[]): string {
          return '[' + params.join(', ') + ']'
        }

        const paramsList = astParams.map(param => generateType(param, options))

        if (paramsList.length > minItems) {
          /*
        if there are more items than the min, we return a union of tuples instead of
        using the optional element operator. This is done because it is more typesafe.

        // optional element operator
        type A = [string, string?, string?]
        const a: A = ['a', undefined, 'c'] // no error

        // union of tuples
        type B = [string] | [string, string] | [string, string, string]
        const b: B = ['a', undefined, 'c'] // TS error
        */

          const cumulativeParamsList: string[] = paramsList.slice(0, minItems)
          const typesToUnion: string[] = []

          if (cumulativeParamsList.length > 0) {
            // actually has minItems, so add the initial state
            typesToUnion.push(paramsToString(cumulativeParamsList))
          } else {
            // no minItems means it's acceptable to have an empty tuple type
            typesToUnion.push(paramsToString([]))
          }

          for (let i = minItems; i < paramsList.length; i += 1) {
            cumulativeParamsList.push(paramsList[i])

            if (i === paramsList.length - 1) {
              // only the last item in the union should have the spread parameter
              addSpreadParam(cumulativeParamsList)
            }

            typesToUnion.push(paramsToString(cumulativeParamsList))
          }

          return typesToUnion.join('|')
        }

        // no max items so only need to return one type
        return paramsToString(addSpreadParam(paramsList))
      })()
    case 'UNION':
      return generateSetOperation(ast, options)
    case 'UNKNOWN':
      return 'unknown'
    case 'CUSTOM_TYPE':
      return ast.params
  }
}

function isAnnotatedString(key: string) {
  return key === 'STRING' || key === 'ENUM' || key === 'LITERAL' || key === 'NUMBER' || key === 'UNKNOWN'
}

/**
 * Generate a Union or Intersection
 */
function generateSetOperation(ast: TIntersection | TUnion, options: Options): string {
  const members = (ast as TUnion).params.map(_ => generateType(_, options))
  const separator = ast.type === 'UNION' ? '|' : '&'
  return members.length === 1 ? members[0] : '(' + members.join(' ' + separator + ' ') + ')'
}

function getMapEntryPrefix(mapEntryKind?: 'BASIC' | 'ARRAY' | 'MAP'): string {
  if (mapEntryKind === 'BASIC') return 'getMapEntry'
  else if (mapEntryKind === 'ARRAY') return 'getMapEntrySequence'
  else if (mapEntryKind === 'MAP') return 'getMapEntryMap'
  return ''
}

function generateEndNodes(
  keyName: string,
  type: string,
  paramType: string,
  isRequired: boolean,
  standaloneName?: string,
  comment?: string,
  deprecated?: boolean,
  mapEntryKind?: 'BASIC' | 'ARRAY' | 'MAP',
): string {
  const mapEntryPrefix = getMapEntryPrefix(mapEntryKind)
  const commentString = comment ? generateComment(comment, deprecated) + '\n' : ''
  if (standaloneName) {
    const res =
      commentString +
      'get ' +
      escapeKeyName(keyName) +
      `() {\n return ${mapEntryPrefix}(this.node, '${escapeKeyName(keyName)}', this.uri, ${standaloneName})` +
      '\n}'
    return res
  } else if (isAnnotatedString(paramType)) {
    const res =
      commentString +
      'get ' +
      escapeKeyName(keyName) +
      `() {\n return ${mapEntryPrefix}(this.node, '${escapeKeyName(keyName)}', this.uri, AnnotatedString)` +
      '\n}'
    return res
  } else if (paramType === 'BOOLEAN') {
    const res =
      commentString +
      'get ' +
      escapeKeyName(keyName) +
      `() {\n return ${mapEntryPrefix}(this.node, '${escapeKeyName(keyName)}', this.uri, AnnotatedBoolean)` +
      '\n}'
    return res
  } else {
    // print default string
    const res = commentString + escapeKeyName(keyName) + (isRequired ? '' : '?') + ': ' + type
    return res
  }
}

function handleUnionRecursively(
  ast: TIntersection | TUnion,
  keyName: string,
  type: string,
  isRequired: boolean,
): string {
  if (ast.params[0].type === 'ARRAY') {
    let standaloneName = ast.params[0].standaloneName
    if (!standaloneName) standaloneName = ast.params[0].params.standaloneName
    return generateEndNodes(
      keyName,
      type,
      ast.params[0].params.type,
      isRequired,
      standaloneName,
      ast.comment,
      ast.deprecated,
      'ARRAY',
    )
  } else if (
    ast.params[0].type === 'INTERFACE' &&
    !ast.params[0].standaloneName &&
    ast.params[0].params.length === 1 &&
    escapeKeyName(ast.params[0].params[0].keyName) === '[k: string]'
  ) {
    const standaloneName = ast.params[0].params[0].ast.standaloneName
    return generateEndNodes(
      keyName,
      type,
      ast.params[0].params[0].ast.type,
      isRequired,
      standaloneName,
      ast.comment,
      ast.deprecated,
      'MAP',
    )
  } else {
    let standaloneName = ast.standaloneName
    if (!standaloneName) standaloneName = ast.params[0].standaloneName
    return generateEndNodes(
      keyName,
      type,
      ast.params[0].type,
      isRequired,
      standaloneName,
      ast.comment,
      ast.deprecated,
      'BASIC',
    )
  }
}

function generateInterface(ast: TInterface, options: Options): string {
  const allKeys = ast.params
    .filter(_ => !_.isPatternProperty && !_.isUnreachableDefinition)
    .filter(({keyName}) => escapeKeyName(keyName) !== '[k: string]')
    .map(({keyName}) => escapeKeyName(keyName))

  return (
    `{` +
    '\n' +
    ast.params
      .filter(_ => !_.isPatternProperty && !_.isUnreachableDefinition)
      .map(
        ({isRequired, keyName, ast}) =>
          [isRequired, keyName, ast, generateType(ast, options)] as [boolean, string, AST, string],
      )
      .map(([isRequired, keyName, ast, type]) => {
        if (isAnnotatedString(ast.type) && escapeKeyName(keyName) !== '[k: string]') {
          const res =
            (hasComment(ast) ? generateComment(ast.comment, ast.deprecated) + '\n' : '') +
            'get ' +
            escapeKeyName(keyName) +
            `() {\n return getMapEntry(this.node, '${escapeKeyName(keyName)}', this.uri, AnnotatedString)` +
            '\n}'
          return res
        } else if (ast.type === 'BOOLEAN' && escapeKeyName(keyName) !== '[k: string]') {
          const res =
            (hasComment(ast) ? generateComment(ast.comment, ast.deprecated) + '\n' : '') +
            'get ' +
            escapeKeyName(keyName) +
            `() {\n return getMapEntry(this.node, '${escapeKeyName(keyName)}', this.uri, AnnotatedBoolean)` +
            '\n}'
          return res
        } else if (ast.type === 'INTERFACE' && ast.standaloneName && escapeKeyName(keyName) !== '[k: string]') {
          const res =
            (hasComment(ast) ? generateComment(ast.comment, ast.deprecated) + '\n' : '') +
            'get ' +
            escapeKeyName(keyName) +
            `() {\n return getMapEntry(this.node, '${escapeKeyName(keyName)}', this.uri, ${ast.standaloneName})` +
            '\n}'
          return res
        } else if (ast.type === 'ARRAY' && escapeKeyName(keyName) !== '[k: string]') {
          return generateEndNodes(
            keyName,
            type,
            ast.params.type,
            isRequired,
            ast.params.standaloneName,
            ast.comment,
            ast.deprecated,
            'ARRAY',
          )
        } else if (
          (ast.type === 'UNION' || ast.type === 'INTERSECTION') &&
          escapeKeyName(keyName) !== '[k: string]' &&
          ast.params.length === 1
        ) {
          return handleUnionRecursively(ast, keyName, type, isRequired)
        } else if (
          ast.type === 'INTERFACE' &&
          !ast.standaloneName &&
          ast.params.length === 1 &&
          escapeKeyName(ast.params[0].keyName) === '[k: string]'
        ) {
          const standaloneName = ast.params[0].ast.standaloneName
          return generateEndNodes(
            keyName,
            type,
            ast.params[0].ast.type,
            isRequired,
            standaloneName,
            ast.comment,
            ast.deprecated,
            'MAP',
          )
        } else if (allKeys.length > 0) {
          if (escapeKeyName(keyName) !== '[k: string]') {
            const res =
              (hasComment(ast) && !ast.standaloneName ? generateComment(ast.comment, ast.deprecated) + '\n' : '') +
              escapeKeyName(keyName) +
              (isRequired ? '' : '?') +
              ': ' +
              type
            return res
          }
        } else {
          const res =
            (hasComment(ast) && !ast.standaloneName ? generateComment(ast.comment, ast.deprecated) + '\n' : '') +
            escapeKeyName(keyName) +
            (isRequired ? '' : '?') +
            ': ' +
            type
          return res
        }
      })
      .join('\n') +
    (allKeys.length > 0 ? `\n get __keys() {\n return [${allKeys.map(key => `'${key}'`)}] }\n` : '') +
    '\n}'
  )
}

function generateComment(comment?: string, deprecated?: boolean): string {
  const commentLines = ['/**']
  if (deprecated) {
    commentLines.push(' * @deprecated')
  }
  if (typeof comment !== 'undefined') {
    commentLines.push(...comment.split('\n').map(_ => ' * ' + _))
  }
  commentLines.push(' */')
  return commentLines.join('\n')
}

function generateStandaloneEnum(ast: TEnum, options: Options): string {
  return (
    (hasComment(ast) ? generateComment(ast.comment, ast.deprecated) + '\n' : '') +
    'export ' +
    (options.enableConstEnums ? 'const ' : '') +
    `enum ${toSafeString(ast.standaloneName)} {` +
    '\n' +
    ast.params.map(({ast, keyName}) => keyName + ' = ' + generateType(ast, options)).join(',\n') +
    '\n' +
    '}'
  )
}

function generateStandaloneInterface(ast: TNamedInterface, options: Options): string {
  return (
    (hasComment(ast) ? generateComment(ast.comment, ast.deprecated) + '\n' : '') +
    `export class ${toSafeString(ast.standaloneName)} extends Annotated ` +
    (ast.superTypes.length > 0
      ? `extends ${ast.superTypes.map(superType => toSafeString(superType.standaloneName)).join(', ')} `
      : '') +
    generateInterface(ast, options)
  )
}

function generateStandaloneType(ast: ASTWithStandaloneName, options: Options): string {
  const generatedType = generateType(omit<AST>(ast, 'standaloneName') as AST /* TODO */, options)

  const suffix = generatedType.startsWith('{')
    ? `export class ${toSafeString(ast.standaloneName)} extends Annotated ${generatedType}`
    : `export type ${toSafeString(ast.standaloneName)} = ${generatedType}`

  return (hasComment(ast) ? generateComment(ast.comment) + '\n' : '') + suffix
}

function escapeKeyName(keyName: string): string {
  if (keyName.length && /[A-Za-z_$]/.test(keyName.charAt(0)) && /^[\w$]+$/.test(keyName)) {
    return keyName
  }
  if (keyName === '[k: string]') {
    return keyName
  }
  return JSON.stringify(keyName)
}

function getSuperTypesAndParams(ast: TInterface): AST[] {
  return ast.params.map(param => param.ast).concat(ast.superTypes)
}
