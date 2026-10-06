/**
 * AX states: parsing Chromium's property list (shapes as measured on Chromium 145, see
 * ax-states.ts) and rendering them where a text-only model reads them — the state
 * tokens on `snapshot()` lines and on the aria tree, with password values masked.
 */

import { describe, expect, it } from 'vitest'
import type { Protocol } from 'devtools-protocol'
import { axStatesFromNode, formatAxStates } from './ax-states.js'
import {
  buildRawSnapshotTree,
  controlNameSources,
  buildSnapshotLines,
  filterFullSnapshotTree,
  filterInteractiveSnapshotTree,
  finalizeSnapshotOutput,
} from './aria-snapshot.js'

function axNode(
  id: string,
  role: string,
  options: {
    name?: string
    value?: Protocol.Accessibility.AXValue
    properties?: Array<[string, unknown]>
    childIds?: string[]
    backendNodeId?: number
  } = {},
): Protocol.Accessibility.AXNode {
  return {
    nodeId: id as Protocol.Accessibility.AXNodeId,
    ignored: false,
    role: { type: 'role', value: role },
    ...(options.name !== undefined ? { name: { type: 'computedString', value: options.name } } : {}),
    ...(options.value ? { value: options.value } : {}),
    ...(options.properties
      ? {
          properties: options.properties.map(([name, value]) => ({
            name: name as Protocol.Accessibility.AXPropertyName,
            value: { type: typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'integer' : 'token', value },
          })),
        }
      : {}),
    ...(options.childIds ? { childIds: options.childIds as Protocol.Accessibility.AXNodeId[] } : {}),
    ...(options.backendNodeId !== undefined ? { backendDOMNodeId: options.backendNodeId as Protocol.DOM.BackendNodeId } : {}),
  }
}

describe('axStatesFromNode', () => {
  it('reads tristate checked/pressed the way Chromium sends them', () => {
    expect(axStatesFromNode(axNode('1', 'checkbox', { properties: [['checked', 'true'], ['focusable', true]] }))).toEqual({ checked: true })
    expect(axStatesFromNode(axNode('1', 'checkbox', { properties: [['checked', 'false']] }))).toEqual({ checked: false })
    expect(axStatesFromNode(axNode('1', 'checkbox', { properties: [['checked', 'mixed']] }))).toEqual({ checked: 'mixed' })
    expect(axStatesFromNode(axNode('1', 'button', { properties: [['pressed', 'false']] }))).toEqual({ pressed: false })
  })

  it('keeps only true booleans and real invalid tokens', () => {
    const states = axStatesFromNode(
      axNode('1', 'textbox', {
        properties: [
          ['invalid', 'false'],
          ['focusable', true],
          ['focused', true],
          ['editable', 'plaintext'],
          ['readonly', false],
          ['required', true],
          ['disabled', false],
        ],
      }),
    )
    expect(states).toEqual({ focused: true, required: true })
    expect(axStatesFromNode(axNode('1', 'textbox', { properties: [['invalid', 'true']] }))).toEqual({ invalid: true })
    expect(axStatesFromNode(axNode('1', 'textbox', { properties: [['invalid', 'spelling']] }))).toEqual({ invalid: 'spelling' })
  })

  it('reads expanded/selected/level/valuetext and the camel-cased hasPopup', () => {
    expect(
      axStatesFromNode(axNode('1', 'button', { properties: [['hasPopup', 'menu'], ['expanded', false]] })),
    ).toEqual({ haspopup: 'menu', expanded: false })
    expect(axStatesFromNode(axNode('1', 'tab', { properties: [['selected', true]] }))).toEqual({ selected: true })
    expect(axStatesFromNode(axNode('1', 'heading', { properties: [['level', 2]] }))).toEqual({ level: 2 })
    expect(
      axStatesFromNode(axNode('1', 'slider', { properties: [['valuetext', '30 percent'], ['valuemin', 0], ['valuemax', 100]] })),
    ).toEqual({ valueText: '30 percent', valueMin: 0, valueMax: 100 })
    expect(axStatesFromNode(axNode('1', 'dialog', { properties: [['modal', true]] }))).toEqual({ modal: true })
  })

  it('reads multiline, autocomplete, the active descendant, the error message and the description', () => {
    const related = (backendDOMNodeId: number): Protocol.Accessibility.AXRelatedNode => ({ backendDOMNodeId: backendDOMNodeId as Protocol.DOM.BackendNodeId })
    const node: Protocol.Accessibility.AXNode = {
      ...axNode('1', 'combobox', { properties: [['multiline', true], ['autocomplete', 'list'], ['invalid', 'true']] }),
      description: { type: 'computedString', value: ' Pick a city ' },
    }
    node.properties!.push(
      { name: 'activedescendant' as Protocol.Accessibility.AXPropertyName, value: { type: 'idref', relatedNodes: [related(41)] } },
      { name: 'errormessage' as Protocol.Accessibility.AXPropertyName, value: { type: 'idrefList', relatedNodes: [related(50), related(51)] } },
    )
    expect(axStatesFromNode(node)).toEqual({
      description: 'Pick a city',
      multiline: true,
      autocomplete: 'list',
      invalid: true,
      activeDescendant: 41,
      errorMessage: [50, 51],
    })
    // `autocomplete="none"` is Chromium's "no suggestions": not a state.
    expect(axStatesFromNode(axNode('1', 'textbox', { properties: [['autocomplete', 'none']] }))).toBeUndefined()
  })

  it('drops the document focus and returns undefined when nothing applies', () => {
    expect(axStatesFromNode(axNode('1', 'RootWebArea', { properties: [['focused', true], ['focusable', true]] }))).toBeUndefined()
    expect(axStatesFromNode(axNode('1', 'button', { properties: [['focusable', true], ['invalid', 'false']] }))).toBeUndefined()
    expect(axStatesFromNode(axNode('1', 'generic'))).toBeUndefined()
  })
})

describe('formatAxStates', () => {
  it('renders tokens in a fixed order', () => {
    expect(formatAxStates({ disabled: true, checked: true, focused: true }, 'checkbox')).toBe(' [focused] [checked] [disabled]')
    expect(formatAxStates({ expanded: false }, 'button')).toBe(' [collapsed]')
    expect(formatAxStates({ expanded: true, haspopup: 'menu' }, 'button')).toBe(' [expanded] [haspopup=menu]')
    expect(formatAxStates({ level: 1 }, 'heading')).toBe(' [level=1]')
    expect(formatAxStates({ valueText: 'Medium "M"' }, 'slider')).toBe(' [valuetext="Medium \\"M\\""]')
    expect(formatAxStates(undefined, 'button')).toBe('')
  })

  it('says unchecked only where unchecked is a visible state, and stays quiet on noise', () => {
    expect(formatAxStates({ checked: false }, 'checkbox')).toBe(' [unchecked]')
    expect(formatAxStates({ checked: false }, 'switch')).toBe(' [unchecked]')
    expect(formatAxStates({ checked: false }, 'option')).toBe('')
    expect(formatAxStates({ checked: 'mixed' }, 'checkbox')).toBe(' [mixed]')
    expect(formatAxStates({ selected: false }, 'tab')).toBe('')
    expect(formatAxStates({ haspopup: 'menu', expanded: false }, 'combobox')).toBe(' [collapsed]')
    expect(formatAxStates({ pressed: false }, 'button')).toBe(' [not pressed]')
    expect(formatAxStates({ invalid: 'grammar' }, 'textbox')).toBe(' [invalid=grammar]')
  })

  it('prints level where it is a rank or a depth, not on every list item', () => {
    expect(formatAxStates({ level: 2 }, 'heading')).toBe(' [level=2]')
    expect(formatAxStates({ level: 3, expanded: true }, 'treeitem')).toBe(' [expanded] [level=3]')
    expect(formatAxStates({ level: 2 }, 'row')).toBe(' [level=2]')
    expect(formatAxStates({ level: 1 }, 'listitem')).toBe('')
  })
})

describe('snapshot lines carry states and values', () => {
  const axNodes = [
    axNode('root', 'RootWebArea', { childIds: ['form'], properties: [['focused', true]] }),
    axNode('form', 'form', { name: 'Login', childIds: ['email', 'pw', 'remember', 'go'], backendNodeId: 10 }),
    axNode('email', 'textbox', {
      name: 'Email',
      value: { type: 'string', value: 'a@b.c' },
      properties: [['focused', true], ['required', false]],
      backendNodeId: 11,
    }),
    axNode('pw', 'textbox', { name: 'Password', value: { type: 'string', value: '••••••' }, backendNodeId: 12 }),
    axNode('remember', 'checkbox', { name: 'Remember me', properties: [['checked', 'true']], backendNodeId: 13 }),
    axNode('go', 'button', { name: 'Sign in', properties: [['disabled', true]], backendNodeId: 14 }),
  ]
  const axById = new Map(axNodes.map((node) => [node.nodeId, node]))
  const domRows: Array<{ id: number; nodeName: string; attributes: Array<[string, string]> }> = [
    { id: 10, nodeName: 'FORM', attributes: [] },
    { id: 11, nodeName: 'INPUT', attributes: [['type', 'email']] },
    { id: 12, nodeName: 'INPUT', attributes: [['type', 'Password']] },
    { id: 13, nodeName: 'INPUT', attributes: [['type', 'checkbox']] },
    { id: 14, nodeName: 'BUTTON', attributes: [] },
  ]
  const domByBackendId = new Map(
    domRows.map(({ id, nodeName, attributes }): [
      Protocol.DOM.BackendNodeId,
      { nodeId: Protocol.DOM.NodeId; backendNodeId: Protocol.DOM.BackendNodeId; nodeName: string; attributes: Map<string, string> },
    ] => [
      id as Protocol.DOM.BackendNodeId,
      {
        nodeId: id as Protocol.DOM.NodeId,
        backendNodeId: id as Protocol.DOM.BackendNodeId,
        nodeName,
        attributes: new Map(attributes),
      },
    ]),
  )
  const raw = buildRawSnapshotTree({ nodeId: 'form' as Protocol.Accessibility.AXNodeId, axById, isNodeInScope: () => true, nameSources: controlNameSources(axById) })!
  let counter = 0
  const createRefForNode = (): string => `e${++counter}`

  it('renders state tokens after the name, then the value, and masks passwords', () => {
    const filtered = filterFullSnapshotTree({ node: raw, ancestorNames: [], domByBackendId, createRefForNode })
    const lines = buildSnapshotLines(filtered.nodes)
    expect(lines.map((line) => line.text)).toEqual([
      '- form "Login"',
      '  - textbox "Email" [focused] = "a@b.c"',
      '  - textbox "Password" = "••••"',
      '  - checkbox "Remember me" [checked]',
      '  - button "Sign in" [disabled]',
    ])
    const { snapshot, tree } = finalizeSnapshotOutput(lines, filtered.nodes, new Map())
    expect(snapshot.split('\n')).toEqual([
      '- form "Login":',
      '  - role=textbox[name="Email"] [focused] = "a@b.c"',
      '  - role=textbox[name="Password"] = "••••"',
      '  - role=checkbox[name="Remember me"] [checked]',
      '  - role=button[name="Sign in"] [disabled]',
    ])
    const [email, password, remember, signIn] = tree[0].children
    expect(email).toMatchObject({ states: { focused: true }, value: 'a@b.c' })
    expect(password.value).toBe('••••')
    expect(remember.states).toEqual({ checked: true })
    expect(signIn.states).toEqual({ disabled: true })
  })

  it('keeps states in the interactive-only filter too', () => {
    const filtered = filterInteractiveSnapshotTree({
      node: raw,
      ancestorNames: [],
      labelContext: false,
      domByBackendId,
      createRefForNode,
    })
    const text = buildSnapshotLines(filtered.nodes).map((line) => line.text.trim())
    expect(text).toContain('- checkbox "Remember me" [checked]')
    expect(text).toContain('- textbox "Password" = "••••"')
  })

  it('masks secret autocomplete fields and values whose DOM row is missing', () => {
    const nodes = [
      axNode('box', 'group', { name: 'Verify', childIds: ['otp', 'cvc', 'orphan', 'city'], backendNodeId: 20 }),
      axNode('otp', 'textbox', { name: 'Code', value: { type: 'string', value: '481516' }, backendNodeId: 21 }),
      axNode('cvc', 'textbox', { name: 'CVC', value: { type: 'string', value: '123' }, backendNodeId: 22 }),
      axNode('orphan', 'textbox', { name: 'Unknown', value: { type: 'string', value: 'secret?' }, backendNodeId: 23 }),
      axNode('city', 'textbox', { name: 'City', value: { type: 'string', value: 'Lyon' }, backendNodeId: 24 }),
    ]
    const axById = new Map(nodes.map((node) => [node.nodeId, node]))
    const tree = buildRawSnapshotTree({
      nodeId: 'box' as Protocol.Accessibility.AXNodeId,
      axById,
      isNodeInScope: () => true,
      nameSources: controlNameSources(axById),
    })!
    const rows: Array<[number, string, Array<[string, string]>]> = [
      [20, 'FIELDSET', []],
      [21, 'INPUT', [['type', 'text'], ['autocomplete', 'one-time-code']]],
      [22, 'INPUT', [['type', 'tel'], ['autocomplete', 'billing cc-csc']]],
      [24, 'INPUT', [['type', 'text'], ['autocomplete', 'address-level2']]],
    ]
    const dom = new Map(
      rows.map(([id, nodeName, attributes]): [Protocol.DOM.BackendNodeId, { nodeId: Protocol.DOM.NodeId; backendNodeId: Protocol.DOM.BackendNodeId; nodeName: string; attributes: Map<string, string> }] => [
        id as Protocol.DOM.BackendNodeId,
        { nodeId: id as Protocol.DOM.NodeId, backendNodeId: id as Protocol.DOM.BackendNodeId, nodeName, attributes: new Map(attributes) },
      ]),
    )
    const filtered = filterFullSnapshotTree({ node: tree, ancestorNames: [], domByBackendId: dom, createRefForNode })
    expect(buildSnapshotLines(filtered.nodes).map((line) => line.text.trim())).toEqual([
      '- group "Verify"',
      '- textbox "Code" = "••••"',
      '- textbox "CVC" = "••••"',
      '- textbox "Unknown" = "••••"',
      '- textbox "City" = "Lyon"',
    ])
  })

  it('keeps a multi-line editor value on one snapshot line', () => {
    const lines = buildSnapshotLines([
      { role: 'textbox', name: 'Notes', value: '\n\nfirst line\n\n  second line\n', children: [] },
      { role: 'textbox', name: 'Blank', value: '\n  \n', children: [] },
    ])
    expect(lines.map((line) => line.text)).toEqual(['- textbox "Notes" = "first line second line"', '- textbox "Blank"'])
  })
})
