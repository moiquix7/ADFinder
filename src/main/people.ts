import { API_BASE, MENTION_EMAIL_DOMAIN, PROJECT } from './config'
import { api } from './http'
import type { Collaborator } from '../shared/types'

const projectPath = `/_apis/projects/${encodeURIComponent(PROJECT)}`

/** Los miembros cambian poco: se reutilizan durante 10 minutos. */
const MEMBERS_CACHE_MS = 10 * 60_000
let membersCache: { at: number; members: Promise<Collaborator[]> } | null = null

interface RawIdentity {
  id: string
  displayName?: string
  uniqueName?: string
  imageUrl?: string
  isContainer?: boolean
}

/** Ejecuta `fn` sobre cada elemento con como mucho `limit` peticiones en vuelo. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

async function loadMembers(): Promise<Collaborator[]> {
  const teams = await api<{ value: { id: string }[] }>(`${projectPath}/teams`, { query: { $top: 1000 } })
  const perTeam = await mapLimit(teams.value, 6, (team) =>
    api<{ value: { identity: RawIdentity }[] }>(`${projectPath}/teams/${team.id}/members`, {
      query: { $top: 1000 }
    })
      .then((result) => result.value.map((member) => member.identity))
      .catch(() => [] as RawIdentity[])
  )

  const byId = new Map<string, Collaborator>()
  for (const identity of perTeam.flat()) {
    if (identity.isContainer || !identity.displayName || byId.has(identity.id)) continue
    byId.set(identity.id, {
      id: identity.id,
      displayName: identity.displayName,
      uniqueName: identity.uniqueName ?? '',
      imageUrl: identity.imageUrl ?? null
    })
  }
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'es'))
}

/** Colaboradores del proyecto: miembros de todos sus equipos, sin grupos ni duplicados. */
export function listCollaborators(): Promise<Collaborator[]> {
  if (!membersCache || Date.now() - membersCache.at > MEMBERS_CACHE_MS) {
    const members = loadMembers()
    membersCache = { at: Date.now(), members }
    // Si falla, la próxima llamada lo vuelve a intentar.
    members.catch(() => (membersCache = null))
  }
  return membersCache.members
}

interface RawPickerIdentity {
  localId?: string
  displayName?: string
  mail?: string
  signInAddress?: string
}

/** Busca personas en el directorio de la organización (incluye quien no está en ningún equipo). */
export async function searchCollaborators(query: string): Promise<Collaborator[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  const result = await api<{ results?: { identities?: RawPickerIdentity[] }[] }>(
    `${API_BASE}/_apis/IdentityPicker/Identities`,
    {
      method: 'POST',
      apiVersion: '7.1-preview.1',
      body: {
        query: trimmed,
        identityTypes: ['user'],
        operationScopes: ['ims', 'source'],
        options: { MinResults: 1, MaxResults: 25 },
        properties: ['DisplayName', 'Mail', 'SignInAddress']
      }
    }
  )

  const domain = MENTION_EMAIL_DOMAIN.toLowerCase()
  return (result.results?.[0]?.identities ?? [])
    .filter((identity): identity is RawPickerIdentity & { localId: string; displayName: string } =>
      Boolean(identity.localId && identity.displayName)
    )
    .map((identity) => ({
      id: identity.localId,
      displayName: identity.displayName,
      uniqueName: identity.mail || identity.signInAddress || '',
      imageUrl: null
    }))
    .filter((person) => !domain || person.uniqueName.toLowerCase().endsWith(`@${domain}`))
}
