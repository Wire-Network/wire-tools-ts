import { serializeRunEvidenceJson } from "@wireio/test-opp-stress"

describe("RunEvidence canonical JSON", () => {
  it("T8-R1-CANONICAL-JSON-ACCESSOR rejects a getter without invoking it", () => {
    // Given: an enumerable own getter whose value changes on every access.
    let getterCalls = 0
    const input = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return getterCalls
      }
    })
    // When/Then: descriptor parsing rejects before the getter can run.
    expect(() => serializeRunEvidenceJson(input)).toThrow(
      "accessor properties are unsupported"
    )
    expect(getterCalls).toBe(0)
  })

  it("rejects setter-only and throwing accessors without invoking them", () => {
    // Given: own accessor descriptors with observable getter/setter side effects.
    let setterCalls = 0,
      throwingGetterCalls = 0
    const setterOnly = Object.defineProperty({}, "value", {
        enumerable: true,
        set: () => {
          setterCalls += 1
        }
      }),
      throwingGetter = Object.defineProperty({}, "value", {
        enumerable: true,
        get: () => {
          throwingGetterCalls += 1
          throw new Error("getter must not execute")
        }
      })
    // When/Then: both descriptors produce the typed accessor rejection directly.
    expect(() => serializeRunEvidenceJson(setterOnly)).toThrow(
      "accessor properties are unsupported"
    )
    expect(() => serializeRunEvidenceJson(throwingGetter)).toThrow(
      "accessor properties are unsupported"
    )
    expect(setterCalls).toBe(0)
    expect(throwingGetterCalls).toBe(0)
  })

  it("preserves shared graphs while rejecting hidden and cyclic structure", () => {
    // Given: one shared acyclic value plus non-enumerable, sparse, and cyclic inputs.
    const shared = { value: 7 },
      accepted = { second: shared, first: shared },
      hidden = Object.defineProperty({}, "value", {
        enumerable: false,
        value: 1
      }),
      sparse = new Array<unknown>(1),
      cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    // When/Then: accepted bytes are stable and hidden graph shapes reject.
    expect(serializeRunEvidenceJson(accepted)).toEqual(
      serializeRunEvidenceJson(accepted)
    )
    expect(() => serializeRunEvidenceJson(hidden)).toThrow(
      "non-enumerable properties are unsupported"
    )
    expect(() => serializeRunEvidenceJson(sparse)).toThrow(
      "sparse arrays are unsupported"
    )
    expect(() => serializeRunEvidenceJson(cyclic)).toThrow(
      "cyclic JSON values are unsupported"
    )
  })

  it("rejects inherited and symbol-keyed values without reading them", () => {
    // Given: an inherited getter and an own symbol-keyed property.
    let inheritedGetterCalls = 0
    const prototype = Object.defineProperty({}, "value", {
        enumerable: true,
        get: () => {
          inheritedGetterCalls += 1
          return 1
        }
      }),
      inherited = Object.create(prototype),
      symbolKeyed = { [Symbol("value")]: 1 }
    // When/Then: neither shape enters canonical JSON or invokes inherited code.
    expect(() => serializeRunEvidenceJson(inherited)).toThrow(
      "only plain JSON objects are supported"
    )
    expect(() => serializeRunEvidenceJson(symbolKeyed)).toThrow(
      "symbol-keyed properties are unsupported"
    )
    expect(inheritedGetterCalls).toBe(0)
  })
})
