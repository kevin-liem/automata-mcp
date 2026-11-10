import { z } from 'zod'
import type { AppOrganization } from '~~/server/utils/app-db'
import type { ToolCallSetting } from '~~/server/utils/tool-calls'

const body = z.object({
  name: z.string().trim().min(1, 'Give the organization a name').max(100).optional(),
  /** Record every MCP tool call and its reason. See server/utils/tool-calls.ts. */
  recordToolCalls: z.boolean().optional(),
}).refine(value => value.name !== undefined || value.recordToolCalls !== undefined, 'Nothing to change')

/** Rename the organization or set its tool-call recording preference. Admin-only. */
export default defineEventHandler(async (event) => {
  const actor = await requireOrgAdmin(event)
  const { name, recordToolCalls } = await parseBody(event, body)

  let toolCalls: ToolCallSetting | undefined
  if (recordToolCalls !== undefined) toolCalls = await setToolCallRecording(actor.org.id, recordToolCalls)

  const org = name !== undefined
    ? await updateRow<AppOrganization>('organizations', actor.org.id, { name })
    : actor.org

  return { org: { id: org.id, name: org.name }, toolCalls }
})
