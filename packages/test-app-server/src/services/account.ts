import { APIClient, API } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"

const log = getLogger(__filename)

export async function getAccount(
  api: APIClient,
  name: string
): Promise<API.v1.AccountObject> {
  try {
    return await api.v1.chain.get_account(name)
  } catch (err) {
    log.error(
      `get_account(${name}) failed: ${err instanceof Error ? err.message : String(err)}`,
      err
    )
    return null
  }
}
