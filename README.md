# AD Finder

Aplicación de escritorio (Electron + React + TypeScript) para ver los **pull requests vinculados a un work item** de Azure DevOps.

- Organización: `sda-iatec` · Proyecto: `Sda.Aasi.Net`
- Los PR se abren en <https://sda-iatec.visualstudio.com>, y la barra inferior tiene un acceso directo a <https://sda-iatec.visualstudio.com/_pulls>.
- Colores **Tokyo Night** (variante *Night* en modo oscuro y *Day* en modo claro).
- **Modo claro y modo oscuro** (botón ☀/☾ en la barra superior; se recuerda entre arranques y la primera vez sigue al sistema), con tamaño **widget 10 × 15** (420 × 630 px, proporción 2:3).
- Acceso **solo** con cuenta Microsoft (Entra ID). No hay login por PAT ni usuario/contraseña.

## Requisitos

Node 20 (queda fijado por Volta en `package.json`, no cambia tu Node global). Si no usas Volta, instala Node ≥ 18.

## Uso

```powershell
cd tools\azdo-pr-viewer
npm install
npm run dev        # desarrollo con recarga en caliente
```

Empaquetado para Windows:

```powershell
npm run dist       # genera instalador NSIS + portable en release\
npm run dist:dir   # solo la carpeta descomprimida (más rápido para probar)
```

## Cómo funciona

1. **Login**: botón *Iniciar sesión con Microsoft*. Se abre una ventana de Entra ID (authorization code + PKCE). El token se guarda cifrado con DPAPI en `%APPDATA%\azdo-pr-viewer\msal-cache.bin`, así que la sesión persiste entre arranques y se refresca sola.
2. **Buscar**: la caja de búsqueda interpreta el término:
   - `12345` → work item **y** pull request con ese número.
   - `#12345` → solo el work item · `!6789` o `PR 6789` → solo el pull request (se muestran sus work items vinculados; un clic abre sus PR).
   - `a1b2c3d…` (SHA de 7–40 hex, o `sha:`/`commit:` + hex) → el commit en los repos del proyecto y los PR que lo contienen o cuyo merge final es ese commit. Azure DevOps no siempre resuelve SHA abreviados; con el SHA completo (40) el resultado es exacto.
   - Texto libre → consulta WIQL sobre `System.Title`, `System.AssignedTo` y `System.Description`.

   Los work items se restringen a los tipos **Feature, Issue, Failure, User Story, Bug, Task, Test Task y Rework**.

   **Resultados de texto libre**:
   - Por defecto la consulta WIQL pide solo los **100 work items modificados más recientemente** (se piden 101 ids: el extra solo indica si hay más, sin contar el total). Si hay más coincidencias aparece un aviso con el botón *Mostrar todos*.
   - El interruptor **Mostrar todos los work items**, bajo la caja de búsqueda, hace la búsqueda completa: todas las coincidencias hasta el tope de 20.000 de WIQL, con el detalle pedido en lotes de 200. Es más lento en búsquedas amplias. La opción se recuerda entre arranques.
   - **Filtro por tipo**: si los resultados incluyen varios tipos, una fila de botones (*Todos* + un botón por tipo, con su contador) filtra la lista. Trabaja sobre lo ya cargado, sin nuevas llamadas a Azure DevOps.
   - **Paginador** al pie de la lista: primera / anterior / siguiente / última página y rango visible (`26–50 de 312`). El campo *por página* acepta cualquier entero ≥ 1 (Enter o salir del campo para aplicar, Esc para deshacer); por defecto 25 y se recuerda entre arranques.
3. **Listar PR**: al seleccionar el work item se leen sus relaciones `ArtifactLink` de tipo `vstfs:///Git/PullRequestId/...` y se resuelve cada pull request contra la API de Git.
4. **Filtrar**: la caja *Filtrar por rama* busca en la rama origen y destino (coincidencia resaltada), y los chips filtran por estado (activos / completados / abandonados).

A tamaño widget la app muestra **un panel a la vez**: la lista de work items y, al seleccionar uno, su detalle. La lista solo se oculta: al volver conserva el término, los resultados, la página y la posición del scroll; los resultados solo desaparecen al borrar el texto de búsqueda. Si agrandas la ventana por encima de 860 px de ancho, el layout pasa automáticamente a dos columnas.

**Navegación**: abrir un work item (desde la lista o desde *Relaciones*) lo apila como en un navegador. Los botones ← / → de la cabecera, **Alt+← / Alt+→** o los botones laterales del ratón vuelven al anterior y avanzan; el tooltip dice a qué work item lleva cada uno. A tamaño widget, ← sin work item anterior vuelve a la lista. Los últimos 30 detalles quedan en memoria, así que volver es inmediato; *Recargar* siempre pide los datos de nuevo.

El panel derecho tiene cuatro pestañas (la última elegida se recuerda):

- **Detalles**: campos agrupados (*Estado*: state, reason, asignado, prioridad, severidad, actividad, columna/carril del tablero, tags · *Planificación*: área, iteración, story points/effort, estimaciones y trabajo restante/completado, fechas objetivo · *Build*: found in / integrated in · *Personas y fechas*: creado, modificado, activado, resuelto, cerrado), los campos HTML (Description, Repro Steps, Acceptance Criteria, System Info…), las **relaciones** (padre, hijos, relacionados…; un clic abre el vinculado en el panel), los **adjuntos** y un desplegable *Otros campos* con el resto de campos con valor. Las imágenes pegadas en Azure DevOps se descargan con el token y se incrustan, porque el renderer no puede autenticarse.
- **Pull requests**: la lista de PR con el filtro por rama y por estado.
- **Discussion**: los comentarios (API `comments` 7.1-preview), del más reciente al más antiguo.
- **Historial**: cada revisión (API `updates`) con autor, fecha, campos cambiados (valor anterior → nuevo), links añadidos/quitados (PR, commits, ramas, work items, adjuntos) y el comentario de esa revisión. Discussion e historial se piden solo al abrir su pestaña.

El HTML de Azure DevOps se sanea antes de mostrarse (sin scripts, estilos en línea ni enlaces que no sean http/mailto) y los enlaces se abren en el navegador.

Cada tarjeta de PR muestra id, título, estado, borrador, rama origen → destino, autor, fecha, repositorio, conflictos de merge y los votos de los revisores. Un clic en el título o en el icono ↗ abre el PR en el navegador.

## Autenticación

Por defecto se usa el **client id público de Visual Studio** (`872cd9fa-d31f-45e0-9eab-6e460a02d1f1`, public client con redirect `http://localhost`), que ya tiene consentimiento sobre el recurso Azure DevOps. No hace falta registrar nada en Entra ID.

Si más adelante quieres un App Registration propio, basta con definir variables de entorno antes de arrancar:

| Variable             | Por defecto                            |
| -------------------- | -------------------------------------- |
| `AZDO_CLIENT_ID`     | client id público de Visual Studio     |
| `AZDO_TENANT_ID`     | `organizations`                        |
| `AZDO_REDIRECT_URI`  | `http://localhost/`                    |
| `AZDO_ORG`           | `sda-iatec`                            |
| `AZDO_PROJECT`       | `Sda.Aasi.Net`                         |
| `AZDO_WEB_HOST`      | `https://sda-iatec.visualstudio.com`   |
| `AZDO_WORK_ITEM_TYPES` | `Feature,Issue,Failure,User Story,Bug,Task,Test Task,Rework` |

El App Registration debe ser *public client / native*, con redirect `http://localhost` y permiso delegado **Azure DevOps → user_impersonation**.

## Estructura

```
src/
  shared/types.ts     Contratos compartidos main ↔ preload ↔ renderer
  shared/query.ts     Interpretación del término de búsqueda (id, !PR, SHA, texto)
  main/
    config.ts         Organización, proyecto, client id, scopes
    auth.ts           MSAL Node + ventana de login + caché cifrada
    http.ts           Llamadas autenticadas a la API REST (JSON y binario)
    azdo.ts           Búsqueda: WIQL, work items, pull requests, commits
    workItem.ts       Detalle del work item: campos, relaciones, adjuntos, Discussion, historial
    settings.ts       Preferencias persistidas (tema)
    index.ts          Ventana principal, tema, handlers IPC
  preload/index.ts    API expuesta con contextBridge (contextIsolation activo)
  renderer/           UI React (WorkItemSearch: búsqueda, filtro por tipo y paginador;
                      WorkItemPanel: pestañas Detalles, Pull requests, Discussion e Historial)
```

El renderer corre con `contextIsolation: true`, `nodeIntegration: false` y CSP estricta; nunca ve el access token, solo invoca IPC.

## Cambios

### 1.2.2

- La lista de resultados se conserva al abrir un work item (también a tamaño widget) hasta que se borra el texto de búsqueda.
- Navegación atrás/adelante entre work items (botones ← / →, Alt+← / Alt+→ y botones laterales del ratón), con caché de los detalles ya cargados.

### 1.2.1

- Panel derecho con pestañas: **Detalles** (campos más usados, HTML con imágenes, relaciones, adjuntos, otros campos), **Pull requests**, **Discussion** e **Historial**.
- Filtro de búsqueda **Nombre Colaborador** (asignado o creador). Discussion y Attachments vienen desmarcados por defecto.

### 1.1.0

- **Filtro por tipo de work item** en los resultados de búsqueda, con contador por tipo.
- **Paginador** de work items con tamaño de página configurable (cualquier entero ≥ 1, se recuerda entre arranques).
- **Búsqueda ligera por defecto**: solo los 100 work items más recientes, con aviso si hay más.
- Interruptor **Mostrar todos los work items** para la búsqueda completa (hasta 20.000, detalle en lotes de 200).
