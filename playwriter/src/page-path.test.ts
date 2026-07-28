import { describe, it, expect } from 'vitest'
import {
  registerType,
  registerVirtualType,
  traverse,
  query,
  explode,
  verify,
  PagePath,
  VISITOR_KEYS,
  FLIPPED_ALIAS_KEYS,
  TYPES,
  type PageNode,
} from './page-path.js'

// --- synthetic type registry ------------------------------------------------
// Registered once at module load; the maps are module-global in page-path.ts.
registerType('Root', { visitor: ['children'] })
registerType('Element', { visitor: ['children'], aliases: ['Node'] })
registerType('Text', {})
registerVirtualType('VisibleElement', (path) => path.is('Element') && !!(path.node as any).visible)

interface Element extends PageNode {
  type: 'Element'
  name: string
  visible?: boolean
  attributes?: Record<string, unknown>
  children: PageNode[]
}

function makeTree(): PageNode {
  return {
    type: 'Root',
    children: [
      {
        type: 'Element',
        name: 'a',
        visible: true,
        attributes: { id: 'x', role: 'button' },
        children: [{ type: 'Text', value: 'hi' }],
      } as Element,
      {
        type: 'Element',
        name: 'b',
        visible: false,
        attributes: { id: 'y' },
        children: [],
      } as Element,
    ],
  }
}

describe('type registry', () => {
  it('records visitor keys, aliases and flipped aliases', () => {
    expect(VISITOR_KEYS['Root']).toEqual(['children'])
    expect(VISITOR_KEYS['Text']).toEqual([])
    expect(FLIPPED_ALIAS_KEYS['Node']).toContain('Element')
    expect(TYPES.has('Element')).toBe(true)
    expect(TYPES.has('Node')).toBe(true)
    expect(TYPES.has('VisibleElement')).toBe(true)
  })
})

describe('visitor system', () => {
  it('explode normalizes shorthand and piped keys', () => {
    const ex = explode({ 'Root|Element': (p) => void p }) as any
    expect(ex.Root.enter.length).toBe(1)
    expect(ex.Element.enter.length).toBe(1)
  })

  it('explode expands alias keys onto concrete types', () => {
    const ex = explode({ Node: (p) => void p }) as any
    expect(ex.Node).toBeUndefined()
    expect(ex.Element.enter.length).toBe(1)
  })

  it('explode merges multiple enter/exit fns into arrays', () => {
    const ex = explode({
      Element: { enter: [(p) => void p, (p) => void p], exit: (p) => void p },
    }) as any
    expect(ex.Element.enter.length).toBe(2)
    expect(ex.Element.exit.length).toBe(1)
  })

  it('verify throws on unknown types', () => {
    expect(() => verify({ NotARealType: () => {} })).toThrow()
    expect(() => verify({ Root: () => {} })).not.toThrow()
  })
})

describe('traverse', () => {
  it('visits enter/exit in depth-first order', () => {
    const order: string[] = []
    traverse(makeTree(), {
      Root: { enter: () => order.push('enter Root'), exit: () => order.push('exit Root') },
      Element: {
        enter: (p) => order.push(`enter Element ${(p.node as any).name}`),
        exit: (p) => order.push(`exit Element ${(p.node as any).name}`),
      },
      Text: (p) => order.push(`Text ${(p.node as any).value}`),
    })
    expect(order).toEqual([
      'enter Root',
      'enter Element a',
      'Text hi',
      'exit Element a',
      'enter Element b',
      'exit Element b',
      'exit Root',
    ])
  })

  it('skip() prunes the subtree', () => {
    const visited: string[] = []
    traverse(makeTree(), {
      Element: (p) => {
        visited.push((p.node as any).name)
        if ((p.node as any).name === 'a') p.skip()
      },
      Text: () => visited.push('text'),
    })
    // Element "a" was skipped, so its Text child is never visited.
    expect(visited).toEqual(['a', 'b'])
  })

  it('stop() aborts the whole traversal', () => {
    const seen: string[] = []
    traverse(makeTree(), {
      Element: (p) => {
        seen.push((p.node as any).name)
        if ((p.node as any).name === 'a') p.stop()
      },
    })
    expect(seen).toEqual(['a'])
  })

  it('matches an alias-keyed visitor', () => {
    const names: string[] = []
    traverse(makeTree(), {
      Node: (p) => names.push((p.node as any).name),
    })
    expect(names).toEqual(['a', 'b'])
  })

  it('runs a virtual-type visitor only when its predicate matches', () => {
    const names: string[] = []
    traverse(makeTree(), {
      VisibleElement: (p) => names.push((p.node as any).name),
    })
    expect(names).toEqual(['a'])
  })

  it('passes state to visitor functions', () => {
    const state = { count: 0 }
    traverse(
      makeTree(),
      {
        Element: (_p, s: any) => {
          s.count++
        },
      },
      { state },
    )
    expect(state.count).toBe(2)
  })
})

describe('path.get caching', () => {
  it('returns the same path objects on repeated get', () => {
    const tree = makeTree()
    let rootPath!: PagePath
    traverse(tree, { Root: (p) => void (rootPath = p) })

    const first = rootPath.get('children') as PagePath[]
    const second = rootPath.get('children') as PagePath[]
    expect(Array.isArray(first)).toBe(true)
    expect(first).toHaveLength(2)
    expect(first[0]).toBe(second[0])
    expect(first[1]).toBe(second[1])
  })

  it('exposes sibling navigation', () => {
    const tree = makeTree()
    let rootPath!: PagePath
    traverse(tree, { Root: (p) => void (rootPath = p) })
    const kids = rootPath.get('children') as PagePath[]
    expect(kids[0].getAllNextSiblings()).toEqual([kids[1]])
    expect(kids[1].getAllPrevSiblings()).toEqual([kids[0]])
  })
})

describe('data bag persistence', () => {
  it('keeps per-path data across separate traversals of the same tree', () => {
    const tree = makeTree()
    const bump = (p: PagePath) => {
      if ((p.node as any).name === 'a') p.setData('count', (p.getData<number>('count') ?? 0) + 1)
    }
    traverse(tree, { Element: bump })
    traverse(tree, { Element: bump })

    let count = 0
    traverse(tree, {
      Element: (p) => {
        if ((p.node as any).name === 'a') count = p.getData<number>('count') ?? 0
      },
    })
    expect(count).toBe(2)
  })
})

describe('resync', () => {
  it('fixes a stale key after a node is swapped in its container', () => {
    const tree = makeTree()
    let elemBPath!: PagePath
    traverse(tree, {
      Element: (p) => {
        if ((p.node as any).name === 'b') elemBPath = p
      },
    })
    expect(elemBPath.key).toBe(1)

    // Mutate the tree under the path: swap the two children.
    const kids = (tree as any).children
    ;[kids[0], kids[1]] = [kids[1], kids[0]]

    elemBPath.resync()
    expect(elemBPath.key).toBe(0)
    expect((elemBPath.node as any).name).toBe('b')
  })

  it('marks the path removed when its node vanishes from the container', () => {
    const tree = makeTree()
    let elemBPath!: PagePath
    traverse(tree, {
      Element: (p) => {
        if ((p.node as any).name === 'b') elemBPath = p
      },
    })
    // Remove element "b" from the same array the path points into.
    ;(tree as any).children.splice(1, 1)
    elemBPath.resync()
    expect(elemBPath._removed).toBe(true)
  })
})

describe('query', () => {
  it('returns paths matching a predicate selector', () => {
    const tree = makeTree()
    const texts = query(tree, (p) => p.is('Text'))
    expect(texts).toHaveLength(1)
    expect((texts[0].node as any).value).toBe('hi')
  })

  it('returns paths matching a type[attr=value] selector', () => {
    const tree = makeTree()
    const buttons = query(tree, 'Element[role=button]')
    expect(buttons).toHaveLength(1)
    expect((buttons[0].node as any).name).toBe('a')
  })

  it('returns paths matching a type#id selector', () => {
    const tree = makeTree()
    const byId = query(tree, 'Element#y')
    expect(byId).toHaveLength(1)
    expect((byId[0].node as any).name).toBe('b')
  })

  it('returns paths matching a virtual-type selector', () => {
    const tree = makeTree()
    const visible = query(tree, 'VisibleElement')
    expect(visible.map((p) => (p.node as any).name)).toEqual(['a'])
  })
})
