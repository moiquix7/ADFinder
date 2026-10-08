/**
 * Genera build/icon.png (512 px, fondo transparente) a partir de build/icon.svg.
 * Usa el propio Electron para rasterizar, así no hace falta ninguna dependencia extra.
 * electron-builder crea el .ico del ejecutable e instalador a partir de ese PNG.
 *
 *   npx electron scripts/render-icon.cjs
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const SIZE = 512
const svgPath = join(__dirname, '../build/icon.svg')
const pngPath = join(__dirname, '../build/icon.png')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true }
  })

  const svg = readFileSync(svgPath, 'utf8')
  const html =
    '<html><body style="margin:0;background:transparent;overflow:hidden">' +
    `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${SIZE}" height="${SIZE}">` +
    '</body></html>'
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
  await new Promise((resolve) => setTimeout(resolve, 300))

  const image = await window.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  writeFileSync(pngPath, image.resize({ width: SIZE, height: SIZE }).toPNG())
  console.log(`icon.png ${image.getSize().width}x${image.getSize().height} -> ${pngPath}`)
  app.quit()
})
