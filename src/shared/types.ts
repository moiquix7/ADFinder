/** Contratos compartidos entre el proceso main, el preload y el renderer. */

export interface AccountInfo {
  name: string
  username: string
  tenantId: string
}

export interface AuthState {
  signedIn: boolean
  account: AccountInfo | null
}

export interface WorkItemSummary {
  id: number
  title: string
  type: string
  state: string
  assignedTo: string | null
  assignedToImageUrl: string | null
  changedDate: string | null
  url: string
}

export interface ReviewerVote {
  displayName: string
  imageUrl: string | null
  /** 10 aprobado, 5 aprobado con sugerencias, 0 sin voto, -5 en espera, -10 rechazado. */
  vote: number
  isRequired: boolean
}

export type PullRequestStatus = 'active' | 'completed' | 'abandoned' | 'notSet' | 'all'

export interface PullRequestSummary {
  pullRequestId: number
  title: string
  description: string | null
  status: PullRequestStatus
  isDraft: boolean
  mergeStatus: string | null
  createdBy: string
  createdByImageUrl: string | null
  creationDate: string
  closedDate: string | null
  sourceBranch: string
  targetBranch: string
  repositoryId: string
  repositoryName: string
  projectName: string
  reviewers: ReviewerVote[]
  webUrl: string
}

/** Cómo se presenta el valor de un campo. */
export type FieldKind = 'text' | 'identity' | 'date' | 'number' | 'boolean' | 'tags' | 'path' | 'html'

export interface FieldValue {
  /** Nombre de referencia (p. ej. `System.AreaPath`). */
  refName: string
  label: string
  kind: FieldKind
  /** Texto ya listo para mostrar (fecha ISO, nombre visible, etc.). En `html`, el HTML original. */
  value: string
  imageUrl?: string | null
  /** Enlace externo al que lleva el valor (p. ej. External Reference → IssueTrack). */
  url?: string
}

export interface FieldGroup {
  title: string
  fields: FieldValue[]
}

export interface LinkedWorkItem {
  /** Tipo de relación legible: Padre, Hijo, Relacionado… */
  relation: string
  workItem: WorkItemSummary
}

export interface AttachmentInfo {
  name: string
  url: string
  size: number | null
  comment: string | null
  addedDate: string | null
}

export type RelatedLinkKind = 'pullRequest' | 'commit' | 'branch' | 'build' | 'hyperlink' | 'wiki' | 'artifact'

/** Vínculo del work item que no es otro work item ni un adjunto (sección Development / Related). */
export interface RelatedLink {
  kind: RelatedLinkKind
  /** Tipo de vínculo legible: «Pull request», «Commit», «Rama», «Hipervínculo»… */
  relation: string
  title: string
  /** Repositorio, título del PR u otro dato secundario. */
  detail: string | null
  comment: string | null
  /** Dónde abrirlo en el navegador; null si no se puede deducir. */
  url: string | null
}

export interface WorkItemDetail {
  workItem: WorkItemSummary
  /** Campos más consultados, agrupados (solo los que tienen valor). */
  groups: FieldGroup[]
  /** Descripción, pasos para reproducir, criterios de aceptación… (HTML con imágenes incrustadas). */
  richText: FieldValue[]
  /** Resto de campos con valor que no están en `groups` ni en `richText`. */
  otherFields: FieldValue[]
  links: LinkedWorkItem[]
  /** PR, commits, ramas, builds, hipervínculos, wiki… */
  relatedLinks: RelatedLink[]
  attachments: AttachmentInfo[]
  commentCount: number
  pullRequests: PullRequestSummary[]
  /** Links de PR del work item que no se pudieron resolver (repo borrado, sin permiso, etc.). */
  unresolved: string[]
}

export interface WorkItemComment {
  id: number
  author: string
  authorImageUrl: string | null
  createdDate: string
  modifiedDate: string | null
  /** HTML del comentario, con las imágenes de Azure DevOps incrustadas. */
  html: string
}

/** Persona que se puede mencionar con `@` en un comentario. */
export interface Collaborator {
  /** Id de identidad de Azure DevOps (el que usa `data-vss-mention`). */
  id: string
  displayName: string
  /** Correo o nombre de inicio de sesión. */
  uniqueName: string
  imageUrl: string | null
}

export interface FieldChange {
  refName: string
  label: string
  kind: FieldKind
  oldValue: string | null
  newValue: string | null
}

export interface LinkChange {
  action: 'added' | 'removed'
  /** Descripción legible: "Padre #123", "Pull request !45", "Adjunto foo.png"… */
  text: string
}

export interface WorkItemRevision {
  rev: number
  author: string
  authorImageUrl: string | null
  date: string
  changes: FieldChange[]
  links: LinkChange[]
  /** Comentario de Discussion añadido en esta revisión (texto plano). */
  comment: string | null
}

export interface CommitSummary {
  commitId: string
  shortId: string
  comment: string
  author: string
  authorDate: string | null
  repositoryId: string
  repositoryName: string
  webUrl: string
}

/** Pull request encontrado por número o por commit, con los work items que tiene vinculados. */
export interface PullRequestMatch {
  pullRequest: PullRequestSummary
  workItems: WorkItemSummary[]
  /** Commit por el que se encontró el PR (solo en búsquedas por SHA). */
  viaCommit: string | null
}

export type SearchKind =
  | 'workItemId'
  | 'pullRequestId'
  | 'number'
  | 'commit'
  | 'text'
  | 'allPullRequests'
  | 'parentWorkItems'
  | 'titlePattern'
  | 'externalReference'

export interface SearchResult {
  kind: SearchKind
  workItems: WorkItemSummary[]
  /** Hay más coincidencias que las devueltas (solo cuando no se pidieron todas). */
  hasMoreWorkItems: boolean
  /** Hay más pull requests que los devueltos (listado con `!` sin «Mostrar todos»). */
  hasMorePullRequests: boolean
  pullRequests: PullRequestMatch[]
  commits: CommitSummary[]
  /** Avisos no fatales (p. ej. un SHA corto que no se pudo resolver). */
  notes: string[]
}

/**
 * Lugares donde se busca. Desmarcar los que no interesan acelera la búsqueda
 * (sobre todo `attachments`, que obliga a recorrer los work items con adjuntos).
 */
export interface SearchScope {
  /** Texto libre en el título del work item. */
  title: boolean
  /** Texto libre en la descripción del work item. */
  description: boolean
  /** Nombre de la persona asignada o que creó el work item (System.AssignedTo / System.CreatedBy). */
  collaborator: boolean
  /** Texto libre en los comentarios de la sección Discussion (campo System.History). */
  discussion: boolean
  /** Texto libre en el nombre o comentario de los archivos de la sección Attachments. */
  attachments: boolean
  /** Un número busca también el pull request con ese número. */
  pullRequestNumber: boolean
  /** Un hexadecimal se busca como SHA de commit; si no, como texto libre. */
  commitHash: boolean
  /** Tipos de work item que se devuelven (subconjunto de AppConfig.workItemTypes). */
  workItemTypes: string[]
}

export interface SearchOptions {
  /** false: solo el detalle de los 100 work items más recientes (rápido). */
  allWorkItems: boolean
  scope: SearchScope
}

export type ThemeMode = 'light' | 'dark'

/** Color de acento que se combina con el tema Tokyo Night Islands. */
export const ACCENT_COLORS = ['tokyo', 'pink', 'light-green', 'cyan', 'mai-tai', 'forest-green'] as const

export type AccentColor = (typeof ACCENT_COLORS)[number]

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === 'string' && (ACCENT_COLORS as readonly string[]).includes(value)
}

export interface AppConfig {
  /** Versión de la app (package.json). */
  version: string
  organization: string
  project: string
  /** Host clásico usado para abrir los PR en el navegador. */
  webHost: string
  pullsUrl: string
  workItemTypes: string[]
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface AzdoApi {
  getConfig(): Promise<AppConfig>
  auth: {
    getState(): Promise<AuthState>
    signIn(): Promise<IpcResult<AuthState>>
    signOut(): Promise<IpcResult<AuthState>>
    onChange(cb: (state: AuthState) => void): () => void
  }
  /** Busca work items, pull requests (número) o commits (SHA) según el término. */
  search(term: string, options: SearchOptions, requestId?: string): Promise<IpcResult<SearchResult>>
  /** Aborta la búsqueda `requestId` y todas sus peticiones pendientes. */
  cancelSearch(requestId: string): Promise<void>
  getWorkItemWithPullRequests(id: number): Promise<IpcResult<WorkItemDetail>>
  /** Comentarios de la sección Discussion, del más reciente al más antiguo. */
  getWorkItemComments(id: number): Promise<IpcResult<WorkItemComment[]>>
  /** Revisiones del work item (cambios de campos, links y comentarios), de la más reciente a la más antigua. */
  getWorkItemHistory(id: number): Promise<IpcResult<WorkItemRevision[]>>
  /** Publica un comentario (HTML, con menciones) en la sección Discussion. */
  addWorkItemComment(id: number, html: string): Promise<IpcResult<null>>
  /** Miembros de todos los equipos del proyecto (en caché unos minutos). */
  getCollaborators(): Promise<IpcResult<Collaborator[]>>
  /** Personas del directorio de IATEC cuyo nombre o correo coincide con `query`. */
  searchCollaborators(query: string): Promise<IpcResult<Collaborator[]>>
  /** Pide dónde guardar y descarga el adjunto; devuelve la ruta, o null si se canceló. */
  downloadAttachment(url: string, fileName: string): Promise<IpcResult<string | null>>
  /** Abre el Explorador con el archivo seleccionado. */
  showItemInFolder(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  /** Avisa cuando se pulsa Ctrl+R (búsqueda por External Reference). Devuelve la función para dejar de escuchar. */
  onExternalReferenceShortcut(cb: () => void): () => void
  theme: {
    /** Tema con el que arrancó la ventana; es síncrono para pintar sin parpadeo. */
    initial: ThemeMode
    set(mode: ThemeMode): Promise<void>
  }
  accent: {
    /** Acento con el que arrancó la ventana; síncrono igual que el tema. */
    initial: AccentColor
    set(accent: AccentColor): Promise<void>
  }
}
