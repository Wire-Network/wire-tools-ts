import type { Renderer } from "@wireio/test-cluster-tool/utils"

describe("Renderer", () => {
  it("contracts a nullary render() that returns a string", () => {
    const renderer: Renderer = { render: () => "hello world" }
    expect(renderer.render()).toBe("hello world")
  })

  it("renders only from constructed state, not call arguments", () => {
    class Greeting implements Renderer {
      constructor(private readonly name: string) {}
      render(): string {
        return `hi ${this.name}`
      }
    }
    expect(new Greeting("wire").render()).toBe("hi wire")
  })
})
