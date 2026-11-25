const tags = new Set('svg g path rect circle ellipse line polyline polygon defs linearGradient radialGradient stop clipPath title desc'.split(' '));
const attributes = new Set(('xmlns id width height viewBox preserveAspectRatio x y x1 x2 y1 y2 cx cy fx fy r rx ry d points transform ' +
  'fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray ' +
  'stroke-dashoffset stroke-opacity opacity clip-path clip-rule clipPathUnits offset stop-color stop-opacity gradientUnits gradientTransform').split(' '));
const svgNamespace = 'http://www.w3.org/2000/svg';
export async function safeSvg(blob: Blob) {
  if (blob.size > 1024 ** 2) throw new Error('1002');
  const raw = await blob.text();
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\b)/i.test(raw)) throw new Error('1003');
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || (root.namespaceURI && root.namespaceURI !== svgNamespace)) throw new Error('1003');
  const nodes = [root, ...root.querySelectorAll('*')];
  if (nodes.length > 2500) throw new Error('1002');
  for (const node of nodes) {
    if (!tags.has(node.localName) || (node.namespaceURI && node.namespaceURI !== svgNamespace)) throw new Error('1006');
    for (const { name, value, namespaceURI } of [...node.attributes]) {
      if (!attributes.has(name) || namespaceURI && name !== 'xmlns' ||
        name === 'xmlns' && value !== svgNamespace ||
        /(?:https?:|data:|javascript:|\\|@import)/i.test(value) && name !== 'xmlns' ||
        /url\s*\(/i.test(value) && !/^url\(#[A-Za-z_][\w.-]*\)$/.test(value.trim())) throw new Error('1006');
    }
  }
  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const width = Number.parseFloat(root.getAttribute('width') ?? '') || viewBox[2] || 512;
  const height = Number.parseFloat(root.getAttribute('height') ?? '') || viewBox[3] || 512;
  if (width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error('1002');
  root.setAttribute('xmlns', svgNamespace);
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  return new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' });
}
