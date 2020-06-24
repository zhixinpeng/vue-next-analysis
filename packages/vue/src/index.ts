// This entry is the "full-build" that includes both the runtime
// and the compiler, and supports on-the-fly compilation of the template option.
import './devCheck'
import { compile, CompilerOptions, CompilerError } from '@vue/compiler-dom'
import { registerRuntimeCompiler, RenderFunction, warn } from '@vue/runtime-dom'
import * as runtimeDom from '@vue/runtime-dom'
import { isString, NOOP, generateCodeFrame, extend } from '@vue/shared'

const compileCache: Record<string, RenderFunction> = Object.create(null)

// Vue 3.x compile 编译函数入口
// template 是需要编译的模板字符串
// opitons 是用于编译的自定义通用编译函数，在 compiler-core/options 文件内有类型定义
function compileToFunction(
  template: string | HTMLElement,
  options?: CompilerOptions
): RenderFunction {
  // 用于处理的 template 模板必须是字符串
  if (!isString(template)) {
    if (template.nodeType) {
      // 传入了一个 HTMLElement 元素，直接获取其 innerHTML 用于编译
      template = template.innerHTML
    } else {
      __DEV__ && warn(`invalid template option: `, template)
      return NOOP
    }
  }

  const key = template
  const cached = compileCache[key]
  // 编译之后的 template 会缓存在 compileCache 对象中，若已存在缓存，直接读取缓存
  // compileCache 的 key 值为原编译模板 template，value 值为其编译后的 render 函数
  if (cached) {
    return cached
  }

  // 传入的字符串 template 是以 id 选择器 # 开头的话，尝试查找元素
  if (template[0] === '#') {
    const el = document.querySelector(template)
    if (__DEV__ && !el) {
      warn(`Template element not found or is empty: ${template}`)
    }
    // __UNSAFE__
    // Reason: potential execution of JS expressions in in-DOM template.
    // The user must make sure the in-DOM template is trusted. If it's rendered
    // by the server, the template should not contain any user data.
    template = el ? el.innerHTML : ``
  }

  // 编译核心代码，通过 compile 函数对 template 进行编译
  // 这里的 compile 是 compiler-dom 提供的针对 web 平台定制的编译函数
  // 你可以根据你的平台编写自定义的编译函数
  const { code } = compile(
    template,
    // 编译选项合并，添加平台错误处理和静态提升标识
    extend(
      {
        // 是否开启静态提升
        hoistStatic: true,
        onError(err: CompilerError) {
          if (__DEV__) {
            const message = `Template compilation error: ${err.message}`
            const codeFrame =
              err.loc &&
              generateCodeFrame(
                template as string,
                err.loc.start.offset,
                err.loc.end.offset
              )
            warn(codeFrame ? `${message}\n${codeFrame}` : message)
          } else {
            /* istanbul ignore next */
            throw err
          }
        }
      },
      options
    )
  )

  // The wildcard import results in a huge object with every export
  // with keys that cannot be mangled, and can be quite heavy size-wise.
  // In the global build we know `Vue` is available globally so we can avoid
  // the wildcard object.
  const render = (__GLOBAL__
    ? new Function(code)()
    : new Function('Vue', code)(runtimeDom)) as RenderFunction
  return (compileCache[key] = render)
}

// 将 compileToFunction 函数注册为默认的 compiler 编译函数进行调用
// 你可以根据功能、平台的差异自定义该编译函数，这里相当于接入了 compiler 接口
registerRuntimeCompiler(compileToFunction)

export { compileToFunction as compile }
export * from '@vue/runtime-dom'
