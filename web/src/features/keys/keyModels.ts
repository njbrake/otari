import { providerInstanceOf } from "@/features/models/modelKey"

/**
 * What a key's model allow-list reaches, for its Models cell: every model its
 * owner may use, none, or a selection named by the providers it draws on.
 */
export type KeyModelsSummary =
  | { kind: "all" }
  | { kind: "none" }
  | {
      kind: "selected"
      /** The instances the entries name, in the order the list first names each. */
      providers: string[]
      /**
       * Catalog models each instance's entries reach, keyed by instance. Empty
       * until the catalog has loaded, so a count is never a guess.
       */
      counts: Map<string, number>
      /** Catalog models the whole list reaches; undefined until the catalog has loaded. */
      total: number | undefined
    }

/**
 * Whether one allow-list entry reaches a canonical `instance:model` id: the
 * gateway's own rule, so a count here is the count it enforces. `instance:*`
 * reaches every model of the instance, `instance:prefix*` those starting with
 * the prefix, and anything else the one model it names.
 */
export function entryReaches(entry: string, modelId: string): boolean {
  const [entryInstance, ...entryRest] = entry.split(":")
  const [modelInstance, ...modelRest] = modelId.split(":")
  if (!entryInstance || entryInstance !== modelInstance) return false
  const entryModel = entryRest.join(":")
  const model = modelRest.join(":")
  if (entryModel === "*") return true
  if (entryModel.endsWith("*")) return model.startsWith(entryModel.slice(0, -1))
  return entryModel === model
}

/**
 * Summarize `allowedModels` against the catalog's `modelIds`, or `undefined`
 * ids while the catalog is still loading. Absent (`undefined`) is "inherits the
 * owner's access", which `[]` cannot say: `[]` is a real answer meaning none.
 */
export function summarizeKeyModels(
  allowedModels: readonly string[] | undefined,
  modelIds: readonly string[] | undefined,
): KeyModelsSummary {
  if (!allowedModels) return { kind: "all" }
  if (allowedModels.length === 0) return { kind: "none" }
  const providers = [
    ...new Set(
      allowedModels.flatMap((entry) => providerInstanceOf(entry) ?? []),
    ),
  ]
  if (!modelIds)
    return { kind: "selected", providers, counts: new Map(), total: undefined }
  const reached = modelIds.filter((id) =>
    allowedModels.some((entry) => entryReaches(entry, id)),
  )
  const counts = new Map(
    providers.map((provider) => [
      provider,
      reached.filter((id) => providerInstanceOf(id) === provider).length,
    ]),
  )
  return { kind: "selected", providers, counts, total: reached.length }
}
