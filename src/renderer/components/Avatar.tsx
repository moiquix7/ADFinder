import { useState } from 'react'

interface AvatarProps {
  name: string
  imageUrl: string | null
  small?: boolean
  title?: string
}

function initials(name: string): string {
  // Solo palabras con letras: "IATec - Moises Rodriguez" da "IM", no "I-".
  const parts = name.trim().split(/\s+/).filter((part) => /\p{L}/u.test(part))
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

/**
 * Los avatares de Azure DevOps requieren token, así que muchas veces devuelven 401.
 * Cuando la imagen falla se cae a las iniciales.
 */
export function Avatar({ name, imageUrl, small, title }: AvatarProps) {
  const [failed, setFailed] = useState(false)
  const className = `avatar${small ? ' avatar--sm' : ''}`

  if (!imageUrl || failed) {
    return (
      <span className={`${className} avatar--fallback`} title={title ?? name}>
        {initials(name)}
      </span>
    )
  }

  return (
    <img
      className={className}
      src={imageUrl}
      alt=""
      title={title ?? name}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}
