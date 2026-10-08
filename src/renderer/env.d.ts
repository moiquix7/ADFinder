/// <reference types="vite/client" />

import type { AzdoApi } from '../shared/types'

declare global {
  interface Window {
    azdo: AzdoApi
  }
}

export {}
