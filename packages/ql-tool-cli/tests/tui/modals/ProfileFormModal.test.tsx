import { ConnectionProfileForm } from "@wireio/ql-shared"

import { ProfileFormModal } from "@wireio/ql-tool-cli/tui/index.js"

import { key } from "../../common/inkKeys.js"
import { press, renderTui, textOf } from "../../common/renderTui.js"
import { FixtureProfile, storeWithResult } from "../../common/storeFixtures.js"

/** A valid endpoint for the form. */
const Endpoint = FixtureProfile.endpoint

/** Type `text` into the focused field. */
function type(text: string): void {
  Array.from(text).forEach(character => press(character))
}

describe("ProfileFormModal", () => {
  it("edits each field (Tab / ↓ next, ↑ previous) and submits the validated profile", () => {
    const onSubmit = jest.fn(),
      onCancel = jest.fn(),
      renderer = renderTui(
        <ProfileFormModal title="Add" initial={ConnectionProfileForm.empty()} onSubmit={onSubmit} onCancel={onCancel} />,
        { store: storeWithResult() }
      )
    ProfileFormModal.Fields.forEach(field => expect(textOf(renderer)).toContain(ProfileFormModal.labelText(field)))
    type(FixtureProfile.name)
    press("", { tab: true })
    type(Endpoint)
    press("", { downArrow: true })
    press("", { backspace: true })
    press("", { downArrow: true })
    type("250")
    press("", { downArrow: true })
    press("", { upArrow: true })
    press("", { downArrow: true })
    press("", { backspace: true })
    type("0")
    press("", { tab: true })
    type("a, b")
    press("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith({
      name: FixtureProfile.name,
      endpoint: Endpoint,
      transportTimeoutMs: FixtureProfile.transportTimeoutMs,
      queryTimeoutMs: 250,
      retries: 0,
      owners: ["a", "b"]
    })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("an invalid form shows the field message and does not submit; Esc cancels", () => {
    const onSubmit = jest.fn(),
      onCancel = jest.fn(),
      renderer = renderTui(
        <ProfileFormModal title="Add" initial={{ ...ConnectionProfileForm.empty(), name: "x", endpoint: "ftp://x" }} onSubmit={onSubmit} onCancel={onCancel} />,
        { store: storeWithResult() }
      )
    press("", { return: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(textOf(renderer)).toMatch(/endpoint: /)
    press("", { escape: true })
    expect(onCancel).toHaveBeenCalled()
  })

  it("createState / toForm round-trip; applyKey wraps around the fields", () => {
    const form = { ...ConnectionProfileForm.empty(), name: "n", endpoint: Endpoint },
      state = ProfileFormModal.createState(form)
    expect(state.field).toBe(0)
    expect(ProfileFormModal.toForm(state)).toEqual(form)
    expect(ProfileFormModal.applyKey(state, "", key({ upArrow: true })).field).toBe(ProfileFormModal.Fields.length - 1)
    expect(ProfileFormModal.applyKey(state, "", key({ tab: true, shift: true })).field).toBe(ProfileFormModal.Fields.length - 1)
    expect(ProfileFormModal.toForm(ProfileFormModal.applyKey(state, "x", key())).name).toBe("nx")
  })
})

describe("ProfileFormModal.KeysHint", () => {
  it("spells Tab / ↓, S-Tab / ↑, Enter and Esc from chords", () => {
    expect(ProfileFormModal.KeysHint).toBe("Tab/↓ next field · S-Tab/↑ previous · Enter save · Esc cancel")
  })
})
