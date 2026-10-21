import { ORGANIZATION, PROJECT, WEB_HOST } from './config'
import { api, fetchBinary, identity, requestScope } from './http'
import { isMarkdownFormat, looksLikeMarkdown, markdownToHtml } from './markdown'
import type {
  AttachmentInfo,
  FieldChange,
  FieldGroup,
  FieldKind,
  FieldValue,
  LinkChange,
  RelatedLink,
  WorkItemComment,
  WorkItemRevision
} from '../shared/types'

/* ---------- Definiciones de campos ---------- */

interface FieldDefinition {
  name: string
  referenceName: string
  type: string
  isIdentity?: boolean
}

let definitions: Promise<Map<string, FieldDefinition>> | null = null

/**
 * Nombres y tipos de todos los campos de la organización; se piden una vez por sesión.
 * La descarga va fuera de `requestScope`: la promesa se comparte, y cancelar la búsqueda que la
 * inició no debe abortarla (se volvería a descargar en cada pulsación).
 */
function fieldDefinitions(): Promise<Map<string, FieldDefinition>> {
  definitions ??= requestScope
    .exit(() => api<{ value: FieldDefinition[] }>('/_apis/wit/fields'))
    .then((result) => new Map(result.value.map((field) => [field.referenceName, field])))
    .catch(() => {
      // Sin definiciones se usan nombres derivados; se reintenta en la siguiente carga.
      definitions = null
      return new Map<string, FieldDefinition>()
    })
  return definitions
}

/** Campo cuyo nombre visible es `name` (sin distinguir mayúsculas ni espacios), o null si no existe. */
export async function findFieldByName(name: string): Promise<{ referenceName: string; type: string } | null> {
  const key = (text: string) => text.replace(/\s+/g, '').toLowerCase()
  for (const field of (await fieldDefinitions()).values()) {
    if (key(field.name) === key(name)) return { referenceName: field.referenceName, type: field.type }
  }
  return null
}

/** `Microsoft.VSTS.Common.ValueArea` → `Value Area` cuando no hay definición. */
function fallbackLabel(refName: string): string {
  const last = refName.split('.').pop() ?? refName
  return last.replace(/([a-z])([A-Z])/g, '$1 $2')
}

function kindOf(refName: string, def: FieldDefinition | undefined, value: unknown): FieldKind {
  if (refName === 'System.Tags') return 'tags'
  if (def?.isIdentity || (value !== null && typeof value === 'object' && 'displayName' in value)) return 'identity'
  switch (def?.type) {
    case 'dateTime':
      return 'date'
    case 'integer':
    case 'double':
    case 'picklistInteger':
    case 'picklistDouble':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'treePath':
      return 'path'
    case 'html':
      return 'html'
    default:
      return 'text'
  }
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

function displayValue(kind: FieldKind, value: unknown): { value: string; imageUrl?: string | null } {
  switch (kind) {
    case 'identity': {
      if (typeof value === 'string') return { value, imageUrl: null }
      const person = identity(value)
      return { value: person.name, imageUrl: person.imageUrl }
    }
    case 'boolean':
      return { value: value === true || value === 'True' ? 'Sí' : 'No' }
    case 'number': {
      const number = Number(value)
      return { value: Number.isFinite(number) ? String(Math.round(number * 100) / 100) : String(value) }
    }
    default:
      return { value: String(value) }
  }
}

/* ---------- Campos que se muestran en el detalle ---------- */

const FIELD_GROUPS: { title: string; refs: string[] }[] = [
  {
    title: 'Estado',
    refs: [
      'System.State',
      'System.Reason',
      'System.AssignedTo',
      'Microsoft.VSTS.Common.Priority',
      'Microsoft.VSTS.Common.Severity',
      'Microsoft.VSTS.Common.Activity',
      'Microsoft.VSTS.Common.ValueArea',
      'System.BoardColumn',
      'System.BoardLane',
      'System.Tags'
    ]
  },
  {
    title: 'Planificación',
    refs: [
      'System.AreaPath',
      'System.IterationPath',
      'Microsoft.VSTS.Scheduling.StoryPoints',
      'Microsoft.VSTS.Scheduling.Effort',
      'Microsoft.VSTS.Scheduling.Size',
      'Microsoft.VSTS.Scheduling.OriginalEstimate',
      'Microsoft.VSTS.Scheduling.RemainingWork',
      'Microsoft.VSTS.Scheduling.CompletedWork',
      'Microsoft.VSTS.Scheduling.StartDate',
      'Microsoft.VSTS.Scheduling.TargetDate',
      'Microsoft.VSTS.Scheduling.DueDate',
      'Microsoft.VSTS.Common.BusinessValue',
      'Microsoft.VSTS.Common.TimeCriticality',
      'Microsoft.VSTS.Common.Risk'
    ]
  },
  {
    title: 'Build',
    refs: [
      'Microsoft.VSTS.Build.FoundIn',
      'Microsoft.VSTS.Build.IntegrationBuild',
      'Microsoft.VSTS.Common.ResolvedReason'
    ]
  },
  {
    title: 'Personas y fechas',
    refs: [
      'System.CreatedBy',
      'System.CreatedDate',
      'System.ChangedBy',
      'System.ChangedDate',
      'Microsoft.VSTS.Common.ActivatedBy',
      'Microsoft.VSTS.Common.ActivatedDate',
      'Microsoft.VSTS.Common.ResolvedBy',
      'Microsoft.VSTS.Common.ResolvedDate',
      'Microsoft.VSTS.Common.ClosedBy',
      'Microsoft.VSTS.Common.ClosedDate',
      'Microsoft.VSTS.Common.StateChangeDate'
    ]
  }
]

/** Campos HTML en el orden en que interesan; el resto de campos HTML va detrás. */
const RICH_TEXT_ORDER = [
  'System.Description',
  'Microsoft.VSTS.TCM.ReproSteps',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
  'Microsoft.VSTS.TCM.SystemInfo',
  'Microsoft.VSTS.Common.Resolution'
]

/** Campos internos o que ya se ven en otra parte (cabecera, enlaces, Discussion). */
const HIDDEN_FIELDS = new Set([
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.TeamProject',
  'System.Rev',
  'System.AuthorizedAs',
  'System.AuthorizedDate',
  'System.RevisedDate',
  'System.Watermark',
  'System.PersonId',
  'System.AreaId',
  'System.IterationId',
  'System.NodeName',
  'System.CommentCount',
  'System.History',
  'System.IsDeleted',
  'System.Parent',
  'System.BoardColumnDone',
  'System.ExternalLinkCount',
  'System.HyperLinkCount',
  'System.AttachedFileCount',
  'System.RelatedLinkCount',
  'System.RemoteLinkCount'
])

/** Los campos WEF_ son la columna/carril del tablero por equipo: duplican System.BoardColumn. */
const HIDDEN_PREFIXES = ['System.AreaLevel', 'System.IterationLevel', 'WEF_']

function isHidden(refName: string): boolean {
  return HIDDEN_FIELDS.has(refName) || HIDDEN_PREFIXES.some((prefix) => refName.startsWith(prefix))
}

/* ---------- Imágenes incrustadas ---------- */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGES_PER_HTML = 30
const IMAGE_CACHE_LIMIT = 200
const imageCache = new Map<string, Promise<string | null>>()

const WEB_HOSTNAME = new URL(WEB_HOST).hostname.toLowerCase()

/** Solo se descargan con el token las URL de la propia organización. */
export function isOrganizationUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    if (host === 'dev.azure.com') return parsed.pathname.toLowerCase().startsWith(`/${ORGANIZATION.toLowerCase()}/`)
    return host === WEB_HOSTNAME || host === `${ORGANIZATION.toLowerCase()}.visualstudio.com`
  } catch {
    return false
  }
}

function decodeAttribute(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

function imageAsDataUri(url: string): Promise<string | null> {
  let cached = imageCache.get(url)
  if (!cached) {
    if (imageCache.size >= IMAGE_CACHE_LIMIT) imageCache.clear()
    cached = fetchBinary(url, MAX_IMAGE_BYTES).then((file) =>
      file && file.contentType.startsWith('image/')
        ? `data:${file.contentType.split(';')[0]};base64,${file.data.toString('base64')}`
        : null
    )
    imageCache.set(url, cached)
  }
  return cached
}

/**
 * Las imágenes pegadas en Azure DevOps son adjuntos que piden autenticación, y el renderer
 * no tiene el token: se descargan aquí y se sustituyen por data URIs.
 */
async function inlineImages(html: string): Promise<string> {
  const sources = new Set<string>()
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi)) {
    if (isOrganizationUrl(decodeAttribute(match[2]))) sources.add(match[2])
    if (sources.size >= MAX_IMAGES_PER_HTML) break
  }
  if (sources.size === 0) return html

  const replacements = await Promise.all(
    [...sources].map(async (source) => [source, await imageAsDataUri(decodeAttribute(source))] as const)
  )
  let result = html
  for (const [source, dataUri] of replacements) {
    if (dataUri) result = result.split(source).join(dataUri)
  }
  return result
}

/** Texto plano a partir de HTML, para el historial. */
function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/* ---------- Enlaces ---------- */

interface RawRelation {
  rel: string
  url: string
  attributes?: { name?: string; comment?: string; resourceSize?: number; resourceCreatedDate?: string; authorizedDate?: string }
}

const RELATION_LABELS: Record<string, string> = {
  Parent: 'Padre',
  Child: 'Hijo',
  Related: 'Relacionado',
  Successor: 'Sucesor',
  Predecessor: 'Predecesor',
  Duplicate: 'Duplicado',
  'Duplicate Of': 'Duplicado de',
  'Tested By': 'Probado por',
  Tests: 'Prueba',
  'Test Case': 'Caso de prueba',
  'Shared Steps': 'Pasos compartidos',
  'Affected By': 'Afectado por',
  Affects: 'Afecta a'
}

const RELATION_ORDER = ['Padre', 'Hijo']

function relationLabel(relation: RawRelation): string {
  const name = relation.attributes?.name ?? relation.rel.split('.').pop() ?? relation.rel
  return RELATION_LABELS[name] ?? name
}

/** Id del work item en un link `…/_apis/wit/workItems/123`, o null si no es un work item. */
function linkedWorkItemId(relation: RawRelation): number | null {
  if (!/\/_apis\/wit\/workItems\/\d+$/i.test(relation.url)) return null
  return Number(relation.url.split('/').pop())
}

/** Describe un link de historial: "Padre #123", "Pull request !45", "Adjunto foo.png"… */
function describeRelation(relation: RawRelation): string {
  if (relation.rel === 'AttachedFile') return `Adjunto ${relation.attributes?.name ?? ''}`.trim()
  if (relation.rel === 'Hyperlink') return `Hipervínculo ${relation.url}`

  const id = linkedWorkItemId(relation)
  if (id !== null) return `${relationLabel(relation)} #${id}`

  if (relation.rel === 'ArtifactLink') {
    const match = /^vstfs:\/\/\/(\w+)\/(\w+)\/(.+)$/i.exec(relation.url)
    if (match) {
      const parts = decodeURIComponent(match[3]).split('/')
      const last = parts.slice(2).join('/') || parts[parts.length - 1]
      if (/^PullRequestId$/i.test(match[2])) return `Pull request !${last}`
      if (/^Commit$/i.test(match[2])) return `Commit ${last.slice(0, 8)}`
      if (/^Ref$/i.test(match[2])) return `Rama ${last.replace(/^GB/, '')}`
      if (/^Build$/i.test(match[1])) return `Build ${parts[parts.length - 1]}`
    }
    return relation.attributes?.name ?? 'Artefacto'
  }
  return relationLabel(relation)
}

/* ---------- Related links (Development / hipervínculos) ---------- */

/** Vínculo ya interpretado; `repositoryId` permite a azdo.ts poner el nombre del repositorio. */
export type RawRelatedLink = RelatedLink & { repositoryId: string | null; pullRequestId: number | null }

const projectWeb = `${WEB_HOST}/${encodeURIComponent(PROJECT)}`

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Interpreta un vínculo que no es work item ni adjunto. Los artefactos llegan como
 * `vstfs:///{herramienta}/{tipo}/{proyecto}%2F{repo}%2F{id}`; el id de una rama puede ir codificado otra vez.
 */
function parseRelatedLink(relation: RawRelation): RawRelatedLink {
  const comment = relation.attributes?.comment || null
  const base = { comment, detail: null, repositoryId: null, pullRequestId: null }

  if (relation.rel === 'Hyperlink') {
    return { ...base, kind: 'hyperlink', relation: 'Hipervínculo', title: relation.url, url: relation.url }
  }

  const match = /^vstfs:\/\/\/(\w+)\/(\w+)\/(.+)$/i.exec(relation.url)
  const name = relation.attributes?.name ?? relationLabel(relation)
  if (relation.rel !== 'ArtifactLink' || !match) {
    return { ...base, kind: 'artifact', relation: name, title: relation.url, url: null }
  }

  const [, tool, type, encoded] = match
  const decoded = safeDecode(encoded)
  const [, repo = '', ...rest] = decoded.split('/')
  const id = safeDecode(rest.join('/'))
  const repoWeb = `${projectWeb}/_git/${encodeURIComponent(repo)}`

  if (/^Git$/i.test(tool) && /^PullRequestId$/i.test(type)) {
    const prId = Number(id)
    return {
      ...base,
      kind: 'pullRequest',
      relation: 'Pull request',
      title: `!${id}`,
      url: `${repoWeb}/pullrequest/${encodeURIComponent(id)}`,
      repositoryId: repo,
      pullRequestId: Number.isFinite(prId) ? prId : null
    }
  }
  if (/^Git$/i.test(tool) && /^Commit$/i.test(type)) {
    return {
      ...base,
      kind: 'commit',
      relation: name === 'Fixed in Commit' ? 'Corregido en commit' : 'Commit',
      title: id.slice(0, 8),
      url: `${repoWeb}/commit/${encodeURIComponent(id)}`,
      repositoryId: repo
    }
  }
  if (/^Git$/i.test(tool) && /^Ref$/i.test(type)) {
    // GB = rama, GT = tag, GC = commit.
    const branch = id.replace(/^G[BTC]/, '')
    return {
      ...base,
      kind: 'branch',
      relation: id.startsWith('GT') ? 'Tag' : 'Rama',
      title: branch,
      url: `${repoWeb}?version=${encodeURIComponent(id)}`,
      repositoryId: repo
    }
  }
  if (/^Build$/i.test(tool)) {
    const buildId = decoded.split('/').pop() ?? decoded
    return {
      ...base,
      kind: 'build',
      relation: name === 'Found in build' ? 'Encontrado en build' : name === 'Integrated in build' ? 'Integrado en build' : 'Build',
      title: `Build ${buildId}`,
      url: `${projectWeb}/_build/results?buildId=${encodeURIComponent(buildId)}`
    }
  }
  if (/^Wiki$/i.test(tool)) {
    const path = id || '/'
    return {
      ...base,
      kind: 'wiki',
      relation: 'Página de wiki',
      title: path,
      url: `${projectWeb}/_wiki/wikis/${encodeURIComponent(repo)}?pagePath=${encodeURIComponent(path)}`
    }
  }
  return { ...base, kind: 'artifact', relation: name, title: decoded, url: null }
}

/* ---------- Detalle ---------- */

interface RawWorkItem {
  id: number
  fields: Record<string, unknown>
  relations?: RawRelation[]
  /** Campos de texto largo escritos en Markdown, p. ej. `{ "System.Description": "markdown" }`. */
  multilineFieldsFormat?: Record<string, string>
}

export interface WorkItemExtras {
  groups: FieldGroup[]
  richText: FieldValue[]
  otherFields: FieldValue[]
  /** Work items vinculados (sin resolver): azdo.ts los convierte en resúmenes. */
  linkRefs: { relation: string; id: number }[]
  relatedLinks: RawRelatedLink[]
  attachments: AttachmentInfo[]
  commentCount: number
}

/** Agrupa los campos del work item y extrae enlaces y adjuntos de sus relaciones. */
export async function readWorkItemDetail(raw: RawWorkItem): Promise<WorkItemExtras> {
  const defs = await fieldDefinitions()

  const toField = (refName: string): FieldValue | null => {
    const value = raw.fields[refName]
    if (isEmpty(value)) return null
    const def = defs.get(refName)
    const kind = kindOf(refName, def, value)
    const shown = displayValue(kind, value)
    if (!shown.value) return null
    return { refName, label: def?.name ?? fallbackLabel(refName), kind, ...shown }
  }

  const used = new Set<string>()
  const groups: FieldGroup[] = []
  for (const group of FIELD_GROUPS) {
    const fields = group.refs.map(toField).filter((field): field is FieldValue => field !== null)
    for (const field of fields) used.add(field.refName)
    if (fields.length > 0) groups.push({ title: group.title, fields })
  }

  const richText: FieldValue[] = []
  const otherFields: FieldValue[] = []
  const rest = Object.keys(raw.fields).filter((refName) => !used.has(refName) && !isHidden(refName))
  for (const refName of [...RICH_TEXT_ORDER.filter((ref) => rest.includes(ref)), ...rest]) {
    if (used.has(refName)) continue
    used.add(refName)
    const field = toField(refName)
    if (!field) continue
    if (field.kind === 'html') {
      if (htmlToText(field.value) || /<img\b/i.test(field.value)) richText.push(field)
    } else otherFields.push(field)
  }
  otherFields.sort((a, b) => a.label.localeCompare(b.label, 'es'))
  await Promise.all(
    richText.map(async (field) => {
      // Los campos en Markdown llegan como texto: se convierten a HTML antes de incrustar imágenes.
      if (isMarkdownFormat(raw.multilineFieldsFormat?.[field.refName]) || looksLikeMarkdown(field.value)) {
        field.value = await markdownToHtml(field.value)
      }
      field.value = await inlineImages(field.value)
    })
  )

  const linkRefs: { relation: string; id: number }[] = []
  const attachments: AttachmentInfo[] = []
  const relatedLinks: RawRelatedLink[] = []
  for (const relation of raw.relations ?? []) {
    if (relation.rel === 'AttachedFile') {
      const name = relation.attributes?.name ?? relation.url.split('/').pop() ?? 'adjunto'
      attachments.push({
        name,
        // Sin fileName el navegador descarga el adjunto con el GUID como nombre.
        url: `${relation.url}?fileName=${encodeURIComponent(name)}`,
        size: relation.attributes?.resourceSize ?? null,
        comment: relation.attributes?.comment || null,
        addedDate: relation.attributes?.resourceCreatedDate ?? relation.attributes?.authorizedDate ?? null
      })
      continue
    }
    const id = linkedWorkItemId(relation)
    if (id !== null) linkRefs.push({ relation: relationLabel(relation), id })
    else relatedLinks.push(parseRelatedLink(relation))
  }
  const rank = (label: string) => {
    const index = RELATION_ORDER.indexOf(label)
    return index < 0 ? RELATION_ORDER.length : index
  }
  linkRefs.sort((a, b) => rank(a.relation) - rank(b.relation) || a.relation.localeCompare(b.relation, 'es') || a.id - b.id)

  return {
    groups,
    richText,
    otherFields,
    linkRefs,
    relatedLinks,
    attachments,
    commentCount: Number(raw.fields['System.CommentCount'] ?? 0) || 0
  }
}

/* ---------- Discussion ---------- */

interface RawComment {
  id: number
  text?: string
  /** `markdown` o `html`. */
  format?: string
  /** HTML ya renderizado (con `$expand=renderedText`); útil cuando el comentario es Markdown. */
  renderedText?: string
  createdBy?: unknown
  createdDate: string
  modifiedDate?: string
  isDeleted?: boolean
}

const COMMENTS_API_VERSION = '7.1-preview.4'
const COMMENTS_PAGE_SIZE = 200
const COMMENTS_MAX_PAGES = 10

/** HTML de un comentario: los escritos en Markdown usan el renderizado de Azure DevOps si viene. */
async function commentHtml(comment: RawComment): Promise<string> {
  const text = comment.text ?? ''
  if (!isMarkdownFormat(comment.format)) return text
  return comment.renderedText || markdownToHtml(text)
}

export async function getWorkItemComments(id: number): Promise<WorkItemComment[]> {
  const raw: RawComment[] = []
  let continuationToken: string | undefined
  for (let page = 0; page < COMMENTS_MAX_PAGES; page++) {
    const result = await api<{ comments?: RawComment[]; continuationToken?: string }>(
      `/${encodeURIComponent(PROJECT)}/_apis/wit/workItems/${id}/comments`,
      {
        apiVersion: COMMENTS_API_VERSION,
        query: { $top: COMMENTS_PAGE_SIZE, order: 'desc', continuationToken, $expand: 'renderedText' }
      }
    )
    raw.push(...(result.comments ?? []))
    continuationToken = result.continuationToken
    if (!continuationToken) break
  }

  return Promise.all(
    raw
      .filter((comment) => !comment.isDeleted)
      .map(async (comment) => {
        const author = identity(comment.createdBy)
        const edited =
          comment.modifiedDate &&
          Math.abs(new Date(comment.modifiedDate).getTime() - new Date(comment.createdDate).getTime()) > 1000
        return {
          id: comment.id,
          author: author.name || 'Desconocido',
          authorImageUrl: author.imageUrl,
          createdDate: comment.createdDate,
          modifiedDate: edited ? comment.modifiedDate! : null,
          html: await inlineImages(await commentHtml(comment))
        }
      })
  )
}

/** Publica un comentario en Discussion. `html` puede llevar menciones `data-vss-mention`. */
export async function addWorkItemComment(id: number, html: string): Promise<null> {
  if (!html.trim()) throw new Error('El comentario está vacío.')
  await api(`/${encodeURIComponent(PROJECT)}/_apis/wit/workItems/${id}/comments`, {
    method: 'POST',
    apiVersion: COMMENTS_API_VERSION,
    body: { text: html }
  })
  return null
}

/* ---------- Historial ---------- */

interface RawUpdate {
  id: number
  rev?: number
  revisedBy?: unknown
  revisedDate?: string
  fields?: Record<string, { oldValue?: unknown; newValue?: unknown }>
  relations?: { added?: RawRelation[]; removed?: RawRelation[] }
}

/** En el historial sí interesan título, tipo y padre; se ocultan solo los campos de sistema. */
const HISTORY_HIDDEN = new Set([
  'System.Id',
  'System.Rev',
  'System.AuthorizedAs',
  'System.AuthorizedDate',
  'System.RevisedDate',
  'System.Watermark',
  'System.PersonId',
  'System.AreaId',
  'System.IterationId',
  'System.NodeName',
  'System.CommentCount',
  'System.History',
  'System.IsDeleted',
  'System.TeamProject',
  'System.ChangedBy',
  'System.ChangedDate',
  'System.CreatedBy',
  'System.CreatedDate',
  'System.BoardColumnDone',
  'System.ExternalLinkCount',
  'System.HyperLinkCount',
  'System.AttachedFileCount',
  'System.RelatedLinkCount',
  'System.RemoteLinkCount',
  'Microsoft.VSTS.Common.StateChangeDate'
])

const UPDATES_PAGE_SIZE = 200
const HISTORY_TEXT_LIMIT = 400

function historyValue(kind: FieldKind, value: unknown): string | null {
  if (isEmpty(value)) return null
  if (kind === 'html') {
    const text = htmlToText(String(value))
    return text.length > HISTORY_TEXT_LIMIT ? `${text.slice(0, HISTORY_TEXT_LIMIT)}…` : text || null
  }
  return displayValue(kind, value).value || null
}

export async function getWorkItemHistory(id: number): Promise<WorkItemRevision[]> {
  const [defs, updates] = await Promise.all([
    fieldDefinitions(),
    (async () => {
      const all: RawUpdate[] = []
      for (let skip = 0; ; skip += UPDATES_PAGE_SIZE) {
        const page = await api<{ value: RawUpdate[] }>(`/_apis/wit/workItems/${id}/updates`, {
          query: { $top: UPDATES_PAGE_SIZE, $skip: skip }
        })
        all.push(...page.value)
        if (page.value.length < UPDATES_PAGE_SIZE) return all
      }
    })()
  ])

  const revisions: WorkItemRevision[] = []
  for (const update of updates) {
    const fields = update.fields ?? {}
    const changes: FieldChange[] = []
    for (const [refName, change] of Object.entries(fields)) {
      if (HISTORY_HIDDEN.has(refName) || HIDDEN_PREFIXES.some((prefix) => refName.startsWith(prefix))) continue
      const def = defs.get(refName)
      const kind = kindOf(refName, def, change.newValue ?? change.oldValue)
      const oldValue = historyValue(kind, change.oldValue)
      const newValue = historyValue(kind, change.newValue)
      if (oldValue === newValue) continue
      changes.push({
        refName,
        label: def?.name ?? fallbackLabel(refName),
        kind: kind === 'html' ? 'text' : kind,
        oldValue,
        newValue
      })
    }

    const links: LinkChange[] = [
      ...(update.relations?.added ?? []).map((relation) => ({ action: 'added' as const, text: describeRelation(relation) })),
      ...(update.relations?.removed ?? []).map((relation) => ({ action: 'removed' as const, text: describeRelation(relation) }))
    ]

    const history = fields['System.History']?.newValue
    const comment = isEmpty(history) ? null : htmlToText(String(history)) || null
    if (changes.length === 0 && links.length === 0 && !comment) continue

    // revisedDate de la última revisión es 9999-01-01: la fecha real es System.ChangedDate.
    const changedDate = fields['System.ChangedDate']?.newValue
    const author = identity(update.revisedBy)
    revisions.push({
      rev: update.rev ?? update.id,
      author: author.name || 'Desconocido',
      authorImageUrl: author.imageUrl,
      date: typeof changedDate === 'string' ? changedDate : (update.revisedDate ?? ''),
      changes,
      links,
      comment
    })
  }
  return revisions.reverse()
}
