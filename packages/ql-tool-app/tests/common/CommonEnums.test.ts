import {
  AppAction,
  DialogOutcome,
  HostControlKind,
  IPCChannel,
  IPCEventChannel,
  QueryHostMessageKind,
  StoreKind,
  ThemeSource
} from "@wireio/ql-tool-app/common"

describe("common identity enums", () => {
  it.each([
    ["AppAction", AppAction],
    ["DialogOutcome", DialogOutcome],
    ["HostControlKind", HostControlKind],
    ["IPCChannel", IPCChannel],
    ["IPCEventChannel", IPCEventChannel],
    ["QueryHostMessageKind", QueryHostMessageKind],
    ["StoreKind", StoreKind],
    ["ThemeSource", ThemeSource]
  ])("%s values equal their keys", (_name, members: Record<string, string>) => {
    Object.entries(members).forEach(([key, value]) => expect(value).toBe(key))
  })

  it("ThemeSource spells Electron's nativeTheme.themeSource values", () => {
    expect(Object.values(ThemeSource).sort()).toEqual(["dark", "light", "system"])
  })

  it("AppAction carries the dismissed-menu sentinel", () => {
    expect(AppAction.none).toBe("none")
  })
})
