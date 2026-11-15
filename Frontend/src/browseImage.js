// browseImage.js — put an ASF "browse" preview of a NISAR scene on the map.
//
// The preview is a north-up PNG whose black padding is transparent; the scene
// itself is a slanted strip inside it. The backend gives us the scene's
// footprint bounding box [west, south, east, north]. The picture's data area
// (found by scanning for non-transparent pixels) covers exactly that box, so
// stretching the data area onto the box tells us where the whole picture goes.
// The picture is in a projected (Mercator-like) grid, so latitude is
// interpolated in Mercator space.

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const latFromMercY = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI

/**
 * Corners [top-left, top-right, bottom-right, bottom-left] of the whole image.
 * `content` is the data area as fractions (0 to 1) of the image: {x0, y0, x1, y1}.
 */
export function imageCorners(bounds, content) {
  const [west, south, east, north] = bounds
  const lonPerUnit = (east - west) / (content.x1 - content.x0)
  const left = west - content.x0 * lonPerUnit
  const right = east + (1 - content.x1) * lonPerUnit

  const ySouth = mercY(south)
  const yNorth = mercY(north)
  const yPerUnit = (yNorth - ySouth) / (content.y1 - content.y0)
  const top = latFromMercY(yNorth + content.y0 * yPerUnit)
  const bottom = latFromMercY(ySouth - (1 - content.y1) * yPerUnit)

  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ]
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous' // ASF's CDN allows this; needed to read pixels
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load the NISAR preview image'))
    img.src = url
  })
}

/**
 * Download a browse image, locate its data area and return what MapLibre needs:
 * an object URL for a (possibly downsized) copy and the four corner coordinates.
 * The caller revokes the URL with URL.revokeObjectURL when finished.
 */
export async function loadBrowseImage(url, bounds, { maxSize = 1400 } = {}) {
  const img = await loadImage(url)
  const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight))
  const width = Math.max(1, Math.round(img.naturalWidth * scale))
  const height = Math.max(1, Math.round(img.naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, width, height)
  const { data } = ctx.getImageData(0, 0, width, height)

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) throw new Error('The NISAR preview image is empty')

  const content = { x0: minX / width, y0: minY / height, x1: (maxX + 1) / width, y1: (maxY + 1) / height }
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the preview'))), 'image/png'),
  )
  return { url: URL.createObjectURL(blob), coordinates: imageCorners(bounds, content) }
}
