import {
  baseCompile,
  baseParse,
  CompilerOptions,
  CodegenResult,
  ParserOptions,
  RootNode,
  noopDirectiveTransform,
  NodeTransform,
  DirectiveTransform
} from '@vue/compiler-core'
import { parserOptions } from './parserOptions'
import { transformStyle } from './transforms/transformStyle'
import { transformVHtml } from './transforms/vHtml'
import { transformVText } from './transforms/vText'
import { transformModel } from './transforms/vModel'
import { transformOn } from './transforms/vOn'
import { transformShow } from './transforms/vShow'
import { warnTransitionChildren } from './transforms/warnTransitionChildren'
import { stringifyStatic } from './transforms/stringifyStatic'
import { extend } from '@vue/shared'

export { parserOptions }

export const DOMNodeTransforms: NodeTransform[] = [
  transformStyle,
  ...(__DEV__ ? [warnTransitionChildren] : [])
]

export const DOMDirectiveTransforms: Record<string, DirectiveTransform> = {
  cloak: noopDirectiveTransform,
  html: transformVHtml,
  text: transformVText,
  model: transformModel, // override compiler-core
  on: transformOn, // override compiler-core
  show: transformShow
}

// web 平台编译函数入口
export function compile(
  template: string,
  options: CompilerOptions = {}
): CodegenResult {
  // 合并了与 dom 平台相关编译选项后真正执行的编译函数交给与平台实现无关的 baseCompile 去进行编译处理
  // baseCompile 在 @vue/compiler-core 内实现
  return baseCompile(
    template,
    // 编译选项合并
    // CompilerOptions 包含三大模块：ParserOptions、TransformOptions、CodegenOptions
    // 这里 parserOptions 实现了 ParserOptions
    // nodeTransforms 是 TransformOptions 内的选项，包含了 style/transtion 属性的转换为 ast 的函数
    // directiveTransform 是 TransformOptions 内的选项，包含了指令转换为 ast 的函数
    extend({}, parserOptions, options, {
      nodeTransforms: [...DOMNodeTransforms, ...(options.nodeTransforms || [])],
      directiveTransforms: extend(
        {},
        DOMDirectiveTransforms,
        options.directiveTransforms || {}
      ),
      transformHoist: __BROWSER__ ? null : stringifyStatic
    })
  )
}

export function parse(template: string, options: ParserOptions = {}): RootNode {
  return baseParse(template, extend({}, parserOptions, options))
}

export * from './runtimeHelpers'
export { transformStyle } from './transforms/transformStyle'
export { createDOMCompilerError, DOMErrorCodes } from './errors'
export * from '@vue/compiler-core'
