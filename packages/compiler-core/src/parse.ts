import { ParserOptions } from './options'
import { NO, isArray, makeMap, extend } from '@vue/shared'
import { ErrorCodes, createCompilerError, defaultOnError } from './errors'
import {
  assert,
  advancePositionWithMutation,
  advancePositionWithClone,
  isCoreComponent
} from './utils'
import {
  Namespaces,
  AttributeNode,
  CommentNode,
  DirectiveNode,
  ElementNode,
  ElementTypes,
  ExpressionNode,
  NodeTypes,
  Position,
  RootNode,
  SourceLocation,
  TextNode,
  TemplateChildNode,
  InterpolationNode,
  createRoot
} from './ast'

type OptionalOptions = 'isNativeTag' | 'isBuiltInComponent'
type MergedParserOptions = Omit<Required<ParserOptions>, OptionalOptions> &
  Pick<ParserOptions, OptionalOptions>

// The default decoder only provides escapes for characters reserved as part of
// the template syntax, and is only used if the custom renderer did not provide
// a platform-specific decoder.
const decodeRE = /&(gt|lt|amp|apos|quot);/g
const decodeMap: Record<string, string> = {
  gt: '>',
  lt: '<',
  amp: '&',
  apos: "'",
  quot: '"'
}

// 默认的编译选项
export const defaultParserOptions: MergedParserOptions = {
  delimiters: [`{{`, `}}`],
  getNamespace: () => Namespaces.HTML,
  getTextMode: () => TextModes.DATA,
  isVoidTag: NO,
  isPreTag: NO,
  isCustomElement: NO,
  decodeEntities: (rawText: string): string =>
    rawText.replace(decodeRE, (_, p1) => decodeMap[p1]),
  onError: defaultOnError
}

// 文本模式枚举
// DATA 表示正常的元素标签文本
// RCDATA 表示没有闭合标识的标签
// RAWTEXT 表示用于加载资源的标签
export const enum TextModes {
  //          | Elements | Entities | End sign              | Inside of
  DATA, //    | ✔        | ✔        | End tags of ancestors |
  RCDATA, //  | ✘        | ✔        | End tag of the parent | <textarea>
  RAWTEXT, // | ✘        | ✘        | End tag of the parent | <style>,<script>
  CDATA,
  ATTRIBUTE_VALUE
}

export interface ParserContext {
  options: MergedParserOptions
  readonly originalSource: string
  source: string
  offset: number
  line: number
  column: number
  inPre: boolean // HTML <pre> tag, preserve whitespaces
  inVPre: boolean // v-pre, do not process directives and interpolations
}

// 核心编译函数，用于将 content 字符串结合 options 编译选项生成 ast 树
export function baseParse(
  content: string,
  options: ParserOptions = {}
): RootNode {
  // 获取当前编译状态的上下文对象
  const context = createParserContext(content, options)
  // 获取当前编译的指针，包含行、列、偏移量
  const start = getCursor(context)
  // createRoot 用于生成根节点的 ast
  // parseChildren 用于生成子节点的 ast（template -> ast 核心代码）
  // getSelection 用于获取子节点编译完成之后的位置信息
  return createRoot(
    parseChildren(context, TextModes.DATA, []),
    getSelection(context, start)
  )
}

// 生成编译上下文对象
function createParserContext(
  content: string,
  options: ParserOptions
): ParserContext {
  return {
    // 编译选项，合并了默认的编译选项
    options: extend({}, defaultParserOptions, options),
    // 当前编译列
    column: 1,
    // 当前编译行
    line: 1,
    // 当前编译偏移量
    offset: 0,
    // 编译源代码
    originalSource: content,
    // 当前编译源代码
    source: content,
    // 是否是在 pre 标签内
    inPre: false,
    // 是否在 v-pre 内
    inVPre: false
  }
}

// 模板字符串通过迭代将子节点编译成 ast 的核心函数
function parseChildren(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  // ancestors中存储的最后一个元素即为当前元素的父级
  const parent = last(ancestors)
  const ns = parent ? parent.ns : Namespaces.HTML
  const nodes: TemplateChildNode[] = []

  // 通过 isEnd 判断是否处理完一个完整标签元素，否则迭代进行处理
  // 这段迭代代码关键对三种情况进行处理
  // 对文本类型的节点进行处理 parseText
  // 对 {{}} 包裹的需要解析的模板进行处理 parseInterpolation
  // 对元素节点进行处理 parseElement
  while (!isEnd(context, mode, ancestors)) {
    __TEST__ && assert(context.source.length > 0)
    const s = context.source
    let node: TemplateChildNode | TemplateChildNode[] | undefined = undefined

    if (mode === TextModes.DATA || mode === TextModes.RCDATA) {
      // 编译模板是否以 {{ 开头，这里需要特殊处理
      if (!context.inVPre && startsWith(s, context.options.delimiters[0])) {
        // '{{'
        node = parseInterpolation(context, mode)
      } else if (mode === TextModes.DATA && s[0] === '<') {
        // 这是一个标签的起始标志，可以进行元素处理了
        // https://html.spec.whatwg.org/multipage/parsing.html#tag-open-state
        if (s.length === 1) {
          // 只有一个 < 标志，无法进行处理，报错
          emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 1)
        } else if (s[1] === '!') {
          // 判断第二个字符是否为 !，为 ! 的话有以下几种情况，分别进行处理
          // https://html.spec.whatwg.org/multipage/parsing.html#markup-declaration-open-state
          if (startsWith(s, '<!--')) {
            // 是一个注释节点
            node = parseComment(context)
          } else if (startsWith(s, '<!DOCTYPE')) {
            // Ignore DOCTYPE by a limitation.
            // 是一个文档类型声明
            node = parseBogusComment(context)
          } else if (startsWith(s, '<![CDATA[')) {
            // 是特殊的 CDATA 类型
            if (ns !== Namespaces.HTML) {
              node = parseCDATA(context, ancestors)
            } else {
              emitError(context, ErrorCodes.CDATA_IN_HTML_CONTENT)
              node = parseBogusComment(context)
            }
          } else {
            emitError(context, ErrorCodes.INCORRECTLY_OPENED_COMMENT)
            node = parseBogusComment(context)
          }
        } else if (s[1] === '/') {
          // 第二个字符是 /，可能是一个结束标志，说明是一个没有正常起始标志的元素，需要报错
          // https://html.spec.whatwg.org/multipage/parsing.html#end-tag-open-state
          if (s.length === 2) {
            emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 2)
          } else if (s[2] === '>') {
            emitError(context, ErrorCodes.MISSING_END_TAG_NAME, 2)
            advanceBy(context, 3)
            continue
          } else if (/[a-z]/i.test(s[2])) {
            emitError(context, ErrorCodes.X_INVALID_END_TAG)
            parseTag(context, TagType.End, parent)
            continue
          } else {
            emitError(
              context,
              ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME,
              2
            )
            node = parseBogusComment(context)
          }
        } else if (/[a-z]/i.test(s[1])) {
          // 第二个字符是字母，可能是一个元素或组件，可以正常解析
          node = parseElement(context, ancestors)
        } else if (s[1] === '?') {
          // 第二个字符是 ?，报错处理
          emitError(
            context,
            ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
            1
          )
          node = parseBogusComment(context)
        } else {
          // 其他情况，报错处理
          emitError(context, ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME, 1)
        }
      }
    }

    // 没有起始标签标志 <，也没有 {{ 标志，当做文本进行处理
    if (!node) {
      node = parseText(context, mode)
    }

    // 将转换成 ast 的节点插入到 nodes数组中存储
    if (isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        pushNode(nodes, node[i])
      }
    } else {
      pushNode(nodes, node)
    }
  }

  // Whitespace management for more efficient output
  // (same as v2 whitespace: 'condense')
  // 空格管理为了更高效的输出，这里会将编译出来的 nodes 节点中是空格节点的 node 删除
  let removedWhitespace = false
  if (mode !== TextModes.RAWTEXT) {
    if (!context.inPre) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        if (node.type === NodeTypes.TEXT) {
          if (!/[^\t\r\n\f ]/.test(node.content)) {
            const prev = nodes[i - 1]
            const next = nodes[i + 1]
            // If:
            // - the whitespace is the first or last node, or:
            // - the whitespace is adjacent to a comment, or:
            // - the whitespace is between two elements AND contains newline
            // Then the whitespace is ignored.
            if (
              !prev ||
              !next ||
              prev.type === NodeTypes.COMMENT ||
              next.type === NodeTypes.COMMENT ||
              (prev.type === NodeTypes.ELEMENT &&
                next.type === NodeTypes.ELEMENT &&
                /[\r\n]/.test(node.content))
            ) {
              removedWhitespace = true
              nodes[i] = null as any
            } else {
              // Otherwise, condensed consecutive whitespace inside the text
              // down to a single space
              node.content = ' '
            }
          } else {
            node.content = node.content.replace(/[\t\r\n\f ]+/g, ' ')
          }
        } else if (!__DEV__ && node.type === NodeTypes.COMMENT) {
          // remove comment nodes in prod
          removedWhitespace = true
          nodes[i] = null as any
        }
      }
    } else if (parent && context.options.isPreTag(parent.tag)) {
      // remove leading newline per html spec
      // https://html.spec.whatwg.org/multipage/grouping-content.html#the-pre-element
      const first = nodes[0]
      if (first && first.type === NodeTypes.TEXT) {
        first.content = first.content.replace(/^\r?\n/, '')
      }
    }
  }

  return removedWhitespace ? nodes.filter(Boolean) : nodes
}

// 节点插入
function pushNode(nodes: TemplateChildNode[], node: TemplateChildNode): void {
  // 如果当前节点是文本节点
  if (node.type === NodeTypes.TEXT) {
    const prev = last(nodes)
    // Merge if both this and the previous node are text and those are
    // consecutive. This happens for cases like "a < b".
    // 这里是为了处理一些特殊的情况，可以将两个并列的文本字符串节点进行合并
    // 直接修改上一个文本节点的内容和结束指针即可
    if (
      prev &&
      prev.type === NodeTypes.TEXT &&
      prev.loc.end.offset === node.loc.start.offset
    ) {
      prev.content += node.content
      prev.loc.end = node.loc.end
      prev.loc.source += node.loc.source
      return
    }
  }

  nodes.push(node)
}

function parseCDATA(
  context: ParserContext,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  __TEST__ &&
    assert(last(ancestors) == null || last(ancestors)!.ns !== Namespaces.HTML)
  __TEST__ && assert(startsWith(context.source, '<![CDATA['))

  advanceBy(context, 9)
  const nodes = parseChildren(context, TextModes.CDATA, ancestors)
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_CDATA)
  } else {
    __TEST__ && assert(startsWith(context.source, ']]>'))
    advanceBy(context, 3)
  }

  return nodes
}

function parseComment(context: ParserContext): CommentNode {
  __TEST__ && assert(startsWith(context.source, '<!--'))

  const start = getCursor(context)
  let content: string

  // Regular comment.
  const match = /--(\!)?>/.exec(context.source)
  if (!match) {
    content = context.source.slice(4)
    advanceBy(context, context.source.length)
    emitError(context, ErrorCodes.EOF_IN_COMMENT)
  } else {
    if (match.index <= 3) {
      emitError(context, ErrorCodes.ABRUPT_CLOSING_OF_EMPTY_COMMENT)
    }
    if (match[1]) {
      emitError(context, ErrorCodes.INCORRECTLY_CLOSED_COMMENT)
    }
    content = context.source.slice(4, match.index)

    // Advancing with reporting nested comments.
    const s = context.source.slice(0, match.index)
    let prevIndex = 1,
      nestedIndex = 0
    while ((nestedIndex = s.indexOf('<!--', prevIndex)) !== -1) {
      advanceBy(context, nestedIndex - prevIndex + 1)
      if (nestedIndex + 4 < s.length) {
        emitError(context, ErrorCodes.NESTED_COMMENT)
      }
      prevIndex = nestedIndex + 1
    }
    advanceBy(context, match.index + match[0].length - prevIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

function parseBogusComment(context: ParserContext): CommentNode | undefined {
  __TEST__ && assert(/^<(?:[\!\?]|\/[^a-z>])/i.test(context.source))

  const start = getCursor(context)
  const contentStart = context.source[1] === '?' ? 1 : 2
  let content: string

  const closeIndex = context.source.indexOf('>')
  if (closeIndex === -1) {
    content = context.source.slice(contentStart)
    advanceBy(context, context.source.length)
  } else {
    content = context.source.slice(contentStart, closeIndex)
    advanceBy(context, closeIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

// 元素解析函数
// 最核心最复杂使用最多的编译处理函数，重点！！！
function parseElement(
  context: ParserContext,
  ancestors: ElementNode[]
): ElementNode | undefined {
  __TEST__ && assert(/^<[a-z]/i.test(context.source))

  // Start tag.
  const wasInPre = context.inPre
  const wasInVPre = context.inVPre
  const parent = last(ancestors)
  // 对一个标签进行编译，返回一个标签的 ast 表达
  const element = parseTag(context, TagType.Start, parent)
  // 是否是 pre 标签边界
  const isPreBoundary = context.inPre && !wasInPre
  // 是否是 v-pre 标签边界
  const isVPreBoundary = context.inVPre && !wasInVPre

  // 如果标签是自闭标签，或者是一个空标签，直接返回当前的 ast 表达式
  if (element.isSelfClosing || context.options.isVoidTag(element.tag)) {
    return element
  }

  // Children.
  // 后面还有元素，当前元素成为了一个父级祖先
  ancestors.push(element)
  // 判断当前元素的类型
  const mode = context.options.getTextMode(element, parent)
  // 继续解析编译子元素
  const children = parseChildren(context, mode, ancestors)
  // 编译完子元素之后，把最后一个父级元素出栈
  ancestors.pop()

  // 给当前元素指定 children
  element.children = children

  // End tag.
  if (startsWithEndTagOpen(context.source, element.tag)) {
    // 检查当前标签的结束标签是否匹配上元素的开始标签，匹配上之后，需要对结束标签进行解析
    parseTag(context, TagType.End, parent)
  } else {
    // 没有结束标签，报错
    emitError(context, ErrorCodes.X_MISSING_END_TAG, 0, element.loc.start)
    if (context.source.length === 0 && element.tag.toLowerCase() === 'script') {
      const first = children[0]
      if (first && startsWith(first.loc.source, '<!--')) {
        emitError(context, ErrorCodes.EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT)
      }
    }
  }

  element.loc = getSelection(context, element.loc.start)

  if (isPreBoundary) {
    context.inPre = false
  }
  if (isVPreBoundary) {
    context.inVPre = false
  }
  return element
}

const enum TagType {
  Start,
  End
}

const isSpecialTemplateDirective = /*#__PURE__*/ makeMap(
  `if,else,else-if,for,slot`
)

/**
 * Parse a tag (E.g. `<div id=a>`) with that type (start tag or end tag).
 */
// 解析出标签类型名称，分为两种标签类型，
function parseTag(
  context: ParserContext,
  type: TagType,
  parent: ElementNode | undefined
): ElementNode {
  __TEST__ && assert(/^<\/?[a-z]/i.test(context.source))
  __TEST__ &&
    assert(
      type === (startsWith(context.source, '</') ? TagType.End : TagType.Start)
    )

  // Tag open.
  // 获取编译指针开始的位置
  const start = getCursor(context)
  // 正则匹配捕获标签名，以 <textarea ... ></textarea>为例，会捕获到 ['<textarea', 'textarea']
  const match = /^<\/?([a-z][^\t\r\n\f />]*)/i.exec(context.source)!
  // 捕获到的第二个元素即为标签名称
  const tag = match[1]
  const ns = context.options.getNamespace(tag, parent)

  // 将指针向前进，从 < 到标签名结束
  advanceBy(context, match[0].length)
  // 从标签名结束之后的空格也需要推进，此时解决完标签名的解析
  advanceSpaces(context)

  // save current state in case we need to re-parse attributes with v-pre
  // 由于后面要进行属性的解析了，要针对 v-pre 进行特殊处理，将当前的指针位置和源模板字符串保存起来
  const cursor = getCursor(context)
  const currentSource = context.source

  // Attributes.
  // 标签属性解析，也是关键内容
  let props = parseAttributes(context, type)

  // check <pre> tag
  // 检查当前元素是不是 pre 标签
  if (context.options.isPreTag(tag)) {
    context.inPre = true
  }

  // check v-pre
  // 检查当前元素是不是携带了 v-pre 指令
  if (
    !context.inVPre &&
    props.some(p => p.type === NodeTypes.DIRECTIVE && p.name === 'pre')
  ) {
    context.inVPre = true
    // reset context
    extend(context, cursor)
    context.source = currentSource
    // re-parse attrs and filter out v-pre itself
    props = parseAttributes(context, type).filter(p => p.name !== 'v-pre')
  }

  // Tag close.
  // 以上刚好解析完了一个标签的属性，接下来要检查标签是否是自闭和标签
  let isSelfClosing = false
  if (context.source.length === 0) {
    // 没有闭合标签了，报错
    emitError(context, ErrorCodes.EOF_IN_TAG)
  } else {
    // 是以 /> 开头，表示是自闭和标签
    isSelfClosing = startsWith(context.source, '/>')
    if (type === TagType.End && isSelfClosing) {
      emitError(context, ErrorCodes.END_TAG_WITH_TRAILING_SOLIDUS)
    }
    // 如果是自闭合标签，编译指针向前进 2 位，否则中间还有内容，是以 > 结束的，前进 1 位
    advanceBy(context, isSelfClosing ? 2 : 1)
  }

  // 默认标签类型是 ELEMENT
  let tagType = ElementTypes.ELEMENT
  const options = context.options
  // 上下文不是在 v-pre 环境中，而且这个标签不是一个常规标签
  if (!context.inVPre && !options.isCustomElement(tag)) {
    // 检查这个标签的属性中是否有 is 指令，这是用于 component 内置组件用的
    const hasVIs = props.some(
      p => p.type === NodeTypes.DIRECTIVE && p.name === 'is'
    )
    if (options.isNativeTag && !hasVIs) {
      // 检查这个标签如果不是原生标签，那么它是一个 COMPONENT 组件类型标签
      if (!options.isNativeTag(tag)) tagType = ElementTypes.COMPONENT
    } else if (
      hasVIs ||
      isCoreComponent(tag) ||
      (options.isBuiltInComponent && options.isBuiltInComponent(tag)) ||
      /^[A-Z]/.test(tag) ||
      tag === 'component'
    ) {
      // 检查是不是 Vue 内置组件 component，也是一个 COMPONENT 组件类型标签
      tagType = ElementTypes.COMPONENT
    }

    if (tag === 'slot') {
      // 如果是这个标签是 slot，那么是 SLOT 插槽类型
      tagType = ElementTypes.SLOT
    } else if (
      tag === 'template' &&
      props.some(p => {
        return (
          p.type === NodeTypes.DIRECTIVE && isSpecialTemplateDirective(p.name)
        )
      })
    ) {
      // 如果标签是 template，而且属性中有携带了 template 能使用的指令属性，那么是 TEMPLATE 模板类型标签
      tagType = ElementTypes.TEMPLATE
    }
  }

  // 返回一个标签的 ast 表达
  return {
    type: NodeTypes.ELEMENT,
    ns,
    tag,
    tagType,
    props,
    isSelfClosing,
    children: [],
    loc: getSelection(context, start),
    codegenNode: undefined // to be created during transform phase
  }
}

// 标签属性解析函数
function parseAttributes(
  context: ParserContext,
  type: TagType
): (AttributeNode | DirectiveNode)[] {
  const props = []
  const attributeNames = new Set<string>()
  // 对需要编译模板字符串进行迭代遍历，直到遇到结束标志 > 或 /> 才结束
  // 对一个标签的所有属性进行迭代编译，存储进 props 数组里面，最后返回这个数组
  while (
    context.source.length > 0 &&
    !startsWith(context.source, '>') &&
    !startsWith(context.source, '/>')
  ) {
    // 遇到单独的 / 在标签内属于异常，报错处理，并将编译指针往后移动
    if (startsWith(context.source, '/')) {
      emitError(context, ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG)
      advanceBy(context, 1)
      advanceSpaces(context)
      continue
    }
    // 标签结束标志
    if (type === TagType.End) {
      emitError(context, ErrorCodes.END_TAG_WITH_ATTRIBUTES)
    }

    // 属性解析，得到一段属性的 ast 表达
    const attr = parseAttribute(context, attributeNames)
    if (type === TagType.Start) {
      // 如果是从头开始解析的属性表达，存储进数组
      props.push(attr)
    }

    if (/^[^\t\r\n\f />]/.test(context.source)) {
      // 如果到下一个属性之间没有空格，报错
      emitError(context, ErrorCodes.MISSING_WHITESPACE_BETWEEN_ATTRIBUTES)
    }
    // 编译指针向前推进，去掉空格
    advanceSpaces(context)
  }
  return props
}

// 标签属性解析
function parseAttribute(
  context: ParserContext,
  nameSet: Set<string>
): AttributeNode | DirectiveNode {
  __TEST__ && assert(/^[^\t\r\n\f />]/.test(context.source))

  // Name.
  // 获取编译开始指针
  const start = getCursor(context)
  // 以 :value="input" 为例，可以匹配到 :value
  const match = /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec(context.source)!
  const name = match[0]

  if (nameSet.has(name)) {
    // 如果属性名集合中已经有了这个属性，则报错说明有重复属性
    emitError(context, ErrorCodes.DUPLICATE_ATTRIBUTE)
  }
  // 将属性名加入集合
  nameSet.add(name)

  if (name[0] === '=') {
    // 如果属性名以 = 开头，则报错
    emitError(context, ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME)
  }
  {
    const pattern = /["'<]/g
    let m: RegExpExecArray | null
    while ((m = pattern.exec(name))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        m.index
      )
    }
  }

  // 将编译指针向前推进
  advanceBy(context, name.length)

  // Value
  let value:
    | {
        content: string
        isQuoted: boolean
        loc: SourceLocation
      }
    | undefined = undefined

  if (/^[\t\r\n\f ]*=/.test(context.source)) {
    // 匹配到 =
    advanceSpaces(context)
    advanceBy(context, 1)
    advanceSpaces(context)
    // 获取到属性值的 ast 表达
    value = parseAttributeValue(context)
    if (!value) {
      emitError(context, ErrorCodes.MISSING_ATTRIBUTE_VALUE)
    }
  }
  // 获取处理完一段属性之后的位置信息和处理内容信息
  const loc = getSelection(context, start)

  // 不在 v-pre 指令作用范围内，且属性名是以 v- : @ # 开头的字符串
  if (!context.inVPre && /^(v-|:|@|#)/.test(name)) {
    // 以 :value="input" 为例，这里的 name 为 :value，match 捕获到的是 [':value', '', 'value']
    const match = /(?:^v-([a-z0-9-]+))?(?:(?::|^@|^#)(\[[^\]]+\]|[^\.]+))?(.+)?$/i.exec(
      name
    )!

    // 获取指令名称，match[1] 捕获到的就是指令名，如果是以 ： @ # 开头的，则分别转换为 bind on slot
    const dirName =
      match[1] ||
      (startsWith(name, ':') ? 'bind' : startsWith(name, '@') ? 'on' : 'slot')

    let arg: ExpressionNode | undefined

    // match[2] 捕获的是属性名
    if (match[2]) {
      // 指令名是否是 slot 插槽
      const isSlot = dirName === 'slot'
      // 获取属性值开始的偏移量
      const startOffset = name.indexOf(match[2])
      const loc = getSelection(
        context,
        getNewPosition(context, start, startOffset),
        getNewPosition(
          context,
          start,
          startOffset + match[2].length + ((isSlot && match[3]) || '').length
        )
      )
      let content = match[2]
      let isStatic = true

      if (content.startsWith('[')) {
        isStatic = false

        if (!content.endsWith(']')) {
          emitError(
            context,
            ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END
          )
        }

        content = content.substr(1, content.length - 2)
      } else if (isSlot) {
        // #1241 special case for v-slot: vuetify relies extensively on slot
        // names containing dots. v-slot doesn't have any modifiers and Vue 2.x
        // supports such usage so we are keeping it consistent with 2.x.
        content += match[3] || ''
      }

      // 返回这个属性的 ast 表达
      arg = {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content,
        isStatic,
        isConstant: isStatic,
        loc
      }
    }

    if (value && value.isQuoted) {
      const valueLoc = value.loc
      valueLoc.start.offset++
      valueLoc.start.column++
      valueLoc.end = advancePositionWithClone(valueLoc.start, value.content)
      valueLoc.source = valueLoc.source.slice(1, -1)
    }

    // 这里返回的属性是指令类型，需要针对表达式进行处理
    return {
      type: NodeTypes.DIRECTIVE,
      name: dirName,
      // 表达式
      exp: value && {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content: value.content,
        isStatic: false,
        // Treat as non-constant by default. This can be potentially set to
        // true by `transformExpression` to make it eligible for hoisting.
        isConstant: false,
        loc: value.loc
      },
      // 参数，属性名
      arg,
      // 修饰符
      modifiers: match[3] ? match[3].substr(1).split('.') : [],
      loc
    }
  }

  // 这里返回的是正常的属性 ast，不需要做额外的编译
  return {
    type: NodeTypes.ATTRIBUTE,
    name,
    value: value && {
      type: NodeTypes.TEXT,
      content: value.content,
      loc: value.loc
    },
    loc
  }
}

function parseAttributeValue(
  context: ParserContext
):
  | {
      content: string
      isQuoted: boolean
      loc: SourceLocation
    }
  | undefined {
  const start = getCursor(context)
  let content: string

  const quote = context.source[0]
  const isQuoted = quote === `"` || quote === `'`
  if (isQuoted) {
    // Quoted value.
    advanceBy(context, 1)

    // 找到另一半引号的索引
    const endIndex = context.source.indexOf(quote)
    if (endIndex === -1) {
      // 解析字符串文本，得到属性后面的表达式字段
      content = parseTextData(
        context,
        context.source.length,
        TextModes.ATTRIBUTE_VALUE
      )
    } else {
      content = parseTextData(context, endIndex, TextModes.ATTRIBUTE_VALUE)
      advanceBy(context, 1)
    }
  } else {
    // Unquoted
    const match = /^[^\t\r\n\f >]+/.exec(context.source)
    if (!match) {
      return undefined
    }
    const unexpectedChars = /["'<=`]/g
    let m: RegExpExecArray | null
    while ((m = unexpectedChars.exec(match[0]))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,
        m.index
      )
    }
    content = parseTextData(context, match[0].length, TextModes.ATTRIBUTE_VALUE)
  }

  // 返回属性的 ast 表达，包括 content: 属性内容，isQuoted：是否是被引号包裹，loc：位置信息
  return { content, isQuoted, loc: getSelection(context, start) }
}

function parseInterpolation(
  context: ParserContext,
  mode: TextModes
): InterpolationNode | undefined {
  const [open, close] = context.options.delimiters
  __TEST__ && assert(startsWith(context.source, open))

  const closeIndex = context.source.indexOf(close, open.length)
  if (closeIndex === -1) {
    emitError(context, ErrorCodes.X_MISSING_INTERPOLATION_END)
    return undefined
  }

  const start = getCursor(context)
  advanceBy(context, open.length)
  const innerStart = getCursor(context)
  const innerEnd = getCursor(context)
  const rawContentLength = closeIndex - open.length
  const rawContent = context.source.slice(0, rawContentLength)
  const preTrimContent = parseTextData(context, rawContentLength, mode)
  const content = preTrimContent.trim()
  const startOffset = preTrimContent.indexOf(content)
  if (startOffset > 0) {
    advancePositionWithMutation(innerStart, rawContent, startOffset)
  }
  const endOffset =
    rawContentLength - (preTrimContent.length - content.length - startOffset)
  advancePositionWithMutation(innerEnd, rawContent, endOffset)
  advanceBy(context, close.length)

  return {
    type: NodeTypes.INTERPOLATION,
    content: {
      type: NodeTypes.SIMPLE_EXPRESSION,
      isStatic: false,
      // Set `isConstant` to false by default and will decide in transformExpression
      isConstant: false,
      content,
      loc: getSelection(context, innerStart, innerEnd)
    },
    loc: getSelection(context, start)
  }
}

// 文本编译
function parseText(context: ParserContext, mode: TextModes): TextNode {
  __TEST__ && assert(context.source.length > 0)

  // 文件编译解析的结束标志是 < 和 {{
  const endTokens = ['<', context.options.delimiters[0]]
  // 如果是 CDATA 类型，还需要增加一个结束标志 ]]>
  if (mode === TextModes.CDATA) {
    endTokens.push(']]>')
  }

  // 源解析模板字符串的长度为最大结束索引，为初始值
  let endIndex = context.source.length
  // 从结束标志数组 endTokens 中逐个遍历，去源字符串中寻找结束索引
  for (let i = 0; i < endTokens.length; i++) {
    const index = context.source.indexOf(endTokens[i], 1)
    if (index !== -1 && endIndex > index) {
      // 每次找到都会更新 endIndex，遍历结束后得到的 endIndex 为最小值
      endIndex = index
    }
  }

  __TEST__ && assert(endIndex > 0)

  // 获取编译开始指针
  const start = getCursor(context)
  // 获取编程处理过的内容，此时文本字符串已经进行了处理，并且编译指针也已经推进到下一个处理位置
  const content = parseTextData(context, endIndex, mode)

  // 返回 ast 树中用来表示文本字符串的对象，包含类型、内容、位置信息
  return {
    type: NodeTypes.TEXT,
    content,
    loc: getSelection(context, start)
  }
}

/**
 * Get text data with a given length from the current location.
 * This translates HTML entities in the text data.
 */
function parseTextData(
  context: ParserContext,
  length: number,
  mode: TextModes
): string {
  // 获取被解析的源文本
  const rawText = context.source.slice(0, length)
  // 推进编译指针的位置
  advanceBy(context, length)
  if (
    mode === TextModes.RAWTEXT ||
    mode === TextModes.CDATA ||
    rawText.indexOf('&') === -1
  ) {
    // 如果此时是 RAWTEXT 或 CDATA 模式，或不是以 & 开头的字符串，直接返回
    return rawText
  } else {
    // DATA or RCDATA containing "&"". Entity decoding required.
    // 特殊文本需要经过 decodeEntities 进行转译显示
    return context.options.decodeEntities(
      rawText,
      mode === TextModes.ATTRIBUTE_VALUE
    )
  }
}

function getCursor(context: ParserContext): Position {
  const { column, line, offset } = context
  return { column, line, offset }
}

// 获取编译指针信息
function getSelection(
  context: ParserContext,
  start: Position,
  end?: Position
): SourceLocation {
  end = end || getCursor(context)
  return {
    // 编译开始位置
    start,
    // 编译结束位置
    end,
    // 编译的源字符串
    source: context.originalSource.slice(start.offset, end.offset)
  }
}

function last<T>(xs: T[]): T | undefined {
  return xs[xs.length - 1]
}

function startsWith(source: string, searchString: string): boolean {
  return source.startsWith(searchString)
}

// 推动编译指针一直前进
function advanceBy(context: ParserContext, numberOfCharacters: number): void {
  const { source } = context
  __TEST__ && assert(numberOfCharacters <= source.length)
  // 计算新的编译指针位置
  advancePositionWithMutation(context, source, numberOfCharacters)
  // 编译上下文中的 source 截掉已处理的部分
  context.source = source.slice(numberOfCharacters)
}

// 推进空格指针
function advanceSpaces(context: ParserContext): void {
  // 空格、换行符等等空白字符都会被当做空进行处理
  const match = /^[\t\r\n\f ]+/.exec(context.source)
  if (match) {
    // 将捕获到的空白内容长度进行推进
    advanceBy(context, match[0].length)
  }
}

// 获取新的指针位置
function getNewPosition(
  context: ParserContext,
  start: Position,
  numberOfCharacters: number
): Position {
  return advancePositionWithClone(
    start,
    context.originalSource.slice(start.offset, numberOfCharacters),
    numberOfCharacters
  )
}

function emitError(
  context: ParserContext,
  code: ErrorCodes,
  offset?: number,
  loc: Position = getCursor(context)
): void {
  if (offset) {
    loc.offset += offset
    loc.column += offset
  }
  context.options.onError(
    createCompilerError(code, {
      start: loc,
      end: loc,
      source: ''
    })
  )
}

// 判断需要编译的字符串上下文是否到达了一个终点
// 比如是否读完了一个标签，是否读完了一段文本
function isEnd(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): boolean {
  // 当前还需要编译的字符串模板源
  const s = context.source

  // 根据编译模式来判断是否到达编译终止节点
  switch (mode) {
    // 普通的标签文本
    case TextModes.DATA:
      // 如果以 </ 开头，遍历已经存储的标签数组，看是否是正常匹配的闭合标签
      if (startsWith(s, '</')) {
        //TODO: probably bad performance
        for (let i = ancestors.length - 1; i >= 0; --i) {
          if (startsWithEndTagOpen(s, ancestors[i].tag)) {
            return true
          }
        }
      }
      break

    // 特殊的标签，匹配到最后一个 ancestors 存储的标签就代表正常闭合了
    case TextModes.RCDATA:
    case TextModes.RAWTEXT: {
      const parent = last(ancestors)
      if (parent && startsWithEndTagOpen(s, parent.tag)) {
        return true
      }
      break
    }

    // CDATA 匹配到 ]]> 即代表结束
    case TextModes.CDATA:
      if (startsWith(s, ']]>')) {
        return true
      }
      break
  }

  return !s
}

// 检查标签的结束标签是否对应上了开始标签
function startsWithEndTagOpen(source: string, tag: string): boolean {
  return (
    startsWith(source, '</') &&
    source.substr(2, tag.length).toLowerCase() === tag.toLowerCase() &&
    /[\t\n\f />]/.test(source[2 + tag.length] || '>')
  )
}
