import { OperatorType } from "@wireio/opp-typescript-models"
import { assert } from "@wireio/shared"
import { z } from "zod"

/**
 * The `OperatorType` codec of the persisted JSON shapes that carry an operator
 * type by NAME (`external-cluster-config.json`, `wire-opreg-bootstrap.json`): the
 * WIRE (input) side is the member NAME (`"BATCH"`), the DECODED (output) side is
 * the numeric proto enum. A shape that admits only some types creates its codec
 * over exactly those members, so its JSON Schema lists exactly their names and
 * its decoded type is exactly their union.
 */
export namespace OperatorTypeCodec {
  /** Every `OperatorType` member, in declaration order — the default admitted set. */
  export const Members: readonly OperatorType[] = Object.values(OperatorType).filter(
    (value): value is OperatorType => typeof value === "number"
  )

  /**
   * Create the codec admitting exactly `members`. The wire side is a `z.enum` of
   * their names, so an unknown or non-admitted name is a zod issue on decode; the
   * decoded side refuses a non-admitted value, so encoding one is an issue too.
   *
   * @param members - The admitted members (default: {@link Members}); at least one.
   * @returns The zod codec — wire: the member NAME, decoded: the numeric enum (`T`).
   * @throws When `members` is empty.
   */
  export function create<T extends OperatorType = OperatorType>(
    members: readonly T[] = Members as readonly T[]
  ) {
    assert(
      members.length > 0,
      "OperatorTypeCodec.create: at least one member is required"
    )
    return z.codec(
      z.enum(members.map(member => OperatorType[member])),
      z.custom<T>(value => members.includes(value as T)),
      {
        decode: (name: string): T => OperatorType[name as keyof typeof OperatorType] as T,
        encode: (value: T): string => OperatorType[value]
      }
    )
  }
}
