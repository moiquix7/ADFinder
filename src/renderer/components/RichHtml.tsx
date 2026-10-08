import { useMemo, type MouseEvent } from 'react'

/** Etiquetas que se conservan; las demás se sustituyen por su contenido. */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup',
  'ul', 'ol', 'li', 'a', 'img', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'hr'
])

/** Etiquetas que se eliminan con todo su contenido. */
const DROPPED_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'select',
  'textarea', 'link', 'meta', 'base', 'svg', 'math', 'noscript', 'template', 'head', 'title'
])

const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan']
}

function safeHref(value: string): boolean {
  return /^(https?:|mailto:)/i.test(value.trim())
}

function safeSrc(value: string): boolean {
  return /^(https:|data:image\/)/i.test(value.trim())
}

function clean(node: Node): void {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove()
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue

    const element = child as Element
    const tag = element.tagName.toLowerCase()
    if (DROPPED_TAGS.has(tag)) {
      element.remove()
      continue
    }
    clean(element)
    if (!ALLOWED_TAGS.has(tag)) {
      element.replaceWith(...element.childNodes)
      continue
    }

    const allowed = ALLOWED_ATTRIBUTES[tag] ?? []
    for (const attribute of [...element.attributes]) {
      if (!allowed.includes(attribute.name)) element.removeAttribute(attribute.name)
    }
    if (tag === 'a') {
      const href = element.getAttribute('href') ?? ''
      // Las menciones (@persona) llegan como <a href="#">: se muestran como texto destacado.
      if (!safeHref(href)) {
        const mention = element.ownerDocument.createElement('span')
        mention.className = 'rich__mention'
        mention.append(...element.childNodes)
        element.replaceWith(mention)
      }
    }
    if (tag === 'img' && !safeSrc(element.getAttribute('src') ?? '')) element.remove()
  }
}

/** Sanea el HTML de Azure DevOps: sin scripts, estilos en línea ni enlaces peligrosos. */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  clean(doc.body)
  return doc.body.innerHTML
}

/** Muestra HTML de un campo o comentario; los enlaces se abren en el navegador. */
export function RichHtml({ html, className = '' }: { html: string; className?: string }) {
  const safe = useMemo(() => sanitizeHtml(html), [html])

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest('a')
    if (!anchor) return
    event.preventDefault()
    const href = anchor.getAttribute('href')
    if (href) window.azdo.openExternal(href)
  }

  return <div className={`rich ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: safe }} />
}
