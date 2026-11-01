// Draws the whole app in happy-dom against the stub API, as main.tsx starts
// it, and finds what a person would see and press.
import { browser } from "./dom.ts"
import { Effect, Option } from "effect"
import { act } from "react"
import { createRoot, type Root as ReactRoot } from "react-dom/client"
import { hostAtom, ownerKeyAtom, transportAtom } from "../../src/api.ts"
import { Root } from "../../src/app.tsx"
import { prefsAtom } from "../../src/atoms.ts"
import { type TestHost, testHost, type TestHostOptions } from "./host.ts"
import { makeStub, type Stub, type StubOptions, stubTransport } from "./stub-api.ts"

export interface Drawn {
  readonly container: HTMLElement
  readonly stub: Stub
  readonly host: TestHost
  readonly close: () => Promise<void>
}

export const draw = async (
  options: {
    readonly stub?: StubOptions
    readonly host?: TestHostOptions
    readonly at?: string
    /** Readies the stub before the app makes its first call, such as failing that call. */
    readonly prepare?: (stub: Stub) => void
  } = {},
): Promise<Drawn> => {
  browser.location.hash = options.at ?? "#/overview"
  const stub = makeStub(options.stub)
  options.prepare?.(stub)
  const host = testHost(options.host)
  const container = browser.document.createElement("div")
  browser.document.body.append(container)
  let root: ReactRoot | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(
      <Root
        initialValues={[
          [hostAtom, Option.some(host.host)],
          [ownerKeyAtom, Option.fromUndefinedOr(options.host?.key)],
          [transportAtom, stubTransport(stub)],
          [prefsAtom, Effect.runSync(host.host.prefs)],
        ]}
      />,
    )
  })
  return {
    container,
    stub,
    host,
    close: async () => {
      await act(async () => root?.unmount())
      container.remove()
      document.body.innerHTML = ""
      await stub.dispose()
    },
  }
}

/** Lets React and the stub answer, in small steps, until `check` holds. */
export const settle = async (check: () => boolean, what: string, timeout = 3_000): Promise<void> => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`)
    await act(async () => {
      await Bun.sleep(10)
    })
  }
}

/** Whether the page shows these words anywhere. */
export const shows = (text: string): boolean => (document.body.textContent ?? "").includes(text)

/** Waits until the page shows these words. */
export const showsSoon = (text: string, timeout?: number) => settle(() => shows(text), JSON.stringify(text), timeout)

/** The control a person would press, by its accessible name or its words. */
export const control = (name: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>("button, [role=menuitem], [role=radio], [role=switch], a"),
  ].find((element) => element.getAttribute("aria-label") === name || element.textContent?.trim() === name)
  if (found === undefined) throw new Error(`no control named ${JSON.stringify(name)}`)
  return found
}

/** Presses a control as a person would. */
export const press = async (name: string): Promise<void> => {
  await act(async () => {
    control(name).click()
  })
}

/** Types into a field found by its label or placeholder. */
export const type = async (label: string, text: string): Promise<void> => {
  const field = [...document.querySelectorAll<HTMLInputElement>("input")].find(
    (input) => input.getAttribute("aria-label") === label || input.placeholder === label,
  )
  if (field === undefined) throw new Error(`no field ${JSON.stringify(label)}`)
  await act(async () => {
    // Set the value the way the browser does, under React's own record of it, so React sees a change.
    let proto: object | null = Object.getPrototypeOf(field)
    let setter: ((value: string) => void) | undefined
    while (proto !== null && setter === undefined) {
      setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
      proto = Object.getPrototypeOf(proto)
    }
    // Focus first and lift a key after: under happy-dom React watches a focused field for changes
    // as it does in browsers without the input event, and sees the new value on keyup.
    field.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }))
    setter?.call(field, text)
    field.dispatchEvent(new window.Event("input", { bubbles: true }))
    field.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }))
  })
}

/** Presses a key on the page. */
export const key = async (name: string, target: EventTarget = window): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }))
  })
}
