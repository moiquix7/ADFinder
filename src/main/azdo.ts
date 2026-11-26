import { PROJECT, WEB_HOST } from './config'
import { api, AzdoHttpError, identity, isNotFound } from './http'
import { findFieldByName, readWorkItemDetail } from './workItem'
import { MAX_MULTIPLE_TERMS, scopedSearch, titlePatternMatcher, wildcardSegments } from '../shared/query'
import type {
  CommitSummary,
  PullRequestMatch,
  PullRequestStatus,
  PullRequestSummary,
  RelatedLink,
  RelatedLinkKind,
  ReviewerVote,
  SearchOptions,
  SearchResult,
  SearchScope,
  WorkItemBranch,
  WorkItemCommit,
  WorkItemCommits,
  WorkItemCommitSource,
  WorkItemDetail,
  WorkItemSummary
} from '../shared/types'

/** Escapa comillas simples para incrustar texto en una consulta WIQL. */
function wiqlLiteral(value: string): string {
  return value.split("'").join("''")
}

/** Nombre de referencia del campo External Reference (p. ej. `Custom.ExternalReference`), o null si no existe. */
async function externalReferenceRefName(): Promise<string | null> {
  const field = await findFieldByName(EXTERNAL_REFERENCE_FIELD_NAME).catch(() => null)
  return field?.referenceName ?? null
}

function mapWorkItem(
  item: { id: number; fields: Record<string, unknown> },
  externalRefName: string | null
): WorkItemSummary {
  const assigned = identity(item.fields['System.AssignedTo'])
  const external = externalRefName ? item.fields[externalRefName] : undefined
  const externalReference = external === undefined || external === null ? '' : String(external).trim()
  return {
    id: item.id,
    title: String(item.fields['System.Title'] ?? '(sin título)'),
    type: String(item.fields['System.WorkItemType'] ?? ''),
    state: String(item.fields['System.State'] ?? ''),
    assignedTo: assigned.name || null,
    assignedToImageUrl: assigned.imageUrl,
    changedDate: (item.fields['System.ChangedDate'] as string | undefined) ?? null,
    externalReference: externalReference || null,
    url: `${WEB_HOST}/${encodeURIComponent(PROJECT)}/_workitems/edit/${item.id}`
  }
}

const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.AssignedTo',
  'System.ChangedDate'
]

/** Máximo de ids que acepta workitemsbatch por petición. */
const BATCH_SIZE = 200
/** Lotes de workitemsbatch que se piden a la vez. */
const BATCH_CONCURRENCY = 6
/** Tope de resultados de una consulta WIQL en Azure DevOps. */
const WIQL_MAX_RESULTS = 20000
/** Work items con detalle que devuelve una búsqueda por texto si no se piden todos. */
const DEFAULT_WORK_ITEM_LIMIT = 100

/** Resuelve ids a resúmenes por lotes, conservando el orden y omitiendo los inaccesibles. */
async function getWorkItemSummaries(ids: number[]): Promise<WorkItemSummary[]> {
  if (ids.length <= BATCH_SIZE) return getWorkItemBatch(ids)

  const chunks: number[][] = []
  for (let i = 0; i < ids.length; i += BATCH_SIZE) chunks.push(ids.slice(i, i + BATCH_SIZE))

  const results: WorkItemSummary[][] = new Array(chunks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      const index = next++
      results[index] = await getWorkItemBatch(chunks[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, chunks.length) }, worker))
  return results.flat()
}

async function getWorkItemBatch(ids: number[]): Promise<WorkItemSummary[]> {
  if (ids.length === 0) return []

  const externalRefName = await externalReferenceRefName()
  const fields = externalRefName ? [...WORK_ITEM_FIELDS, externalRefName] : WORK_ITEM_FIELDS
  const batch = await api<{ value: ({ id: number; fields: Record<string, unknown> } | null)[] }>(
    '/_apis/wit/workitemsbatch',
    { method: 'POST', body: { ids, fields, errorPolicy: 'omit' } }
  )

  const byId = new Map(
    batch.value
      .filter((item): item is { id: number; fields: Record<string, unknown> } => item !== null)
      .map((item) => [item.id, mapWorkItem(item, externalRefName)])
  )
  return ids.map((id) => byId.get(id)).filter((w): w is WorkItemSummary => Boolean(w))
}

/**
 * Busca work items del proyecto por id exacto, o por texto en los lugares marcados en
 * `scope` (título, descripción, colaborador, Discussion, adjuntos). Solo devuelve los tipos de
 * `scope.workItemTypes`.
 *
 * Con `limit`, la consulta WIQL pide solo `limit + 1` ids (el extra indica si hay más) y
 * se resuelve el detalle de `limit`. Sin `limit` trae todo, hasta el tope de WIQL.
 */
async function searchWorkItems(
  criteria: { id: number } | { text: string },
  scope: SearchScope,
  limit: number | null = null
): Promise<{ workItems: WorkItemSummary[]; hasMore: boolean; truncated: boolean; notes: string[] }> {
  const none = { workItems: [], hasMore: false, truncated: false, notes: [] }
  if (scope.workItemTypes.length === 0) return none

  let where: string | null
  if ('id' in criteria) {
    where = `[System.Id] = ${criteria.id}`
  } else {
    const escaped = wiqlLiteral(criteria.text)
    const clauses: string[] = []
    if (scope.title) clauses.push(`[System.Title] CONTAINS '${escaped}'`)
    if (scope.description) clauses.push(`[System.Description] CONTAINS WORDS '${escaped}'`)
    // Los campos de identidad comparan con el nombre visible ("Nombre Apellido <correo>").
    if (scope.collaborator) {
      clauses.push(`[System.AssignedTo] CONTAINS '${escaped}'`, `[System.CreatedBy] CONTAINS '${escaped}'`)
    }
    // La sección Discussion se guarda en System.History, indexado como texto largo.
    if (scope.discussion) clauses.push(`[System.History] CONTAINS WORDS '${escaped}'`)
    where = clauses.length > 0 ? `(${clauses.join(' OR ')})` : null
  }

  let found: { workItems: WorkItemSummary[]; hasMore: boolean; truncated: boolean; notes: string[] } = none
  if (where !== null) {
    const ids = (await runWiql(where, scope.workItemTypes, limit === null ? WIQL_MAX_RESULTS : limit + 1)).map(
      (w) => w.id
    )
    const hasMore = limit !== null && ids.length > limit
    found = {
      workItems: await getWorkItemSummaries(hasMore ? ids.slice(0, limit) : ids),
      hasMore,
      truncated: limit === null && ids.length >= WIQL_MAX_RESULTS,
      notes: []
    }
  }

  if ('id' in criteria || !scope.attachments) return found

  // WIQL no indexa los adjuntos: se combinan con los work items cuyo adjunto coincide.
  const attached = await searchAttachments(criteria.text, scope.workItemTypes, limit)
  const byId = new Map(found.workItems.map((item) => [item.id, item]))
  for (const item of attached.workItems) byId.set(item.id, item)
  const merged = [...byId.values()].sort((a, b) => (b.changedDate ?? '').localeCompare(a.changedDate ?? ''))
  const overLimit = limit !== null && merged.length > limit

  return {
    workItems: overLimit ? merged.slice(0, limit) : merged,
    hasMore: found.hasMore || attached.hasMore || overLimit,
    truncated: found.truncated,
    notes: attached.notes
  }
}

/** Ejecuta una consulta WIQL limitada al proyecto y a `types`, de más a menos reciente. */
async function runWiql(where: string, types: string[], top: number): Promise<{ id: number }[]> {
  const typeList = types.map((type) => `'${wiqlLiteral(type)}'`).join(', ')

  const wiql =
    `SELECT [System.Id] FROM WorkItems ` +
    `WHERE [System.TeamProject] = '${wiqlLiteral(PROJECT)}' ` +
    `AND [System.WorkItemType] IN (${typeList}) AND ${where} ` +
    `ORDER BY [System.ChangedDate] DESC`

  const result = await api<{ workItems?: { id: number }[] }>(
    `/${encodeURIComponent(PROJECT)}/_apis/wit/wiql`,
    { method: 'POST', body: { query: wiql }, query: { $top: top } }
  )
  return result.workItems ?? []
}

/** Work items que se revisan en una búsqueda con `%` limitada (sin «Mostrar todos»). */
const TITLE_PATTERN_SCAN_LIMIT = 2000

/**
 * Busca work items cuyo título encaja con un patrón con comodines `%`. WIQL no tiene LIKE:
 * se piden los que contienen todos los trozos y aquí se comprueba el orden y los bordes,
 * de más a menos reciente, hasta reunir `limit + 1` coincidencias.
 */
async function searchTitlePattern(
  pattern: string,
  types: string[],
  limit: number | null
): Promise<{ workItems: WorkItemSummary[]; hasMore: boolean; truncated: boolean }> {
  const segments = wildcardSegments(pattern)
  if (segments.length === 0 || types.length === 0) return { workItems: [], hasMore: false, truncated: false }

  const where = segments.map((segment) => `[System.Title] CONTAINS '${wiqlLiteral(segment)}'`).join(' AND ')
  const scanLimit = limit === null ? WIQL_MAX_RESULTS : TITLE_PATTERN_SCAN_LIMIT
  const ids = (await runWiql(where, types, scanLimit)).map((w) => w.id)
  const matches = titlePatternMatcher(pattern)
  const wanted = limit === null ? Infinity : limit + 1

  const workItems: WorkItemSummary[] = []
  for (let i = 0; i < ids.length && workItems.length < wanted; i += BATCH_SIZE * BATCH_CONCURRENCY) {
    const summaries = await getWorkItemSummaries(ids.slice(i, i + BATCH_SIZE * BATCH_CONCURRENCY))
    workItems.push(...summaries.filter((item) => matches(item.title)))
  }

  const hasMore = workItems.length > (limit ?? Infinity)
  return {
    workItems: hasMore ? workItems.slice(0, limit!) : workItems,
    hasMore,
    truncated: limit === null && ids.length >= WIQL_MAX_RESULTS
  }
}

/** Tipos de work item que tienen el campo External Reference. */
const EXTERNAL_REFERENCE_TYPES = ['Failure', 'Issue', 'Feature', 'User Story', 'Bug']
/** Nombre visible del campo; su nombre de referencia se resuelve con las definiciones de campos. */
const EXTERNAL_REFERENCE_FIELD_NAME = 'External Reference'

/**
 * Busca work items cuyo External Reference es exactamente `reference`, entre los tipos que
 * tienen ese campo y que el filtro no excluye.
 */
async function searchExternalReference(
  reference: string,
  scope: SearchScope,
  limit: number | null
): Promise<{ workItems: WorkItemSummary[]; hasMore: boolean; truncated: boolean; notes: string[] }> {
  const none = { workItems: [], hasMore: false, truncated: false }
  const field = await findFieldByName(EXTERNAL_REFERENCE_FIELD_NAME)
  if (!field) {
    return { ...none, notes: [`No se encontró el campo «${EXTERNAL_REFERENCE_FIELD_NAME}» en la organización.`] }
  }
  const types = EXTERNAL_REFERENCE_TYPES.filter((type) => scope.workItemTypes.includes(type))
  if (types.length === 0) {
    return {
      ...none,
      notes: [`El filtro excluye todos los tipos con External Reference (${EXTERNAL_REFERENCE_TYPES.join(', ')}).`]
    }
  }

  // Un campo numérico se compara como número; uno de texto, como cadena.
  const value = field.type === 'integer' || field.type === 'double' ? reference : `'${wiqlLiteral(reference)}'`
  const ids = (
    await runWiql(`[${field.referenceName}] = ${value}`, types, limit === null ? WIQL_MAX_RESULTS : limit + 1)
  ).map((w) => w.id)
  const hasMore = limit !== null && ids.length > limit
  return {
    workItems: await getWorkItemSummaries(hasMore ? ids.slice(0, limit) : ids),
    hasMore,
    truncated: limit === null && ids.length >= WIQL_MAX_RESULTS,
    notes: []
  }
}

/** Work items con adjuntos que se revisan en una búsqueda limitada (sin «Mostrar todos»). */
const ATTACHMENT_SCAN_LIMIT = 2000

/**
 * Busca el texto en el nombre y el comentario de los adjuntos. La API no permite filtrar
 * por adjunto, así que se recorren los work items con adjuntos (de más a menos reciente)
 * cargando sus relaciones, y se para en cuanto hay `limit + 1` coincidencias.
 */
async function searchAttachments(
  text: string,
  types: string[],
  limit: number | null
): Promise<{ workItems: WorkItemSummary[]; hasMore: boolean; notes: string[] }> {
  const scanLimit = limit === null ? WIQL_MAX_RESULTS : ATTACHMENT_SCAN_LIMIT
  const ids = (await runWiql('[System.AttachedFileCount] > 0', types, scanLimit)).map((w) => w.id)
  const needle = text.toLowerCase()
  const wanted = limit === null ? Infinity : limit + 1
  const externalRefName = await externalReferenceRefName()

  const chunks: number[][] = []
  for (let i = 0; i < ids.length; i += BATCH_SIZE) chunks.push(ids.slice(i, i + BATCH_SIZE))

  const matches: WorkItemSummary[] = []
  let scanned = 0
  for (let i = 0; i < chunks.length && matches.length < wanted; i += BATCH_CONCURRENCY) {
    const wave = chunks.slice(i, i + BATCH_CONCURRENCY)
    const batches = await Promise.all(
      wave.map((chunk) =>
        // $expand no se puede combinar con `fields`: se reciben todos los campos.
        api<{ value: (RawWorkItem | null)[] }>('/_apis/wit/workitemsbatch', {
          method: 'POST',
          body: { ids: chunk, $expand: 'relations', errorPolicy: 'omit' }
        })
      )
    )
    for (const item of batches.flatMap((batch) => batch.value)) {
      if (item && attachmentMatches(item, needle)) matches.push(mapWorkItem(item, externalRefName))
    }
    scanned += wave.reduce((sum, chunk) => sum + chunk.length, 0)
  }

  const hasMore = matches.length > (limit ?? Infinity)
  const notes =
    !hasMore && limit !== null && ids.length >= scanLimit && scanned >= ids.length
      ? [
          `En adjuntos solo se revisaron los ${ATTACHMENT_SCAN_LIMIT.toLocaleString('es')} work items con adjuntos modificados más recientemente. Activa «Mostrar todos los work items» para revisar el resto.`
        ]
      : []
  return { workItems: hasMore ? matches.slice(0, limit!) : matches, hasMore, notes }
}

function attachmentMatches(item: RawWorkItem, needle: string): boolean {
  return (item.relations ?? []).some((rel) => {
    if (rel.rel !== 'AttachedFile') return false
    const name = String(rel.attributes?.name ?? '').toLowerCase()
    const comment = String(rel.attributes?.comment ?? '').toLowerCase()
    return name.includes(needle) || comment.includes(needle)
  })
}

function truncatedNote(truncated: boolean): string[] {
  return truncated
    ? [
        `La búsqueda devolvió más de ${WIQL_MAX_RESULTS.toLocaleString('es')} work items; solo se muestran los ${WIQL_MAX_RESULTS.toLocaleString('es')} modificados más recientemente. Afina el término para ver el resto.`
      ]
    : []
}

interface RawWorkItem {
  id: number
  fields: Record<string, unknown>
  relations?: { rel: string; url: string; attributes?: Record<string, unknown> }[]
}

interface ParsedArtifact {
  repositoryId: string
  pullRequestId: number
}

/**
 * Los PR vinculados llegan como artifact links con la forma
 * `vstfs:///Git/PullRequestId/{projectId}%2F{repositoryId}%2F{pullRequestId}`.
 */
function parsePullRequestArtifact(url: string): ParsedArtifact | null {
  const marker = 'vstfs:///Git/PullRequestId/'
  if (!url.startsWith(marker)) return null
  const parts = decodeURIComponent(url.slice(marker.length)).split('/')
  if (parts.length < 3) return null
  const pullRequestId = Number(parts[2])
  if (!Number.isFinite(pullRequestId)) return null
  return { repositoryId: parts[1], pullRequestId }
}

interface RawPullRequest {
  pullRequestId: number
  title: string
  description?: string
  status: PullRequestStatus
  isDraft?: boolean
  mergeStatus?: string
  createdBy?: unknown
  creationDate: string
  closedDate?: string
  sourceRefName: string
  targetRefName: string
  reviewers?: { displayName?: string; imageUrl?: string; vote?: number; isRequired?: boolean }[]
  repository: { id: string; name: string; project?: { name?: string } }
}

function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

function mapPullRequest(pr: RawPullRequest): PullRequestSummary {
  const author = identity(pr.createdBy)
  const projectName = pr.repository.project?.name ?? PROJECT
  const reviewers: ReviewerVote[] = (pr.reviewers ?? []).map((r) => ({
    displayName: r.displayName ?? '',
    imageUrl: r.imageUrl ?? null,
    vote: r.vote ?? 0,
    isRequired: Boolean(r.isRequired)
  }))

  return {
    pullRequestId: pr.pullRequestId,
    title: pr.title,
    description: pr.description ?? null,
    status: pr.status,
    isDraft: Boolean(pr.isDraft),
    mergeStatus: pr.mergeStatus ?? null,
    createdBy: author.name,
    createdByImageUrl: author.imageUrl,
    creationDate: pr.creationDate,
    closedDate: pr.closedDate ?? null,
    sourceBranch: shortBranch(pr.sourceRefName),
    targetBranch: shortBranch(pr.targetRefName),
    repositoryId: pr.repository.id,
    repositoryName: pr.repository.name,
    projectName,
    reviewers,
    webUrl:
      `${WEB_HOST}/${encodeURIComponent(projectName)}` +
      `/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`
  }
}

/** Obtiene el work item con sus campos y relaciones, y resuelve cada PR y work item vinculado. */
export async function getWorkItemWithPullRequests(id: number): Promise<WorkItemDetail> {
  const raw = await api<RawWorkItem>(`/_apis/wit/workitems/${id}`, {
    query: { $expand: 'relations' }
  })
  // Campos, enlaces y adjuntos se preparan en paralelo con la carga de los PR.
  const extrasPromise = readWorkItemDetail(raw)

  const artifacts: { url: string; parsed: ParsedArtifact }[] = []
  for (const rel of raw.relations ?? []) {
    if (rel.rel !== 'ArtifactLink') continue
    const parsed = parsePullRequestArtifact(rel.url)
    if (parsed) artifacts.push({ url: rel.url, parsed })
  }

  const unresolved: string[] = []
  const settled = await Promise.all(
    artifacts.map(async ({ url, parsed }) => {
      try {
        const pr = await api<RawPullRequest>(
          `/_apis/git/repositories/${parsed.repositoryId}/pullrequests/${parsed.pullRequestId}`
        )
        return mapPullRequest(pr)
      } catch {
        // Repo borrado, PR purgado o sin permisos: se reporta sin romper el resto.
        unresolved.push(url)
        return null
      }
    })
  )

  const pullRequests = settled
    .filter((pr): pr is PullRequestSummary => pr !== null)
    .sort((a, b) => b.pullRequestId - a.pullRequestId)

  const { linkRefs, relatedLinks: rawRelated, ...extras } = await extrasPromise

  // Nombre del repositorio y título del PR para que los vínculos de desarrollo se entiendan.
  const repoNames = rawRelated.some((link) => link.repositoryId)
    ? new Map((await listRepositories().catch(() => [])).map((repo) => [repo.id.toLowerCase(), repo.name]))
    : new Map<string, string>()
  const prTitles = new Map(pullRequests.map((pr) => [pr.pullRequestId, pr.title]))
  const relatedLinks: RelatedLink[] = rawRelated.map(({ repositoryId, pullRequestId, ...link }) => {
    const repoName = repositoryId ? repoNames.get(repositoryId.toLowerCase()) ?? null : null
    const prTitle = pullRequestId !== null ? prTitles.get(pullRequestId) : undefined
    // Con el nombre real la URL es la que mostraría Azure DevOps (con el id también funciona).
    const url =
      repoName && repositoryId && link.url
        ? link.url.replace(`/_git/${encodeURIComponent(repositoryId)}`, `/_git/${encodeURIComponent(repoName)}`)
        : link.url
    return { ...link, title: prTitle ? `${link.title} ${prTitle}` : link.title, detail: repoName, url }
  })
  const order: RelatedLinkKind[] = ['pullRequest', 'branch', 'commit', 'build', 'wiki', 'hyperlink', 'artifact']
  relatedLinks.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  // Los vinculados pueden ser de cualquier tipo (p. ej. una Epic padre): no se filtra por tipo.
  const linkedSummaries = new Map(
    (await getWorkItemSummaries([...new Set(linkRefs.map((ref) => ref.id))])).map((w) => [w.id, w])
  )
  const links = linkRefs.flatMap((ref) => {
    const workItem = linkedSummaries.get(ref.id)
    return workItem ? [{ relation: ref.relation, workItem }] : []
  })

  return { workItem: mapWorkItem(raw, await externalReferenceRefName()), ...extras, links, relatedLinks, pullRequests, unresolved }
}


/* ---------- Búsqueda por pull request y por commit ---------- */

const projectPath = `/${encodeURIComponent(PROJECT)}`

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

async function getPullRequestById(id: number): Promise<RawPullRequest | null> {
  try {
    return await api<RawPullRequest>(`${projectPath}/_apis/git/pullrequests/${id}`)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/** Añade al PR los work items que tiene vinculados (de cualquier tipo). */
async function toPullRequestMatch(pr: RawPullRequest, viaCommit: string | null): Promise<PullRequestMatch> {
  const refs = await api<{ value: { id: string | number }[] }>(
    `${projectPath}/_apis/git/repositories/${pr.repository.id}/pullRequests/${pr.pullRequestId}/workitems`
  ).catch(() => ({ value: [] }))

  const ids = refs.value.map((ref) => Number(ref.id)).filter(Number.isFinite)
  return {
    pullRequest: mapPullRequest(pr),
    workItems: await getWorkItemSummaries(ids).catch(() => []),
    viaCommit
  }
}

interface RawRepository {
  id: string
  name: string
  isDisabled?: boolean
  /** `refs/heads/…`; falta en repositorios vacíos. */
  defaultBranch?: string
}

const REPO_CACHE_MS = 5 * 60_000
let repoCache: { at: number; repos: RawRepository[] } | null = null

async function listRepositories(): Promise<RawRepository[]> {
  if (repoCache && Date.now() - repoCache.at < REPO_CACHE_MS) return repoCache.repos
  const result = await api<{ value: RawRepository[] }>(`${projectPath}/_apis/git/repositories`)
  const repos = result.value.filter((repo) => !repo.isDisabled)
  repoCache = { at: Date.now(), repos }
  return repos
}

interface RawCommit {
  commitId: string
  comment?: string
  author?: { name?: string; date?: string }
}

function mapCommit(commit: RawCommit, repo: RawRepository): CommitSummary {
  return {
    commitId: commit.commitId,
    shortId: commit.commitId.slice(0, 8),
    comment: (commit.comment ?? '').split('\n')[0],
    author: commit.author?.name ?? '',
    authorDate: commit.author?.date ?? null,
    repositoryId: repo.id,
    repositoryName: repo.name,
    webUrl:
      `${WEB_HOST}/${encodeURIComponent(PROJECT)}` +
      `/_git/${encodeURIComponent(repo.name)}/commit/${commit.commitId}`
  }
}

async function getCommit(repo: RawRepository, commitId: string): Promise<CommitSummary | null> {
  try {
    const commit = await api<RawCommit>(
      `${projectPath}/_apis/git/repositories/${repo.id}/commits/${commitId}`
    )
    return mapCommit(commit, repo)
  } catch (error) {
    if (!isNotFound(error)) console.warn(`[commit] ${repo.name}: ${String(error)}`)
    return null
  }
}

/** Cuántos commits recientes y PR se revisan para resolver un SHA abreviado. */
const SHORT_SHA_SCAN = 1000

interface RawPullRequestCommits {
  repository: { id: string }
  lastMergeSourceCommit?: { commitId: string }
  lastMergeCommit?: { commitId: string }
}

/**
 * La API REST solo acepta el SHA completo, así que un SHA abreviado se busca por prefijo en:
 * - el último commit y el merge de los PR recientes del proyecto (una sola llamada), y
 * - el historial reciente de la rama por defecto de cada repo (merges y squash ya integrados).
 * Devuelve los pares repo → SHA completo candidatos.
 */
async function expandShortSha(sha: string, repos: RawRepository[]): Promise<Map<string, Set<string>>> {
  const candidates = new Map<string, Set<string>>()
  const add = (repoId: string, commitId: string | undefined) => {
    if (!commitId?.toLowerCase().startsWith(sha)) return
    if (!candidates.has(repoId)) candidates.set(repoId, new Set())
    candidates.get(repoId)!.add(commitId)
  }

  const prs = await api<{ value: RawPullRequestCommits[] }>(`${projectPath}/_apis/git/pullrequests`, {
    query: { 'searchCriteria.status': 'all', $top: SHORT_SHA_SCAN }
  }).catch(() => ({ value: [] }))
  for (const pr of prs.value) {
    add(pr.repository.id, pr.lastMergeSourceCommit?.commitId)
    add(pr.repository.id, pr.lastMergeCommit?.commitId)
  }

  await mapLimit(repos, 8, async (repo) => {
    const history = await api<{ value: { commitId: string }[] }>(
      `${projectPath}/_apis/git/repositories/${repo.id}/commits`,
      { query: { 'searchCriteria.$top': SHORT_SHA_SCAN } }
    ).catch(() => ({ value: [] }))
    for (const commit of history.value) add(repo.id, commit.commitId)
  })

  return candidates
}

/**
 * La API de commits exige el repositorio, así que se prueba el SHA en todos los repos
 * del proyecto. Con un SHA de 40 caracteres el resultado es exacto; uno abreviado se
 * expande primero con expandShortSha.
 */
async function findCommits(sha: string): Promise<CommitSummary[]> {
  const repos = await listRepositories()

  if (sha.length === 40) {
    const found = await mapLimit(repos, 8, (repo) => getCommit(repo, sha))
    return found.filter((commit): commit is CommitSummary => commit !== null)
  }

  const candidates = await expandShortSha(sha, repos)
  const byId = new Map(repos.map((repo) => [repo.id, repo]))
  const lookups = [...candidates].flatMap(([repoId, ids]) => {
    const repo = byId.get(repoId)
    return repo ? [...ids].map((id) => ({ repo, id })) : []
  })
  const found = await Promise.all(lookups.map(({ repo, id }) => getCommit(repo, id)))
  return found.filter((commit): commit is CommitSummary => commit !== null)
}

/** `results` va en la raíz, con un diccionario SHA → PR por cada consulta enviada. */
interface PullRequestQueryResponse {
  results?: Record<string, RawPullRequest[]>[]
}

/**
 * PR que contienen el commit (`commit`) o cuyo merge final es ese commit (`lastMergeCommit`),
 * de modo que sirve tanto un commit de la rama origen como el merge en la rama destino.
 */
async function findPullRequestsForCommit(commit: CommitSummary): Promise<RawPullRequest[]> {
  const response = await api<PullRequestQueryResponse>(
    `${projectPath}/_apis/git/repositories/${commit.repositoryId}/pullrequestquery`,
    {
      method: 'POST',
      body: {
        queries: [
          { type: 'commit', items: [commit.commitId] },
          { type: 'lastMergeCommit', items: [commit.commitId] }
        ]
      }
    }
  )

  const ids = new Set<number>()
  for (const result of response.results ?? []) {
    for (const prs of Object.values(result)) {
      for (const pr of prs ?? []) ids.add(pr.pullRequestId)
    }
  }
  console.log(`[commit] ${commit.shortId} → PR ${[...ids].join(', ') || '(ninguno)'}`)

  // La consulta devuelve PR parciales: se recargan completos para tener revisores, ramas, etc.
  const full = await Promise.all([...ids].map((id) => getPullRequestById(id)))
  return full.filter((pr): pr is RawPullRequest => pr !== null)
}

/* ---------- Listados: todos los PR (`!`) y work items padre (`#`) ---------- */

/** PR que devuelve `!` sin «Mostrar todos» y tope con él (cada PR pide sus work items vinculados). */
const DEFAULT_PULL_REQUEST_LIMIT = 100
const MAX_PULL_REQUEST_LIMIT = 1000
const PULL_REQUEST_PAGE = 100

/** Pull requests del proyecto en cualquier estado, del más reciente creado al más antiguo. */
async function listPullRequests(limit: number): Promise<{ pullRequests: PullRequestMatch[]; hasMore: boolean }> {
  const raw: RawPullRequest[] = []
  // Se pide uno de más para saber si quedan PR sin mostrar.
  while (raw.length <= limit) {
    const page = await api<{ value: RawPullRequest[] }>(`${projectPath}/_apis/git/pullrequests`, {
      query: {
        'searchCriteria.status': 'all',
        $top: PULL_REQUEST_PAGE,
        $skip: raw.length
      }
    })
    raw.push(...page.value)
    if (page.value.length < PULL_REQUEST_PAGE) break
  }

  raw.sort((a, b) => b.creationDate.localeCompare(a.creationDate) || b.pullRequestId - a.pullRequestId)
  const hasMore = raw.length > limit
  const pullRequests = await mapLimit(raw.slice(0, limit), 8, (pr) => toPullRequestMatch(pr, null))
  return { pullRequests, hasMore }
}

/** Ventana inicial (días) al recorrer los padres hacia atrás; se duplica hasta un año. */
const PARENT_WINDOW_DAYS = 30
const PARENT_MAX_WINDOW_DAYS = 365
const DAY_MS = 24 * 3600_000

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10)

/** Azure DevOps rechaza (VS402337) las consultas que devuelven más de 20.000 filas. */
function isSizeLimitError(error: unknown): boolean {
  return error instanceof AzdoHttpError && error.message.includes('VS402337')
}

/** Fecha de creación del work item más antiguo del proyecto: hasta ahí se recorre hacia atrás. */
async function oldestCreatedDate(types: string[]): Promise<number> {
  const typeList = types.map((type) => `'${wiqlLiteral(type)}'`).join(', ')
  const wiql =
    `SELECT [System.Id] FROM WorkItems ` +
    `WHERE [System.TeamProject] = '${wiqlLiteral(PROJECT)}' AND [System.WorkItemType] IN (${typeList}) ` +
    `ORDER BY [System.CreatedDate] ASC`
  const result = await api<{ workItems?: { id: number }[] }>(`${projectPath}/_apis/wit/wiql`, {
    method: 'POST',
    body: { query: wiql },
    query: { $top: 1 }
  })
  const id = result.workItems?.[0]?.id
  if (id === undefined) return Date.now()
  const item = await api<{ fields: Record<string, unknown> }>(`/_apis/wit/workitems/${id}`, {
    query: { fields: 'System.CreatedDate' }
  })
  return new Date(String(item.fields['System.CreatedDate'])).getTime()
}

/**
 * Padres modificados en [from, to) (días completos), del más reciente al más antiguo. Si la
 * ventana supera el límite de filas de Azure DevOps, se parte en dos y se consulta cada mitad.
 */
async function parentIdsInWindow(types: string[], from: number, to: number): Promise<number[]> {
  const typeList = types.map((type) => `'${wiqlLiteral(type)}'`).join(', ')
  const wiql =
    `SELECT [System.Id] FROM WorkItemLinks ` +
    `WHERE [Source].[System.TeamProject] = '${wiqlLiteral(PROJECT)}' ` +
    `AND [Source].[System.WorkItemType] IN (${typeList}) ` +
    `AND [Source].[System.ChangedDate] >= '${isoDay(from)}' ` +
    `AND [Source].[System.ChangedDate] < '${isoDay(to)}' ` +
    `AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' ` +
    `ORDER BY [System.ChangedDate] DESC ` +
    `MODE (MustContain)`

  let relations: { rel: string | null; source: { id: number } | null; target: { id: number } }[]
  try {
    const result = await api<{ workItemRelations?: typeof relations }>(`${projectPath}/_apis/wit/wiql`, {
      method: 'POST',
      body: { query: wiql }
    })
    relations = result.workItemRelations ?? []
  } catch (error) {
    const days = Math.round((to - from) / DAY_MS)
    if (!isSizeLimitError(error) || days <= 1) throw error
    const middle = from + Math.floor(days / 2) * DAY_MS
    return [...(await parentIdsInWindow(types, middle, to)), ...(await parentIdsInWindow(types, from, middle))]
  }

  // Las filas sin `rel` son los propios padres; las demás, padre → hijo.
  const ids: number[] = []
  const seen = new Set<number>()
  for (const relation of relations) {
    const id = relation.rel === null ? relation.target.id : relation.source?.id
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Work items con al menos un hijo (link Hierarchy-Forward), de `types`, del más recientemente
 * modificado al más antiguo. Una sola consulta de links superaría el límite de 20.000 filas, así
 * que se recorre el tiempo hacia atrás por ventanas hasta reunir `limit + 1` padres (o todos).
 */
async function listParentWorkItems(
  types: string[],
  limit: number | null
): Promise<{ workItems: WorkItemSummary[]; hasMore: boolean; truncated: boolean }> {
  if (types.length === 0) return { workItems: [], hasMore: false, truncated: false }

  const oldest = await oldestCreatedDate(types)
  const wanted = limit === null ? Infinity : limit + 1
  const ids: number[] = []
  const seen = new Set<number>()

  // `to` es mañana para incluir todo lo modificado hoy.
  let to = new Date(isoDay(Date.now())).getTime() + DAY_MS
  let windowDays = PARENT_WINDOW_DAYS
  while (ids.length < wanted && to > oldest) {
    const from = to - windowDays * DAY_MS
    for (const id of await parentIdsInWindow(types, from, to)) {
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    to = from
    windowDays = Math.min(windowDays * 2, PARENT_MAX_WINDOW_DAYS)
  }

  const hasMore = ids.length > (limit ?? Infinity)
  const workItems = await getWorkItemSummaries(hasMore ? ids.slice(0, limit!) : ids)
  workItems.sort((a, b) => (b.changedDate ?? '').localeCompare(a.changedDate ?? ''))
  return { workItems, hasMore, truncated: false }
}

/** Búsquedas de una lista con comas que se lanzan a la vez (cada una puede hacer varias peticiones). */
const MULTIPLE_CONCURRENCY = 4

/**
 * Busca cada valor de una lista por separado y une los resultados en el orden de la lista, sin
 * repetir work items, PR ni commits. Los avisos se agrupan por texto indicando a qué valores aplican.
 */
async function searchMultiple(terms: string[], options: SearchOptions): Promise<SearchResult> {
  const searched = terms.slice(0, MAX_MULTIPLE_TERMS)
  const results = await mapLimit(searched, MULTIPLE_CONCURRENCY, (term) => search(term, options))

  const workItems = new Map<number, WorkItemSummary>()
  const pullRequests = new Map<number, PullRequestMatch>()
  const commits = new Map<string, CommitSummary>()
  const notesByText = new Map<string, string[]>()
  let hasMoreWorkItems = false
  let hasMorePullRequests = false

  results.forEach((result, index) => {
    for (const item of result.workItems) if (!workItems.has(item.id)) workItems.set(item.id, item)
    for (const match of result.pullRequests) {
      const id = match.pullRequest.pullRequestId
      if (!pullRequests.has(id)) pullRequests.set(id, match)
    }
    for (const commit of result.commits) {
      const key = `${commit.repositoryId}/${commit.commitId}`
      if (!commits.has(key)) commits.set(key, commit)
    }
    for (const note of result.notes) notesByText.set(note, [...(notesByText.get(note) ?? []), searched[index]])
    hasMoreWorkItems ||= result.hasMoreWorkItems
    hasMorePullRequests ||= result.hasMorePullRequests
  })

  const notes = [...notesByText].map(([note, noteTerms]) => `${noteTerms.map((term) => `«${term}»`).join(', ')}: ${note}`)
  if (terms.length > MAX_MULTIPLE_TERMS) {
    notes.unshift(
      `Se buscaron solo los primeros ${MAX_MULTIPLE_TERMS} valores de ${terms.length}; divide la lista para buscar el resto.`
    )
  }

  return {
    kind: 'multiple',
    workItems: [...workItems.values()],
    hasMoreWorkItems,
    pullRequests: [...pullRequests.values()],
    hasMorePullRequests,
    commits: [...commits.values()],
    notes
  }
}

/** Punto de entrada único: decide qué buscar a partir del término y del filtro. */
export async function search(term: string, options: SearchOptions): Promise<SearchResult> {
  const { scope } = options
  const query = scopedSearch(term, scope)
  const empty = {
    workItems: [],
    hasMoreWorkItems: false,
    pullRequests: [],
    hasMorePullRequests: false,
    commits: [],
    notes: []
  }

  switch (query.kind) {
    case 'empty':
      return { kind: 'text', ...empty }

    case 'multiple':
      return searchMultiple(query.terms, options)

    case 'allPullRequests': {
      const limit = options.allWorkItems ? MAX_PULL_REQUEST_LIMIT : DEFAULT_PULL_REQUEST_LIMIT
      const { pullRequests, hasMore } = await listPullRequests(limit)
      const notes =
        options.allWorkItems && hasMore
          ? [`Se muestran los ${MAX_PULL_REQUEST_LIMIT.toLocaleString('es')} pull requests más recientes.`]
          : []
      return { kind: query.kind, ...empty, pullRequests, hasMorePullRequests: hasMore && !options.allWorkItems, notes }
    }

    case 'parentWorkItems': {
      const limit = options.allWorkItems ? null : DEFAULT_WORK_ITEM_LIMIT
      const { workItems, hasMore, truncated } = await listParentWorkItems(scope.workItemTypes, limit)
      return { kind: query.kind, ...empty, workItems, hasMoreWorkItems: hasMore, notes: truncatedNote(truncated) }
    }

    case 'text': {
      if (!scope.title && !scope.description && !scope.collaborator && !scope.discussion && !scope.attachments) {
        return {
          kind: 'text',
          ...empty,
          notes: [
            'El filtro no tiene marcado ningún lugar de texto (título, descripción, colaborador, Discussion o adjuntos).'
          ]
        }
      }
      const limit = options.allWorkItems ? null : DEFAULT_WORK_ITEM_LIMIT
      const { workItems, hasMore, truncated, notes } = await searchWorkItems({ text: query.text }, scope, limit)
      return {
        kind: 'text',
        ...empty,
        workItems,
        hasMoreWorkItems: hasMore,
        notes: [...truncatedNote(truncated), ...notes]
      }
    }

    case 'titlePattern': {
      if (wildcardSegments(query.pattern).length === 0) {
        return { kind: query.kind, ...empty, notes: ['Escribe algún texto junto al comodín «%» (p. ej. %login%).'] }
      }
      const limit = options.allWorkItems ? null : DEFAULT_WORK_ITEM_LIMIT
      const { workItems, hasMore, truncated } = await searchTitlePattern(query.pattern, scope.workItemTypes, limit)
      return { kind: query.kind, ...empty, workItems, hasMoreWorkItems: hasMore, notes: truncatedNote(truncated) }
    }

    case 'externalReference': {
      if (!query.reference) {
        // Mientras se escribe el número se van descargando las definiciones de campos.
        void findFieldByName(EXTERNAL_REFERENCE_FIELD_NAME)
        return { kind: query.kind, ...empty, notes: ['Escribe el número de External Reference.'] }
      }
      const limit = options.allWorkItems ? null : DEFAULT_WORK_ITEM_LIMIT
      const { workItems, hasMore, truncated, notes } = await searchExternalReference(query.reference, scope, limit)
      return {
        kind: query.kind,
        ...empty,
        workItems,
        hasMoreWorkItems: hasMore,
        notes: [...truncatedNote(truncated), ...notes]
      }
    }

    case 'workItemId': {
      const { workItems } = await searchWorkItems({ id: query.id }, scope)
      return { kind: query.kind, ...empty, workItems }
    }

    case 'pullRequestId':
    case 'number': {
      if (!scope.pullRequestNumber) {
        return { kind: query.kind, ...empty, notes: ['El filtro tiene desmarcado «Número PullRequest».'] }
      }
      const [{ workItems }, pr] = await Promise.all([
        query.kind === 'number'
          ? searchWorkItems({ id: query.id }, scope)
          : Promise.resolve({ workItems: [] }),
        getPullRequestById(query.id)
      ])
      const pullRequests = pr ? [await toPullRequestMatch(pr, null)] : []
      return { kind: query.kind, ...empty, workItems, pullRequests }
    }

    case 'commit': {
      const commits = await findCommits(query.sha)
      const notes: string[] = []
      if (commits.length === 0 && query.sha.length < 40) {
        notes.push(
          'No se encontró el commit. Un SHA abreviado solo se busca en los PR recientes y en el historial reciente de la rama por defecto: prueba con el SHA completo (40 caracteres).'
        )
      }

      const seen = new Set<number>()
      const pullRequests: PullRequestMatch[] = []
      for (const commit of commits) {
        for (const pr of await findPullRequestsForCommit(commit)) {
          if (seen.has(pr.pullRequestId)) continue
          seen.add(pr.pullRequestId)
          pullRequests.push(await toPullRequestMatch(pr, commit.commitId))
        }
      }
      pullRequests.sort((a, b) => b.pullRequest.pullRequestId - a.pullRequest.pullRequestId)

      return { kind: 'commit', ...empty, commits, pullRequests, notes }
    }
  }
}

/* ---------- Historial de commits del work item ---------- */

/** Tope de commits que se piden por PR (la API pagina; un PR con más es muy raro). */
const PULL_REQUEST_COMMITS_TOP = 1000

/** `lastMergeCommit` en un PR completado es el commit con el que entró en la rama destino. */
interface RawPullRequestWithMerge extends RawPullRequest {
  lastMergeCommit?: { commitId: string }
}

interface GitArtifact {
  type: string
  repositoryId: string
  id: string
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** `vstfs:///Git/{tipo}/{proyecto}%2F{repo}%2F{id}`; el id de una rama puede ir codificado otra vez. */
function parseGitArtifact(url: string): GitArtifact | null {
  const match = /^vstfs:\/\/\/Git\/(\w+)\/(.+)$/i.exec(url)
  if (!match) return null
  const [, repositoryId = '', ...rest] = decodeSafely(match[2]).split('/')
  const id = decodeSafely(rest.join('/'))
  return repositoryId && id ? { type: match[1].toLowerCase(), repositoryId, id } : null
}

const BRANCH_ORDER: WorkItemBranch['origin'][] = ['link', 'pullRequestSource', 'pullRequestTarget', 'repositoryDefault']

function sameSource(a: WorkItemCommitSource, b: WorkItemCommitSource): boolean {
  if (a.kind === 'link' || b.kind === 'link') return a.kind === b.kind
  return a.kind === b.kind && a.pullRequestId === b.pullRequestId
}

/**
 * Commits relacionados con el work item: los de cada PR vinculado, el commit con el que se
 * completó cada PR (merge o squash en la rama destino) y los vinculados directamente. Junto a
 * ellos, las ramas relacionadas (vinculadas y origen/destino de los PR) para filtrar por rama.
 */
export async function getWorkItemCommits(id: number): Promise<WorkItemCommits> {
  const raw = await api<RawWorkItem>(`/_apis/wit/workitems/${id}`, { query: { $expand: 'relations' } })
  const artifacts = (raw.relations ?? [])
    .filter((rel) => rel.rel === 'ArtifactLink')
    .map((rel) => parseGitArtifact(rel.url))
    .filter((artifact): artifact is GitArtifact => artifact !== null)

  const repos = await listRepositories().catch(() => [] as RawRepository[])
  const repoById = new Map(repos.map((repo) => [repo.id.toLowerCase(), repo]))
  const repoFor = (repositoryId: string): RawRepository =>
    repoById.get(repositoryId.toLowerCase()) ?? { id: repositoryId, name: repositoryId }

  const notes: string[] = []
  const commits = new Map<string, WorkItemCommit>()
  const addCommit = (commit: CommitSummary, source: WorkItemCommitSource) => {
    const key = `${commit.repositoryId.toLowerCase()}/${commit.commitId.toLowerCase()}`
    const existing = commits.get(key)
    if (!existing) commits.set(key, { ...commit, sources: [source] })
    else if (!existing.sources.some((s) => sameSource(s, source))) existing.sources.push(source)
  }

  const branches = new Map<string, WorkItemBranch>()
  const addBranch = (repo: RawRepository, name: string, origin: WorkItemBranch['origin'], pullRequestId?: number) => {
    const key = `${repo.id.toLowerCase()}/${name}`
    const existing = branches.get(key)
    if (!existing) {
      branches.set(key, {
        repositoryId: repo.id,
        repositoryName: repo.name,
        name,
        origin,
        pullRequestIds: pullRequestId === undefined ? [] : [pullRequestId]
      })
      return
    }
    // Se queda el origen más relevante (vinculada > origen de PR > destino de PR > por defecto).
    if (BRANCH_ORDER.indexOf(origin) < BRANCH_ORDER.indexOf(existing.origin)) existing.origin = origin
    if (pullRequestId !== undefined && !existing.pullRequestIds.includes(pullRequestId)) {
      existing.pullRequestIds.push(pullRequestId)
    }
  }

  // GB = rama; los tags (GT) y commits (GC) vinculados como Ref no sirven para filtrar.
  for (const ref of artifacts.filter((artifact) => artifact.type === 'ref' && artifact.id.startsWith('GB'))) {
    addBranch(repoFor(ref.repositoryId), ref.id.slice(2), 'link')
  }

  const pullRequests = await mapLimit(
    artifacts.filter((artifact) => artifact.type === 'pullrequestid'),
    6,
    async (ref) => {
      try {
        return await api<RawPullRequestWithMerge>(
          `/_apis/git/repositories/${ref.repositoryId}/pullrequests/${encodeURIComponent(ref.id)}`
        )
      } catch {
        notes.push(`No se pudo cargar el pull request !${ref.id} (repositorio eliminado o sin permisos).`)
        return null
      }
    }
  )

  await mapLimit(
    pullRequests.filter((pr): pr is RawPullRequestWithMerge => pr !== null),
    4,
    async (pr) => {
      const repo = repoFor(pr.repository.id)
      const prId = pr.pullRequestId
      addBranch(repo, shortBranch(pr.sourceRefName), 'pullRequestSource', prId)
      addBranch(repo, shortBranch(pr.targetRefName), 'pullRequestTarget', prId)

      try {
        const list = await api<{ value: RawCommit[] }>(
          `/_apis/git/repositories/${repo.id}/pullRequests/${prId}/commits`,
          { query: { $top: PULL_REQUEST_COMMITS_TOP } }
        )
        for (const commit of list.value) {
          addCommit(mapCommit(commit, repo), { kind: 'pullRequest', pullRequestId: prId })
        }
        if (list.value.length >= PULL_REQUEST_COMMITS_TOP) {
          notes.push(
            `El pull request !${prId} tiene más de ${PULL_REQUEST_COMMITS_TOP} commits; solo se muestran los primeros.`
          )
        }
      } catch {
        notes.push(`No se pudieron cargar los commits del pull request !${prId}.`)
      }

      // En un PR activo `lastMergeCommit` es el merge de prueba, no un commit real de la rama destino.
      if (pr.status === 'completed' && pr.lastMergeCommit) {
        const merge = await getCommit(repo, pr.lastMergeCommit.commitId)
        if (merge) addCommit(merge, { kind: 'merge', pullRequestId: prId })
      }
    }
  )

  await mapLimit(
    artifacts.filter((artifact) => artifact.type === 'commit'),
    6,
    async (ref) => {
      const commit = await getCommit(repoFor(ref.repositoryId), ref.id)
      if (commit) addCommit(commit, { kind: 'link' })
      else notes.push(`No se pudo cargar el commit vinculado ${ref.id.slice(0, 8)}.`)
    }
  )

  // Un commit vinculado sin PR vinculado: se buscan los PR que lo contienen (o cuyo merge es él)
  // para mostrar su PR y conocer sus ramas origen y destino.
  const loaded = new Map<number, RawPullRequestWithMerge>()
  for (const pr of pullRequests) if (pr) loaded.set(pr.pullRequestId, pr)
  const orphans = [...commits.values()].filter((commit) => commit.sources.every((source) => source.kind === 'link'))
  await mapLimit(orphans, 4, async (commit) => {
    let found: RawPullRequestWithMerge[]
    try {
      found = (await findPullRequestsForCommit(commit)) as RawPullRequestWithMerge[]
    } catch {
      notes.push(`No se pudieron buscar los pull requests del commit ${commit.shortId}.`)
      return
    }
    for (const pr of found) {
      const prId = pr.pullRequestId
      if (!loaded.has(prId)) loaded.set(prId, pr)
      const isMerge = pr.lastMergeCommit?.commitId.toLowerCase() === commit.commitId.toLowerCase()
      addCommit(commit, { kind: isMerge ? 'merge' : 'pullRequest', pullRequestId: prId })
      const repo = repoFor(pr.repository.id)
      addBranch(repo, shortBranch(pr.sourceRefName), 'pullRequestSource', prId)
      addBranch(repo, shortBranch(pr.targetRefName), 'pullRequestTarget', prId)
    }
  })

  // La rama por defecto de cada repositorio con commits siempre se puede elegir (p. ej. sin PR).
  for (const repositoryId of new Set([...commits.values()].map((commit) => commit.repositoryId.toLowerCase()))) {
    const repo = repoById.get(repositoryId)
    if (repo?.defaultBranch) addBranch(repo, shortBranch(repo.defaultBranch), 'repositoryDefault')
  }

  const sortedCommits = [...commits.values()].sort((a, b) =>
    (b.authorDate ?? '').localeCompare(a.authorDate ?? '')
  )
  const sortedBranches = [...branches.values()].sort(
    (a, b) =>
      BRANCH_ORDER.indexOf(a.origin) - BRANCH_ORDER.indexOf(b.origin) ||
      a.repositoryName.localeCompare(b.repositoryName) ||
      a.name.localeCompare(b.name)
  )
  const loadedPullRequests = [...loaded.values()].map(mapPullRequest)
  return { commits: sortedCommits, branches: sortedBranches, pullRequests: loadedPullRequests, notes }
}

/** Tope de commits que se comprueban en una rama de una vez (una petición por commit). */
const BRANCH_CHECK_LIMIT = 2000

/**
 * De `commitIds`, los que están en la rama: un commit está en la rama si es antecesor de su
 * punta, es decir, si el ancestro común entre el commit y la rama es el propio commit.
 */
export async function getCommitsInBranch(
  repositoryId: string,
  branch: string,
  commitIds: string[]
): Promise<string[]> {
  const ids = [...new Set(commitIds)].slice(0, BRANCH_CHECK_LIMIT)
  try {
    const found = await mapLimit(ids, 8, async (commitId) => {
      const diff = await api<{ commonCommit?: string }>(
        `${projectPath}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/diffs/commits`,
        {
          query: {
            baseVersion: commitId,
            baseVersionType: 'commit',
            targetVersion: branch,
            targetVersionType: 'branch',
            diffCommonCommit: 'true',
            $top: 1
          }
        }
      )
      return diff.commonCommit?.toLowerCase() === commitId.toLowerCase() ? commitId : null
    })
    return found.filter((commitId): commitId is string => commitId !== null)
  } catch (error) {
    if (isNotFound(error)) throw new Error(`La rama «${branch}» ya no existe en el repositorio.`)
    throw error
  }
}
