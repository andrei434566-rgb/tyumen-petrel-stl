const maxTriangles = 10_000_000;
const maxBytes = 500_000_084;

self.onmessage = async ({data}) => {
  try {
    const file = data.file;
    if (file && file.size > maxBytes) throw new Error('STL превышает 500 МБ.');
    const buffer = file ? await file.arrayBuffer() : await getSample(data.url);
    const mesh = parseStl(buffer);
    self.postMessage(mesh, [mesh.positions.buffer]);
  } catch (error) {
    self.postMessage({error: error.message || 'Не удалось прочитать STL.'});
  }
};

async function getSample(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Файл модели недоступен.');
  if (Number(response.headers.get('Content-Length')) > maxBytes) throw new Error('STL превышает 500 МБ.');
  return response.arrayBuffer();
}

function parseStl(buffer) {
  const reader = new DataView(buffer);
  let positions;
  if (reader.byteLength >= 84 && 84 + reader.getUint32(80, true) * 50 === reader.byteLength) {
    const count = reader.getUint32(80, true);
    checkCount(count);
    positions = new Float32Array(count * 9);
    for (let face = 0; face < count; face++) {
      const offset = 96 + face * 50;
      for (let i = 0; i < 9; i++) positions[face * 9 + i] = reader.getFloat32(offset + i * 4, true);
    }
  } else {
    positions = readAscii(buffer);
  }

  const lower = [Infinity, Infinity, Infinity];
  const upper = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = positions[i + axis];
      if (!Number.isFinite(coordinate)) throw new Error('В STL есть некорректные координаты.');
      lower[axis] = Math.min(lower[axis], coordinate);
      upper[axis] = Math.max(upper[axis], coordinate);
    }
  }
  if (upper.every((value, axis) => value === lower[axis])) throw new Error('У модели нулевой размер.');
  return {positions, lower, upper, triangles: positions.length / 9};
}

function checkCount(count) {
  if (!Number.isInteger(count) || count === 0) throw new Error('STL не содержит корректных треугольников.');
  if (count > maxTriangles) throw new Error('STL содержит более 10 млн треугольников.');
}

function readAscii(buffer) {
  const utf8 = new TextDecoder();
  if (!/^\s*solid\b/i.test(utf8.decode(buffer.slice(0, 128)))) {
    throw new Error('Файл повреждён или имеет формат, отличный от STL.');
  }
  const source = utf8.decode(buffer);
  const vertex = /^[ \t]*vertex[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)[ \t]*$/gim;
  let vertexCount = 0;
  for (const _ of source.matchAll(vertex)) vertexCount++;
  checkCount(vertexCount / 3);
  const positions = new Float32Array(vertexCount * 3);
  let offset = 0;
  for (const [, x, y, z] of source.matchAll(vertex)) {
    positions[offset++] = Number(x);
    positions[offset++] = Number(y);
    positions[offset++] = Number(z);
  }
  return positions;
}
