import { NodeTransform } from '../transform'
import { findDir } from '../utils'
import { NodeTypes } from '../ast'
import { SET_BLOCK_TRACKING } from '../runtimeHelpers'

// v-once 的 transform 方法
export const transformOnce: NodeTransform = (node, context) => {
  // 找一下 ELEMENT 元素类型的节点是否有 once 指令
  if (node.type === NodeTypes.ELEMENT && findDir(node, 'once', true)) {
    context.helper(SET_BLOCK_TRACKING)
    return () => {
      if (node.codegenNode) {
        node.codegenNode = context.cache(node.codegenNode, true /* isVNode */)
      }
    }
  }
}
