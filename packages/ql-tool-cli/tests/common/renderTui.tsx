import type { ReactElement } from "react"
import { act } from "react"
import { Provider } from "react-redux"
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer"

import {
  TuiRouter,
  TuiRouterProvider,
  TuiServiceProvider,
  type TuiServiceRegistry,
  type TuiStore
} from "@wireio/ql-tool-cli/tui/index.js"

/** The mocked ink module's test hooks (tests/jest.setup.ts). */
export interface InkTestHooks {
  /** Deliver a keypress to every active handler. */
  __press(input: string, key?: Record<string, boolean>): void
  /** Active handler count. */
  __handlerCount(): number
  /** The shared `useApp().exit`. */
  __exit: jest.Mock
  /** The shared `useStdout().write`. */
  __write: jest.Mock
}

/** What a TUI element renders inside. */
export interface TuiRenderOptions {
  /** The store. */
  store: TuiStore
  /** The services (omitted = no service provider). */
  registry?: TuiServiceRegistry
  /** The initial router (default: workbench). */
  router?: TuiRouter
}

/**
 * The mocked ink module.
 *
 * @returns Its test hooks.
 */
export function inkMock(): InkTestHooks {
  return jest.requireMock("ink") as InkTestHooks
}

/** The TUI renders currently mounted (their key handlers are live). */
let mounted: ReactTestRenderer[] = []

/** Unmount every TUI render (a mounted route would otherwise keep receiving keys). */
export function unmountTui(): void {
  const previous = mounted
  mounted = []
  act(() => previous.forEach(renderer => renderer.unmount()))
}

/**
 * Render `element` inside the store / service / router providers. Like a real
 * terminal there is ONE live TUI: earlier renders are unmounted first.
 *
 * @param element - The element.
 * @param options - Store, registry, router.
 * @returns The renderer.
 */
export function renderTui(element: ReactElement, options: TuiRenderOptions): ReactTestRenderer {
  unmountTui()
  const routed = <TuiRouterProvider initial={options.router ?? new TuiRouter()}>{element}</TuiRouterProvider>,
    wrapped = options.registry == null ? routed : <TuiServiceProvider registry={options.registry}>{routed}</TuiServiceProvider>
  let renderer: ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<Provider store={options.store}>{wrapped}</Provider>)
  })
  mounted = [...mounted, renderer]
  return renderer
}

/**
 * Press a key (inside act).
 *
 * @param input - Ink `input`.
 * @param key - Key flags.
 */
export function press(input: string, key: Record<string, boolean> = {}): void {
  act(() => inkMock().__press(input, key))
}

/**
 * Await pending promises inside act (service calls triggered by keys).
 *
 * @returns Resolves after the microtasks settle.
 */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setImmediate(resolve))
  })
}

/** Host element name of Ink `Text` under the mock. */
const HostText = "Text"
/** Host element name of Ink `Box` under the mock. */
const HostBox = "Box"

/** Text of a rendered node: Text children concatenated, Box children one per line. */
function nodeText(node: ReactTestRendererJSON | string): string {
  if (typeof node === "string") return node
  const children = (node.children ?? []).map(nodeText)
  return node.type === HostBox ? children.join("\n") : children.join("")
}

/**
 * All rendered text.
 *
 * @param renderer - The renderer.
 * @returns The text.
 */
export function textOf(renderer: ReactTestRenderer): string {
  const tree = renderer.toJSON()
  return tree == null ? "" : Array.isArray(tree) ? tree.map(nodeText).join("\n") : nodeText(tree)
}

/**
 * Host `Text` instances carrying a prop value.
 *
 * @param renderer - The renderer.
 * @param prop - Prop name.
 * @returns Matching instances.
 */
export function textsWithProp(renderer: ReactTestRenderer, prop: string): ReactTestInstance[] {
  return renderer.root.findAll(instance => String(instance.type) === HostText && instance.props[prop] != null && instance.props[prop] !== false)
}
