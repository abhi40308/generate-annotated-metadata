import {uniqBy} from 'lodash'
import {Options} from '.'
import {generateType} from './generator'
import {AST, TInterface, TInterfaceParam, T_ANY, T_INTERFACE, T_STRING, T_UNKNOWN} from './types/AST'
import {log} from './utils'

export function optimize(ast: AST, options: Options, processed = new Set<AST>()): AST {
  if (processed.has(ast)) {
    return ast
  }

  processed.add(ast)

  switch (ast.type) {
    case 'LITERAL':
      if (ast.comment) {
        return {...T_STRING, comment: ast.comment}
      } else {
        return T_STRING
      }
    case 'ARRAY':
      ast = Object.assign(ast, {
        params: optimize(ast.params, options, processed),
      })

      if (ast.params.standaloneName && ast.params.type === 'STRING') {
        if (ast.params.comment) {
          ast = Object.assign(ast, {
            params: {...T_STRING, comment: ast.params.comment},
          })
        } else {
          ast = Object.assign(ast, {
            params: T_STRING,
          })
        }
      }

      return ast
    case 'TUPLE':
      ast = Object.assign(ast, {
        params: ast.params.map(_ => optimize(_, options, processed)),
      })
      return ast
    case 'INTERFACE':
      ast = Object.assign(ast, {
        params: ast.params.map(_ => Object.assign(_, {ast: optimize(_.ast, options, processed)})),
      })

      ast = Object.assign(ast, {
        params: ast.params.map(_ => {
          if (_.ast.standaloneName && _.ast.type === 'STRING') {
            if (_.ast.comment) {
              return Object.assign(_, {ast: {...T_STRING, comment: _.ast.comment}})
            } else {
              return Object.assign(_, {ast: T_STRING})
            }
          }
          return _
        }),
      })

      ast = optimize(ast, options, processed)

      return ast
    case 'INTERSECTION':
    case 'UNION':
      // Start with the leaves...
      const optimizedAST = Object.assign(ast, {
        params: ast.params.map(_ => optimize(_, options, processed)),
      })

      // [A, B, C, null] -> [A, B, C]
      if (optimizedAST.params.some(_ => _.type === 'NULL')) {
        optimizedAST.params = optimizedAST.params.filter(_ => _.type !== 'NULL')
      }

      // [A, B, C, Any] -> Any
      if (optimizedAST.params.some(_ => _.type === 'ANY')) {
        log('cyan', 'optimizer', '[A, B, C, Any] -> Any', optimizedAST)
        return T_ANY
      }

      // [A, B, C, Unknown] -> Unknown
      if (optimizedAST.params.some(_ => _.type === 'UNKNOWN')) {
        log('cyan', 'optimizer', '[A, B, C, Unknown] -> Unknown', optimizedAST)
        return T_UNKNOWN
      }

      // [union of string literals] -> string
      if (optimizedAST.params.every(_ => _.type === 'LITERAL' || _.type === 'STRING' || _.type === 'NULL')) {
        if (optimizedAST.comment) {
          return {...T_STRING, comment: optimizedAST.comment}
        } else {
          return T_STRING
        }
      }

      // [A (named), A] -> [A (named)]
      if (
        optimizedAST.params.every(_ => {
          const a = generateType(omitStandaloneName(_), options)
          const b = generateType(omitStandaloneName(optimizedAST.params[0]), options)
          return a === b
        }) &&
        optimizedAST.params.some(_ => _.standaloneName !== undefined)
      ) {
        log('cyan', 'optimizer', '[A (named), A] -> [A (named)]', optimizedAST)
        optimizedAST.params = optimizedAST.params.filter(_ => _.standaloneName !== undefined)
      }

      // [A, B, B] -> [A, B]
      const params = uniqBy(optimizedAST.params, _ => generateType(_, options))
      if (params.length !== optimizedAST.params.length) {
        log('cyan', 'optimizer', '[A, B, B] -> [A, B]', optimizedAST)
        optimizedAST.params = params
      }

      // [union of interfaces] -> combine all unique keys into a single interface
      // 1. if there are multiple keys with same name, only considers the first one encountered
      // 2. if interface has standalone name, make it inline interface by removing the standalone name in optimizedAST.params (due to using T_INTERFACE)
      if (optimizedAST.params.length > 1 && optimizedAST.params.every(_ => _.type === 'INTERFACE')) {
        const acc: TInterfaceParam[] = []

        ;(optimizedAST.params as TInterface[]).forEach(param => {
          param.params.forEach(p => {
            if (!acc.some(a => a.keyName === p.keyName)) {
              acc.push(p)
            }
          })
        })
        return Object.assign(optimizedAST, {
          params: [T_INTERFACE(acc, optimizedAST.comment)],
        })
      }

      return Object.assign(optimizedAST, {
        params: optimizedAST.params.map(_ => optimize(_, options, processed)),
      })
    default:
      return ast
  }
}

// TODO: More clearly disambiguate standalone names vs. aliased names instead.
function omitStandaloneName<A extends AST>(ast: A): A {
  switch (ast.type) {
    case 'ENUM':
      return ast
    default:
      return {...ast, standaloneName: undefined}
  }
}
